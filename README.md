# Source Bridge

Source Bridge is a browser-based workspace for translating code between Python, Java, C, and
C++. It combines an AI translation flow with source and output editors, compiler feedback, and
tools for saving, reviewing, and running code.

## What the website provides

- **Translate code:** choose a source and target language, edit or upload source code, and receive
  the translation as it streams into the output editor.
- **Personalize the result:** select design suggestions or enter up to 100 characters of custom
  preferences. Preferences are sent with the translation request and guide the generated code.
- **Edit comfortably:** use line numbers, automatic bracket and quote pairing, Tab indentation,
  resizable editors, and a responsive layout.
- **Compile and run:** run either editor's code, view compiler output, and respond to interactive
  program input without losing the run context.
- **Manage results:** copy or download translations. Save results in this browser as a guest, or
  sign in to keep saved translations and translation history with your account.
- **Review history:** signed-in users can filter, reopen, bookmark, and delete past completed or
  failed translation attempts.
- **Personalize the workspace:** switch light/dark themes and adjust editor preferences.

## How translation works

1. Select the source and target languages in the browser.
2. Paste or type code into the source editor, or upload a supported source file.
3. Optionally add code-design preferences.
4. The server validates the request, checks source code and language convertibility, then requests
   a translation from Google Gemini.
5. The result streams into the output editor. You can review it, run it, copy it, download it, or
   save it.

Signed-in translation attempts are recorded in History, including failures and their failure
stage. Guest translations are not added to server-side history.

## Project structure

```text
Source_Bridge/
├── backend/
│   ├── main.py                 Flask app, translation stream, accounts, history, and run API
│   ├── compiler.py             Compile/run support for C, C++, Python, and Java
│   ├── convertibility.py       Source/target language compatibility checks
│   ├── database.py             SQLite accounts, saved translations, and history
│   ├── requirements.txt        Backend dependency list
│   ├── data/                   Runtime SQLite data (created automatically)
│   └── Demo tseting/           Older chat-demo prototype; not the main app
├── frontend/
│   ├── templates/
│   │   └── index.html          Main page, editors, dialogs, and navigation
│   ├── static/
│   │   ├── css/                Layout, themes, responsive styles, dialogs, and animations
│   │   ├── js/
│   │   │   ├── main.js         Frontend entry point and module initialization
│   │   │   ├── account/        Authentication and session handling
│   │   │   ├── core/           Shared state, config, storage, and feedback
│   │   │   ├── editor/         Source editor behavior and resizing
│   │   │   ├── files/          Upload, copy, and download
│   │   │   ├── history/        Translation history UI
│   │   │   ├── languages/      Language selection and logos
│   │   │   ├── run/            Compiler terminal and interactive input
│   │   │   ├── saved/          Local and account-backed saved translations
│   │   │   ├── translate/      Translation, streaming, and personalization
│   │   │   └── ui/             Navigation, themes, dialogs, and buttons
│   │   ├── fonts/              Bundled Inter font files and license
│   │   └── icon*.webp/png      App icons
│   ├── Demo testing/           Older chat-demo UI; not served by the main app
│   └── README.md               Frontend module notes
├── env.example                 Environment-variable template
├── requirements.txt            Pinned dependencies for the main app
├── vercel.json                 Vercel Python entry point and route configuration
├── SIGN_IN_CHANGES.md          Account/history implementation notes
├── explaination.md             Notes for an earlier prototype
└── README.md                   Project overview and setup
```

The current application entry point is `backend/main.py`. It serves
`frontend/templates/index.html` and the files under `frontend/static/`; there is no frontend
build step or Node.js package setup.

## Requirements

- Python 3.9 or newer
- A Google Gemini API key
- Python, a Java JDK, and C/C++ compilers on the host for the corresponding compile/run features

Install the project's pinned dependencies from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Set the required key and start the Flask app:

```powershell
$env:GEMINI_API_KEY = "your-gemini-api-key"
$env:COOKIE_SECURE = "0"
python .\backend\main.py
```

Then open <http://127.0.0.1:5000>.

`COOKIE_SECURE=0` is for local HTTP development so the browser will accept the sign-in cookie.
Do not use it in production. The application defaults to secure cookies. Generate and set a
persistent `SECRET_KEY` for deployments:

```powershell
$env:SECRET_KEY = (python -c "import secrets; print(secrets.token_hex(32))")
```

`env.example` documents the available settings; it is a template and is not loaded automatically.
Set the variables in your shell or hosting provider.

## Configuration

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Required for translation requests. |
| `GEMINI_API_KEY_2` | Optional backup key, used for eligible provider-side failures. |
| `GEMINI_MODEL` | Optional main model name; defaults to `gemini-3.5-flash-lite`. |
| `GEMINI_MODEL_2` | Optional backup model; defaults to the main model. |
| `SECRET_KEY` | Recommended persistent Flask session-signing key. |
| `COOKIE_SECURE` | Defaults to secure cookies; set to `0` only for local HTTP testing. |
| `DATABASE_DIR` | Optional persistent directory for the three SQLite databases. Defaults to `backend/data`. |
| `LIMITER_STORAGE_URI` | Rate-limit storage URI; defaults to in-memory storage. Use shared storage such as Redis for multi-worker deployments. |
| `ALLOWED_HOSTS` | Optional comma-separated host allowlist for deployments behind a proxy that rewrites the host. |
| `USERNAME_INDEX_KEY` | Optional separate secret for the keyed username lookup index. |

## Application endpoints

### Translation and code execution

- `GET /` - serves the Source Bridge application.
- `POST /send` - accepts multipart form fields `message`, `source_language`, and `language`, plus
  optional `instructions`. If the request accepts `application/x-ndjson`, the response streams
  `chunk`, `error`, and `complete` events; other callers receive plain text.
- `POST /execute` - accepts JSON containing `code`, `language`, and optional interactive `inputs`
  and `eof`; returns run status, standard output/error, and input-request information.

### Account and translation history

- `GET /me` - returns the current sign-in state.
- `GET /username-available?username=...` - checks username validity and availability.
- `POST /signup`, `POST /login`, `POST /logout` - account and session actions.
- `DELETE /account` - deletes the signed-in account and its server-side history.
- `GET /translations` - lists the signed-in user's history; supports saved-only and pagination
  query options.
- `GET /translations/<id>` - reads one history entry.
- `POST /translations/<id>/save` - bookmarks or un-bookmarks a completed translation.
- `DELETE /translations/<id>` - deletes a history entry.

History endpoints require sign-in. Guest bookmarks remain in the browser; account bookmarks and
history use SQLite on the server.

## Data and deployment notes

- SQLite databases are created automatically under `backend/data/` unless `DATABASE_DIR` points
  elsewhere. Back up this directory if it contains data you need to keep.
- The included `vercel.json` routes requests to the Python app, but serverless disks are temporary.
  Do not rely on local SQLite files for persistent accounts or history on Vercel; use persistent
  storage or a hosted database.
- **Code execution warning:** the translation preflight and `/execute` run submitted programs on
  the server. The compiler applies time, output, and resource limits, but it is not a complete
  security sandbox. Do not expose this service to untrusted users without isolating code execution
  in an appropriately restricted container or service.
- Password reset and email verification are not currently provided.
