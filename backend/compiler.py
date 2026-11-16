"""
compiler.py - universal compiler / runner for C, C++, Python and Java.

Two entry points, both standalone (no Flask, no database):

  run_code(code, language, stdin_text, eof)
                                REALLY compiles (C, C++, Java) and then RUNS the
                                program, returning its stdout / stderr / exit
                                code.  Used by the Run button (/execute).

                                STATELESS INPUT MODEL: nothing is ever kept waiting.
                                The program is started from scratch with ALL the input
                                the user has typed so far. The moment it asks for MORE
                                input than that, the program stops itself and the
                                result is status "needs_input" together with WHICH
                                variable / line asked (see "input_request"). The page
                                labels the user's answer and calls run_code again with
                                the answers added. No process, thread or session
                                survives between two calls.

  compile_code(code, language)  Check-only (syntax / type check, nothing is run).
                                Used by /send to quickly validate translations.

NOTE ON SAFETY: run_code executes user-supplied code on the server.  It uses a
throw-away temp directory, a stripped environment, a wall-clock timeout, CPU /
memory / file-size limits (Linux & macOS) and output caps - but this is NOT a
full sandbox.  For a public deployment run the whole app inside Docker (or
another container) with no network and a non-root user.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import json
import atexit
import threading
from concurrent.futures import ThreadPoolExecutor

try:                                   # not available on Windows
    import resource
except ImportError:
    resource = None

COMPILE_TIMEOUT = 15          # seconds allowed for compiling
RUN_TIMEOUT = 10              # seconds allowed for the program to run
MAX_ERROR_CHARS = 4000        # compiler messages shown in the UI
MAX_OUTPUT_CHARS = 20_000     # program output shown in the UI
MAX_CODE_CHARS = 200_000      # refuse absurdly large input
MAX_OUTPUT_BYTES = 1_000_000  # hard cap on bytes the program may write
MEMORY_LIMIT_BYTES = 512 * 1024 * 1024

_ALIASES = {
    "python": "python", "py": "python", "python3": "python",
    "c": "c",
    "c++": "cpp", "cpp": "cpp", "cxx": "cpp",
    "java": "java",
}

_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="compiler")
_run_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="runner")

_IS_WINDOWS = os.name == "nt"
_EXE = ".exe" if _IS_WINDOWS else ""


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def normalize_language(name):
    return _ALIASES.get((name or "").strip().lower())


def strip_fences(code):
    """Remove ```lang fences in case the AI wrapped its output in markdown."""
    m = re.fullmatch(r"\s*```[\w+#-]*\n(.*?)\n?```\s*", code, re.S)
    return m.group(1) if m else code


def detect_language(code):
    """Cheap heuristic guess; returns 'python', 'c', 'cpp', 'java' or None."""
    score = {"python": 0, "c": 0, "cpp": 0, "java": 0}
    rules = [
        ("java",   r"\bpublic\s+static\s+void\s+main\b", 3),
        ("java",   r"\bSystem\.out\.print", 3),
        ("java",   r"^\s*import\s+java\.", 3),
        ("java",   r"\bpublic\s+(final\s+|abstract\s+)?class\b", 1),
        ("cpp",    r"^\s*#\s*include\s*<(iostream|vector|string|map|set|algorithm|memory|cmath|sstream|fstream)>", 3),
        ("cpp",    r"\bstd::", 2),
        ("cpp",    r"\bcout\s*<<|\bcin\s*>>", 2),
        ("cpp",    r"\busing\s+namespace\b", 2),
        ("cpp",    r"\b(class|template)\b[^;{]*[{<]", 1),
        ("c",      r"^\s*#\s*include\s*<(stdio|stdlib|string|math|stdint|stdbool|ctype|time)\.h>", 3),
        ("c",      r"\bprintf\s*\(|\bscanf\s*\(", 1),
        ("c",      r"\bint\s+main\s*\(", 1),
        ("python", r"^\s*def\s+\w+", 2),
        ("python", r"^\s*(import\s+\w+|from\s+\w+.*\simport\s)", 1),
        ("python", r"^\s*(if|elif|else|for|while|class|try|except)\b.*:\s*$", 2),
        ("python", r"\bprint\s*\(", 1),
        ("python", r"__name__\s*==", 3),
    ]
    for lang, pattern, weight in rules:
        if re.search(pattern, code, re.M):
            score[lang] += weight
    best = max(score, key=score.get)
    return best if score[best] > 0 else None


def _result(language, status, errors="", compiler=None, started=None, **extra):
    out = {
        "language": language,
        "status": status,   # success | error | timeout | unavailable | skipped
        "ok": status == "success",
        "errors": errors[:MAX_ERROR_CHARS],
        "compiler": compiler,
        "duration_ms": int((time.perf_counter() - started) * 1000) if started else 0,
    }
    out.update(extra)
    return out


def _clean_env(workdir):
    env = {"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8",
           "HOME": workdir, "TMPDIR": workdir, "PYTHONIOENCODING": "utf-8",
           "PYTHONDONTWRITEBYTECODE": "1"}
    for key in ("SYSTEMROOT", "SystemDrive", "COMSPEC", "PATHEXT", "JAVA_HOME"):
        if key in os.environ:
            env[key] = os.environ[key]
    if _IS_WINDOWS:
        env["TEMP"] = env["TMP"] = workdir
    return env


def _limits(cpu_seconds, limit_memory=True):
    """Returns a preexec_fn applying resource limits (POSIX only)."""
    if resource is None or _IS_WINDOWS:
        return None

    def apply():
        os.setsid()
        try:
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
            resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES * 2, MAX_OUTPUT_BYTES * 2))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            if limit_memory:
                resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
        except (ValueError, OSError):
            pass
    return apply


