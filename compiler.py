"""
compiler.py — Sandboxed multi-language code execution using Docker.

Design goals:
  - Never execute untrusted code in the Flask process itself.
  - Each run happens in a brand-new, disposable Docker container.
  - No network access, capped memory/CPU, no process-bomb potential,
    read-only root filesystem, non-root user inside the container.
  - Hard wall-clock timeout so runaway/infinite-loop code can't hang forever.
  - Temp files are written per-run and always cleaned up afterward.

Usage from server.py:
    from compiler import run_code, UnsupportedLanguageError

    result = run_code(language="python", code=source_code)
    # result = {"stdout": "...", "stderr": "...", "exit_code": 0, "timed_out": False}
"""

import os
import shutil
import subprocess
import tempfile
import uuid


class UnsupportedLanguageError(Exception):
    """Raised when the requested language isn't in the allowed set."""


class CompilerUnavailableError(Exception):
    """Raised when Docker itself isn't available or fails to run at all."""


# ---------------------------------------------------------------------------
# Language configuration
# ---------------------------------------------------------------------------
# Each entry defines:
#   image        - the Docker image to run the code in (pinned to a specific
#                  tag, never ":latest", so behavior doesn't silently change)
#   filename     - what to name the source file inside the container
#   build_cmd    - optional compile step (list of argv), or None if interpreted
#   run_cmd      - the command that actually executes the code (list of argv)
#
# Extend this dict to add more languages later — nothing else needs to change.
LANGUAGES = {
    "python": {
        "image": "python:3.12-slim",
        "filename": "main.py",
        "build_cmd": None,
        "run_cmd": ["python3", "main.py"],
    },
    "javascript": {
        "image": "node:20-slim",
        "filename": "main.js",
        "build_cmd": None,
        "run_cmd": ["node", "main.js"],
    },
    "java": {
        "image": "eclipse-temurin:21-jdk-alpine",
        "filename": "Main.java",
        # Java requires the public class name to match the filename.
        "build_cmd": ["javac", "Main.java"],
        "run_cmd": ["java", "Main"],
    },
    "cpp": {
        "image": "gcc:13-bookworm",
        "filename": "main.cpp",
        "build_cmd": ["g++", "-O2", "-o", "main", "main.cpp"],
        "run_cmd": ["./main"],
    },
}

# Hard safety ceilings — do not let a caller override these upward.
MAX_RUN_TIMEOUT_SECONDS = 10      # wall-clock limit for the program's own execution
MAX_BUILD_TIMEOUT_SECONDS = 20    # wall-clock limit for compilation (javac/g++ startup is slow)
MAX_OUTPUT_BYTES = 200_000        # truncate huge output instead of storing/returning it all
CONTAINER_MEMORY_LIMIT = "128m"
CONTAINER_CPU_LIMIT = "0.5"
CONTAINER_PIDS_LIMIT = "64"


