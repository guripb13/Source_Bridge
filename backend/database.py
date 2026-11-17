"""
database.py - Source Bridge storage layer (SQLite: Python standard library + Werkzeug, which
Flask already installs - nothing new to add to requirements.txt).

It creates and manages exactly TWO database files, side by side in one folder:

    users.db          WHO can sign in
        users             one row per account: credentials + login bookkeeping
        settings          tiny key/value table (holds the secret that signs login cookies)

    translations.db   WHAT each signed-in user translated
        languages         lookup table: every language name is stored once
        translations      one row per translation attempt, pointing at languages

HOW THE TWO FILES RELATE
    translations.user_id  ->  users.id        (one user has many translations)
    translations.source_language_id / target_language_id  ->  languages.id

    SQLite cannot enforce a foreign key between two different files, so that one link is kept
    honest in code instead:  start_translation() refuses an unknown user, delete_user() removes
    the user's translations too, and purge_orphaned_translations() cleans up anything left over.
    users.id uses AUTOINCREMENT so an id is never handed out twice - a deleted account's id can
    never accidentally "inherit" someone else's history.

NORMALIZATION (why the tables look like this)
    1NF  every column holds one plain value (no lists, no "python,java" strings).
    2NF/3NF  each fact lives in exactly one place:
             - account facts only in users;
             - a language's name only in languages (translations stores the id, so "Python" is
               written once, can't be misspelled in 500 rows and can be renamed in one place);
             - translations holds only facts about that one attempt.
    Deliberately NOT split further: source_code and target_code stay in the same row. They are
    1:1 with the attempt and always read together, so a separate table would add a JOIN for
    nothing. Likewise status is ONE column ('pending' | 'completed' | 'failed'); "is it
    completed?" and "did it error?" are derived from it, so the two can never contradict each
    other. CHECK constraints below make the database itself reject impossible rows.

LIFE OF A TRANSLATION ROW
    start_translation()  -> status 'pending'
    complete_translation()-> status 'completed' (target_code filled)        can then be saved
    fail_translation()   -> status 'failed'    (error_stage + error_message)
    A 'pending' row older than STALE_PENDING_MINUTES is marked failed/'interrupted' (the server
    died mid-stream), so nothing stays "in progress" forever.

DEPLOYMENT NOTE
    SQLite files are ordinary files. On a normal server / your own PC they persist. On Vercel
    the disk is temporary: data would be lost when the function restarts. For real deployment
    either use a host with a persistent disk (set DATABASE_DIR to it) or move these same tables
    to a hosted database (Postgres, Turso, ...).
"""
import logging
import os
import re
import secrets
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

from werkzeug.security import check_password_hash, generate_password_hash

try:                                            # reuse the project's language aliases (py -> python)
    from convertibility import normalize as _normalize_language
except ImportError:                             # pragma: no cover - database.py also works alone
    def _normalize_language(name):
        return " ".join((name or "").strip().lower().split())

log = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
SCHEMA_VERSION = 1

USERNAME_RE = re.compile(r"[A-Za-z0-9_.\-]{3,30}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
PASSWORD_MIN, PASSWORD_MAX = 8, 128

MAX_FAILED_LOGINS = 5                           # wrong passwords before the account is paused
LOCK_MINUTES = 15
STALE_PENDING_MINUTES = 10
MAX_HISTORY_PER_USER = 500                      # newest unsaved translations kept per user
MAX_SAVED_PER_USER = 100                        # saved translations are never auto-deleted
MAX_ERROR_CHARS = 2000

ERROR_STAGES = ("compiler", "convertibility", "translation", "interrupted")

_HASH_METHOD = "pbkdf2:sha256:600000"           # available everywhere, OWASP-recommended cost


# --------------------------------------------------------------------------
# Errors (main.py turns these into JSON replies)
# --------------------------------------------------------------------------
class DatabaseError(Exception):
    """Base class. The message is safe to show to the user."""


class ValidationError(DatabaseError):
    def __init__(self, message, field=None):
        super().__init__(message)
        self.field = field


class DuplicateError(ValidationError):
    """Username or email already registered."""


class AuthError(DatabaseError):
    """Wrong credentials / account paused."""


# --------------------------------------------------------------------------
# Where the two files live
# --------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _pick_data_dir():
    wanted = os.environ.get("DATABASE_DIR") or os.path.join(BASE_DIR, "data")
    fallback = os.path.join(tempfile.gettempdir(), "source_bridge_data")
    for folder in (wanted, fallback):
        try:
            os.makedirs(folder, exist_ok=True)
            probe = os.path.join(folder, ".write_test")
            with open(probe, "w") as handle:
                handle.write("ok")
            os.remove(probe)
        except OSError:
            continue
        if folder != wanted:
            log.warning("%s is not writable; databases are in %s and may be lost on restart.",
                        wanted, folder)
        return folder
    raise RuntimeError("No writable folder for the databases. Set the DATABASE_DIR variable.")


DATA_DIR = _pick_data_dir()
USERS_DB = os.path.join(DATA_DIR, "users.db")
TRANSLATIONS_DB = os.path.join(DATA_DIR, "translations.db")


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------
USERS_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,          -- never reused (see top of file)
    username       TEXT NOT NULL UNIQUE COLLATE NOCASE
                        CHECK (length(username) BETWEEN 3 AND 30),
    email          TEXT NOT NULL UNIQUE COLLATE NOCASE
                        CHECK (length(email) BETWEEN 5 AND 254),
    password_hash  TEXT NOT NULL,                              -- salted hash, never the password
    is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    failed_logins  INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
    locked_until   TEXT,                                       -- UTC ISO time, NULL = not locked
    created_at     TEXT NOT NULL,
    last_login_at  TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);