def _kill_tree(proc):
    try:
        if _IS_WINDOWS:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                           capture_output=True, timeout=5)
        else:
            import signal
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _exec(cmd, cwd, timeout, limit_memory=True, stdin_text=None):
    """
    Run `cmd`, with stdout/stderr redirected to files (so a runaway program
    can't eat server memory).  Returns (state, returncode, stdout, stderr)
    where state is 'ok' | 'timeout' | 'missing'.
    """
    out_path = os.path.join(cwd, ".sb_stdout")
    err_path = os.path.join(cwd, ".sb_stderr")
    state, code = "ok", None
    with open(out_path, "wb") as fo, open(err_path, "wb") as fe:
        try:
            proc = subprocess.Popen(
                cmd, cwd=cwd, env=_clean_env(cwd),
                stdin=subprocess.PIPE, stdout=fo, stderr=fe,
                preexec_fn=_limits(int(timeout) + 2, limit_memory),
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if _IS_WINDOWS else 0,
            )
        except FileNotFoundError:
            return "missing", None, "", f"Executable not found: {cmd[0]}"
        try:
            proc.communicate(input=(stdin_text or "").encode("utf-8"), timeout=timeout)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                proc.communicate(timeout=3)
            except Exception:
                pass
            state = "timeout"

    def read(path):
        with open(path, "rb") as f:
            data = f.read(MAX_OUTPUT_CHARS * 4 + 1)
        text = data.decode("utf-8", errors="replace")
        if len(text) > MAX_OUTPUT_CHARS:
            text = text[:MAX_OUTPUT_CHARS] + "\n... [output truncated]"
        return text

    return state, code, read(out_path), read(err_path)


# --------------------------------------------------------------------------
# "Which input is the program asking for?"  (stateless input model)
#
# Every language runs with stdin = a pipe that holds ALL the answers typed so
# far and is then CLOSED.  Inside the program a tiny hook notices the moment a
# read hits that end ("the program wants MORE input than we have"), writes the
# source line that asked into the file  .sb_need  and ends the process at once.
# So nothing ever waits for a human: the process is already gone when the
# result goes back to the browser.  The hook knows the exact line, so the
# variable name is read from that line:
#   Python  hook in sb_runner.py (builtins.input + sys.stdin), name from `ast`
#   C       macros for scanf / fgets / getchar ... + feof(stdin) check
#   C++     std::cin gets a wrapper streambuf, `cin` macro records __LINE__
#   Java    System.in is replaced by SBLauncher.SBIn, line from the stack trace
# --------------------------------------------------------------------------
NEED_FILE = ".sb_need"

_C_COMMON = r'''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif
#define SB_UNUSED_ __attribute__((unused))
static int sb_eof_ok_ SB_UNUSED_ = 0;
static int sb_line_ SB_UNUSED_ = 0;
static void sb_need_(int line) SB_UNUSED_;
static void sb_need_(int line) {
    FILE *f = fopen(".sb_need", "w");
    if (f) { fprintf(f, "{\"line\": %d}", line); fclose(f); }
    fflush(NULL);
    _exit(3);
}
static void sb_check_(int line) SB_UNUSED_;
static void sb_check_(int line) { if (!sb_eof_ok_ && feof(stdin)) sb_need_(line); }
static void sb_atexit_(void) { if (!sb_eof_ok_ && feof(stdin)) sb_need_(sb_line_); }
'''

_C_PREFIX = _C_COMMON + r'''
__attribute__((constructor)) static void sb_init_(void) {
    const char *e = getenv("SB_EOF");
    sb_eof_ok_ = (e && e[0] == '1');
    setvbuf(stdout, NULL, _IONBF, 0);
    atexit(sb_atexit_);
}
#undef getchar
#undef getc
#undef fgetc
#define scanf(...)   ({ int sb_r_ = scanf(__VA_ARGS__);   sb_check_(__LINE__); sb_r_; })
#define fscanf(...)  ({ int sb_r_ = fscanf(__VA_ARGS__);  sb_check_(__LINE__); sb_r_; })
#define getchar()    ({ int sb_r_ = getchar();            sb_check_(__LINE__); sb_r_; })
#define getc(...)    ({ int sb_r_ = getc(__VA_ARGS__);    sb_check_(__LINE__); sb_r_; })
#define fgetc(...)   ({ int sb_r_ = fgetc(__VA_ARGS__);   sb_check_(__LINE__); sb_r_; })
#define fgets(...)   ({ char *sb_r_ = fgets(__VA_ARGS__); sb_check_(__LINE__); sb_r_; })
#line 1 "main.c"
'''