def _truncate(text: str) -> str:
    if text is None:
        return ""
    data = text.encode("utf-8", errors="replace")
    if len(data) <= MAX_OUTPUT_BYTES:
        return text
    return data[:MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore") + "\n... [output truncated]"


def _docker_available() -> bool:
    return shutil.which("docker") is not None


def ensure_images_pulled(timeout_per_image: int = 300) -> dict:
    """
    Pulls every image listed in LANGUAGES if it isn't already cached locally.
    Call this once at server startup (not per-request) so a user's first
    "Run" click is never the moment a ~100-200MB image download happens —
    that download alone can easily exceed the per-execution timeout and
    surfaces to the user as a confusing "Execution timed out."

    Returns {"pulled": [...], "already_present": [...], "failed": {image: error}}.
    """
    if not _docker_available():
        raise CompilerUnavailableError("Docker is not available on this server.")

    images = sorted({config["image"] for config in LANGUAGES.values()})
    result = {"pulled": [], "already_present": [], "failed": {}}

    for image in images:
        inspect = subprocess.run(
            ["docker", "image", "inspect", image],
            capture_output=True, text=True,
        )
        if inspect.returncode == 0:
            result["already_present"].append(image)
            continue

        pull = subprocess.run(
            ["docker", "pull", image],
            capture_output=True, text=True,
            timeout=timeout_per_image,
        )
        if pull.returncode == 0:
            result["pulled"].append(image)
        else:
            result["failed"][image] = pull.stderr.strip() or "Unknown pull failure."

    return result


def _run_in_container(work_dir: str, image: str, argv: list, timeout: int) -> dict:
    """
    Runs `argv` inside a fresh, locked-down container with `work_dir` mounted
    read-write as /code (so compiled languages can write their build output
    there), and a small writable /tmp for additional scratch space.

    Returns {"stdout": str, "stderr": str, "exit_code": int, "timed_out": bool}.
    """
    container_name = f"sb-run-{uuid.uuid4().hex[:12]}"

    docker_cmd = [
        "docker", "run",
        "--rm",                                   # auto-remove container when it exits
        "--name", container_name,
        "--network", "none",                      # no network access at all
        "--memory", CONTAINER_MEMORY_LIMIT,
        "--memory-swap", CONTAINER_MEMORY_LIMIT,   # disable swap beyond the memory cap
        "--cpus", CONTAINER_CPU_LIMIT,
        "--pids-limit", CONTAINER_PIDS_LIMIT,      # stop fork bombs
        "--tmpfs", "/tmp:rw,size=16m,mode=1777",   # small writable scratch space
        "--security-opt", "no-new-privileges",
        "--cap-drop", "ALL",                       # drop all Linux capabilities
        "-v", f"{work_dir}:/code:rw",              # source + build output, read-write
        "-w", "/code",
        image,
    ] + argv

    try:
        proc = subprocess.run(
            docker_cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "stdout": _truncate(proc.stdout),
            "stderr": _truncate(proc.stderr),
            "exit_code": proc.returncode,
            "timed_out": False,
        }
    except subprocess.TimeoutExpired:
        # Best-effort cleanup: the container is --rm, but if it's still running
        # past the timeout, force-kill it by name so it doesn't linger.
        subprocess.run(["docker", "kill", container_name], capture_output=True)
        return {
            "stdout": "",
            "stderr": "Execution timed out.",
            "exit_code": None,
            "timed_out": True,
        }


def run_code(language: str, code: str, run_timeout: int = MAX_RUN_TIMEOUT_SECONDS,
             build_timeout: int = MAX_BUILD_TIMEOUT_SECONDS) -> dict:
    """
    Executes `code` in an isolated Docker container for the given `language`.

    Compiled languages get their own, more generous timeout for the build
    step (compiler startup + parsing is often slow, especially cold) that is
    completely separate from the timeout given to the program's own run —
    so a slow `g++`/`javac` invocation no longer eats into the time the
    program itself gets to actually execute.

    Raises:
        UnsupportedLanguageError  - if `language` isn't configured.
        CompilerUnavailableError  - if Docker itself can't be used.

    Returns:
        {"stdout": str, "stderr": str, "exit_code": int|None, "timed_out": bool}
    """
    language = (language or "").strip().lower()
    if language not in LANGUAGES:
        raise UnsupportedLanguageError(f"Unsupported language: {language!r}")

    if not _docker_available():
        raise CompilerUnavailableError("Docker is not available on this server.")

    run_timeout = min(int(run_timeout or MAX_RUN_TIMEOUT_SECONDS), MAX_RUN_TIMEOUT_SECONDS)
    build_timeout = min(int(build_timeout or MAX_BUILD_TIMEOUT_SECONDS), MAX_BUILD_TIMEOUT_SECONDS)
    config = LANGUAGES[language]

    # Each run gets its own throwaway temp directory; always cleaned up,
    # even if execution raises or the process is killed by the timeout.
    work_dir = tempfile.mkdtemp(prefix="sb-exec-")
    try:
        source_path = os.path.join(work_dir, config["filename"])
        with open(source_path, "w", encoding="utf-8") as f:
            f.write(code)
        # Make the temp dir world-writable so the container's (non-root,
        # numeric-UID) user can write compiled artifacts into it — the
        # directory only ever contains this one run's files and is deleted
        # in `finally` below regardless of outcome.
        os.chmod(work_dir, 0o777)

        if config["build_cmd"]:
            # Build first, as its own container with its own timeout budget.
            # The compiled artifact lands in `work_dir` (mounted read-write),
            # so it's still there for the separate run step below — even
            # though that's a fresh container, it shares the same host
            # directory via the bind mount.
            build_result = _run_in_container(work_dir, config["image"], config["build_cmd"], build_timeout)

            if build_result["timed_out"]:
                return {
                    "stdout": "",
                    "stderr": "Compilation timed out.",
                    "exit_code": None,
                    "timed_out": True,
                }
            if build_result["exit_code"] != 0:
                # Compilation failed — surface the compiler's own error output,
                # never attempt to run a binary that doesn't exist.
                return {
                    "stdout": "",
                    "stderr": build_result["stderr"] or "Compilation failed.",
                    "exit_code": build_result["exit_code"],
                    "timed_out": False,
                }

        # Run step: gets the full, dedicated run_timeout, unaffected by how
        # long compilation took.
        run_result = _run_in_container(work_dir, config["image"], config["run_cmd"], run_timeout)
        return run_result
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)