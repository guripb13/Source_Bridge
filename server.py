import os
import re
import json
from datetime import timezone

from flask import Flask, request, render_template, Response, session, jsonify
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from werkzeug.security import check_password_hash
from google import genai
from google.genai import types

# --- CHANGED: added purge_expired_translations to the import ---
# This was the bug: server.py called purge_expired_translations() below
# but never imported it, so the app would crash on startup with a
# NameError. This is the function we wrote in database.py step 6.
from database import db, User, Translation, LOGIN_DUMMY_HASH, purge_expired_translations

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "2f0ba1616d552516fd562e6cdb953cc064f1bf39c8f77ece1042aed74aee4481")
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///sourcebridge.db"
db.init_app(app)

with app.app_context():
    db.create_all()
    purge_expired_translations()  # sweeps trash older than TRASH_RETENTION_DAYS on every boot

limiter = Limiter(get_remote_address, app=app, default_limits=[])

client = genai.Client(api_key="AIzaSyCnDB53ztXXPpBnVh7BypkoBg08VSC47gk") # Replace with your actual API key


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


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()
    language = request.form.get("language", "Java").strip() or "Java"
    logged_in_user_id = session.get("user_id")
    # Opt in explicitly; existing callers still receive the original plain text.
    use_events = request.headers.get("Accept", "").strip().lower() == "application/x-ndjson"

    def event(kind, **data):
        return json.dumps({"type": kind, **data}, ensure_ascii=True) + "\n"

    def generate():
        if not text:
            if use_events:
                yield event("error", message="Please provide some source code.")
            return

        chunks = []

        try:
            for chunk in client.models.generate_content_stream(
                model="gemini-3.6-flash",
                contents=text,
                config=types.GenerateContentConfig(
                    system_instruction=build_task(language)
                ),
            ):
                if chunk.text:
                    chunks.append(chunk.text)
                    yield event("chunk", text=chunk.text) if use_events else chunk.text

        except Exception as e:
            message = f"Error: {e}"
            yield event("error", message=message) if use_events else message
            return

        translated_code = "".join(chunks)

        # Skip empty results and the AI's input-validation errors.
        if (
            not translated_code.strip()
            or translated_code.lstrip().lower().startswith("error:")
        ):
            if use_events:
                yield event(
                    "error",
                    message=translated_code.strip() or "No code was returned. Please try again.",
                )
            return

        # Save only after generation finishes successfully.
        translation_id = None
        created_at = None
        with app.app_context():
            try:
                translation = Translation(
                    user_id=logged_in_user_id,
                    source_code=text,
                    translated_code=translated_code,
                    target_language=language,
                    is_saved=False,
                )

                db.session.add(translation)
                db.session.flush()
                committed_id = translation.id
                committed_at = translation.created_at.replace(tzinfo=timezone.utc).isoformat()
                db.session.commit()
                translation_id = committed_id
                created_at = committed_at

            except Exception:
                db.session.rollback()
                app.logger.exception(
                    "Translation completed, but saving to the database failed."
                )

        # This is a separate event, never part of the translated source code.
        # The ID is sent only after commit succeeds, so it identifies this result.
        if use_events:
            yield event(
                "complete",
                translation_id=translation_id,
                user_id=logged_in_user_id,
                is_saved=False,
                created_at=created_at,
                persisted=translation_id is not None,
            )

    response = Response(
        generate(),
        mimetype="application/x-ndjson" if use_events else "text/plain",
    )
    if use_events:
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Accel-Buffering"] = "no"
    return response


@app.route("/register", methods=["POST"])
def register():
    if not request.is_json:
        return jsonify(error="Send the details as JSON."), 415

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify(error="Invalid registration details."), 400

    name = data.get("name")
    email = data.get("email")
    password = data.get("password")

    if not all(isinstance(value, str) for value in (name, email, password)):
        return jsonify(
            error="Name, email and password are required as text."
        ), 400

    name = name.strip()
    email = email.strip().lower()

    if not 1 <= len(name) <= 100:
        return jsonify(error="Name must contain 1–100 characters."), 400

    if (
        len(email) > 254
        or re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) is None
    ):
        return jsonify(error="Enter a valid email address."), 400

    if not 8 <= len(password) <= 128 or not password.strip():
        return jsonify(
            error="Password must contain 15–128 characters and cannot be blank."
        ), 400

    try:
        user = User(name=name, email=email)
        user.set_password(password)

        db.session.add(user)
        db.session.commit()

    except IntegrityError:
        db.session.rollback()
        return jsonify(error="This email is already registered."), 409

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Account registration failed.")
        return jsonify(
            error="Could not create the account. Please try again."
        ), 500

    return jsonify(message="Account created successfully."), 201