_CPP_PREFIX = r'''
#include <iostream>
#include <streambuf>
#include <cstdio>
''' + _C_COMMON + r'''
struct SBBuf_ : public std::streambuf {
    std::streambuf *in_;
    explicit SBBuf_(std::streambuf *in) : in_(in) {}
protected:
    int_type underflow() override {
        int_type c = in_->sgetc();
        if (traits_type::eq_int_type(c, traits_type::eof()) && !sb_eof_ok_) sb_need_(sb_line_);
        return c;
    }
    int_type uflow() override {
        int_type c = in_->sbumpc();
        if (traits_type::eq_int_type(c, traits_type::eof()) && !sb_eof_ok_) sb_need_(sb_line_);
        return c;
    }
};
__attribute__((constructor)) static void sb_init_(void) {
    const char *e = getenv("SB_EOF");
    sb_eof_ok_ = (e && e[0] == '1');
    setvbuf(stdout, NULL, _IONBF, 0);
    std::cin.rdbuf(new SBBuf_(std::cin.rdbuf()));
    atexit(sb_atexit_);
}
struct SBCin_ {
    std::istream &at(int line) const { sb_line_ = line; return std::cin; }
};
static SBCin_ sb_cin_ SB_UNUSED_;
namespace std { using ::sb_cin_; }
#undef getchar
#undef getc
#undef fgetc
#define cin sb_cin_.at(__LINE__)
#define sync_with_stdio(...) sync_with_stdio(true)
#define scanf(...)   ({ int sb_r_ = scanf(__VA_ARGS__);   sb_check_(__LINE__); sb_r_; })
#define fscanf(...)  ({ int sb_r_ = fscanf(__VA_ARGS__);  sb_check_(__LINE__); sb_r_; })
#define getchar()    ({ int sb_r_ = getchar();            sb_check_(__LINE__); sb_r_; })
#define fgets(...)   ({ char *sb_r_ = fgets(__VA_ARGS__); sb_check_(__LINE__); sb_r_; })
#line 1 "main.cpp"
'''


def _instrument(lang, code):
    """Wrap user code with the input hooks. Line numbers stay the user's (#line 1)."""
    if lang == "c":
        return _C_PREFIX + code
    if lang == "cpp":
        # `using std::cin;` cannot be combined with the cin macro -> drop it
        # (the macro is visible everywhere anyway). Keeps the same line count.
        code = re.sub(r"\busing\s+std\s*::\s*cin\s*;", ";", code)
        return _CPP_PREFIX + code
    return code


_PY_RUNNER = r'''# sb_runner.py - runs main.py and stops itself when it needs MORE input than supplied.
import ast, builtins, json, os, sys, traceback

_FILE = "main.py"
_EOF_OK = os.environ.get("SB_EOF") == "1"


def _target_for(tree, line):
    """Name(s) the value read on `line` is assigned to: 'a', 'a, b', 'arr[i]' ..."""
    best, best_span = None, None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            tgts, val = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            tgts, val = [node.target], node.value
        elif isinstance(node, ast.AugAssign):
            tgts, val = [node.target], node.value
        elif isinstance(node, ast.NamedExpr):
            tgts, val = [node.target], node.value
        elif isinstance(node, (ast.For, ast.AsyncFor)) and "stdin" in ast.unparse(node.iter):
            tgts, val = [node.target], node.iter
        else:
            continue
        lo = val.lineno
        hi = getattr(val, "end_lineno", lo) or lo
        if lo <= line <= hi and (best is None or hi - lo < best_span):
            best, best_span = tgts, hi - lo
    if not best:
        return None
    names = []
    for t in best:
        s = ast.unparse(t)
        if isinstance(t, ast.Tuple) and s.startswith("(") and s.endswith(")"):
            s = s[1:-1]
        names.append(s)
    return ", ".join(names)


def _need():
    lines, f = [], sys._getframe(1)
    while f is not None:                       # innermost user frame first
        if f.f_code.co_filename == _FILE:
            lines.append(f.f_lineno)
        f = f.f_back
    var = None
    try:
        with open(_FILE, encoding="utf-8") as fh:
            tree = ast.parse(fh.read())
        for ln in lines:                       # e.g. helper get() -> caller's `a = get()`
            var = _target_for(tree, ln)
            if var:
                break
    except Exception:
        var = None
    try:
        with open(".sb_need", "w", encoding="utf-8") as fh:
            json.dump({"line": lines[0] if lines else 0, "var": var}, fh)
    except OSError:
        pass
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(3)


class _Guard:
    """Wraps stdin: running out of supplied input = the program wants more."""
    def __init__(self, stream, text=True):
        self._s, self._text = stream, text

    def readline(self, *a):
        v = self._s.readline(*a)
        if len(v) == 0 and not _EOF_OK:
            _need()
        return v

    def read(self, n=-1):
        if n is None or n < 0:
            if not _EOF_OK:
                _need()
            return self._s.read()
        v = self._s.read(n)
        if len(v) < n and not _EOF_OK:
            _need()
        return v

    def readlines(self, *a):
        if not _EOF_OK:
            _need()
        return self._s.readlines(*a)

    def __iter__(self):
        return self

    def __next__(self):
        v = self._s.readline()
        if len(v) == 0:
            if not _EOF_OK:
                _need()
            raise StopIteration
        return v

    @property
    def buffer(self):
        return _Guard(self._s.buffer, False)

    def __getattr__(self, name):
        return getattr(self._s, name)


_real_stdin = sys.stdin
sys.stdin = _Guard(_real_stdin)


def _input(prompt=""):
    if prompt is not None and str(prompt) != "":
        sys.stdout.write(str(prompt))
    sys.stdout.flush()
    line = _real_stdin.readline()
    if line == "":
        if _EOF_OK:
            raise EOFError("EOF when reading a line")
        _need()
    if line.endswith("\n"):
        line = line[:-1]
    if line.endswith("\r"):
        line = line[:-1]
    return line


builtins.input = _input

with open(_FILE, encoding="utf-8") as _fh:
    _code = compile(_fh.read(), _FILE, "exec")
sys.argv = [_FILE]
try:
    exec(_code, {"__name__": "__main__", "__file__": _FILE, "__builtins__": builtins})
except SystemExit:
    raise
except BaseException:
    _t, _v, _tb = sys.exc_info()
    traceback.print_exception(_t, _v, _tb.tb_next)   # hide this runner's own frame
    sys.exit(1)
'''

