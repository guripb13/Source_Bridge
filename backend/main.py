"""
main.py - Source Bridge backend (stateless).

Files that must sit next to this one:  compiler.py, convertibility.py

WORKFLOW OF /send  (every request is independent, nothing is kept between requests)

    1. COMPILER GATE      compiler.py   - the source code is compiled AND run once, hidden
                                          from the user. Compile error, crash (non-zero exit)
                                          or timeout  ->  stop here, the AI is NOT called.
                                          "Asks for input" counts as fine (code is valid).
    2. CONVERTIBILITY     convertibility.py - can <source language> become <target language>?
                                          No -> stop here, the AI is NOT called.
    3. TRANSLATION API    Gemini        - called ONLY if steps 1 and 2 both passed. The answer
                                          is streamed back chunk by chunk.

WORKFLOW OF /execute (Run button) - STATELESS "interactive" input

    The page sends the whole program + every answer typed so far. compiler.run_code starts the
    program from the beginning with those answers on stdin. If the program wants MORE input it
    stops itself and we answer  needs_input: true  (+ which variable asked and what was
    printed so far). The page shows the input box, adds the answer and calls /execute again
    with the longer list. No process, thread or session survives between two calls.
    (This replaces interactive.py's live sessions, which keep processes in server memory and
    therefore are not stateless - so interactive.py is deliberately not registered here.)
"""
import json
import os
import re
from concurrent.futures import TimeoutError as FutureTimeoutError

from flask import Flask, Response, jsonify, render_template, request
from google import genai
from google.genai import types

import compiler                                   # step 1: compile + run
from convertibility import check_convertible      # step 2: source -> target allowed?

# --------------------------------------------------------------------------
# App setup
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _first_existing(*paths):
    for p in paths:
        if os.path.isdir(p):
            return p
    return paths[0]


# Works with  backend/main.py + frontend/{templates,static}   (your Vercel layout)
# and with    main.py + {templates,static} in the same folder  (the zip layout).
app = Flask(
    __name__,
    template_folder=_first_existing(
        os.path.join(BASE_DIR, "..", "frontend", "templates"),
        os.path.join(BASE_DIR, "templates"),
    ),
    static_folder=_first_existing(
        os.path.join(BASE_DIR, "..", "frontend", "static"),
        os.path.join(BASE_DIR, "static"),
    ),
)

# Rate limiting protects /execute (it runs user code) and the paid AI call.
# Optional: if flask-limiter is not installed the app still runs, just unlimited.
try:
    from flask_limiter import Limiter
    from flask_limiter.util import get_remote_address

    _limiter = Limiter(get_remote_address, app=app, default_limits=[])
    limit = _limiter.limit
except ImportError:                                # pragma: no cover
    def limit(_rule):
        return lambda fn: fn

# The API key comes from the environment, never from the code.
# Set GEMINI_API_KEY in your shell or in Vercel -> Environment Variables.
API_KEY = "API_KEY"  # os.environ.get("GEMINI_API_KEY")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set.")
client = genai.Client(api_key=API_KEY)

MAX_SOURCE_CHARS = compiler.MAX_CODE_CHARS
GATE_TIMEOUT = compiler.COMPILE_TIMEOUT + compiler.RUN_TIMEOUT + 10


# --------------------------------------------------------------------------
# Prompt for the translation API
# --------------------------------------------------------------------------
def build_task(language):
    return f"""You are a code translation engine. Your target language is {language}.

Step 1 - Validation:
Check whether the given input is valid, translatable source code (in any recognizable programming language).
If the input is NOT code (e.g. plain text, gibberish, an empty/meaningless snippet), or is code written in a language/format that cannot be reasonably translated to {language}, do NOT attempt translation.
Instead, return only this single line, with no extra text:
ERROR: The provided input cannot be translated to {language}. Please provide valid source code in a supported language.

Step 2 - Syntax check:
If the input contains syntax errors, still translate as much as possible, but mark each problematic line in the output using a {language}-appropriate comment placed directly above or beside that line, in this format:
// SYNTAX ERROR: <short description of the issue>
(use the correct comment syntax for {language} instead of // if different)

Step 3 - Translation:
Convert the given code to {language}.
Return only the translated code (with syntax-error comments where applicable). No explanations, no markdown, no extra messages of any kind.
Format it like a normal {language} file: one statement per line, and proper indentation for each nested level."""


def clean_language(value, default=""):
    """Language names go into the AI prompt, so accept only a short, plain name."""
    value = (value or "").strip()
    if not value:
        return default
    if len(value) > 40 or not re.fullmatch(r"[A-Za-z0-9+#./\- ]+", value):
        return None
    return value