@app.route("/login", methods=["POST"])
@limiter.limit("5 per minute")
def login():
    if not request.is_json:
        return jsonify(error="Send the details as JSON."), 415

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify(error="Invalid login details."), 400

    email = data.get("email")
    password = data.get("password")

    if not isinstance(email, str) or not isinstance(password, str):
        return jsonify(error="Email and password are required as text."), 400

    email = email.strip().lower()

    if not email or len(email) > 254 or not 1 <= len(password) <= 128:
        return jsonify(error="Incorrect email or password."), 401

    try:
        user = db.session.execute(
            db.select(User).where(User.email == email)
        ).scalar_one_or_none()

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Login database lookup failed.")
        return jsonify(error="Could not log in. Please try again."), 500

    password_matches = (
        user.check_password(password)
        if user is not None
        else check_password_hash(LOGIN_DUMMY_HASH, password)
    )

    if user is None or not password_matches:
        return jsonify(error="Incorrect email or password."), 401

    session.clear()
    session["user_id"] = user.id

    return jsonify(message="Logged in successfully.")


@app.route("/me", methods=["GET"])
def current_user():
    user_id = session.get("user_id")

    try:
        user = db.session.get(User, user_id) if user_id is not None else None

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Current-user database lookup failed.")
        return jsonify(error="Could not check the login session."), 500

    if user is None:
        session.pop("user_id", None)

    response = jsonify(
        authenticated=user is not None,
        user={
            "id": user.id,
            "name": user.name,
            "email": user.email,
        } if user is not None else None,
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/logout", methods=["POST"])
def logout():
    if not request.is_json:
        return jsonify(error="Send the request as JSON."), 415

    if not isinstance(request.get_json(silent=True), dict):
        return jsonify(error="Invalid logout request."), 400

    session.clear()
    return jsonify(message="Logged out successfully.")


@app.errorhandler(429)
def login_rate_limit_exceeded(error):
    return jsonify(
        error="Too many login attempts. Wait one minute and try again."
    ), 429


@app.route("/history", methods=["GET"])
def translation_history():
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to view your history."), 401

    page_number = request.args.get("page", default=1, type=int)

    if not 1 <= page_number <= 1_000_000:
        return jsonify(error="Invalid page number."), 400

    try:
        user = db.session.get(User, user_id)

        if user is None:
            session.clear()
            return jsonify(error="Please sign in again."), 401

        history = db.paginate(
            db.select(Translation)
            .where(
                Translation.user_id == user_id,
                # CHANGED: history now only shows active (non-trashed) rows.
                # Without this filter, deleted items would still show up here.
                Translation.deleted_at.is_(None),
            )
            .order_by(Translation.id.desc()),
            page=page_number,
            per_page=20,
            max_per_page=20,
            error_out=False,
        )

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not load translation history.")
        return jsonify(error="Could not load history. Please try again."), 500

    response = jsonify(
        page=history.page,
        total_pages=history.pages,
        total_translations=history.total,
        translations=[
            {
                "id": item.id,
                "user_id": item.user_id,
                "source_code": item.source_code,
                "translated_code": item.translated_code,
                "target_language": item.target_language,
                "is_saved": item.is_saved,
                "created_at": item.created_at.replace(
                    tzinfo=timezone.utc
                ).isoformat(),
            }
            for item in history.items
        ],
    )

    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/translations/<int:translation_id>/save", methods=["POST"])
def set_translation_saved(translation_id):
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to save translations."), 401

    if not request.is_json:
        return jsonify(error="Send the request as JSON."), 415

    data = request.get_json(silent=True)

    if (
        not isinstance(data, dict)
        or not isinstance(data.get("is_saved"), bool)
    ):
        return jsonify(error="is_saved must be true or false."), 400

    is_saved = data["is_saved"]

    try:
        user = db.session.get(User, user_id)

        if user is None:
            session.clear()
            return jsonify(error="Please sign in again."), 401

        translation = db.session.execute(
            db.select(Translation).where(
                Translation.id == translation_id,
                Translation.user_id == user_id,
            )
        ).scalar_one_or_none()

        if translation is None:
            return jsonify(error="Translation not found."), 404

        translation.is_saved = is_saved
        db.session.commit()

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not update saved translation.")
        return jsonify(
            error="Could not update the translation. Please try again."
        ), 500

    response = jsonify(
        message=(
            "Translation saved."
            if is_saved
            else "Translation removed from Saved."
        ),
        id=translation_id,
        is_saved=is_saved,
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/saved", methods=["GET"])
def saved_translations():
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to view saved translations."), 401

    try:
        page_number = int(request.args.get("page", "1"))
    except (TypeError, ValueError):
        return jsonify(error="Invalid page number."), 400

    if not 1 <= page_number <= 1_000_000:
        return jsonify(error="Invalid page number."), 400

    try:
        user = db.session.get(User, user_id)

        if user is None:
            session.clear()
            return jsonify(error="Please sign in again."), 401

        saved = db.paginate(
            db.select(Translation)
            .where(
                Translation.user_id == user_id,
                Translation.is_saved.is_(True),
                # CHANGED: same reasoning as /history above — don't show
                # trashed items just because they were once starred.
                Translation.deleted_at.is_(None),
            )
            .order_by(Translation.id.desc()),
            page=page_number,
            per_page=20,
            max_per_page=20,
            error_out=False,
        )

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not load saved translations.")
        return jsonify(
            error="Could not load saved translations. Please try again."
        ), 500

    response = jsonify(
        page=saved.page,
        total_pages=saved.pages,
        total_translations=saved.total,
        translations=[
            {
                "id": item.id,
                "user_id": item.user_id,
                "source_code": item.source_code,
                "translated_code": item.translated_code,
                "target_language": item.target_language,
                "is_saved": item.is_saved,
                "created_at": item.created_at.replace(
                    tzinfo=timezone.utc
                ).isoformat(),
            }
            for item in saved.items
        ],
    )

    response.headers["Cache-Control"] = "no-store"
    return response


# ============================================================
# NEW: Recycle bin routes
# All four follow the same rhythm from database.py step 7:
# fetch -> mutate -> commit. None of these write raw SQL.
# ============================================================


@app.route("/translations/<int:translation_id>", methods=["DELETE"])
def delete_translation(translation_id):
    """Move a translation to the recycle bin (soft delete)."""
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to delete translations."), 401

    try:
        translation = db.session.execute(
            db.select(Translation).where(
                Translation.id == translation_id,
                Translation.user_id == user_id,
                Translation.deleted_at.is_(None),  # can't delete what's already trashed
            )
        ).scalar_one_or_none()

        if translation is None:
            return jsonify(error="Translation not found."), 404

        translation.soft_delete()  # sets deleted_at = now(), defined in database.py
        db.session.commit()

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not delete translation.")
        return jsonify(error="Could not delete the translation. Please try again."), 500

    return jsonify(message="Moved to trash.", id=translation_id)


@app.route("/trash", methods=["GET"])
def trash_list():
    """List everything currently in the recycle bin for the logged-in user."""
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to view trash."), 401

    page_number = request.args.get("page", default=1, type=int)

    if not 1 <= page_number <= 1_000_000:
        return jsonify(error="Invalid page number."), 400

    try:
        trashed = db.paginate(
            db.select(Translation)
            .where(
                Translation.user_id == user_id,
                Translation.deleted_at.is_not(None),  # opposite filter from /history
            )
            .order_by(Translation.deleted_at.desc()),
            page=page_number,
            per_page=20,
            max_per_page=20,
            error_out=False,
        )

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not load trash.")
        return jsonify(error="Could not load trash. Please try again."), 500

    response = jsonify(
        page=trashed.page,
        total_pages=trashed.pages,
        total_translations=trashed.total,
        translations=[
            {
                "id": item.id,
                "source_code": item.source_code,
                "translated_code": item.translated_code,
                "target_language": item.target_language,
                "deleted_at": item.deleted_at.replace(tzinfo=timezone.utc).isoformat(),
            }
            for item in trashed.items
        ],
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/translations/<int:translation_id>/restore", methods=["POST"])
def restore_translation(translation_id):
    """Bring a translation back out of the recycle bin."""
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to restore translations."), 401

    try:
        translation = db.session.execute(
            db.select(Translation).where(
                Translation.id == translation_id,
                Translation.user_id == user_id,
                Translation.deleted_at.is_not(None),  # only trashed items can be restored
            )
        ).scalar_one_or_none()

        if translation is None:
            return jsonify(error="Translation not found in trash."), 404

        translation.restore()  # sets deleted_at = None, defined in database.py
        db.session.commit()

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not restore translation.")
        return jsonify(error="Could not restore the translation. Please try again."), 500

    return jsonify(message="Restored.", id=translation_id)


@app.route("/translations/<int:translation_id>/permanent", methods=["DELETE"])
def permanently_delete_translation(translation_id):
    """Hard delete — removes the row for real. Only allowed from trash."""
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to delete translations."), 401

    try:
        translation = db.session.execute(
            db.select(Translation).where(
                Translation.id == translation_id,
                Translation.user_id == user_id,
                Translation.deleted_at.is_not(None),  # safety: must already be trashed
            )
        ).scalar_one_or_none()

        if translation is None:
            return jsonify(error="Translation not found in trash."), 404

        db.session.delete(translation)  # real deletion, no undo
        db.session.commit()

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not permanently delete translation.")
        return jsonify(error="Could not delete the translation. Please try again."), 500

    return jsonify(message="Permanently deleted.", id=translation_id)


@app.route("/trash/empty", methods=["POST"])
def empty_trash():
    """Permanently delete everything currently in the user's trash."""
    user_id = session.get("user_id")

    if user_id is None:
        return jsonify(error="Please sign in to empty trash."), 401

    try:
        trashed = db.session.execute(
            db.select(Translation).where(
                Translation.user_id == user_id,
                Translation.deleted_at.is_not(None),
            )
        ).scalars().all()

        count = len(trashed)
        for translation in trashed:
            db.session.delete(translation)

        if count:
            db.session.commit()

    except SQLAlchemyError:
        db.session.rollback()
        app.logger.exception("Could not empty trash.")
        return jsonify(error="Could not empty trash. Please try again."), 500

    return jsonify(message="Trash emptied.", deleted_count=count)


if __name__ == "__main__":
    app.run(debug=True)