"""

TRANSLATIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS languages (
    id    INTEGER PRIMARY KEY,
    code  TEXT NOT NULL UNIQUE,         -- normalised key, e.g. 'python', 'c++'
    name  TEXT NOT NULL                 -- display name as first seen, e.g. 'Python', 'C++'
);

CREATE TABLE IF NOT EXISTS translations (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id             INTEGER NOT NULL,                      -- -> users.db users.id (see top)
    source_language_id  INTEGER REFERENCES languages(id),      -- NULL = user did not say
    target_language_id  INTEGER NOT NULL REFERENCES languages(id),
    source_code         TEXT NOT NULL,                         -- what the user pasted
    target_code         TEXT,                                  -- the translated result
    status              TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'completed', 'failed')),
    error_stage         TEXT CHECK (error_stage IN
                             ('compiler', 'convertibility', 'translation', 'interrupted')),
    error_message       TEXT,
    is_saved            INTEGER NOT NULL DEFAULT 0 CHECK (is_saved IN (0, 1)),
    saved_at            TEXT,
    created_at          TEXT NOT NULL,
    finished_at         TEXT,                                  -- set when completed OR failed

    -- the table can only hold sensible states:
    CHECK ((status = 'failed') = (error_stage IS NOT NULL)),   -- failed <=> has an error
    CHECK ((error_stage IS NULL) = (error_message IS NULL)),
    CHECK (status <> 'completed' OR target_code IS NOT NULL),  -- completed => has a result
    CHECK ((status = 'pending') = (finished_at IS NULL)),
    CHECK (is_saved = 0 OR status = 'completed'),              -- only finished work can be saved
    CHECK ((is_saved = 1) = (saved_at IS NOT NULL))
);

-- history page:   WHERE user_id = ? ORDER BY id DESC
CREATE INDEX IF NOT EXISTS idx_translations_user_recent
    ON translations (user_id, id DESC);
-- "Saved" page: a small index holding only the saved rows
CREATE INDEX IF NOT EXISTS idx_translations_user_saved
    ON translations (user_id, id DESC) WHERE is_saved = 1;
-- cleanup of stuck rows: a small index holding only the pending rows
CREATE INDEX IF NOT EXISTS idx_translations_pending
    ON translations (created_at) WHERE status = 'pending';
"""


# --------------------------------------------------------------------------
# Connections and small helpers
# --------------------------------------------------------------------------
@contextmanager
def _connect(path, write=False):
    """
    One short-lived connection per operation (cheap for SQLite, safe with several workers).
    write=True takes the write lock up front, so "check, then change" cannot be interleaved
    with another request. Commits on success, rolls back on any error.
    Default journal mode is kept on purpose: it leaves exactly two .db files on disk.
    """
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    try:
        if write:
            conn.execute("BEGIN IMMEDIATE")
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _minutes_ago(minutes):
    moment = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _minutes_from_now(minutes):
    moment = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _migrate(conn, schema):
    """Create what is missing. Future schema changes: add `if version < 2: ...` steps here."""
    conn.executescript(schema)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {int(SCHEMA_VERSION)}")


