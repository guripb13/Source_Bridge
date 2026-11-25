"""
main.py - Source Bridge backend.

Files that must sit next to this one:  compiler.py, convertibility.py, database.py

ACCOUNTS (database.py -> users.db)
    GET  /username-available?username=NAME   live "is it taken?" check (username_index.db)
    POST /signup   create an account and sign in        {username, email, password, remember?}
    POST /login    sign in with username OR email       {identifier, password}
    POST /logout   sign out
    GET  /me       who is signed in?                    -> {authenticated, user}
    DELETE /account  delete the account + its history   {password}
    Signing in puts the user id in a signed, HttpOnly cookie (no server-side session storage,
    so it also works on serverless hosting). Visitors who are NOT signed in use the app exactly
    as before and nothing about them is stored.

HISTORY (database.py -> translations.db)  - signed-in users only
    GET    /translations              list (add ?saved=1 for bookmarked only, ?before_id= to page)
    GET    /translations/<id>         one translation with the full source + translated code
    POST   /translations/<id>/save    bookmark it   (body {"saved": false} un-bookmarks)
    DELETE /translations/<id>         remove it

WORKFLOW OF /send
    0. A row is recorded as 'pending' for signed-in users (language pair + source code).
    1. COMPILER GATE      compiler.py   - the source code is compiled AND run once, hidden
                                          from the user. Compile error, crash (non-zero exit)
                                          or timeout  ->  stop here, the AI is NOT called.
                                          "Asks for input" counts as fine (code is valid).
    2. CONVERTIBILITY     convertibility.py - can <source language> become <target language>?
                                          No -> stop here, the AI is NOT called.
    3. TRANSLATION API    Gemini        - called ONLY if steps 1 and 2 both passed. The answer
                                          is streamed back chunk by chunk.
    The row ends as 'completed' (with the translated code) or 'failed' (with the step that
    failed and why). If the browser closes the stream early the row is marked 'failed' too.
    Any database problem is only logged: the translation itself still works.

WORKFLOW OF /execute (Run button) - STATELESS "interactive" input
    The page sends the whole program + every answer typed so far. compiler.run_code starts the
    program from the beginning with those answers on stdin. If the program wants MORE input it
    stops itself and we answer  needs_input: true  (+ which variable asked and what was
    printed so far). The page shows the input box, adds the answer and calls /execute again
    with the longer list. No process, thread or session survives between two calls.

SANDBOX NOTE
    /execute and the compiler gate call compiler.py directly (no Docker). POSIX resource
    limits and Python -I apply, but user code runs on the same machine as the app, so there
    is no full network/filesystem isolation.
"""
import functools
import json
import os
import re
import sqlite3
from concurrent.futures import TimeoutError as FutureTimeoutError
from datetime import timedelta
from urllib.parse import urlsplit

from flask import Flask, Response, g, jsonify, render_template, request, session
from flask_limiter import Limiter                     # hard import — must be in requirements.txt
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix   # correct client-IP detection behind proxies
import httpx
from google import genai
from google.genai import errors as genai_errors
from google.genai import types

import compiler                                   # step 1: compile + run
import database as db                             # users.db + translations.db + username_index.db
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

# ProxyFix: when running behind Vercel's load balancer or nginx, the real client
# IP arrives in X-Forwarded-For. Without this, get_remote_address returns the
# proxy's IP (127.0.0.1) and ALL clients share one rate-limit bucket.
# x_for=1 trusts exactly one proxy hop; increase only if you have multiple
# trusted reverse proxies in front of the app.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# Create users.db / translations.db on first start (does nothing if they already exist).
db.init_db()

app.config.update(
    SECRET_KEY=db.get_secret_key(),               # SECRET_KEY env var preferred; else DB-generated
    SESSION_COOKIE_HTTPONLY=True,                 # JavaScript can't read the login cookie
    SESSION_COOKIE_SAMESITE="Lax",                # not sent on cross-site POSTs (CSRF protection)
    # FIX VULN-010: Secure by default; to disable in local dev set COOKIE_SECURE=0
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "1") != "0",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

