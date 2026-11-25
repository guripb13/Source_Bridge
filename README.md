# Source Bridge

Source Bridge is a browser-based workspace for translating code between programming languages.
It combines a Flask/Python backend, a plain HTML/CSS/JavaScript frontend, Google's Gemini API,
and optional compiler tools installed on the host.

The main application is served from `backend/main.py`. The frontend has no Node.js build step.

## What you can do

- **Translate code:** choose source and target languages, enter or upload code, and stream a
  Gemini-generated translation into the result editor. Known incompatible language families are
  rejected before the AI request.
- **Guide the result:** select design suggestions or add up to 100 characters of custom
  instructions.
- **Edit and export:** use editor conveniences, copy or download results, and switch between light
  and dark themes.
- **Compile and run:** run Python, Java, C, or C++ code. Programs can request input interactively.
- **Work as a guest:** translate and run code without creating an account. Guests have separate
  server-enforced limits of three translation requests and three compile/run requests per browser
  session.
- **Keep work:** guest bookmarks are kept in the browser. Signed-in users can access translation
  history, including failed attempts, and save completed translations to their account.

> **Code execution warning:** the server runs supported source code during translation preflight
> and when a user selects Run. The compiler applies time, output, and (where supported) resource
> limits, but it is not a complete security sandbox. Do not expose this service to untrusted users
> without isolating code execution in a restricted container or separate service.

## How translation works

1. Select the source and target languages and enter code in the workspace.
2. Optionally upload a supported source file or add design instructions.
3. The server validates the request. When the source is recognized as Python, Java, C, or C++,
   it compiles and runs that source as a preflight check. Code that fails this check is not sent to
   Gemini.
4. The server checks known language-family compatibility and requests a translation from Gemini.
5. The response streams to the browser. Signed-in attempts are recorded in History; guests'
   translations are not stored on the server.

The preflight can execute source code even when the user has not pressed Run. Review the code
execution warning above before deploying the application publicly.

## Run locally

Requirements:

- Python 3.9 or newer
- The pinned packages in `requirements.txt`
- A Gemini API key
- Python, a Java JDK, and C/C++ toolchains for the corresponding compile/run features and
  translation preflight checks

### Windows PowerShell

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
py -m pip install -r requirements.txt
$env:GEMINI_API_KEY = "your-gemini-api-key"
$env:COOKIE_SECURE = "0"
py .\backend\main.py
```

### macOS or Linux

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export GEMINI_API_KEY="your-gemini-api-key"
export COOKIE_SECURE=0
python backend/main.py
```

Open <http://127.0.0.1:5000>. `COOKIE_SECURE=0` is only for local HTTP development; production
should use HTTPS and the default secure-cookie setting. Set a persistent, randomly generated
`SECRET_KEY` for deployments:

```sh
python -c "import secrets; print(secrets.token_hex(32))"
```

`env.example` lists supported environment variables. It is a reference file and is not loaded
automatically.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Required main Gemini API key. |
| `GEMINI_API_KEY_2` | Optional backup key for eligible provider-side failures. |
| `GEMINI_MODEL` | Optional main model; defaults to `gemini-3.5-flash-lite` in the current backend. |
| `GEMINI_MODEL_2` | Optional backup model; defaults to the main model. |
| `SECRET_KEY` | Recommended persistent Flask session-signing key. If unset, the backend obtains a key from its database. |
| `COOKIE_SECURE` | Defaults to secure cookies. Set to `0` only for local HTTP development. |
| `DATABASE_DIR` | Optional directory for the SQLite databases; defaults to `backend/data`. |
| `LIMITER_STORAGE_URI` | Flask-Limiter storage URI; defaults to in-memory storage. Use shared storage for a multi-worker deployment. |
| `ALLOWED_HOSTS` | Optional comma-separated public hosts for deployments where a proxy rewrites the host. |
| `USERNAME_INDEX_KEY` | Optional separate secret for the keyed username lookup index. |

## Main endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /` | Serve the application. |
| `GET /me` | Return the current authentication state and, for guests, usage counts. |
| `GET /username-available?username=...` | Check username validity and availability during sign-up. |
| `POST /signup`, `POST /login`, `POST /logout` | Create an account, sign in, and sign out. |
| `DELETE /account` | Delete the signed-in account after password confirmation. |
| `POST /send` | Translate submitted source code; the frontend requests an NDJSON event stream. |
| `POST /execute` | Compile and run Python, Java, C, or C++ code. |
| `GET /translations` | List a signed-in user's history; supports pagination and saved-only results. |
| `GET /translations/<id>` | Read one owned translation with its full source and result. |
| `POST /translations/<id>/save` | Save or unsave a completed translation. |
| `DELETE /translations/<id>` | Delete an owned history entry. |

Account and history routes require the appropriate authenticated session. See
[SIGN_IN.md](./SIGN_IN.md) for the account flow and storage details.

## Repository map

```text
backend/
  main.py                 Flask app, API routes, translation stream, and account/session flow
  compiler.py             Compile/run and source-code preflight helpers
  convertibility.py       Language-family compatibility checks
  database.py             SQLite accounts, guest usage, saved translations, and history
  requirements.txt        Backend dependency list
frontend/
  templates/index.html    Main page, editors, dialogs, and navigation
  static/css/             Layout, responsive styles, themes, and components
  static/js/main.js       Frontend entry point
  static/js/account/      Authentication and account dialogs
  static/js/core/         Shared configuration, state, storage, and feedback
  static/js/editor/       Editor behavior and resizing
  static/js/files/        Upload, copy, and download
  static/js/history/      Translation history
  static/js/languages/    Language selection and presentation
  static/js/run/          Compiler terminal and interactive input
  static/js/saved/        Browser and account-backed saved results
  static/js/translate/    Translation requests, streaming, and personalization
  static/js/ui/           Navigation, themes, dialogs, and buttons
requirements.txt          Pinned application dependencies
env.example               Environment variable reference
vercel.json               Vercel routing configuration
explaination.md           Detailed project explanation
SIGN_IN.md                Sign-in and account behavior
```

## Data and deployment

- The backend creates `users.db`, `translations.db`, and `username_index.db` under
  `DATABASE_DIR` (or `backend/data`) on startup.
- Guest counters are server-authoritative; the browser's local-storage counter is only a display
  mirror. Clearing the guest cookie can create a new guest session.
- Keep the database directory on persistent storage if accounts and history must survive restarts.
  Vercel's local filesystem is temporary, so the default SQLite setup is not durable there.
- `SECRET_KEY` should remain stable across restarts and private. Do not commit credentials,
  database files, or `.env` files.
- The default rate-limit storage is in memory. Multi-worker deployments need shared storage such
  as Redis so limits are consistent between workers.
- Password reset and email verification are not implemented.

For a fuller walkthrough of the application flow and components, read
[explaination.md](./explaination.md). For account-specific behavior, read
[SIGN_IN.md](./SIGN_IN.md).