def init_db():
    """Create users.db and translations.db (and their tables) if they do not exist yet."""
    with _connect(USERS_DB) as conn:
        _migrate(conn, USERS_SCHEMA)
    with _connect(TRANSLATIONS_DB) as conn:
        _migrate(conn, TRANSLATIONS_SCHEMA)


def get_secret_key():
    """
    Key that signs the login cookie. Uses the SECRET_KEY environment variable when set;
    otherwise one random key is generated once and kept in users.db (so logins survive restarts).
    """
    from_env = os.environ.get("SECRET_KEY")
    if from_env:
        return from_env
    with _connect(USERS_DB, write=True) as conn:
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret_key', ?)",
                     (secrets.token_hex(32),))
        return conn.execute("SELECT value FROM settings WHERE key = 'secret_key'").fetchone()[0]


# --------------------------------------------------------------------------
# USERS  -  sign up, sign in, look up, delete
# --------------------------------------------------------------------------
def _clean_username(value):
    value = value.strip() if isinstance(value, str) else ""
    if not USERNAME_RE.fullmatch(value):
        raise ValidationError("Username must be 3-30 characters: letters, numbers, . _ -",
                              "username")
    return value


def _clean_email(value):
    value = value.strip().lower() if isinstance(value, str) else ""
    if len(value) > 254 or not EMAIL_RE.fullmatch(value):
        raise ValidationError("Please enter a valid email address.", "email")
    return value


def _check_password(value):
    if not isinstance(value, str) or not (PASSWORD_MIN <= len(value) <= PASSWORD_MAX):
        raise ValidationError(
            f"Password must be {PASSWORD_MIN}-{PASSWORD_MAX} characters long.", "password")


def _public_user(row):
    return {"id": row["id"], "username": row["username"], "email": row["email"],
            "created_at": row["created_at"]}