# --------------------------------------------------------------------------
# Rate limiting — hard dependency; flask-limiter must be in requirements.txt.
# FIX VULN-007: removed the try/except ImportError fallback that silently
# disabled all rate limits when flask-limiter was not installed.
# --------------------------------------------------------------------------
_limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=[],
    storage_uri=os.environ.get("LIMITER_STORAGE_URI", "memory://"),
)
limit = _limiter.limit

# --------------------------------------------------------------------------
# API key — pop from the environment after reading so that user code running
# as the same OS user cannot exfiltrate it via /proc/<flask-pid>/environ.
# FIX VULN-001 (partial): popping removes it from the environment before
# any user-submitted code is compiled or run.
# --------------------------------------------------------------------------
API_KEY = os.environ.pop("GEMINI_API_KEY", "API").strip()
if not API_KEY:
    raise RuntimeError(
        "GEMINI_API_KEY environment variable is not set or is empty.\n"
        "  Local:  export GEMINI_API_KEY='your-real-key'\n"
        "  Vercel: Settings -> Environment Variables -> GEMINI_API_KEY"
    )

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
client = genai.Client(api_key=API_KEY)

# BACKUP translation API (optional). Exactly the same call as the main one, just a second
# key/client. It is used ONLY when the main API fails on the provider's side (busy, quota,
# unavailable, timeout). Set GEMINI_API_KEY_2 to enable it; leave it unset to disable.
# Popped from the environment for the same reason as the main key.
BACKUP_API_KEY = os.environ.pop("GEMINI_API_KEY_2", "").strip()
BACKUP_MODEL = os.environ.get("GEMINI_MODEL_2", MODEL)
backup_client = genai.Client(api_key=BACKUP_API_KEY) if BACKUP_API_KEY else None

# HTTP codes meaning "the API side has a problem" (not the user's/our request):
# 408 timeout, 429 busy/quota, 500 internal, 502/503 unavailable, 504 gateway timeout.
BACKUP_STATUS_CODES = {408, 429, 500, 502, 503, 504}


# Key problems on the main API (invalid / expired / blocked key): the backup key can still work.
KEY_PROBLEM_CODES = {401, 403}
KEY_PROBLEM_HINTS = ("api key not valid", "api_key_invalid", "api key expired", "permission_denied")


def _is_api_side_error(exc):
    """True when the MAIN API cannot serve the request (busy / unavailable / quota / bad key),
    so trying the backup API makes sense. A normal bad request (e.g. invalid prompt) is not one."""
    if isinstance(exc, genai_errors.APIError):
        if exc.code in BACKUP_STATUS_CODES or exc.code in KEY_PROBLEM_CODES:
            return True
        # Google reports an invalid API key as HTTP 400, so check the message too.
        return exc.code == 400 and any(h in str(exc).lower() for h in KEY_PROBLEM_HINTS)
    return isinstance(exc, httpx.TransportError)      # connection failed / timed out

MAX_SOURCE_CHARS = compiler.MAX_CODE_CHARS
GATE_TIMEOUT = compiler.COMPILE_TIMEOUT + compiler.RUN_TIMEOUT + 10

def _run_code(code, lang, stdin_text, eof=False):
    """Execute code directly with compiler.py (no Docker)."""
    return compiler.submit_run(code, lang, stdin_text, eof).result(timeout=GATE_TIMEOUT)