# --------------------------------------------------------------------------
# STEP 1 - compiler gate (compiler.py)
# --------------------------------------------------------------------------
def check_source_code(text, source_language):
    """
    Hidden pre-translation gate. Compiles AND runs the code once through compiler.py.
    Returns None if the code is fine, otherwise a user-facing error message.

    Passes:   exit code 0, or the program stopped because it wants user input.
    Blocks:   compile error, non-zero exit code, timeout, compiler missing on the server.
    Skipped:  languages compiler.py cannot build (JavaScript, Go, ...) go straight on.
    """
    lang = (
        compiler.normalize_language(source_language)
        if source_language
        else compiler.detect_language(compiler.strip_fences(text))
    )
    if lang is None:
        return None

    try:
        result = compiler.submit_run(text, lang, "").result(timeout=GATE_TIMEOUT)
    except FutureTimeoutError:
        app.logger.exception("Source-code check did not finish in time.")
        return "Source-code check timed out. Please try again."
    except Exception:
        app.logger.exception("Source-code check failed unexpectedly.")
        return "Could not check the source code. Please try again."

    status = result["status"]
    phase = result.get("phase")

    if status == "needs_input":                       # valid program, just waiting for input
        return None
    if status == "success" and result.get("exit_code") == 0:
        return None

    if status == "timeout":
        message = ("Source-code compilation timed out" if phase == "compile"
                   else "Source code did not finish running in time")
    elif status == "unavailable":
        message = "Cannot check the source code on this server"
    elif status == "skipped":
        message = "Could not check the source code"
    elif phase == "compile":
        message = "Source code has a compilation error"
    else:
        message = f"Source code failed when run (exit code {result.get('exit_code')})"

    details = "\n".join(
        part.strip()
        for part in (result.get("stderr") or "", result.get("errors") or "")
        if part and part.strip()
    )[-compiler.MAX_ERROR_CHARS:]
    return f"{message}:\n{details}" if details else f"{message}."


# --------------------------------------------------------------------------
# Pages
# --------------------------------------------------------------------------
@app.route("/")
def home():
    return render_template("index.html")


@app.route("/me", methods=["GET"])
def current_user():
    """The app is stateless (no accounts here), so nobody is ever 'signed in'."""
    response = jsonify(authenticated=False, user=None)
    response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------------------------------
# /send  -  compiler -> convertibility -> translation API
# --------------------------------------------------------------------------
@app.route("/send", methods=["POST"])
@limit("20 per minute")
def send():
    text = request.form.get("message", "").strip()
    language = clean_language(request.form.get("language"), default="Java")
    source_language = clean_language(
        request.form.get("source_language") or request.form.get("sourceLanguage")
    )
    # The page opts in to JSON-lines events; other callers get plain text.
    use_events = request.headers.get("Accept", "").strip().lower() == "application/x-ndjson"

    def event(kind, **data):
        return json.dumps({"type": kind, **data}, ensure_ascii=True) + "\n"

    def fail(message):
        return event("error", message=message) if use_events else message

    def generate():
        # ---- input checks ------------------------------------------------
        if not text:
            yield fail("Please provide some source code.")
            return
        if len(text) > MAX_SOURCE_CHARS:
            yield fail("The source code is too large.")
            return
        if language is None or source_language is None:
            yield fail("Invalid language name.")
            return

        # ---- STEP 1: compiler gate  (AI is NOT called on failure) --------
        problem = check_source_code(text, source_language)
        if problem:
            yield fail(problem)
            return

        # ---- STEP 2: can source -> target be converted? ------------------
        problem = check_convertible(source_language, language) if source_language else None
        if problem:
            yield fail(problem)
            return

        # ---- STEP 3: translation API (only reached when 1 and 2 passed) --
        chunks = []
        try:
            for chunk in client.models.generate_content_stream(
                model=MODEL,
                contents=text,
                config=types.GenerateContentConfig(system_instruction=build_task(language)),
            ):
                if chunk.text:
                    chunks.append(chunk.text)
                    yield event("chunk", text=chunk.text) if use_events else chunk.text
        except Exception:
            # Real error goes to the server log; the user gets a safe message.
            app.logger.exception("Gemini request failed")
            yield fail("Error: The translation service is currently unavailable. Please try again.")
            return

        translated = "".join(chunks)
        if not translated.strip() or translated.lstrip().lower().startswith("error:"):
            if use_events:                            # the AI refused / returned nothing
                yield event("error",
                            message=translated.strip() or "No code was returned. Please try again.")
            return

        if use_events:
            # Nothing is stored server-side, so there is no id to report.
            yield event("complete", translation_id=None, user_id=None,
                        is_saved=False, created_at=None, persisted=False)

    response = Response(generate(), mimetype="application/x-ndjson" if use_events else "text/plain")
    if use_events:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Accel-Buffering"] = "no"
    return response


