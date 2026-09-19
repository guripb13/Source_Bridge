# Project Explanation

This project is a small Flask-based web app that demonstrates how a browser, a server, and a simple chat interface work together. It has two versions:

1. A basic server in `server.py` that accepts text and optional file uploads and saves them in memory.
2. A more advanced demo in `Demo testing/Demo.py` that sends messages to a Flask route and optionally calls the OpenRouter AI API.

The project is mainly a learning example for:

- Flask routes
- HTML forms and file upload handling
- template rendering
- in-memory data storage
- JavaScript browser logic
- JSON request/response communication

---

## 1) Project structure

- `server.py` — the simplest Flask app for a message form
- `templates/index.html` — simple HTML page with textarea and file upload
- `Demo testing/Demo.py` — more advanced chat backend with AI support
- `Demo testing/templates/Demo.html` — chat UI mockup
- `Demo testing/static/script.js` — client-side chat logic
- `Demo testing/static/style.css` — CSS styling
- `README.md` — setup and usage notes

---

## 2) What the app is doing overall

At a high level, the app acts like a mini message system:

- the browser shows a form or chat box
- the user enters text or attaches a file
- the frontend sends the data to the Flask server
- the server reads the incoming request
- the server stores the message in memory
- the backend returns a response
- the browser updates the screen to display the result

The basic pattern is:

Browser -> HTTP request -> Flask route -> Python logic -> response -> browser update

---

## 3) Basic app: `server.py`

This is the simplest version and is the clearest example of Flask form handling.

### Imports

```python
from flask import Flask, request, jsonify, render_template, redirect, url_for
```

These imports are important:

- `Flask` creates the web application object.
- `request` lets the app read browser-submitted values.
- `jsonify` creates JSON responses.
- `render_template` loads HTML templates from the `templates` folder.
- `redirect` sends the browser to another route.
- `url_for` builds a URL from a Python function name.

### App initialization

```python
app = Flask(__name__)
```

This creates the Flask application instance. `__name__` tells Flask where the app is located and helps it find templates and static files.

### In-memory message store

```python
messages = []
```

This list stores all messages while the app is running. It is temporary memory only, not a database. When the server restarts, the list resets.

Each item is a dictionary like:

```python
{"text": "hello", "file": "report.pdf"}
```

This means:

- `text` = typed message
- `file` = name of uploaded file, if present

---

### Home route

```python
def home():
    return render_template("index.html", messages=messages)
```

This function is connected to `/` with:

```python
@app.route("/")
```

Meaning:

- when the browser opens the home page, Flask calls `home()`
- `render_template(...)` loads the HTML page
- the `messages` list is passed into the page so old messages can be displayed

So the flow is:

1. browser requests `/`
2. Flask runs `home()`
3. the template loads
4. the page displays past messages

---

### Send route

```python
@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()
    file = request.files.get("attachment")
    file_name = file.filename if file and file.filename else None

    if text or file_name:
        messages.append({"text": text, "file": file_name})

    return redirect(url_for("home"))
```

This is the main logic for receiving submitted data.

#### `request.form.get("message", "")`

This reads the form input named `message`.

- it looks inside the posted form data
- if not found, it uses an empty string
- `.strip()` removes extra spaces around the message

#### `request.files.get("attachment")`

This reads the uploaded file from the form.

- `attachment` is the name of the file input in the HTML form
- if no file is selected, it becomes `None`

#### `file_name = file.filename if file and file.filename else None`

This extracts the file’s original name.

- if there is a file with a filename, store it
- otherwise, set it to `None`

#### `if text or file_name:`

This prevents empty submissions.

- if the user typed nothing and attached nothing, ignore it
- if either text or file exists, save it

#### `messages.append(...)`

This adds the new message to the in-memory list.

Example:

```python
{"text": "hello", "file": "notes.pdf"}
```

#### `redirect(url_for("home"))`

After saving, the app redirects the browser back to `/`.

This refreshes the page so the new message appears.

---

### Startup block

```python
if __name__ == "__main__":
    app.run(debug=True)
```