# --------------------------------------------------------------------------
# Security headers — applied to every response.
# FIX VULN-014 (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
# FIX VULN-017 (Server header disclosure)
# --------------------------------------------------------------------------
@app.after_request
def add_security_headers(response):
    # Prevent MIME-type sniffing attacks.
    response.headers.setdefault("X-Content-Type-Options", "nosniff")

    # Prevent the page from being loaded in any frame (clickjacking).
    response.headers.setdefault("X-Frame-Options", "DENY")

    # Referrer information sent on navigation.
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")

    # Disable access to powerful browser APIs not used by this app.
    response.headers.setdefault(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=(), payment=()"
    )

    # HSTS: tell browsers to always use HTTPS for this origin.
    response.headers.setdefault(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains"
    )

    # Content-Security-Policy:
    #   - All scripts loaded from same origin (/static/).
    #   - Styles from same origin (/static/).
    #   - Language icons loaded as <img src="..."> from jsdelivr CDN.
    #   - fetch() calls go to same origin only (/send, /execute, /translations, etc.).
    #   - No inline scripts, no eval.
    response.headers.setdefault(
        "Content-Security-Policy",
        (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self'; "
            "img-src 'self' cdn.jsdelivr.net data:; "
            "font-src 'self'; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self';"
        )
    )

    # Strip the Server header that reveals Flask/Werkzeug version strings.
    response.headers.remove("Server")

    return response


# --------------------------------------------------------------------------
# Small helpers: JSON replies, who is signed in, safe database calls
# --------------------------------------------------------------------------
def reply(payload, status=200):
    """JSON answer that browsers must never cache (it can contain account data)."""
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def json_body():
    data = request.get_json(silent=True) if request.is_json else None
    return data if isinstance(data, dict) else None


def current_user():
    """The signed-in user (dict) or None. Looked up once per request."""
    if "user" not in g:
        g.user = None
        user_id = session.get("uid")
        if user_id is not None:
            try:
                g.user = db.get_user(user_id)
                if g.user is None:                 # account deleted / disabled -> drop the cookie
                    session.pop("uid", None)
            except Exception:
                app.logger.exception("Could not look up the signed-in user.")
    return g.user


def start_session(user, remember=True):
    """
    remember=True  -> "Keep me signed in": a long-lived cookie (PERMANENT_SESSION_LIFETIME, 30 days,
                      renewed on every visit) that survives closing the browser.
    remember=False -> not remembered: the browser drops the cookie when it closes, AND the server
                      ends the session whenever the page is loaded or refreshed (see home()),
                      so the person has to sign in again.
    The cookie lives in one browser on one device, so each phone/computer/browser keeps its own choice.
    """
    session.clear()                                # fresh cookie on every sign-in
    session["uid"] = user["id"]
    session.permanent = bool(remember)
    session["remember"] = bool(remember)
    g.user = user


def wants_remember(data):
    """Only an explicit `false` from the page turns "keep me signed in" off."""
    return data.get("remember") is not False


def login_required(view):
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return reply({"error": "Please sign in first."}, 401)
        return view(*args, **kwargs)
    return wrapper


# --------------------------------------------------------------------------
# Cross-site request protection (defence in depth on top of SameSite=Lax cookies).
# Browsers attach an Origin header to every cross-origin write. If it names a different
# site than the one serving this app, the request is refused before any route runs.
# Requests without an Origin header (curl, same-origin GETs) are not affected.
# Behind a proxy that rewrites the Host header, list your public host(s) in
# ALLOWED_HOSTS (comma separated, e.g. "myapp.vercel.app").
# --------------------------------------------------------------------------
_ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get("ALLOWED_HOSTS", "").split(",") if h.strip()}


@app.before_request
def block_cross_site_writes():
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        origin = request.headers.get("Origin")
        if origin:
            host = urlsplit(origin).netloc.lower()
            if host != request.host.lower() and host not in _ALLOWED_HOSTS:
                return reply({"error": "Cross-site request blocked."}, 403)


def _safe(function, *args):
    """Database trouble must never break a translation: log it and carry on."""
    try:
        return function(*args)
    except Exception:
        app.logger.exception("Database call %s failed.", getattr(function, "__name__", "?"))
        return None


