# Source Bridge: project explanation

This document describes the application that is currently served from this repository.

## 1. What the website does

Source Bridge is a browser workspace for translating source code and reviewing the result. A user
chooses source and target languages, edits or uploads source text, optionally adds design
instructions, and sends a translation request to the Python backend. The backend checks the
request, applies language compatibility rules, and streams a Gemini response back to the browser.

The workspace also includes:

- Editors for source and translated code, with line numbers, paired brackets/quotes, indentation,
  and adjustable editor height.
- File upload for supported Python, Java, C, and C++ source files (up to 1 MiB).
- Copy and download actions for translated output.
- A compiler terminal for running Python, Java, C, and C++ programs, including interactive input.
- Guest bookmarks stored in the browser and account-backed translation history and bookmarks.
- Light/dark themes, language selection, a responsive sidebar, help, settings, and personalization
  controls.

Translation supports more language families than the compiler does. The compiler can build and run
only Python, Java, C, and C++ on the host. A generated translation is not guaranteed to be correct;
review and test it before using it.

## 2. Application architecture

There is no frontend package manager or build step. Flask serves the HTML template and static
assets directly.

```text
Browser
  frontend/templates/index.html
  frontend/static/css/
  frontend/static/js/
        | same-origin HTTP requests
        v
Flask application (backend/main.py)
  ├── Gemini API          translation generation
  ├── compiler.py         source preflight and Run feature
  ├── convertibility.py   known language-pair checks
  └── database.py         SQLite account, guest quota, and history storage
```

`backend/main.py` creates the Flask app, configures security and rate limits, initializes the
database, and defines the HTTP routes. It locates the template and static directories under
`frontend/`. The browser entry point is `frontend/static/js/main.js`, which initializes the
feature modules.

## 3. Page startup and browser state

1. Flask returns `frontend/templates/index.html`, which contains the page structure, dialogs, and
   SVG icon sprite.
2. The browser loads the CSS files in the order listed by the template and loads `main.js` as an
   ES module.
3. Frontend modules initialize the editor, language controls, navigation, dialogs, themes, saved
   translations, and compiler UI.
4. The account/session module requests `GET /me`. The response identifies the signed-in user or
   returns guest usage counters. The server response is authoritative.
5. Local preferences such as the theme, sidebar state, and guest-saved translations use browser
   storage. The browser's guest-usage count is only a display mirror; the server enforces the
   quota.

The frontend is split by responsibility:

| Directory | Responsibility |
| --- | --- |
| `static/js/account/` | Sign-in, sign-up, session state, and account actions. |
| `static/js/core/` | DOM helpers, configuration, state, browser storage, and shared feedback. |
| `static/js/editor/` | Source editor behavior, paired characters, and resizing. |
| `static/js/files/` | File upload, copy, and download. |
| `static/js/history/` | Signed-in history view and paging. |
| `static/js/languages/` | Source and target language selection. |
| `static/js/run/` | Run buttons, output terminal, and interactive input. |
| `static/js/saved/` | Guest and account-backed saved translations. |
| `static/js/translate/` | Translation requests, streaming, errors, and personalization. |
| `static/js/ui/` | Navigation, theme control, dialogs, and button states. |

Styles are separated into `frontend/static/css/` by concern. The main HTML, including the account
forms and application dialogs, is in `frontend/templates/index.html`.

## 4. Translation request lifecycle

The browser sends `POST /send` as multipart form data. The main fields are:

- `message`: source text (maximum 200,000 characters).
- `source_language`: selected source language, when known.
- `language`: target language.
- `instructions`: optional design guidance (maximum 100 characters).

The frontend opts into an NDJSON response stream. The backend emits events as the generation
progresses; the browser updates the output editor as chunks arrive. Other callers that do not
request NDJSON receive plain text.

The backend processes a request in this order:

1. Validate that source text and target language are present and within size limits.
2. Apply the guest translation quota when there is no signed-in user. Guests may make three
   translation requests per browser session.
3. For a recognized Python, Java, C, or C++ source language, perform a preflight by compiling and
   running the submitted source with no supplied input. A failure or timeout stops the request
   before Gemini is called. Other languages may skip this compiler check.
4. Check known language-family compatibility. The compatibility module groups general programming
   languages, SQL dialects, data formats, markup/styling languages, and hardware-description
   languages. It rejects known incompatible families; an unknown language name may pass through
   for the AI to handle.
5. Request a Gemini translation and stream the output back.
6. For signed-in users, complete or fail the corresponding history entry. Guest translations are
   not stored in account history.

The preflight is significant: source code can execute during a translation request, before the
user presses Run. This is a deployment security concern, not merely a validation detail.

## 5. Compile and run lifecycle

The workspace sends `POST /execute` with JSON containing `code`, `language`, and optional input
answers. Only Python, Java, C, and C++ are supported by this route.

