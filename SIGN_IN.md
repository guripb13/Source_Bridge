# Sign-in and account guide

This document describes the account features in the current Source Bridge application. It is a
feature and maintenance guide, not a change log.

## What account features provide

- Create an account with a username, email address, and password.
- Sign in with either the username or the email address and password.
- Choose whether to keep the account signed in on this device.
- Open the account dialog to view account details, open History, sign out, or delete the account.
- Keep translation History and saved translations on the account.

Signing in is optional. Guests can translate and run code within their guest limits; guest
bookmarks remain in browser storage and are not copied into an account later.

## Account form behavior

### Create account

| Field | Rules and browser hint |
| --- | --- |
| Username | 3-30 characters; letters, numbers, `.`, `_`, and `-`. Browser autofill is disabled so an existing email address is not suggested in this field. |
| Email | Must be a valid email address, up to 254 characters. Uses the browser's `email` autocomplete token. |
| Password | 8-128 characters. Uses `new-password` so password managers can offer a generated password here. |
| Confirm password | Must match the password. Autofill is disabled so password generation is offered for the primary password field rather than confirmation. |

The page checks username availability while the user types. The server checks availability again
when the account is submitted; the live check is only a convenience. A newly created account is
signed in immediately.

### Sign in

The identifier accepts either a username or an email address and uses the browser's `username`
autocomplete hint. The password uses `current-password`. Sign-in errors are intentionally generic
so the form does not reveal whether a particular username or email is registered.

The browser can only offer saved credentials or generated passwords when its password manager
supports the form and has suitable saved data. The autocomplete hints guide the browser; they do
not create or store credentials.

### Password rules and protection

- The server is authoritative and requires passwords to be 8-128 characters.
- Passwords are hashed with Werkzeug's salted PBKDF2-SHA256 configuration; plaintext passwords
  are not stored in the account database.
- Five consecutive incorrect password attempts pause that account for 15 minutes.
- Sign-up and sign-in endpoints are rate limited. The sign-in form reports failures without
  identifying which part of the credentials was incorrect.
- Password reset and email verification are not implemented.

## "Keep me signed in"

When enabled, the session cookie is persistent for up to 30 days and is renewed on visits. When
disabled, the browser receives a session cookie and the server also ends that login when the
application page is loaded or refreshed. The choice applies to this browser on this device.

The session is a Flask-signed cookie; the browser cannot read it through JavaScript because it is
`HttpOnly`. The cookie uses `SameSite=Lax` and is `Secure` by default. For local HTTP development
only, set `COOKIE_SECURE=0`; production should use HTTPS and leave secure cookies enabled.

## Account and history lifecycle

1. On page startup, the frontend requests `GET /me` and displays either the signed-in account
   control or the guest sign-in control.
2. The sign-in or sign-up form sends credentials to the same-origin backend as JSON.
3. The server validates the data, creates or verifies the account, then returns public account
   details and sets the signed session cookie.
4. The frontend updates its shared authentication state and notifies other UI modules.
5. Signed-in translations are recorded in History as completed or failed attempts. Guests'
   translations are not added to server History.
6. Completed translations may be bookmarked. Failed attempts can be reviewed and deleted but
   cannot be bookmarked.
7. Account deletion requires the current password and removes the account's history. Signing out
   preserves the guest-session identity and its guest usage counters.

The backend keeps up to 500 newest unsaved History entries and up to 100 saved entries per user.
Repeated identical attempts immediately after the previous matching attempt may be grouped by a
repeat counter.

## HTTP endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /me` | Returns authentication state and, for guests, server-side usage counters. |
| `GET /username-available?username=...` | Checks username validity and availability. |
| `POST /signup` | JSON: `username`, `email`, `password`, optional `remember`. Creates and signs in the user. |
| `POST /login` | JSON: `identifier`, `password`, optional `remember`. The identifier may be a username or email. |
| `POST /logout` | Clears the signed-in identity and returns the client to guest mode. |
| `DELETE /account` | JSON: `password`. Deletes the current account and its History. |
| `GET /translations` | Lists the current user's History; supports `saved`, `limit`, and `before_id`. |
| `GET /translations/<id>` | Returns one owned translation with full source and result text. |
| `POST /translations/<id>/save` | JSON: `saved` boolean. Saves or unsaves a completed translation. |
| `DELETE /translations/<id>` | Deletes one History entry owned by the current user. |

History routes require sign-in. Account endpoints are rate limited where configured in
`backend/main.py`. State-changing requests with a cross-origin `Origin` are rejected.

## Storage

By default, the backend creates these SQLite databases under `backend/data`:

| Database | Account-related contents |
| --- | --- |
| `users.db` | Account records, salted password hashes, failed-login state, and guest usage counters. |
| `translations.db` | Signed-in translation History and saved-state information. |
| `username_index.db` | Keyed hashes used for username availability lookups; it does not store readable usernames. |

The users table is the source of truth. The username lookup index can be rebuilt if it is lost.
The history database is a separate file, so account deletion removes that user's records from it.

Keep these files private and use persistent storage for production data. Vercel's local filesystem
is temporary; the default SQLite databases there are not durable across restarts. Configure
`DATABASE_DIR` to point to a persistent directory on a suitable host, or use a hosted database.

## Implementation map

| File | Responsibility |
| --- | --- |
| `frontend/templates/index.html` | Account form fields, account dialogs, and account button markup. |
| `frontend/static/js/account/auth-dialog.js` | Form modes, client-side validation, account dialogs, and account button rendering. |
| `frontend/static/js/account/session.js` | Session loading and sign-in, sign-up, sign-out, and deletion requests. |
| `frontend/static/js/account/api.js` | Same-origin account API requests and response/error handling. |
| `frontend/static/js/core/state.js` | Shared frontend authentication state. |
| `frontend/static/js/saved/` and `frontend/static/js/history/` | Guest/account bookmarks and signed-in History UI. |
| `frontend/static/css/account.css` | Account button and account dialog styles. |
| `frontend/static/css/history.css` | History cards, filters, and status presentation. |
| `backend/main.py` | Account routes, cookie/session policy, Origin checks, and rate limits. |
| `backend/database.py` | Account validation, password hashing, session lookup data, History, and SQLite persistence. |

## Local development

From the repository root, install `requirements.txt`, set `GEMINI_API_KEY`, and run
`backend/main.py`. Set `COOKIE_SECURE=0` only when testing over local HTTP. The full setup,
environment-variable reference, and deployment cautions are in [README.md](./README.md).