class Attempt:
    """
    One translation attempt in translations.db. For visitors who are not signed in (or when the
    database is unavailable) every method quietly does nothing, so /send works either way.
    """

    def __init__(self, user_id, source_language, target_language, source_code):
        self.user_id = user_id
        self.row = None                            # {"id", "created_at"} once recorded
        self.closed = False                        # row already completed or failed
        self.stored = False                        # completed row really written
        if user_id is not None:
            self.row = _safe(db.start_translation, user_id, source_language,
                             target_language, source_code)

    def fail(self, stage, message):
        if self.row and not self.closed:
            self.closed = True
            _safe(db.fail_translation, self.row["id"], self.user_id, stage, message)

    def complete(self, target_code):
        if self.row and not self.closed:
            self.closed = True
            result = _safe(db.complete_translation, self.row["id"], self.user_id, target_code)
            self.stored = bool(result)
            if result:
                # An identical back-to-back result is merged into the earlier entry, so from now
                # on this attempt IS that entry (its id, its date, its repeat_count).
                self.row = result
        return self.stored


# --------------------------------------------------------------------------
# Language allowlist — prevents prompt injection via the language field.
# FIX VULN-012: replaced the permissive regex with a strict known-languages
# allowlist. No user-supplied free text ever reaches the Gemini system prompt.
# --------------------------------------------------------------------------
_KNOWN_LANGUAGES = {
    # General programming languages
    "python": "Python", "python3": "Python", "py": "Python",
    "java": "Java",
    "c": "C",
    "c++": "C++", "cpp": "C++", "cplusplus": "C++", "c plus plus": "C++",
    "c#": "C#", "csharp": "C#", "c sharp": "C#", "cs": "C#",
    "javascript": "JavaScript", "js": "JavaScript",
    "node": "JavaScript", "nodejs": "JavaScript", "node.js": "JavaScript",
    "typescript": "TypeScript", "ts": "TypeScript",
    "go": "Go", "golang": "Go",
    "rust": "Rust", "rs": "Rust",
    "php": "PHP",
    "swift": "Swift",
    "kotlin": "Kotlin", "kt": "Kotlin",
    "ruby": "Ruby", "rb": "Ruby",
    "scala": "Scala",
    "dart": "Dart",
    "r": "R",
    "lua": "Lua",
    "perl": "Perl",
    "haskell": "Haskell",
    "matlab": "MATLAB",
    "objective-c": "Objective-C", "objc": "Objective-C", "objectivec": "Objective-C",
    "objective-c++": "Objective-C++",
    "bash": "Bash", "sh": "Bash", "shell": "Bash", "zsh": "Bash",
    "powershell": "PowerShell", "ps1": "PowerShell",
    "julia": "Julia",
    "groovy": "Groovy",
    "elixir": "Elixir",
    "clojure": "Clojure",
    "f#": "F#", "fsharp": "F#",
    "visual basic": "Visual Basic", "vb": "Visual Basic",
    "vb.net": "Visual Basic .NET", "vbnet": "Visual Basic .NET",
    "visual basic .net": "Visual Basic .NET",
    "cobol": "COBOL",
    "fortran": "Fortran",
    "pascal": "Pascal",
    "lisp": "Lisp", "common lisp": "Common Lisp",
    "scheme": "Scheme",
    "prolog": "Prolog",
    "erlang": "Erlang",
    "ocaml": "OCaml",
    "racket": "Racket",
    "ada": "Ada",
    "nim": "Nim",
    "crystal": "Crystal",
    "zig": "Zig",
    "d": "D",
    "assembly": "Assembly", "asm": "Assembly",
    "coffeescript": "CoffeeScript",
    "clojurescript": "ClojureScript",
    "purescript": "PureScript",
    "elm": "Elm",
    "reasonml": "ReasonML", "reason": "ReasonML",
    "v": "V",
    "mojo": "Mojo",
    # SQL variants
    "sql": "SQL",
    "mysql": "MySQL",
    "postgresql": "PostgreSQL", "postgres": "PostgreSQL", "psql": "PostgreSQL",
    "sqlite": "SQLite",
    "t-sql": "T-SQL", "tsql": "T-SQL", "mssql": "T-SQL",
    "transact-sql": "T-SQL", "sql server": "T-SQL",
    "pl/sql": "PL/SQL", "plsql": "PL/SQL", "oracle sql": "PL/SQL",
    # Data formats
    "json": "JSON",
    "yaml": "YAML", "yml": "YAML",
    "xml": "XML",
    "toml": "TOML",
    # Markup / styling
    "html": "HTML", "html5": "HTML",
    "css": "CSS", "css3": "CSS",
    "markdown": "Markdown", "md": "Markdown",
    # Hardware description
    "verilog": "Verilog",
    "vhdl": "VHDL",
}