This starts the Flask development server.

- `__name__ == "__main__"` means run only when this file is executed directly
- `app.run(...)` starts the local server
- `debug=True` enables debug mode for easier development and error reporting

---

## 4) Frontend for the simple app: `templates/index.html`

This HTML file creates the basic message form.

### Form submission

```html
<form method="POST" action="{{ url_for('send') }}" enctype="multipart/form-data">
```

This is the important part:

- `method="POST"` sends data using a POST request
- `action="{{ url_for('send') }}"` sends it to the `/send` route
- `enctype="multipart/form-data"` is required for file uploads

### Text input

```html
<textarea name="message" rows="2"></textarea>
```

This creates the textbox. The attribute `name="message"` matches the server-side code reading `request.form.get("message")`.

### File input

```html
<input type="file" name="attachment">
```

This allows the user to choose a file. Its name matches the server-side `request.files.get("attachment")`.

### Displaying messages

```html
{% for m in messages %}
  <div class="message">
    {% if m.file %}
      <div class="file-tag">📎 {{ m.file }}</div>
    {% endif %}
    {{ m.text }}
  </div>
{% endfor %}
```

This is Jinja template syntax.

- `for m in messages` loops through every saved message
- if a file exists, it shows a file label
- then it prints the message text

This makes the page show all previous messages.

---

## 5) Advanced demo: `Demo testing/Demo.py`

This version is more realistic and includes interactive chat behavior and optional AI integration.

### Imports

```python
import os
import requests
from flask import Flask, request, jsonify, render_template
```

- `os` reads environment variables
- `requests` sends HTTP requests to external APIs
- `Flask` handles the app and routes
- `request` reads incoming data
- `jsonify` returns JSON responses
- `render_template` loads HTML web pages

### App setup

```python
app = Flask(__name__)
```

This creates the Flask app for the demo version.

### Message storage

```python
messages = []
```

This stores conversation text in memory while the server is running.

---

### OpenRouter configuration

```python
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = "openai/gpt-4o-mini"
```

This configures the AI part:

- `OPENROUTER_API_KEY` is read from environment variables
- if no key is set, the app still works but cannot call AI
- `OPENROUTER_URL` is the external API endpoint
- `OPENROUTER_MODEL` chooses the model to use

The app is designed to run either with or without AI.

### System prompt

```python
SYSTEM_PROMPT = (
    "You are a helpful assistant embedded in a website. "
    "Answer the user's message clearly and concisely."
)
```

This tells the AI how to behave. It acts like a built-in instruction for the assistant.

---

### Function: `call_openrouter(user_message: str) -> str`

```python
def call_openrouter(user_message: str) -> str:
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": OPENROUTER_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
    }

    response = requests.post(OPENROUTER_URL, headers=headers, json=payload, timeout=30)
    response.raise_for_status()
    data = response.json()
    return data["choices"][0]["message"]["content"]
```

This is the actual AI call function.

#### What it does step by step

1. prepares HTTP headers with the API key
2. creates the payload containing:
   - model name
   - system instructions
   - user message
3. sends a POST request to OpenRouter
4. checks whether the response is valid
5. parses the JSON response
6. extracts the model’s reply text and returns it

This is the function that turns the app from a simple echo service into an AI-powered chat app.

---

### Home route for the chat demo

```python
@app.route("/", methods=["GET"])
def home():
    return render_template("Demo.html")
```

This route loads the advanced browser page from `Demo testing/templates/Demo.html`.

---

### Send message route for the demo

```python
@app.route("/send", methods=["POST"])
def send_message():
    data = request.get_json(silent=True) or {}
    text = data.get("message", "").strip()

    if not text:
        return jsonify({"error": "Empty message"}), 400

    messages.append(text)
    print("Received message:", text)

    if OPENROUTER_API_KEY:
        try:
            reply = call_openrouter(text)
        except requests.exceptions.RequestException as e:
            print("OpenRouter request failed:", e)
            return jsonify({"error": "Could not reach OpenRouter."}), 502
        except (KeyError, IndexError) as e:
            print("Unexpected OpenRouter response shape:", e)
            return jsonify({"error": "Unexpected response from OpenRouter."}), 502
    else:
        reply = f"Server received: {text}"

    return jsonify({
        "status": "ok",
        "reply": reply
    })
```

