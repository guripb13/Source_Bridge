"""
database.py - Source Bridge storage layer (SQLite: Python standard library + Werkzeug, which
Flask already installs - nothing new to add to requirements.txt).

It creates and manages exactly THREE database files, side by side in one folder:

    users.db          WHO can sign in
        users             one row per account: credentials + login bookkeeping
        settings          tiny key/value table (holds the secret that signs login cookies)
        guest_usage      server-side translation and compile quotas per guest session

    translations.db   WHAT each signed-in user translated
        languages         lookup table: every language name is stored once
        translations      one row per translation attempt, pointing at languages
                          (identical back-to-back results are merged: see repeat_count)

    username_index.db HOW FAST we can tell whether a username is taken (an index / cache)
        username_index    one row per account: HMAC-SHA256 hash of the username + users.id

HOW THE FILES RELATE
    translations.user_id  ->  users.id        (one user has many translations)
    username_index.user_id -> users.id        (one index row per user)
    translations.source_language_id / target_language_id  ->  languages.id

    SQLite cannot enforce a foreign key between two different files, so those links are kept
    honest in code instead:  start_translation() refuses an unknown user, delete_user() removes
    the user's translations and index row too, purge_orphaned_translations() cleans up anything
    left over, and sync_username_index() (run at start-up) repairs the index from users.db.
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

USERNAME INDEX (username_index.db)
    Lets the sign-up form answer "is this username taken?" while the person is still typing,
    with one primary-key lookup instead of a click on "Create account".
      - Only a keyed hash is stored, never the readable username. The hash is
        HMAC-SHA256(secret pepper, lower-cased username), so the file alone cannot be turned
        back into usernames (and cannot be dictionary-guessed without the pepper, which lives in
        users.db / the USERNAME_INDEX_KEY environment variable - a different place).
      - users.db stays the single source of truth. The index is a disposable cache: if it is
        lost or drifts, sync_username_index() rebuilds it. Even if the index were wrong, the
        UNIQUE constraint on users.username still stops a real duplicate account.

REPEATED TRANSLATIONS (translations.repeat_count)
    When an attempt finishes (completed OR failed) and the same user's PREVIOUS history entry
    (only the most recent one) has the same source language, target language, source code,
    status and result (the translated code, or the same error stage + message for a failure),
    no new row is written: that entry's repeat_count goes up by one. Any different entry in
    between breaks the chain, so the next identical one starts a new row.

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
import hashlib
import hmac
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
SCHEMA_VERSION = 3

USERNAME_RE = re.compile(r"[A-Za-z0-9_.\-]{3,30}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
PASSWORD_MIN, PASSWORD_MAX = 8, 128

MAX_FAILED_LOGINS = 5                           # wrong passwords before the account is paused
LOCK_MINUTES = 15
STALE_PENDING_MINUTES = 10
MAX_HISTORY_PER_USER = 500                      # newest unsaved translations kept per user
MAX_SAVED_PER_USER = 100                        # saved translations are never auto-deleted
MAX_ERROR_CHARS = 2000
GUEST_ACTION_LIMIT = 3
_GUEST_ACTION_COLUMNS = {
    "translation": "translations",
    "compilation": "compilations",
}

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
USERNAME_INDEX_DB = os.path.join(DATA_DIR, "username_index.db")


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

CREATE TABLE IF NOT EXISTS guest_usage (
    guest_key_hash  TEXT PRIMARY KEY,
    translations    INTEGER NOT NULL DEFAULT 0 CHECK (translations BETWEEN 0 AND 3),
    compilations    INTEGER NOT NULL DEFAULT 0 CHECK (compilations BETWEEN 0 AND 3),
    updated_at      TEXT NOT NULL
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
    repeat_count        INTEGER NOT NULL DEFAULT 1             -- identical back-to-back runs
                             CHECK (repeat_count >= 1),

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

# The username index: hash -> user id. WITHOUT ROWID makes the hash itself the table's
# B-tree key, so a lookup is a single index search.
USERNAME_INDEX_SCHEMA = """
CREATE TABLE IF NOT EXISTS username_index (
    username_hash  TEXT PRIMARY KEY,                 -- HMAC-SHA256 hex of the lower-cased name
    user_id        INTEGER NOT NULL UNIQUE           -- -> users.db users.id (see top)
) WITHOUT ROWID;
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
    Default journal mode is kept on purpose: it leaves exactly three .db files on disk.
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