def clean_language(value, default=""):
    """
    Validate and normalise a language name before it is used in an AI prompt.

    STRICT: only languages in _KNOWN_LANGUAGES are accepted. Everything else
    returns None, which the calling route turns into a 400 error response.
    This is a hard security boundary: no user-supplied free text ever reaches
    the Gemini system prompt via this field.
    """
    value = (value or "").strip()
    if not value:
        return default

    if len(value) > 40:
        return None

    normalised = " ".join(value.lower().split())
    return _KNOWN_LANGUAGES.get(normalised)   # None if not in the allowlist


# --------------------------------------------------------------------------
# Prompt for the translation API
# FIX VULN-012: language is quoted and validated before being embedded in
# the system prompt.
# --------------------------------------------------------------------------
def build_task(language):
    # `language` has already been validated against _KNOWN_LANGUAGES.
    # Strip residual quote chars as belt-and-braces.
    lang = language.replace('"', "").replace("'", "")
    return f"""You are a code translation engine. Your target language is "{lang}".

Step 1 - Validation:
Check whether the given input is valid, translatable source code (in any recognizable programming language).
If the input is NOT code (e.g. plain text, gibberish, an empty/meaningless snippet), or is code written in a language/format that cannot be reasonably translated to "{lang}", do NOT attempt translation.
Instead, return only this single line, with no extra text:
ERROR: The provided input cannot be translated to "{lang}". Please provide valid source code in a supported language.

Step 2 - Syntax check:
If the input contains syntax errors, still translate as much as possible, but mark each problematic line in the output using a "{lang}"-appropriate comment placed directly above or beside that line, in this format:
// SYNTAX ERROR: <short description of the issue>
(use the correct comment syntax for "{lang}" instead of // if different)

Step 3 - Translation:
Convert the given code to "{lang}".
Return only the translated code (with syntax-error comments where applicable). No explanations, no markdown, no extra messages of any kind.
Format it like a normal "{lang}" file: one statement per line, and proper indentation for each nested level."""