def register_user(username, email, password):
    """Create an account. Returns the public user dict. Raises ValidationError / DuplicateError."""
    username = _clean_username(username)
    email = _clean_email(email)
    _check_password(password)
    password_hash = generate_password_hash(password, method=_HASH_METHOD)
    now = _now()
    try:
        with _connect(USERS_DB, write=True) as conn:
            cursor = conn.execute(
                "INSERT INTO users (username, email, password_hash, created_at, last_login_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (username, email, password_hash, now, now))
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError as exc:
        text = str(exc)
        if "users.email" in text:
            raise DuplicateError("An account with this email already exists.", "email") from None
        if "users.username" in text:
            raise DuplicateError("That username is already taken.", "username") from None
        raise
    return {"id": user_id, "username": username, "email": email, "created_at": now}


_BAD_LOGIN = "Incorrect username/email or password."
_dummy_hash = None


def _burn_time(password):
    """Unknown account: still spend the same time hashing, so timing doesn't reveal who exists."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = generate_password_hash("not-a-real-password", method=_HASH_METHOD)
    check_password_hash(_dummy_hash, password if isinstance(password, str) else "")


def authenticate(identifier, password):
    """
    Sign in with username OR email + password. Returns the public user dict, or raises AuthError.
    After MAX_FAILED_LOGINS wrong passwords the account is paused for LOCK_MINUTES.
    """
    identifier = identifier.strip() if isinstance(identifier, str) else ""
    if not identifier or not isinstance(password, str) or len(password) > PASSWORD_MAX:
        raise AuthError(_BAD_LOGIN)

    with _connect(USERS_DB, write=True) as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ? OR email = ?",
                           (identifier, identifier)).fetchone()
        if row is None:
            _burn_time(password)
            raise AuthError(_BAD_LOGIN)

        now = _now()
        if row["locked_until"] and row["locked_until"] > now:
            raise AuthError("Too many failed attempts. Try again in a few minutes.")

        if not check_password_hash(row["password_hash"], password):
            failures = row["failed_logins"] + 1
            if failures >= MAX_FAILED_LOGINS:
                conn.execute("UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?",
                             (_minutes_from_now(LOCK_MINUTES), row["id"]))
            else:
                conn.execute("UPDATE users SET failed_logins = ? WHERE id = ?",
                             (failures, row["id"]))
            conn.commit()                 # keep the counter even though we raise below
            raise AuthError(_BAD_LOGIN)

        if not row["is_active"]:
            raise AuthError("This account has been disabled.")

        conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? "
                     "WHERE id = ?", (now, row["id"]))
        return _public_user(row)


def get_user(user_id):
    """The public user dict for an active account, else None (used to validate the login cookie)."""
    with _connect(USERS_DB) as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ? AND is_active = 1",
                           (user_id,)).fetchone()
    return _public_user(row) if row else None


def delete_user(user_id, password):
    """Delete the account AND all of its translations (the cross-file 'cascade')."""
    with _connect(USERS_DB, write=True) as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None:
            raise AuthError("Account not found.")
        if not isinstance(password, str) or not check_password_hash(row["password_hash"], password):
            raise AuthError("Incorrect password.")
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        conn.execute("DELETE FROM translations WHERE user_id = ?", (user_id,))


def purge_orphaned_translations():
    """Maintenance: delete translations whose user no longer exists. Returns rows removed."""
    with _connect(USERS_DB) as conn:
        alive = {row[0] for row in conn.execute("SELECT id FROM users")}
    removed = 0
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        owners = [row[0] for row in conn.execute("SELECT DISTINCT user_id FROM translations")]
        for owner in owners:
            if owner not in alive:
                removed += conn.execute("DELETE FROM translations WHERE user_id = ?",
                                        (owner,)).rowcount
    return removed


# --------------------------------------------------------------------------
# TRANSLATIONS  -  record, save, list, delete
# --------------------------------------------------------------------------
def _language_id(conn, name):
    """Id of a language row, creating it the first time it is seen. None for a blank name."""
    name = (name or "").strip()
    if not name:
        return None
    code = _normalize_language(name)
    conn.execute("INSERT OR IGNORE INTO languages (code, name) VALUES (?, ?)", (code, name))
    return conn.execute("SELECT id FROM languages WHERE code = ?", (code,)).fetchone()[0]


def _expire_stale(conn):
    conn.execute(
        "UPDATE translations SET status = 'failed', error_stage = 'interrupted', "
        "error_message = 'The translation was interrupted before it finished.', finished_at = ? "
        "WHERE status = 'pending' AND created_at < ?",
        (_now(), _minutes_ago(STALE_PENDING_MINUTES)))


def _prune_history(conn, user_id):
    """Keep only the newest MAX_HISTORY_PER_USER unsaved rows. Saved rows are never touched."""
    conn.execute(
        "DELETE FROM translations WHERE user_id = ? AND is_saved = 0 AND id NOT IN "
        "(SELECT id FROM translations WHERE user_id = ? AND is_saved = 0 "
        " ORDER BY id DESC LIMIT ?)",
        (user_id, user_id, MAX_HISTORY_PER_USER))


def start_translation(user_id, source_language, target_language, source_code):
    """Record a new attempt as 'pending'. Returns {"id", "created_at"}."""
    with _connect(USERS_DB) as conn:             # the cross-file "foreign key" check
        known = conn.execute("SELECT 1 FROM users WHERE id = ? AND is_active = 1",
                             (user_id,)).fetchone()
    if known is None:
        raise DatabaseError("Unknown user.")
    if not isinstance(source_code, str) or not source_code.strip():
        raise ValidationError("There is no source code to record.", "source_code")

    now = _now()
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        _expire_stale(conn)
        target_id = _language_id(conn, target_language)
        if target_id is None:
            raise ValidationError("A target language is required.", "language")
        cursor = conn.execute(
            "INSERT INTO translations (user_id, source_language_id, target_language_id, "
            "source_code, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
            (user_id, _language_id(conn, source_language), target_id, source_code, now))
        return {"id": cursor.lastrowid, "created_at": now}


def complete_translation(translation_id, user_id, target_code):
    """pending -> completed. Returns True if the row was updated."""
    if not isinstance(target_code, str) or not target_code.strip():
        raise ValidationError("There is no translated code to record.", "target_code")
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        cursor = conn.execute(
            "UPDATE translations SET status = 'completed', target_code = ?, finished_at = ? "
            "WHERE id = ? AND user_id = ? AND status = 'pending'",
            (target_code, _now(), translation_id, user_id))
        if cursor.rowcount != 1:
            return False
        _prune_history(conn, user_id)
        return True


def fail_translation(translation_id, user_id, stage, message):
    """pending -> failed, remembering which step failed and why. Returns True if updated."""
    if stage not in ERROR_STAGES:
        raise ValueError(f"stage must be one of {ERROR_STAGES}")
    message = (message or "Unknown error.").strip()[:MAX_ERROR_CHARS] or "Unknown error."
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        cursor = conn.execute(
            "UPDATE translations SET status = 'failed', error_stage = ?, error_message = ?, "
            "finished_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
            (stage, message, _now(), translation_id, user_id))
        return cursor.rowcount == 1


def set_saved(translation_id, user_id, saved=True):
    """
    Bookmark / un-bookmark a finished translation. Returns False if it does not exist, is not
    yours, or is not completed. Raises ValidationError when the saved limit is reached.
    """
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        row = conn.execute("SELECT status, is_saved FROM translations WHERE id = ? AND user_id = ?",
                           (translation_id, user_id)).fetchone()
        if row is None:
            return False
        if saved:
            if row["status"] != "completed":
                return False
            if not row["is_saved"]:
                count = conn.execute("SELECT COUNT(*) FROM translations "
                                     "WHERE user_id = ? AND is_saved = 1", (user_id,)).fetchone()[0]
                if count >= MAX_SAVED_PER_USER:
                    raise ValidationError(
                        f"You can keep up to {MAX_SAVED_PER_USER} saved translations. "
                        "Remove one to save another.")
                conn.execute("UPDATE translations SET is_saved = 1, saved_at = ? WHERE id = ?",
                             (_now(), translation_id))
        elif row["is_saved"]:
            conn.execute("UPDATE translations SET is_saved = 0, saved_at = NULL WHERE id = ?",
                         (translation_id,))
        return True


def delete_translation(translation_id, user_id):
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        return conn.execute("DELETE FROM translations WHERE id = ? AND user_id = ?",
                            (translation_id, user_id)).rowcount == 1


_COLUMNS = """
    t.id, t.status, t.error_stage, t.error_message, t.is_saved, t.saved_at,
    t.created_at, t.finished_at, sl.name AS source_language, tl.name AS target_language"""
_FROM = """
    FROM translations t
    JOIN languages tl ON tl.id = t.target_language_id
    LEFT JOIN languages sl ON sl.id = t.source_language_id"""


def _translation_dict(row):
    keys = row.keys()
    item = {
        "id": row["id"],
        "source_language": row["source_language"],
        "target_language": row["target_language"],
        "status": row["status"],
        "is_completed": row["status"] == "completed",     # derived, can't contradict status
        "has_error": row["status"] == "failed",
        "error_stage": row["error_stage"],
        "error_message": row["error_message"],
        "is_saved": bool(row["is_saved"]),
        "created_at": row["created_at"],
        "finished_at": row["finished_at"],
        "saved_at": row["saved_at"],
    }
    for key in ("source_preview", "target_preview", "source_code", "target_code"):
        if key in keys:
            item[key] = row[key]
    return item


def get_translation(translation_id, user_id):
    """One translation with its full source and translated code, or None."""
    with _connect(TRANSLATIONS_DB) as conn:
        row = conn.execute(
            f"SELECT {_COLUMNS}, t.source_code, t.target_code {_FROM} "
            "WHERE t.id = ? AND t.user_id = ?", (translation_id, user_id)).fetchone()
    return _translation_dict(row) if row else None


def list_translations(user_id, saved_only=False, limit=20, before_id=None):
    """
    Newest first, with short previews instead of the full code (keeps the page light).
    Paging: pass the returned next_before_id as before_id to get the next page.
    Returns (items, next_before_id_or_None).
    """
    limit = max(1, min(int(limit), 100))
    sql = (f"SELECT {_COLUMNS}, substr(t.source_code, 1, 200) AS source_preview, "
           f"substr(t.target_code, 1, 200) AS target_preview {_FROM} WHERE t.user_id = ?")
    params = [user_id]
    if saved_only:
        sql += " AND t.is_saved = 1"
    if before_id is not None:
        sql += " AND t.id < ?"
        params.append(int(before_id))
    sql += " ORDER BY t.id DESC LIMIT ?"
    params.append(limit + 1)                       # one extra row tells us if there is a next page

    with _connect(TRANSLATIONS_DB) as conn:
        rows = conn.execute(sql, params).fetchall()
    more = len(rows) > limit
    items = [_translation_dict(row) for row in rows[:limit]]
    return items, (items[-1]["id"] if more and items else None)