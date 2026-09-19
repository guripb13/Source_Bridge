# Source Bridge

A small Flask project containing a chat-style message composer prototype. It includes a standalone frontend demo and a Flask-backed version that can echo messages or call an OpenRouter model.

## Features

- Contenteditable chat input
- Rich-text paste converted to plain text
- File attachment chips for frontend testing
- Enter to send and Shift+Enter for a new line
- Optional OpenRouter integration
- In-memory message history for the backend demo

## Requirements

- Python 3.9 or newer
- Flask
- Requests (required by the backend demo)

## Setup

From the project root, create and activate a virtual environment:



Install the dependencies:

```powershell
pip install flask requests
```

## Run the standalone demo

The standalone version only exercises the frontend composer and does not send requests to a server:

```powershell
python server.py
```

Open <http://127.0.0.1:5000> in a browser.

## Run the Flask chat demo

The backend demo serves the UI from `Demo testing/templates/Demo.html` and uses `Demo testing/static/` for its assets:

```powershell
python ".\Demo testing\Demo.py"
```

Open <http://127.0.0.1:5000> in a browser.

Without an API key, messages receive a local echo response. To enable OpenRouter, set the key before starting the server:

```powershell
$env:OPENROUTER_API_KEY = "your-api-key"
python ".\Demo testing\Demo.py"
```

The model defaults to `openai/gpt-4o-mini`. Change `OPENROUTER_MODEL` in `Demo testing/Demo.py` to use another model supported by OpenRouter.

## API endpoints

The backend demo exposes:

- `GET /` - Serves the chat interface.
- `POST /send` - Accepts `{ "message": "..." }` and returns a reply.
- `GET /messages` - Returns messages stored in memory during the current process.

Example request:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/send -Method Post -ContentType "application/json" -Body '{"message":"Hello"}'
```

## Project structure

```text
server.py                    # Standalone frontend demo server
templates/index.html         # Standalone demo page
Demo testing/Demo.py         # Backend chat demo server
Demo testing/templates/      # Backend demo HTML
Demo testing/static/         # Backend demo CSS and JavaScript
```

## Notes

- Message history is stored in memory and is cleared when the server restarts.
- Uploaded files are displayed as UI chips; their contents are not uploaded to the backend.
- Flask debug mode is enabled for local development.