# --------------------------------------------------------------------------
# STEP 1 - compiler gate (compiler.py or runner HTTP service)
# --------------------------------------------------------------------------
def check_source_code(text, source_language):
    """
    Hidden pre-translation gate. Compiles AND runs the code once.
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
        result = _run_code(text, lang, "")
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
    # "Keep me signed in" was unticked: that sign-in only lasts for the page the person is on.
    # Loading or refreshing the page (which is what reaches this route) signs them out.
    if session.get("remember") is False:
        session.clear()
    return render_template("index.html")


# --------------------------------------------------------------------------
# Accounts: sign up / sign in / sign out / who am I / delete account
# --------------------------------------------------------------------------
@app.route("/me", methods=["GET"])
def me():
    user = current_user()
    # `remember` lets the page enforce "Keep me signed in = off" on its own side too.
    return reply({"authenticated": user is not None, "user": user,
                  "remember": session.get("remember", True) is not False})


@app.route("/username-available", methods=["GET"])
@limit("60 per minute")
def username_available():
    """Live sign-up check. Answers from username_index.db, so it is a single quick lookup."""
    return reply(db.check_username(request.args.get("username", "")))


@app.route("/signup", methods=["POST"])
@limit("10 per minute")
def signup():
    data = json_body()
    if data is None:
        return reply({"error": "Send the request as JSON."}, 415)
    user = db.register_user(data.get("username"), data.get("email"), data.get("password"))
    start_session(user, wants_remember(data))      # a new account is signed in straight away
    return reply({"authenticated": True, "user": user}, 201)


@app.route("/login", methods=["POST"])
@limit("10 per minute")
def login():
    data = json_body()
    if data is None:
        return reply({"error": "Send the request as JSON."}, 415)
    identifier = data.get("identifier") or data.get("username") or data.get("email")
    user = db.authenticate(identifier, data.get("password"))
    start_session(user, wants_remember(data))
    return reply({"authenticated": True, "user": user})


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    g.user = None
    return reply({"authenticated": False, "user": None})


@app.route("/account", methods=["DELETE"])
@limit("5 per minute")
@login_required
def delete_account():
    data = json_body()
    if data is None:
        return reply({"error": "Send the request as JSON."}, 415)
    db.delete_user(current_user()["id"], data.get("password"))
    session.clear()
    g.user = None
    return reply({"authenticated": False, "user": None, "deleted": True})


# --------------------------------------------------------------------------
# History: the signed-in user's translations
# --------------------------------------------------------------------------
@app.route("/translations", methods=["GET"])
@login_required
def list_translations():
    items, next_before_id = db.list_translations(
        current_user()["id"],
        saved_only=request.args.get("saved") in ("1", "true"),
        limit=request.args.get("limit", 20, type=int),
        before_id=request.args.get("before_id", type=int),
    )
    return reply({"translations": items, "next_before_id": next_before_id})


@app.route("/translations/<int:translation_id>", methods=["GET"])
@login_required
def get_translation(translation_id):
    item = db.get_translation(translation_id, current_user()["id"])
    if item is None:
        return reply({"error": "Translation not found."}, 404)
    return reply({"translation": item})


@app.route("/translations/<int:translation_id>/save", methods=["POST"])
@login_required
def save_translation(translation_id):
    data = json_body() or {}
    wanted = data.get("saved", True) is not False
    if not db.set_saved(translation_id, current_user()["id"], wanted):
        return reply({"error": "Translation not found, or it did not finish."}, 404)
    return reply({"id": translation_id, "is_saved": wanted})


@app.route("/translations/<int:translation_id>", methods=["DELETE"])
@login_required
def delete_translation(translation_id):
    if not db.delete_translation(translation_id, current_user()["id"]):
        return reply({"error": "Translation not found."}, 404)
    return reply({"id": translation_id, "deleted": True})


def stream_translation(text, language):
    """
    Yield the translated text chunk by chunk.
    Main API first. The backup API (same call, same model settings) is tried ONLY if the main
    one fails with an API-side error (busy / unavailable / quota / timeout) BEFORE any text was
    sent to the user - so the user never gets duplicated or mixed output.
    """
    apis = [("main", client, MODEL)]
    if backup_client is not None:
        apis.append(("backup", backup_client, BACKUP_MODEL))

    for number, (name, api, model) in enumerate(apis):
        started = False
        try:
            for chunk in api.models.generate_content_stream(
                model=model,
                contents=text,
                config=types.GenerateContentConfig(system_instruction=build_task(language)),
            ):
                if chunk.text:
                    started = True
                    yield chunk.text
            return
        except Exception as exc:
            is_last = number == len(apis) - 1
            if started or is_last or not _is_api_side_error(exc):
                raise
            app.logger.warning("Gemini %s API failed (%s); switching to the backup API.", name, exc)


# --------------------------------------------------------------------------
# /send  -  compiler -> convertibility -> translation API  (+ history for signed-in users)
# --------------------------------------------------------------------------
@app.route("/send", methods=["POST"])
@limit("15 per minute")       # reduced from 20 — protects Gemini API quota
def send():
    text = request.form.get("message", "").strip()
    language = clean_language(request.form.get("language"), default="Java")
    source_language = clean_language(
        request.form.get("source_language") or request.form.get("sourceLanguage")
    )
    # The page opts in to JSON-lines events; other callers get plain text.
    use_events = request.headers.get("Accept", "").strip().lower() == "application/x-ndjson"
    # Read now: the response is streamed after Flask has finished with this request.
    user = current_user()
    user_id = user["id"] if user else None

    def event(kind, **data):
        return json.dumps({"type": kind, **data}, ensure_ascii=True) + "\n"

    def fail(message):
        return event("error", message=message) if use_events else message

    def generate():
        # ---- input checks (nothing is recorded for these) ----------------
        if not text:
            yield fail("Please provide some source code.")
            return
        if len(text) > MAX_SOURCE_CHARS:
            yield fail("The source code is too large.")
            return
        if language is None:
            yield fail("Unrecognised target language. Please select from the dropdown.")
            return
        if source_language is None and request.form.get("source_language"):
            # source_language was supplied but not in the allowlist
            yield fail("Unrecognised source language.")
            return

        attempt = Attempt(user_id, source_language, language, text)   # row: 'pending'
        try:
            # ---- STEP 1: compiler gate  (AI is NOT called on failure) ----
            problem = check_source_code(text, source_language)
            if problem:
                attempt.fail("compiler", problem)
                yield fail(problem)
                return

            # ---- STEP 2: can source -> target be converted? --------------
            problem = check_convertible(source_language, language) if source_language else None
            if problem:
                attempt.fail("convertibility", problem)
                yield fail(problem)
                return

            # ---- STEP 3: translation API (only reached when 1 and 2 passed)
            chunks = []
            try:
                for piece in stream_translation(text, language):
                    chunks.append(piece)
                    yield event("chunk", text=piece) if use_events else piece
            except Exception:
                # Real error goes to the server log; the user gets a safe message.
                app.logger.exception("Gemini request failed")
                message = "Error: The translation service is currently unavailable. Please try again."
                attempt.fail("translation", message)
                yield fail(message)
                return

            translated = "".join(chunks)
            if not translated.strip() or translated.lstrip().lower().startswith("error:"):
                message = translated.strip() or "No code was returned. Please try again."
                attempt.fail("translation", message)      # the AI refused / returned nothing
                if use_events:
                    yield event("error", message=message)
                return

            attempt.complete(translated)                  # row: 'completed'
            if use_events:
                yield event(
                    "complete",
                    translation_id=attempt.row["id"] if attempt.stored else None,
                    user_id=user_id if attempt.stored else None,
                    is_saved=False,
                    created_at=attempt.row["created_at"] if attempt.stored else None,
                    repeat_count=attempt.row.get("repeat_count", 1) if attempt.stored else None,
                    persisted=attempt.stored,
                )
        finally:
            # Browser closed the stream / unexpected crash: don't leave the row 'pending'.
            attempt.fail("interrupted", "The translation was stopped before it finished.")

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
@limit("20 per minute")       # reduced from 120 — each request may compile + run user code
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
        result = _run_code(code, lang, stdin_text, eof)
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


# --------------------------------------------------------------------------
# Error handlers: database.py errors become clean JSON answers
# --------------------------------------------------------------------------
@app.errorhandler(db.DuplicateError)
def duplicate_error(error):
    return reply({"error": str(error), "field": error.field}, 409)


@app.errorhandler(db.ValidationError)
def validation_error(error):
    return reply({"error": str(error), "field": error.field}, 400)


@app.errorhandler(db.AuthError)
def auth_error(error):
    return reply({"error": str(error)}, 401)


@app.errorhandler(sqlite3.Error)
def database_failure(_error):
    app.logger.exception("Database error.")
    return reply({"error": "The database is unavailable right now. Please try again."}, 503)


@app.errorhandler(429)
def rate_limited(_error):
    return jsonify(error="Too many requests. Wait one minute and try again."), 429


if __name__ == "__main__":
    app.run(debug=False)