_JAVA_LAUNCHER = r'''import java.io.*;
import java.lang.reflect.*;
import java.util.*;

public class SBLauncher {
    static boolean eofOk;
    static String userFile = "";

    static void need() {
        int line = 0;
        for (StackTraceElement e : new Throwable().getStackTrace()) {
            if (userFile.equals(e.getFileName())) { line = e.getLineNumber(); break; }
        }
        try (FileWriter w = new FileWriter(".sb_need")) { w.write("{\"line\": " + line + "}"); }
        catch (IOException ex) { /* ignore */ }
        System.out.flush();
        System.err.flush();
        Runtime.getRuntime().halt(3);
    }

    /** System.in replacement: running out of supplied input = the program wants more. */
    static class SBIn extends InputStream {
        private final InputStream in;
        SBIn(InputStream in) { this.in = in; }
        @Override public int read() throws IOException {
            int c = in.read();
            if (c < 0 && !eofOk) need();
            return c;
        }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (len == 0) return 0;
            int n = in.read(b, off, len);
            if (n < 0 && !eofOk) need();
            return n;
        }
        @Override public int available() throws IOException { return in.available(); }
    }

    public static void main(String[] args) throws Exception {
        String mainClass = args[0];
        userFile = args.length > 1 ? args[1] : "";
        eofOk = "1".equals(System.getenv("SB_EOF"));
        System.setIn(new SBIn(System.in));
        Method m;
        try {
            m = Class.forName(mainClass).getDeclaredMethod("main", String[].class);
            m.setAccessible(true);
        } catch (ReflectiveOperationException e) {
            System.err.println("error: could not find 'public static void main(String[] args)' in " + mainClass);
            System.exit(1);
            return;
        }
        try {
            m.invoke(null, (Object) new String[0]);
        } catch (InvocationTargetException e) {
            Throwable t = e.getCause();
            List<StackTraceElement> keep = new ArrayList<>();
            for (StackTraceElement el : t.getStackTrace()) {
                String c = el.getClassName();
                if (c.startsWith("SBLauncher") || c.startsWith("jdk.internal.reflect")
                        || c.startsWith("java.lang.reflect")) break;
                keep.add(el);
            }
            t.setStackTrace(keep.toArray(new StackTraceElement[0]));
            System.err.print("Exception in thread \"main\" ");
            t.printStackTrace();
            System.exit(1);
        }
    }
}
'''


