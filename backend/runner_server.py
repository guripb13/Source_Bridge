"""
runner_server.py - Isolated code execution microservice.

This service wraps compiler.py and exposes a single HTTP endpoint (/run).
It is intended to run ONLY inside the sandbox Docker container defined in
Dockerfile.runner, which has:

    --network none        (user code cannot open sockets or exfiltrate data)
    --read-only           (user code cannot write to the host filesystem)
    --cap-drop ALL        (all Linux capabilities dropped)
    --pids-limit 64       (limits total processes spawned by user code)
    --user sandbox        (non-root; Flask + user code run as the same user here)
    --security-opt no-new-privileges

No AI credentials are present in this container. If user code reads
/proc/self/environ or /proc/<pid>/environ, it finds no API keys.

The web container (Dockerfile / docker-compose.yml) calls this service over
the private Docker Compose network. No port of this service is exposed to the
host or the internet.
"""
import os
import sys

from flask import Flask, jsonify, request

# compiler.py must be in the same directory or on PYTHONPATH.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compiler

app = Flask(__name__)

# Hard limit on how long we wait for a compile + run cycle.
_TIMEOUT = compiler.COMPILE_TIMEOUT + compiler.RUN_TIMEOUT + 10

# Only accept requests from within the Docker network.
# The web container's internal address is the only caller; all other origins
# are rejected. Set RUNNER_ALLOWED_HOST to the web container's Docker hostname.
_ALLOWED_HOST = os.environ.get("RUNNER_ALLOWED_HOST", "")


@app.before_request
def _check_origin():
    """Block requests that do not come from the web container."""
    if not _ALLOWED_HOST:
        # In development with RUNNER_URL set locally, allow all.
        return
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    remote = forwarded_for.split(",")[0].strip() if forwarded_for else request.remote_addr
    if remote != _ALLOWED_HOST:
        return jsonify(error="Forbidden"), 403


@app.route("/health", methods=["GET"])
def health():
    return jsonify(ok=True)


@app.route("/run", methods=["POST"])
def run():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="JSON body required"), 400

    code = data.get("code", "")
    language = data.get("language", "")
    stdin_text = data.get("stdin_text", "")
    eof = bool(data.get("eof", False))

    if not isinstance(code, str) or not isinstance(language, str):
        return jsonify(error="code and language must be strings"), 400
    if not code.strip():
        return jsonify(error="code is empty"), 400
    if len(code) > compiler.MAX_CODE_CHARS:
        return jsonify(error="code too large"), 413

    lang = compiler.normalize_language(language)
    if lang is None:
        return jsonify(error=f"unsupported language: {language!r}"), 400

    try:
        result = compiler.submit_run(code, lang, stdin_text, eof).result(timeout=_TIMEOUT)
    except TimeoutError:
        return jsonify(error="runner timed out"), 504
    except Exception as exc:
        app.logger.exception("submit_run raised unexpectedly")
        return jsonify(error=f"internal runner error: {exc}"), 500

    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("RUNNER_PORT", 8001))
    # debug=False is mandatory — this service executes untrusted code and must
    # never expose an interactive debugger.
    app.run(host="127.0.0.1", port=port, debug=False)
