"""
turso_db.py - a tiny sqlite3-style connection that talks to a Turso (hosted SQLite) database
over HTTPS. database.py uses it automatically when TURSO_DATABASE_URL is set; without that
variable database.py keeps using local SQLite files exactly as before.

Why not a driver package?  Only `requests` is needed (already in requirements.txt), so there
is nothing native to compile on Hugging Face / Render / Docker.

Protocol: Turso's "Hrana over HTTP" endpoint  POST <db-url>/v2/pipeline
    - a statement outside a transaction is one request (and the stream is closed at once);
    - BEGIN opens a stream; the server returns a "baton" that every later request sends back,
      so BEGIN ... COMMIT behaves like a normal interactive transaction.

Environment variables:
    TURSO_DATABASE_URL   e.g. libsql://my-db-myorg.aws-us-east-1.turso.io
    TURSO_AUTH_TOKEN     the database token created in the Turso dashboard / CLI
"""
import base64
import os
import re
import sqlite3
import threading

import requests

REQUEST_TIMEOUT = 30          # seconds for one HTTP round trip
_local = threading.local()    # one keep-alive HTTP session per thread


def configured():
    """True when a Turso database URL is present in the environment."""
    return bool(os.environ.get("TURSO_DATABASE_URL", "").strip())


# --------------------------------------------------------------------------
# Errors: subclasses of sqlite3's, so existing `except sqlite3.IntegrityError` and
# `@app.errorhandler(sqlite3.Error)` code keeps working unchanged.
# --------------------------------------------------------------------------
class TursoError(sqlite3.OperationalError):
    pass


class TursoIntegrityError(sqlite3.IntegrityError):
    pass


def _raise_remote(error):
    message = (error or {}).get("message") or "Unknown Turso error"
    code = str((error or {}).get("code") or "")
    if "CONSTRAINT" in code.upper() or "constraint failed" in message:
        raise TursoIntegrityError(message)
    raise TursoError(message)


# --------------------------------------------------------------------------
# Values and rows
# --------------------------------------------------------------------------
def _encode(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"type": "blob", "base64": base64.b64encode(bytes(value)).decode("ascii")}
    return {"type": "text", "value": str(value)}


def _decode(cell):
    kind = cell.get("type")
    if kind == "null":
        return None
    if kind == "integer":
        return int(cell["value"])
    if kind == "float":
        return float(cell["value"])
    if kind == "blob":
        data = cell.get("base64", "")
        return base64.b64decode(data + "=" * (-len(data) % 4))
    return cell.get("value")


class Row(tuple):
    """Like sqlite3.Row: row[0], row["name"], row.keys(), iteration gives the values."""

    def __new__(cls, values, names):
        self = super().__new__(cls, values)
        self._names = names
        return self

    def __getitem__(self, key):
        if isinstance(key, str):
            wanted = key.lower()
            for position in range(len(self._names) - 1, -1, -1):
                if self._names[position].lower() == wanted:
                    return tuple.__getitem__(self, position)
            raise IndexError("No item with that key")
        return tuple.__getitem__(self, key)

    def keys(self):
        return list(self._names)


class Cursor:
    def __init__(self, rows=(), rowcount=-1, lastrowid=None):
        self._rows = list(rows)
        self._position = 0
        self.rowcount = rowcount
        self.lastrowid = lastrowid

    def fetchone(self):
        if self._position >= len(self._rows):
            return None
        row = self._rows[self._position]
        self._position += 1
        return row

    def fetchall(self):
        rows = self._rows[self._position:]
        self._position = len(self._rows)
        return rows

    def __iter__(self):
        return iter(self.fetchall())


def _split_script(script):
    """Split a schema script into statements (the project's schemas hold no ';' inside text)."""
    without_comments = "\n".join(re.sub(r"--.*$", "", line) for line in script.splitlines())
    return [part.strip() for part in without_comments.split(";") if part.strip()]