def _read_need(cwd):
    """The hook's note ('.sb_need'), or None if the program never asked for more input."""
    path = os.path.join(cwd, NEED_FILE)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = json.loads(f.read(2000) or "{}")
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _exec_run(cmd, cwd, timeout, limit_memory=True, stdin_text="", eof=False):
    """
    Run the compiled program ONCE, from the start, with all known input.

    stdin gets `stdin_text` and is then closed. If the program asks for more than
    that, its own hook ends it and leaves .sb_need behind (see above). Nothing is
    ever left running or waiting. Returns (state, returncode, stdout, stderr, need)
    with state 'ok' | 'timeout' | 'missing' | 'needs_input'.
    """
    out_path = os.path.join(cwd, ".sb_stdout")
    err_path = os.path.join(cwd, ".sb_stderr")
    env = _clean_env(cwd)
    env["SB_EOF"] = "1" if eof else "0"
    state, code = "ok", None
    with open(out_path, "wb") as fo, open(err_path, "wb") as fe:
        try:
            proc = subprocess.Popen(
                cmd, cwd=cwd, env=env,
                stdin=subprocess.PIPE, stdout=fo, stderr=fe,
                preexec_fn=_limits(int(timeout) + 2, limit_memory),
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if _IS_WINDOWS else 0,
            )
        except FileNotFoundError:
            return "missing", None, "", f"Executable not found: {cmd[0]}", None
        try:
            proc.communicate(input=(stdin_text or "").encode("utf-8"), timeout=timeout)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            try:
                proc.communicate(timeout=3)
            except Exception:
                pass
            state = "timeout"

    def read(path):
        with open(path, "rb") as f:
            data = f.read(MAX_OUTPUT_CHARS * 4 + 1)
        text = data.decode("utf-8", errors="replace")
        if len(text) > MAX_OUTPUT_CHARS:
            text = text[:MAX_OUTPUT_CHARS] + "\n... [output truncated]"
        return text

    need = _read_need(cwd) if state == "ok" else None
    if need is not None:
        state = "needs_input"
    return state, code, read(out_path), read(err_path), need


# --------------------------------------------------------------------------
# Naming the variable that is being asked for
# --------------------------------------------------------------------------
_KEY_JAVA = (r"nextInt|nextLine|nextDouble|nextLong|nextFloat|nextBoolean|nextShort|nextByte|"
             r"nextBigInteger|nextBigDecimal|next|readLine|readInt|readDouble|read|"
             r"parseInt|parseDouble|parseLong|nextToken")
_KEY_ANY = re.compile(r"\b(scanf|fscanf|fgets|gets|getchar|getc|fgetc|getline|cin|" + _KEY_JAVA + r")\b")
_JAVA_ASSIGN = re.compile(
    r"([A-Za-z_]\w*(?:\[[^\]]*\])*)\s*[-+*/%]?=\s*[^;,=]*?\b(?:" + _KEY_JAVA + r")\b")


def _split_args(text):
    """Split 'a, &b, f(x, y)' at top-level commas."""
    args, depth, cur = [], 0, ""
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            args.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        args.append(cur.strip())
    return args


def _call_args(stmt, func):
    """Arguments of the first `func( ... )` call in `stmt`, or None."""
    m = re.search(r"\b" + func + r"\s*\(", stmt)
    if not m:
        return None
    depth, i, start = 1, m.end(), m.end()
    while i < len(stmt) and depth:
        depth += {"(": 1, ")": -1}.get(stmt[i], 0)
        i += 1
    return _split_args(stmt[start:i - 1])


def _clean_name(arg):
    arg = re.sub(r"^\(\s*[\w\s\*]+\)\s*", "", arg.strip())      # (int*) cast
    return arg.lstrip("&*").strip()


def _statement_at(code, line):
    """Source text of the input statement that starts on (or just above) `line`."""
    lines = [re.sub(r"//.*", "", ln) for ln in code.split("\n")]
    i = min(max(line - 1, 0), len(lines) - 1)
    start = i
    for k in range(i, max(i - 5, -1), -1):          # C __LINE__ can be the last line of a call
        if _KEY_ANY.search(lines[k]):
            start = k
            break
    text = " ".join(lines[start:start + 6])
    m = _KEY_ANY.search(text)
    if not m:
        return text
    end = text.find(";", m.end())
    return text[:end if end != -1 else len(text)]


def _guess_vars(lang, code, line):
    """Best-effort variable name(s) for C / C++ / Java from the exact source line."""
    if not line or not code:
        return None
    stmt = _statement_at(code, line)
    names = []
    if lang == "java":
        names = [m.group(1) for m in _JAVA_ASSIGN.finditer(stmt)]
    else:
        args = _call_args(stmt, "scanf")
        if args is not None:
            names = [_clean_name(a) for a in args[1:]]
        if not names:
            args = _call_args(stmt, "fscanf")
            if args is not None:
                names = [_clean_name(a) for a in args[2:]]
        if not names:
            for fn in ("fgets", "gets", "getline"):
                args = _call_args(stmt, fn)
                if args:
                    if fn == "getline" and re.match(r"\s*(?:std::)?cin\b", args[0]):
                        names = [_clean_name(args[1])] if len(args) > 1 else []
                    else:
                        names = [_clean_name(args[0])]
                    break
        if not names:
            m = re.search(r"\bcin\b", stmt)
            if m:
                rest = stmt[m.start():]
                names = re.findall(r">>\s*([A-Za-z_][\w\.]*(?:->\w+)*(?:\[[^\]]*\])*)", rest)
                if not names:
                    g = re.search(r"\bcin\s*\.\s*(?:get|getline)\s*\(\s*([^,)]+)", rest)
                    names = [g.group(1).strip()] if g else []
        if not names:
            m = re.search(r"([A-Za-z_][\w\.\->]*(?:\[[^\]]*\])*)\s*=\s*(?:\([^)]*\)\s*)?"
                          r"(?:getchar|getc|fgetc)\s*\(", stmt)
            if m:
                names = [m.group(1)]
    names = [n for n in names if n]
    return ", ".join(dict.fromkeys(names)) or None