For interactive programs, the browser sends all answers collected so far. The compiler starts the
program again with those answers. If the program asks for more input, the response tells the page
what input is needed; the page collects another answer and retries with the expanded answer list.
No waiting process or execution session remains between requests.

The compiler uses temporary working directories and time/output limits. On platforms that support
them, it also applies resource limits. These safeguards do not provide full network or filesystem
isolation. Running untrusted code on the same host as the web service is unsafe without a proper
container or isolated execution service.

## 6. Accounts, History, and Saved

### Guests

- Guests can use translation and compile/run features subject to separate server-enforced limits:
  three translation requests and three compile/run requests per guest browser session.
- Guest usage is associated with a signed session identifier; the database stores a one-way hash
  of that identifier with the counters.
- Guest translation attempts are not written to server-side History.
- Guest bookmarks remain in browser storage.

### Signed-in users

- A person can create an account with a username, email address, and password, or sign in with
  either their username or email address.
- A newly created account is signed in immediately.
- The account dialog provides the account name and email, sign-out, History, and account deletion
  (which requires the password again).
- Translation History stores both completed and failed attempts. It includes the language pair,
  status, timestamps, failure stage/message when relevant, and the source/result text.
- Only completed translations can be saved to the account. History can be paged and filtered to
  saved items.
- Account-backed history is separate from guest browser bookmarks; guest-saved items are not
  automatically copied into an account.

The database keeps up to 500 newest unsaved history entries per user. Saved entries are retained
separately, up to 100 per user. Repeating the same immediately previous request with an identical
outcome may increment its repeat count instead of creating another row.

See [SIGN_IN.md](./SIGN_IN.md) for the account fields, endpoints, cookie behavior, security, and
operational details.

## 7. Data storage

`backend/database.py` creates three SQLite files in `DATABASE_DIR`, defaulting to `backend/data`:

| Database | Contents |
| --- | --- |
| `users.db` | Usernames, email addresses, password hashes, login bookkeeping, settings, and guest counters. |
| `translations.db` | Signed-in translation attempts and the language lookup table. |
| `username_index.db` | A keyed-hash lookup index used for quick username availability checks. |

The users table is the source of truth for accounts. The username index can be rebuilt from it.
The history database is a separate file, so code manages the user/history relationship across the
files.

SQLite files persist on a normal machine or persistent server disk. Serverless filesystems such
as Vercel's are temporary; accounts and history need a persistent volume or hosted database to
survive restarts there.

## 8. Backend modules

| File | Responsibility |
| --- | --- |
| `backend/main.py` | Flask configuration, security headers, same-origin write checks, rate limits, routes, Gemini calls, and request orchestration. |
| `backend/compiler.py` | Compile/run helpers, supported compiler detection, output limits, and interactive-input handling. |
| `backend/convertibility.py` | Normalizes language names and rejects known incompatible source/target categories. |
| `backend/database.py` | SQLite schema, account validation, password hashing, guest quotas, History, and bookmarks. |

## 9. HTTP API overview

| Method and path | Description |
| --- | --- |
| `GET /` | Serve the application. |
| `GET /me` | Return authentication state and guest usage when signed out. |
| `GET /username-available` | Validate/check username availability. |
| `POST /signup` | Create an account and start a session. |
| `POST /login` | Authenticate using username or email and password. |
| `POST /logout` | End the authenticated session while preserving the guest identity. |
| `DELETE /account` | Delete the current account and its History. |
| `POST /send` | Validate, preflight, and translate source code. |
| `POST /execute` | Compile and run supported languages. |
| `GET /translations` | List History, with pagination and saved-only filtering. |
| `GET /translations/<id>` | Fetch an owned History entry and its full code. |
| `POST /translations/<id>/save` | Bookmark/unbookmark a completed entry. |
| `DELETE /translations/<id>` | Delete an owned History entry. |

Protected History and account routes rely on the authenticated session. See the endpoint handling
in `backend/main.py` for request and response shapes.

## 10. Security and operational boundaries

- Passwords are checked and stored as salted PBKDF2-SHA256 hashes; plaintext passwords are not
  stored in SQLite.
- Flask's signed session cookie is `HttpOnly`, `SameSite=Lax`, and secure by default. Local HTTP
  development needs `COOKIE_SECURE=0`; production should use HTTPS and secure cookies.
- State-changing requests with a cross-origin `Origin` are rejected. `ALLOWED_HOSTS` is only for
  trusted deployments where a reverse proxy rewrites the host.
- Account routes and other endpoints have rate limits. The default limiter storage is in memory;
  use shared storage for multiple workers.
- Code compilation and execution are not a complete sandbox. Use an isolated, restricted runtime
  before offering this app to untrusted users.
- The application has no password-reset or email-verification flow.

## 11. Local development

Install dependencies, set `GEMINI_API_KEY`, and run `backend/main.py` from the repository root.
For local HTTP, also set `COOKIE_SECURE=0`. Complete Windows PowerShell and macOS/Linux commands,
configuration details, and deployment notes are in the root [README.md](./README.md).