def _upgrade_translations(conn):
    """Databases made before schema 2 have no repeat_count column: add it (existing rows = 1)."""
    columns = {row[1] for row in conn.execute("PRAGMA table_info(translations)")}
    if "repeat_count" not in columns:
        conn.execute("ALTER TABLE translations "
                     "ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1)")


def _migrate(conn, schema, upgrade=None):
    """Create what is missing, then bring older files up to date (upgrade steps are idempotent)."""
    conn.executescript(schema)
    if upgrade:
        upgrade(conn)
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    if version < SCHEMA_VERSION:
        conn.execute(f"PRAGMA user_version = {int(SCHEMA_VERSION)}")


def init_db():
    """Create users.db, translations.db and username_index.db (and their tables) if missing."""
    with _connect(USERS_DB) as conn:
        _migrate(conn, USERS_SCHEMA)
    with _connect(TRANSLATIONS_DB) as conn:
        _migrate(conn, TRANSLATIONS_SCHEMA, _upgrade_translations)
    with _connect(USERNAME_INDEX_DB) as conn:
        _migrate(conn, USERNAME_INDEX_SCHEMA)
    sync_username_index()


def _guest_usage_payload(row=None):
    return {
        "translations": row["translations"] if row is not None else 0,
        "compilations": row["compilations"] if row is not None else 0,
        "limit": GUEST_ACTION_LIMIT,
    }