# --------------------------------------------------------------------------
# /execute  -  Run button, stateless interactive input
# --------------------------------------------------------------------------
MAX_ANSWERS = 200
MAX_ANSWER_CHARS = 10_000
MAX_ANSWERS_TOTAL_CHARS = 100_000


def read_answers(data):
    """
    Turn the page's labelled answers into the text the program reads on stdin.
    The page sends  "inputs": [{"label": "a", "value": "5"}, ...]  (plain strings work too).
    Labels are only for the page; the program receives the values in order, one per line.
    Returns (stdin_text, error_message_or_None).
    """
    raw = data.get("inputs")
    if raw is None:                                   # old clients: a single "stdin" string
        legacy = data.get("stdin", "")
        return (legacy[:100_000] if isinstance(legacy, str) else ""), None
    if not isinstance(raw, list) or len(raw) > MAX_ANSWERS:
        return "", "Too many answers for one run."
    lines, total = [], 0
    for item in raw:
        value = item.get("value") if isinstance(item, dict) else item
        if not isinstance(value, str):
            return "", "Every answer must be text."
        value = value[:MAX_ANSWER_CHARS].replace("\r", "").replace("\n", " ")
        total += len(value) + 1
        if total > MAX_ANSWERS_TOTAL_CHARS:
            return "", "Too much input for one run."
        lines.append(value + "\n")
    return "".join(lines), None


@app.route("/execute", methods=["POST"])
@limit("120 per minute")
def execute_code():
    if not request.is_json:
        return jsonify(error="Send the request as JSON."), 415

    data = request.get_json(silent=True)
    if (not isinstance(data, dict)
            or not isinstance(data.get("code"), str)
            or not isinstance(data.get("language"), str)):
        return jsonify(error="Code and language are required as text."), 400

    code = data["code"]
    if not code.strip():
        return jsonify(error="There is no code to run."), 400
    if len(code) > MAX_SOURCE_CHARS:
        return jsonify(error="The code is too large."), 413

    stdin_text, problem = read_answers(data)
    if problem:
        return jsonify(error=problem), 413
    eof = data.get("eof") is True

    lang = compiler.normalize_language(data["language"])
    if lang is None:
        return jsonify(error="Only C, C++, Python and Java can be compiled and run right now."), 400

    try:
        result = compiler.submit_run(code, lang, stdin_text, eof).result(timeout=GATE_TIMEOUT)
    except Exception:
        app.logger.exception("Run request failed.")
        return jsonify(error="The compiler failed. Please try again."), 500

    status = result["status"]
    tool = result["compiler"] or lang
    took = f'{result["duration_ms"]} ms'
    stdout = result.get("stdout", "")
    stderr = result.get("stderr", "")
    timed_out = False

    if status == "success":
        if result["errors"]:                          # compiler warnings
            stderr = (stderr + "\n" if stderr else "") + "Compiler warnings:\n" + result["errors"]
        if not stdout and not stderr:
            stdout = f"(program finished with no output - {tool}, {took})"
    elif status == "error":
        if result["phase"] == "compile":
            stdout = ""
            stderr = f"Compilation failed ({tool}):\n\n" + result["errors"]
        else:                                         # runtime error / non-zero exit
            stderr = (stderr + "\n" if stderr else "") + f"[exited with code {result['exit_code']}]"
    elif status == "needs_input":
        pass        # keep stdout exactly as printed: the page needs its length (stdout_units)
    elif status == "timeout":
        timed_out = True
        if result["phase"] == "compile":
            stderr = result["errors"]
        else:
            stderr = (stderr + "\n" if stderr else "") + result["errors"]
    else:                                             # unavailable / skipped
        stdout, stderr = "", result["errors"]

    response = jsonify(
        stdout=stdout,
        stderr=stderr,
        timed_out=timed_out,
        status=status,
        needs_input=bool(result.get("needs_input")),
        input_request=result.get("input_request"),
        stdout_units=result.get("stdout_units", 0),
        phase=result["phase"],
        exit_code=result["exit_code"],
        language=result["language"],
        duration_ms=result["duration_ms"],
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.errorhandler(429)
def rate_limited(_error):
    return jsonify(error="Too many requests. Wait one minute and try again."), 429


if __name__ == "__main__":
    app.run(debug=False)