# --------------------------------------------------------------------------
# Connection
# --------------------------------------------------------------------------
class Connection:
    def __init__(self):
        url = os.environ.get("TURSO_DATABASE_URL", "").strip()
        token = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
        if not url:
            raise TursoError("TURSO_DATABASE_URL is not set.")
        if not token:
            raise TursoError("TURSO_AUTH_TOKEN is not set.")
        for prefix in ("libsql://", "wss://", "ws://", "https://", "http://"):
            if url.startswith(prefix):
                url = ("http://" if prefix in ("ws://", "http://") else "https://") + url[len(prefix):]
                break
        else:
            url = "https://" + url
        self._root = url.rstrip("/")
        self._base = self._root
        self._headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        self._baton = None
        self._in_transaction = False

    # ---- HTTP ---------------------------------------------------------
    def _session(self):
        session = getattr(_local, "session", None)
        if session is None:
            session = _local.session = requests.Session()
        return session

    def _send(self, requests_list, retry=False):
        body = {"baton": self._baton, "requests": requests_list}
        attempts = 2 if retry else 1
        for attempt in range(attempts):
            try:
                response = self._session().post(self._base + "/v2/pipeline", json=body,
                                                headers=self._headers, timeout=REQUEST_TIMEOUT)
                break
            except requests.RequestException as exc:
                if attempt + 1 >= attempts:
                    self._baton, self._base = None, self._root
                    raise TursoError(f"Could not reach Turso: {exc}") from None
        if response.status_code != 200:
            self._baton, self._base = None, self._root
            raise TursoError(f"Turso answered HTTP {response.status_code}: {response.text[:200]}")
        data = response.json()
        self._baton = data.get("baton")
        self._base = (data.get("base_url") or self._root).rstrip("/") if self._baton else self._root
        results = data.get("results", [])
        for item in results:
            if item.get("type") == "error":
                _raise_remote(item.get("error"))
        return results

    @staticmethod
    def _execute_request(sql, params=()):
        return {"type": "execute",
                "stmt": {"sql": sql, "args": [_encode(p) for p in params], "want_rows": True}}

    # ---- sqlite3-style API --------------------------------------------
    def execute(self, sql, params=()):
        text = sql.strip()
        keyword = text.split(None, 1)[0].upper() if text else ""
        if keyword == "BEGIN":
            self._in_transaction = True
        requests_list = [self._execute_request(text, params)]
        if not self._in_transaction:
            requests_list.append({"type": "close"})
        try:
            results = self._send(requests_list, retry=(keyword == "SELECT" and not self._in_transaction))
        except Exception:
            if keyword == "BEGIN":
                self._in_transaction = False
            raise
        result = results[0]["response"]["result"]
        names = [col.get("name") or "" for col in result.get("cols", [])]
        rows = [Row([_decode(cell) for cell in raw], names) for raw in result.get("rows", [])]
        last = result.get("last_insert_rowid")
        return Cursor(rows, result.get("affected_row_count", -1),
                      int(last) if last not in (None, "") else None)

    def executescript(self, script):
        statements = _split_script(script)
        if not statements:
            return
        requests_list = [self._execute_request(statement) for statement in statements]
        if not self._in_transaction:
            requests_list.append({"type": "close"})
        self._send(requests_list)

    def _finish(self, verb):
        if not self._in_transaction:
            return
        self._in_transaction = False
        try:
            self._send([self._execute_request(verb), {"type": "close"}])
        finally:
            self._baton, self._base = None, self._root

    def commit(self):
        self._finish("COMMIT")

    def rollback(self):
        try:
            self._finish("ROLLBACK")
        except sqlite3.Error:
            pass                                  # the stream may already be gone; nothing to undo

    def close(self):
        if self._baton:
            try:
                self._send([{"type": "close"}])
            except sqlite3.Error:
                pass
        self._baton, self._base, self._in_transaction = None, self._root, False


def connect():
    return Connection()