This is the main chat backend logic.

#### Step-by-step flow

1. `request.get_json(silent=True)` reads incoming JSON from the browser
2. it reads the `message` value from the JSON object
3. it trims spaces and rejects empty messages
4. it saves the message in `messages`
5. if an API key exists, it calls OpenRouter
6. otherwise, it returns a local echo response
7. then it returns a JSON reply to the browser

This route is the server’s main request handler.

#### HTTP response behavior

- if the message is empty: returns `400 Bad Request`
- if OpenRouter fails: returns `502 Bad Gateway`
- otherwise: returns `200 OK` with reply text

---

### Messages route

```python
@app.route("/messages", methods=["GET"])
def get_messages():
    return jsonify({"messages": messages})
```

This route provides the saved message history as JSON.

It is useful for:

- debugging
- checking current message state
- creating a client that reads the conversation history

---

### Startup block for demo app

```python
if __name__ == "__main__":
    app.run(debug=True, port=5000)
```

This starts the advanced app on port `5000`.

---

## 6) Frontend for the advanced demo: `Demo testing/templates/Demo.html`

This HTML page is more modern and resembles a real chat interface.

Key elements:

- `div id="conversation"` — where chat bubbles appear
- `div id="editor" contenteditable="true"` — editable text input area
- `button id="sendBtn"` — send button
- `input type="file" id="fileInput"` — hidden file picker
- script tag loads `script.js`

The page is designed to be controlled by JavaScript rather than a normal form post.

---

## 7) JavaScript behavior: `Demo testing/static/script.js`

This file controls the browser-side chat behavior.

### DOM initialization

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const composer = document.getElementById('composer');
  const editor = document.getElementById('editor');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileInput');
  const conversation = document.getElementById('conversation');
