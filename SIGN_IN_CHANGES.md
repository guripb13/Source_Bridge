# Sign-in, History and Saved: front-end connected to the back-end

The back-end (`backend/main.py`, `backend/database.py`) already had accounts and history.
The front-end never called it. This change connects the two.

## What a person can now do
- **Sign in / Create account / Sign out** from the header button (same green pill style as the app).
- **Account dialog**: username, email, member-since, View history, Sign out, Delete account (asks for the password).
- **History** (sidebar): every translation while signed in, finished or failed, with filters
  All / Completed / Failed / Saved, "Load more", Open, bookmark, and two-click Delete.
  Failed rows show which step failed (source check, language support, translation service).
- **Saved**: signed in -> bookmarks are stored on the account; signed out -> still saved in the browser as before.
- Visitors can still translate without an account; nothing is stored for them.

## Files added
| File | Purpose |
|---|---|
| `frontend/static/js/account/api.js` | one fetch wrapper (cookie, JSON, friendly errors) |
| `frontend/static/js/account/session.js` | who is signed in, `/me`, login, signup, logout, delete account |
| `frontend/static/js/account/auth-dialog.js` | sign-in / sign-up form, validation, password strength, account dialog |
| `frontend/static/js/history/history.js` | History page |
| `frontend/static/js/saved/cloud.js` | server side of Saved / History |
| `frontend/static/css/account.css` | dialogs, header button, password meter (light + dark) |
| `frontend/static/css/history.css` | History cards, filters, status chips |

## Files changed
`frontend/templates/index.html` (dialog markup, confirm-password field, 2 stylesheet links),
`js/main.js`, `js/core/config.js`, `js/core/state.js`, `js/ui/navigation.js` (History is now a real page),
`js/ui/buttons.js`, `js/saved/saved.js`, `js/saved/store.js`, `js/translate/translate.js`
(keeps the server's `translation_id` so a result can be bookmarked), `js/translate/errors.js` (one message),
`backend/main.py` (Origin check, see below), `env.example` (`ALLOWED_HOSTS`).

## Security
- Password: sent once over the page's own origin, never stored or logged, fields are emptied on close and
  after a failed attempt. Stored by the server as a salted PBKDF2-SHA256 hash (600,000 rounds).
- Login cookie: `HttpOnly` (JavaScript cannot read it), `SameSite=Lax`, `Secure` in production.
- **New:** the server refuses any POST/DELETE whose `Origin` header is another site (`403`).
  If you host behind a proxy that rewrites the Host header, set `ALLOWED_HOSTS=your.domain`.
- Sign-in errors are generic ("Incorrect username/email or password"), a locked account is paused 15 minutes
  after 5 wrong passwords (server), sign-in/sign-up are rate limited (server).
- All text from the server or from stored code is inserted with `textContent` (no HTML injection),
  and no inline scripts/styles are used, so the strict Content-Security-Policy still passes.
- If the session expires while the page is open, the page signs itself out and says so.

## Run locally
```
pip install -r requirements.txt
export GEMINI_API_KEY="your-key"
export COOKIE_SECURE=0      # REQUIRED on http://localhost, otherwise the browser drops the login cookie
python backend/main.py
```

## Things to know
1. **Hosting on Vercel**: the disk is temporary, so `users.db` / `translations.db` are wiped when the function
   restarts and accounts would disappear. Use a host with a persistent disk (set `DATABASE_DIR`) or move the same
   tables to a hosted database before relying on accounts in production.
2. `backend/data/users.db` in your zip holds a user row and the cookie-signing key. Do not commit or share it;
   set `SECRET_KEY` in the environment instead.
3. Not included (needs an email service): "Forgot password" and email verification.
4. Browser-saved translations are not copied into an account; they stay in the browser and show again after sign-out.