def get_guest_usage(guest_key_hash):
    """Return server-side guest counters without creating a row for a new visitor."""
    if not isinstance(guest_key_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", guest_key_hash):
        raise ValidationError("Invalid guest session.")
    with _connect(USERS_DB) as conn:
        row = conn.execute(
            "SELECT translations, compilations FROM guest_usage WHERE guest_key_hash = ?",
            (guest_key_hash,),
        ).fetchone()
    return _guest_usage_payload(row)


def consume_guest_action(guest_key_hash, action):
    """Atomically consume one guest translation or compile request, enforcing its separate cap."""
    column = _GUEST_ACTION_COLUMNS.get(action)
    if column is None:
        raise ValidationError("Invalid guest action.")
    if not isinstance(guest_key_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", guest_key_hash):
        raise ValidationError("Invalid guest session.")

    with _connect(USERS_DB, write=True) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO guest_usage (guest_key_hash, updated_at) VALUES (?, ?)",
            (guest_key_hash, _now()),
        )
        row = conn.execute(
            "SELECT translations, compilations FROM guest_usage WHERE guest_key_hash = ?",
            (guest_key_hash,),
        ).fetchone()
        usage = _guest_usage_payload(row)
        if usage[column] >= GUEST_ACTION_LIMIT:
            return {"allowed": False, "usage": usage}

        conn.execute(
            f"UPDATE guest_usage SET {column} = {column} + 1, updated_at = ? "
            "WHERE guest_key_hash = ?",
            (_now(), guest_key_hash),
        )
        usage[column] += 1
        return {"allowed": True, "usage": usage}


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
# USERNAME INDEX  -  fast "is this username taken?" (username_index.db)
# --------------------------------------------------------------------------
_pepper_cache = None


def _index_pepper():
    """
    Secret that keys the username hash. USERNAME_INDEX_KEY (environment) wins; otherwise a random
    one is generated once and kept in users.db - deliberately NOT in username_index.db, so
    someone who only gets the index file cannot test guessed usernames against it.
    """
    global _pepper_cache
    if _pepper_cache is None:
        from_env = os.environ.get("USERNAME_INDEX_KEY")
        if from_env:
            _pepper_cache = from_env.encode("utf-8")
        else:
            with _connect(USERS_DB, write=True) as conn:
                conn.execute("INSERT OR IGNORE INTO settings (key, value) "
                             "VALUES ('username_index_pepper', ?)", (secrets.token_hex(32),))
                value = conn.execute("SELECT value FROM settings "
                                     "WHERE key = 'username_index_pepper'").fetchone()[0]
            _pepper_cache = value.encode("utf-8")
    return _pepper_cache


def _username_hash(username):
    """Keyed one-way hash of a username. Case-insensitive, like users.username itself."""
    return hmac.new(_index_pepper(), username.strip().lower().encode("utf-8"),
                    hashlib.sha256).hexdigest()


def _index_add(user_id, username):
    with _connect(USERNAME_INDEX_DB, write=True) as conn:
        conn.execute("DELETE FROM username_index WHERE user_id = ?", (user_id,))
        conn.execute("INSERT OR REPLACE INTO username_index (username_hash, user_id) VALUES (?, ?)",
                     (_username_hash(username), user_id))


def _index_remove(user_id):
    with _connect(USERNAME_INDEX_DB, write=True) as conn:
        conn.execute("DELETE FROM username_index WHERE user_id = ?", (user_id,))


def _index_add_quietly(user_id, username):
    """The index is only a cache: if writing to it fails, log it and let the next sync repair it."""
    try:
        _index_add(user_id, username)
    except Exception:
        log.exception("Could not update the username index; sync_username_index() will repair it.")


def check_username(value):
    """
    Live sign-up check. Returns {"valid": bool, "available": bool, "message": str}.
    The answer comes from username_index.db (one primary-key lookup), not from users.db.
    """
    value = value.strip() if isinstance(value, str) else ""
    if not USERNAME_RE.fullmatch(value):
        return {"valid": False, "available": False,
                "message": "Username must be 3-30 characters: letters, numbers, . _ -"}
    with _connect(USERNAME_INDEX_DB) as conn:
        taken = conn.execute("SELECT 1 FROM username_index WHERE username_hash = ?",
                             (_username_hash(value),)).fetchone() is not None
    return {"valid": True, "available": not taken,
            "message": "That username is already taken." if taken else "Username is available."}


def sync_username_index():
    """
    Make username_index.db match users.db: add missing accounts, drop rows of deleted ones.
    Runs at start-up (cheap when nothing differs) and can be called any time. Returns
    (added, removed).
    """
    with _connect(USERS_DB) as conn:
        users = {row["id"]: row["username"] for row in conn.execute("SELECT id, username FROM users")}
    with _connect(USERNAME_INDEX_DB, write=True) as conn:
        indexed = {row[0] for row in conn.execute("SELECT user_id FROM username_index")}
        stale = indexed - users.keys()
        missing = users.keys() - indexed
        for user_id in stale:
            conn.execute("DELETE FROM username_index WHERE user_id = ?", (user_id,))
        for user_id in missing:
            conn.execute("INSERT OR REPLACE INTO username_index (username_hash, user_id) "
                         "VALUES (?, ?)", (_username_hash(users[user_id]), user_id))
    return len(missing), len(stale)


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
            sync_username_index_quietly()      # the index missed this name: repair it now
            raise DuplicateError("That username is already taken.", "username") from None
        raise
    _index_add_quietly(user_id, username)       # keep the fast-lookup index in step
    return {"id": user_id, "username": username, "email": email, "created_at": now}


def sync_username_index_quietly():
    try:
        sync_username_index()
    except Exception:
        log.exception("Could not repair the username index.")


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

    with _connect(USERS_DB) as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ? OR email = ?",
                           (identifier, identifier)).fetchone()
    if row is None:
        _burn_time(password)
        raise AuthError(_BAD_LOGIN)

    now = _now()
    if row["locked_until"] and row["locked_until"] > now:
        raise AuthError("Too many failed attempts. Try again in a few minutes.")

    password_matches = check_password_hash(row["password_hash"], password)

    with _connect(USERS_DB, write=True) as conn:
        current = conn.execute("SELECT * FROM users WHERE id = ?", (row["id"],)).fetchone()
        if current is None:
            raise AuthError(_BAD_LOGIN)

        now = _now()
        if current["locked_until"] and current["locked_until"] > now:
            raise AuthError("Too many failed attempts. Try again in a few minutes.")
        if current["password_hash"] != row["password_hash"]:
            raise AuthError(_BAD_LOGIN)

        if not password_matches:
            failures = current["failed_logins"] + 1
            if failures >= MAX_FAILED_LOGINS:
                conn.execute("UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?",
                             (_minutes_from_now(LOCK_MINUTES), row["id"]))
            else:
                conn.execute("UPDATE users SET failed_logins = ? WHERE id = ?",
                             (failures, row["id"]))
        else:
            if not current["is_active"]:
                raise AuthError("This account has been disabled.")
            conn.execute("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? "
                         "WHERE id = ?", (now, row["id"]))
            return _public_user(current)

    raise AuthError(_BAD_LOGIN)


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
    try:
        _index_remove(user_id)                  # free the username in the index too
    except Exception:
        log.exception("Could not remove the user from the username index.")


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