def _last_prompt(stdout):
    """What the program printed just before asking: the unfinished last line, else the last line."""
    tail = stdout.rsplit("\n", 1)[-1].strip()
    if not tail:
        lines = [ln.strip() for ln in stdout.split("\n") if ln.strip()]
        tail = lines[-1] if lines else ""
    return tail[-120:]


def _utf16_len(text):
    """Length in JavaScript string units, so the page can place text exactly."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _describe_need(lang, code, need, stdout, index):
    try:
        line = int(need.get("line") or 0)
    except (TypeError, ValueError):
        line = 0
    var = need.get("var") if isinstance(need.get("var"), str) and need.get("var") else None
    if not var and lang in ("c", "cpp", "java"):
        var = _guess_vars(lang, code, line)
    prompt = _last_prompt(stdout)
    return {
        "index": index,                      # how many answers were already supplied
        "line": line,                        # source line that asked (0 = unknown)
        "var": var,                          # e.g. "a, b"  (None if it cannot be named)
        "prompt": prompt,                    # e.g. "Enter a: "
        "label": var or prompt or f"input {index + 1}",
    }


def _find(*names):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def _scrub(text, workdir):
    return text.replace(workdir + os.sep, "").replace(workdir, "")


def _java_names(code):
    """(file_name_stem, main_class_name) for a Java source."""
    pub = re.search(r"\bpublic\s+(?:(?:final|abstract|sealed|non-sealed|strictfp)\s+)*"
                    r"(?:class|interface|enum|record)\s+(\w+)", code)
    file_stem = pub.group(1) if pub else "Main"
    main_class = None
    m = re.search(r"\bstatic\s+void\s+main\s*\(", code)
    if m:
        before = list(re.finditer(r"\b(?:class|enum|record|interface)\s+(\w+)", code[:m.start()]))
        if before:
            main_class = before[-1].group(1)
    if main_class is None:
        main_class = file_stem
    pkg = re.search(r"^\s*package\s+([\w.]+)\s*;", code, re.M)
    if pkg:
        main_class = pkg.group(1) + "." + main_class
    return file_stem, main_class


# --------------------------------------------------------------------------
# Build step (real compilation) per language
# --------------------------------------------------------------------------
def _build(lang, code, workdir, instrument=False):
    """
    Compile `code` inside `workdir`.
    Returns (status, messages, tool, run_cmd, limit_memory)
      status   success | error | timeout | unavailable
      run_cmd  argv list to execute the result (None if nothing to run)
    instrument=True adds the "stop when more input is needed" hooks (run path only).
    """
    if lang == "python":
        with open(os.path.join(workdir, "main.py"), "w", encoding="utf-8") as f:
            f.write(code)
        try:
            compile(code, "main.py", "exec")
        except SyntaxError as e:
            where = f"line {e.lineno}" + (f", col {e.offset}" if e.offset else "")
            text = (e.text or "").rstrip()
            msg = f"{where}: SyntaxError: {e.msg}" + (f"\n    {text}" if text else "")
            return "error", msg, "python", None, True
        except (ValueError, MemoryError, RecursionError) as e:
            return "error", str(e), "python", None, True
        with open(os.path.join(workdir, "sb_runner.py"), "w", encoding="utf-8") as f:
            f.write(_PY_RUNNER)
        return "success", "", "python", [sys.executable, "-u", "-B", "sb_runner.py"], True

    if lang in ("c", "cpp"):
        if lang == "c":
            exe = _find("gcc", "clang", "cc")
            label = "No C compiler (gcc/clang) found on the server."
            fname, std = "main.c", ["-std=gnu11"]
        else:
            exe = _find("g++", "clang++")
            label = "No C++ compiler (g++/clang++) found on the server."
            fname, std = "main.cpp", ["-std=c++17"]
        if not exe:
            return "unavailable", label, None, None, True
        with open(os.path.join(workdir, fname), "w", encoding="utf-8") as f:
            f.write(_instrument(lang, code) if instrument else code)
        out_name = "program" + _EXE
        cmd = [exe, *std, "-O1", "-Wall", "-o", out_name, fname]
        if not _IS_WINDOWS:
            cmd.append("-lm")
        state, rc, so, se = _exec(cmd, workdir, COMPILE_TIMEOUT)
        msgs = _scrub((se or so).strip(), workdir)
        tool = os.path.basename(exe)
        if state == "timeout":
            return "timeout", f"Compilation exceeded {COMPILE_TIMEOUT}s.", tool, None, True
        if state == "missing":
            return "unavailable", msgs, tool, None, True
        if rc != 0:
            return "error", msgs, tool, None, True
        return "success", msgs, tool, [os.path.join(workdir, out_name)], True

    if lang == "java":
        javac, java = _find("javac"), _find("java")
        if not javac or not java:
            return ("unavailable",
                    "Java JDK not found on the server (need both `javac` and `java` on PATH).",
                    None, None, False)
        stem, main_class = _java_names(code)
        files = [f"{stem}.java"]
        with open(os.path.join(workdir, files[0]), "w", encoding="utf-8") as f:
            f.write(code)
        if instrument:
            with open(os.path.join(workdir, "SBLauncher.java"), "w", encoding="utf-8") as f:
                f.write(_JAVA_LAUNCHER)
            files.append("SBLauncher.java")
        state, rc, so, se = _exec([javac, "-proc:none", "-encoding", "UTF-8", "-d", workdir, *files],
                                  workdir, COMPILE_TIMEOUT, limit_memory=False)
        msgs = _scrub((se or so).strip(), workdir)
        if state == "timeout":
            return "timeout", f"Compilation exceeded {COMPILE_TIMEOUT}s.", "javac", None, False
        if rc != 0:
            return "error", msgs, "javac", None, False
        flags = [java, "-Xmx256m", "-Xss16m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1", "-cp", workdir]
        if instrument:
            return "success", msgs, "javac", flags + ["SBLauncher", main_class, f"{stem}.java"], False
        return "success", msgs, "javac", flags + [main_class], False

    return "skipped", f"Unsupported language: {lang}", None, None, True


# --------------------------------------------------------------------------
# Build cache: the user answers input #1, #2, #3 ... and every answer re-runs
# the SAME code. Compiling again each time would be wasted work, so a finished
# build is kept for a short while (keyed by language + code hash) and COPIED into
# a fresh private folder for each run. Only compiled files are cached - never any
# running process or user state.
# --------------------------------------------------------------------------
_CACHE_TTL = 120          # seconds a build is kept after its last use
_CACHE_MAX = 24           # builds kept at once
_cache = {}
_cache_lock = threading.Lock()


def _drop_entry(entry):
    if entry and entry.get("dir"):
        shutil.rmtree(entry["dir"], ignore_errors=True)


def _evict_locked():
    now = time.monotonic()
    for key, entry in list(_cache.items()):
        if now - entry["ts"] > _CACHE_TTL:
            _drop_entry(_cache.pop(key))
    while len(_cache) > _CACHE_MAX:
        oldest = min(_cache, key=lambda k: _cache[k]["ts"])
        _drop_entry(_cache.pop(oldest))


def _clear_cache():
    with _cache_lock:
        for entry in _cache.values():
            _drop_entry(entry)
        _cache.clear()


atexit.register(_clear_cache)


def _get_build(lang, code):
    """(status, msgs, tool, build_dir, cmd, limit_mem) - compiled once, reused for a while."""
    import hashlib
    key = hashlib.sha256((lang + "\0" + code).encode("utf-8", "surrogatepass")).hexdigest()
    with _cache_lock:
        entry = _cache.get(key)
        if entry:
            entry["ts"] = time.monotonic()
            return entry
    build_dir = tempfile.mkdtemp(prefix="sb_build_")
    status, msgs, tool, cmd, limit_mem = _build(lang, code, build_dir, instrument=True)
    if lang in ("c", "cpp") and status in ("success", "error") and msgs:
        # The input hooks sit ABOVE the user's code, so compiler messages from this
        # build would quote the wrong source lines. Take the messages from a clean
        # compile of the user's own code instead.
        plain_dir = tempfile.mkdtemp(prefix="sb_plain_")
        p_status, p_msgs, p_tool, p_cmd, p_mem = _build(lang, code, plain_dir, instrument=False)
        if status == "error" and p_status == "success":
            # The code is fine, only the hooks do not fit it (very unusual, e.g. std::getchar()).
            # Run it without hooks: it works, but cannot pause to ask for input.
            shutil.rmtree(build_dir, ignore_errors=True)
            build_dir = plain_dir
            status, msgs, tool, cmd, limit_mem = p_status, p_msgs, p_tool, p_cmd, p_mem
        else:
            msgs = p_msgs
            shutil.rmtree(plain_dir, ignore_errors=True)
    entry = {"status": status, "msgs": msgs, "tool": tool, "cmd": cmd, "limit_mem": limit_mem,
             "dir": build_dir if status == "success" else None, "ts": time.monotonic()}
    if status != "success":
        shutil.rmtree(build_dir, ignore_errors=True)
    if status in ("success", "error"):          # timeouts / missing compilers are not remembered
        with _cache_lock:
            other = _cache.get(key)
            if other:
                _drop_entry(entry)
                entry = other
                entry["ts"] = time.monotonic()
            else:
                _cache[key] = entry
                _evict_locked()
    return entry


def _new_run_dir(entry):
    """Private copy of a cached build. Returns (run_dir, cmd) or (None, None) if it vanished."""
    run_dir = tempfile.mkdtemp(prefix="sb_run_")
    with _cache_lock:
        src = entry.get("dir")
        ok = bool(src) and os.path.isdir(src)
        if ok:
            try:
                shutil.copytree(src, run_dir, dirs_exist_ok=True)
            except OSError:
                ok = False
    if not ok:
        shutil.rmtree(run_dir, ignore_errors=True)
        return None, None
    return run_dir, [a.replace(entry["dir"], run_dir) for a in entry["cmd"]]


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------
def run_code(code, language=None, stdin_text="", eof=False):
    """
    Compile AND run `code` from the start. Blocking - call from a thread (see submit_run()).

    stdin_text  every answer typed so far, one line each, each ending in "\\n".
    eof         True = the user pressed "No more input": the program sees end-of-file
                instead of being asked for more.

    Returns a JSON-safe dict:
      language, status, ok, compiler, duration_ms
      phase        'compile' | 'run'   (where it stopped)
      errors       compiler messages / warnings
      stdout, stderr, exit_code, timed_out, run_ms
      status: success | error (compile error OR non-zero exit) | timeout |
              needs_input | unavailable | skipped
      needs_input  True when status == 'needs_input'. Then:
        input_request  {index, line, var, prompt, label}   what is being asked
        stdout_units   len(stdout) in JavaScript string units: the exact spot where
                       the page should show the user's answer
    """
    started = time.perf_counter()
    code = strip_fences(code or "")
    base = {"stdout": "", "stderr": "", "exit_code": None, "timed_out": False,
            "phase": "compile", "run_ms": 0, "needs_input": False,
            "input_request": None, "stdout_units": 0}
    if not code.strip():
        return _result(language, "skipped", "Empty code.", started=started, **base)
    if len(code) > MAX_CODE_CHARS:
        return _result(language, "skipped", "Code too large to compile.", started=started, **base)

    lang = normalize_language(language) or detect_language(code)
    if lang is None:
        return _result(language, "skipped",
                       "Could not detect a supported language (Python, C, C++, Java).",
                       started=started, **base)
    run_dir = None
    try:
        entry = _get_build(lang, code)
        if entry["status"] != "success":
            return _result(lang, entry["status"], entry["msgs"], entry["tool"], started, **base)
        tool, msgs = entry["tool"], entry["msgs"]

        run_dir, run_cmd = _new_run_dir(entry)
        if run_dir is None:                                  # cache entry was evicted meanwhile
            run_dir = tempfile.mkdtemp(prefix="sb_run_")
            status, msgs, tool, run_cmd, limit_mem = _build(lang, code, run_dir, instrument=True)
            if status != "success":
                return _result(lang, status, msgs, tool, started, **base)
            entry = {"limit_mem": limit_mem}

        base["phase"] = "run"
        t0 = time.perf_counter()
        state, rc, so, se, need = _exec_run(run_cmd, run_dir, RUN_TIMEOUT,
                                            limit_memory=entry["limit_mem"],
                                            stdin_text=stdin_text, eof=eof)
        base["run_ms"] = int((time.perf_counter() - t0) * 1000)
        stdout, stderr = _scrub(so, run_dir), _scrub(se, run_dir)
        base.update(stdout=stdout, stderr=stderr, exit_code=rc)

        if state == "needs_input":
            # The program stopped itself right where it wanted more input.
            base.update(needs_input=True, stdout_units=_utf16_len(stdout),
                        input_request=_describe_need(lang, code, need or {}, stdout,
                                                     (stdin_text or "").count("\n")))
            return _result(lang, "needs_input", "", tool, started, **base)
        if state == "timeout":
            base["timed_out"] = True
            return _result(lang, "timeout",
                           f"Program exceeded the {RUN_TIMEOUT}s time limit and was stopped.",
                           tool, started, **base)
        if state == "missing":
            return _result(lang, "unavailable", se, tool, started, **base)
        if rc != 0:
            return _result(lang, "error", msgs, tool, started, **base)
        return _result(lang, "success", msgs, tool, started, **base)
    except Exception as e:   # never let the worker thread crash the server
        return _result(lang, "error", f"Internal compiler error: {e}", started=started, **base)
    finally:
        if run_dir:
            shutil.rmtree(run_dir, ignore_errors=True)


def compile_code(code, language=None):
    """Check-only: compile without running (used by /send for quick validation)."""
    started = time.perf_counter()
    code = strip_fences(code or "")
    if not code.strip():
        return _result(language, "skipped", "Empty code.", started=started)
    if len(code) > MAX_CODE_CHARS:
        return _result(language, "skipped", "Code too large to compile.", started=started)
    lang = normalize_language(language) or detect_language(code)
    if lang is None:
        return _result(language, "skipped",
                       "Could not detect a supported language (Python, C, C++, Java).",
                       started=started)
    try:
        with tempfile.TemporaryDirectory(prefix="sb_check_") as workdir:
            status, msgs, tool, _cmd, _mem = _build(lang, code, workdir)
    except Exception as e:
        return _result(lang, "error", f"Internal compiler error: {e}", started=started)
    return _result(lang, status, msgs, tool, started)


def submit(code, language=None):
    """Background check-only compile. Returns a Future."""
    return _pool.submit(compile_code, code, language)


def submit_run(code, language=None, stdin_text="", eof=False):
    """Background compile + run. Returns a Future."""
    return _run_pool.submit(run_code, code, language, stdin_text, eof)