```

This grabs references to the UI elements the script needs to manipulate.

### Focus effect

```javascript
editor.addEventListener('focus', () => composer.classList.add('focused'));
editor.addEventListener('blur', () => composer.classList.remove('focused'));
```

When the user clicks into the editor, the UI adds a focus style.

### Content check

```javascript
function hasContent() {
  return editor.textContent.trim().length > 0 || attachWrap.children.length > 0;
}
```

This determines whether the user has text or attachments before allowing send.

---

### Plain-text paste logic

```javascript
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  const plainText = (e.clipboardData || window.clipboardData).getData('text/plain');
  insertPlainText(plainText);
});
```

This is a very important feature. It prevents pasted rich text from preserving HTML formatting and instead inserts plain text only.

This keeps the message clean and predictable.

---

### Enter-to-send behavior

```javascript
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    trySend();
  }
});
```

- Enter sends the message
- Shift+Enter creates a new line

This is common chat UX behavior.

---

### Main sending logic: `trySend()`

```javascript
async function trySend() {
  if (!hasContent() || sendBtn.classList.contains('loading')) return;

  const messageText = editor.textContent;
  addBubble(messageText, 'user');

  editor.textContent = '';
  attachWrap.innerHTML = '';
  setLoading(true);

  try {
    const response = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageText })
    });

    const data = await response.json();

    if (!response.ok) {
      addBubble(data.error || 'Something went wrong.', 'ai', true);
    } else {
      addBubble(data.reply, 'ai');
    }
  } catch (err) {
    console.error(err);
    addBubble('Could not reach the server.', 'ai', true);
  } finally {
    setLoading(false);
  }
}
```

This is the browser’s main communication path.

#### What it does

1. checks whether there is content to send
2. reads the message text from the editor
3. displays a user bubble immediately
4. clears the input box
5. sends a POST request to `/send`
6. waits for the response
7. adds the AI or error reply as a new bubble
8. resets the loading state

The core front-end/backend communication is:

```javascript
fetch('/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: messageText })
})
```

This sends JSON like:

```json
{ "message": "hello" }
```

---

### `addBubble()`

```javascript
function addBubble(text, who, isError) {
  const bubble = document.createElement('div');
  bubble.className = `bubble ${who}` + (isError ? ' error' : '');
  bubble.textContent = text;
  conversation.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
```

This creates a chat bubble and adds it to the conversation box.

- `who` indicates whether it is a user or AI message
- `isError` changes the styling for errors
- `scrollIntoView` keeps the latest message visible

---

### Loading spinner logic

```javascript
function setLoading(isLoading) {
  sendBtn.classList.toggle('loading', isLoading);
  sendBtn.disabled = isLoading;
  if (isLoading) {
    sendIcon.innerHTML = '<div class="spinner"></div>';
  } else {
    sendIcon.innerHTML = `<svg ...></svg>`;
  }
}
```

This prevents duplicate sends while waiting for a response and gives visual feedback.

---

### File chip handling

```javascript
fileInput.addEventListener('change', () => {
  [...fileInput.files].forEach(addChip);
  fileInput.value = '';
  refreshSendState();
});
```

This listens for file selection and converts each file into a chip-like visual item.

These chips help represent attached files without actually sending the file content through the demo UI.

---

## 8) App data flow: simple version

### Flow A: loading the page

1. Browser requests `/`
2. Flask runs `home()`
3. `render_template("index.html", messages=messages)` loads the page
4. the template displays the message list
5. the browser renders the page

### Flow B: sending a message

1. the user types a message and maybe uploads a file
2. the form submits to `/send`
3. Flask reads the data with `request.form` and `request.files`
4. the app saves it to `messages`
5. the app redirects to `/`
6. the browser reloads and sees the new message

---

## 9) App data flow: advanced demo

### Flow C: browser to server

1. user types text in the editor
2. JavaScript sends `fetch('/send')`
3. the body contains JSON: `{ "message": "hello" }`
4. Flask route `send_message()` receives it
5. the message is validated and saved to `messages`

### Flow D: server to AI or fallback

6. if `OPENROUTER_API_KEY` exists, the server calls `call_openrouter()`
7. the AI returns a reply
8. if no API key is set, the server returns a local echo message instead
9. Flask sends JSON back to the browser, like:

```json
{ "status": "ok", "reply": "Server received: hello" }
```

### Flow E: browser update

10. JavaScript receives that JSON
11. it adds a new bubble to the conversation UI
12. the chat screen updates without reloading the page

---

## 10) Important keywords and concepts explained

### `@app.route(...)`
A decorator that binds a URL to a Python function.

Example:

```python
@app.route("/send", methods=["POST"])
```

This means: when a request hits `/send`, run the function below.

### `methods=["POST"]`
Defines which HTTP method is allowed for that route.

- `GET` = read data
- `POST` = send data

### `request.form`
Contains form data submitted by HTML form fields.

Example:

```python
request.form.get("message")
```

### `request.files`
Contains uploaded files from a form.

### `render_template(...)`
Loads and renders an HTML file from the `templates` directory.

### `redirect(...)`
Sends the user to a different URL.

### `url_for(...)`
Builds a URL from the function name.

Example:

```python
url_for("home")
```

returns `/`.

### `jsonify(...)`
Converts Python objects into JSON for the browser.

### `messages = []`
A temporary in-memory list used for simple storage.

### `request.get_json(...)`
Reads JSON from the client request body.

### `if __name__ == "__main__":`
Runs the app only when the file is executed directly, not when it is imported somewhere else.

### `app.run(...)`
Starts the local Flask development server.

---

## 11) Summary

This project is a small full-stack Flask demo that shows how a real web application works:

- the client sends data from a browser
- the Flask server receives it
- Python logic processes the request
- data is stored in memory
- a response is returned to the browser
- the user interface updates

The simple version proves the basic request/response model. The demo version adds an AI layer using OpenRouter, which turns the project into a minimal API-driven chat application.

In one sentence: this app is a small example of how a web interface, a backend server, and an AI endpoint can work together in a complete request cycle.
