from datetime import datetime, timedelta, timezone

from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()

# Precomputed hash of a random value, used to run check_password_hash()
# against a non-existent user so login timing doesn't reveal whether an
# email is registered.
LOGIN_DUMMY_HASH = generate_password_hash("dummy-password-for-timing-safety")

# How long a trashed translation is kept before it's eligible for
# permanent deletion. Used by purge_expired_translations() below.
TRASH_RETENTION_DAYS = 30


class User(db.Model):
    __tablename__ = "user"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(254), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(
        db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc)
    )

    translations = db.relationship("Translation", backref="user", lazy=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Translation(db.Model):
    __tablename__ = "translation"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=True)

    source_code = db.Column(db.Text, nullable=False)
    translated_code = db.Column(db.Text, nullable=False)

    # Auto-detected at translation time (not user-entered).
    
    target_language = db.Column(db.String(50), nullable=False)

    # "Starred" flag — independent from trash/deleted_at.
    is_saved = db.Column(db.Boolean, nullable=False, default=False)

    created_at = db.Column(
        db.DateTime, nullable=False, default=lambda: datetime.now(timezone.utc)
    )

    # NULL = active. A timestamp = sitting in the recycle bin since then.
    deleted_at = db.Column(db.DateTime, nullable=True)

    # ---- convenience helpers, keep the soft-delete logic in one place ----

    def soft_delete(self):
        self.deleted_at = datetime.now(timezone.utc)

    def restore(self):
        self.deleted_at = None

    @property
    def is_deleted(self):
        return self.deleted_at is not None


def purge_expired_translations(retention_days=TRASH_RETENTION_DAYS):
    """
    Permanently deletes translations that have been sitting in the
    recycle bin for longer than `retention_days`.

    Call this once at app startup, and/or wire it to a scheduled
    job (cron, APScheduler, etc). Returns the number of rows removed.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

    expired = db.session.execute(
        db.select(Translation).where(
            Translation.deleted_at.is_not(None),
            Translation.deleted_at < cutoff,
        )
    ).scalars().all()

    count = len(expired)
    for translation in expired:
        db.session.delete(translation)

    if count:
        db.session.commit()

    return count