def _previous_entry(conn, user_id, translation_id):
    """The same user's most recent entry before this one (and only that one), or None."""
    return conn.execute(
        "SELECT id, created_at, repeat_count, status, error_stage, error_message, "
        "source_language_id, target_language_id, source_code, target_code "
        "FROM translations WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT 1",
        (user_id, translation_id)).fetchone()


def _same_request(previous, current):
    """Same user (already guaranteed by the query), same languages, same source code."""
    return (previous is not None
            and previous["source_language_id"] == current["source_language_id"]
            and previous["target_language_id"] == current["target_language_id"]
            and previous["source_code"] == current["source_code"])


def _merge_into(conn, previous, translation_id):
    """Count one more repeat on the earlier entry and drop the duplicate pending row."""
    conn.execute("UPDATE translations SET repeat_count = repeat_count + 1 WHERE id = ?",
                 (previous["id"],))
    conn.execute("DELETE FROM translations WHERE id = ?", (translation_id,))
    return {"id": previous["id"], "created_at": previous["created_at"],
            "repeat_count": previous["repeat_count"] + 1, "merged": True}


def _pending_row(conn, translation_id, user_id):
    return conn.execute(
        "SELECT id, created_at, source_language_id, target_language_id, source_code "
        "FROM translations WHERE id = ? AND user_id = ? AND status = 'pending'",
        (translation_id, user_id)).fetchone()


def complete_translation(translation_id, user_id, target_code):
    """
    pending -> completed.

    If the user's previous entry is a completed translation with the same languages, the same
    source code AND the same result, nothing new is stored: that entry's repeat_count goes up by
    one and the pending row is dropped. Otherwise the row is completed normally.

    Returns None if the row could not be completed, otherwise
        {"id", "created_at", "repeat_count", "merged"}
    where id/created_at belong to the row to show (the earlier one when merged).
    """
    if not isinstance(target_code, str) or not target_code.strip():
        raise ValidationError("There is no translated code to record.", "target_code")
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        current = _pending_row(conn, translation_id, user_id)
        if current is None:
            return None
        previous = _previous_entry(conn, user_id, translation_id)
        if (_same_request(previous, current) and previous["status"] == "completed"
                and previous["target_code"] == target_code):
            return _merge_into(conn, previous, translation_id)

        conn.execute(
            "UPDATE translations SET status = 'completed', target_code = ?, finished_at = ? "
            "WHERE id = ?", (target_code, _now(), translation_id))
        _prune_history(conn, user_id)
        return {"id": translation_id, "created_at": current["created_at"],
                "repeat_count": 1, "merged": False}


def fail_translation(translation_id, user_id, stage, message):
    """
    pending -> failed, remembering which step failed and why. Returns True if handled.
    Like complete_translation: if the user's previous entry is the same request (languages and
    source code) that failed at the same stage with the same message, that entry's repeat_count
    goes up by one instead of a new failed row being kept.
    """
    if stage not in ERROR_STAGES:
        raise ValueError(f"stage must be one of {ERROR_STAGES}")
    message = (message or "Unknown error.").strip()[:MAX_ERROR_CHARS] or "Unknown error."
    with _connect(TRANSLATIONS_DB, write=True) as conn:
        current = _pending_row(conn, translation_id, user_id)
        if current is None:
            return False
        previous = _previous_entry(conn, user_id, translation_id)
        if (_same_request(previous, current) and previous["status"] == "failed"
                and previous["error_stage"] == stage and previous["error_message"] == message):
            _merge_into(conn, previous, translation_id)
            return True
        conn.execute(
            "UPDATE translations SET status = 'failed', error_stage = ?, error_message = ?, "
            "finished_at = ? WHERE id = ?", (stage, message, _now(), translation_id))
        return True


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
    t.created_at, t.finished_at, t.repeat_count,
    sl.name AS source_language, tl.name AS target_language"""
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
        "repeat_count": row["repeat_count"],
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