# Project Explanation

This project is a small Flask-based chat/message demo. It has two versions:

1. A simpler demo in `server.py` that accepts a text message and optional file attachment and stores them in memory.
2. A more complete chat UI in `Demo testing/Demo.py` that sends messages to a backend route and optionally calls the OpenRouter API.

The goal is to show how a browser form, a Flask server, and a simple in-memory message list work together.

---

## 1) Project structure

- `server.py` — the basic Flask app
- `templates/index.html` — the simple frontend page with textarea and file attachment
- `Demo testing/Demo.py` — more advanced chat server with AI reply support
- `Demo testing/templates/Demo.html` — rich chat UI HTML
- `Demo testing/static/script.js` — JavaScript logic that drives the chat UI
- `Demo testing/static/style.css` — styling for the chat interface

---

## 2) What the app is doing overall

The app behaves like a mini message system.

- The browser loads a page.
- The user types a message or attaches a file.
- The form sends data to the Flask server.
- The server reads that data.
- The server stores it in memory (`messages` list).
- The page refreshes or the frontend displays a response.
- In the advanced demo, the server may send the message to OpenRouter, which returns an AI answer.

This is a classic web application pattern:

Browser -> HTTP request -> Flask route -> Python logic -> response -> browser updates

---

## 3) The simple version: `server.py`

### Imports

```python
from flask import Flask, request, jsonify, render_template, redirect, url_for
```

These are the key Flask pieces:

- `Flask` — creates the web application object.
- `request` — gives access to incoming browser data such as form fields, files, JSON, and URL parameters.
- `jsonify` — converts Python data into JSON for HTTP responses.
- `render_template` — loads an HTML page from the `templates` folder.
- `redirect` — sends the browser to a different route.
- `url_for` — builds a URL from a function name.

### App object

```python
app = Flask(__name__)
```

This creates the Flask app instance. `__name__` tells Flask where the app is located so it can find templates and static files correctly.

### In-memory storage

```python
messages = []
```

This is a Python list used to store messages temporarily while the server is running. It is not saved to a database, and it disappears when the server restarts.

Each message is a dictionary like:

```python
{"text": "hello", "file": "resume.pdf"}
```

That means:

- `text` keeps the typed message
- `file` keeps the uploaded file name if one exists

---

### Route: home page

```python
@app.route("/")
def home():
    return render_template("index.html", messages=messages)
```

This is the main page. The decorator `@app.route("/")` tells Flask:

- when a browser opens the root URL `/`, call this function
- return the result of `render_template("index.html", messages=messages)`

`render_template` loads the HTML page and sends the `messages` list into the template so the page can display earlier messages.

So the flow is:

- browser requests `/`
- Flask calls `home()`
- HTML template loads
- template loops through `messages`
- all old messages are shown on the page

---

### Route: send message

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

This handles form submission when the user clicks Send.

#### `request.form.get("message", "")`

This reads the text field named `message` from the submitted form. It says:

- look in form data
- find the field called `message`
- if it is missing, use an empty string
- then strip spaces from both ends

#### `request.files.get("attachment")`

This reads the uploaded file. In the HTML, the file input uses the name `attachment`.

- if a file is uploaded, `file` is a file object
- if no file is selected, `file` is `None`

#### `file_name = file.filename if file and file.filename else None`

This line extracts the uploaded file's original name.

- If a file exists and has a filename, store it
- Otherwise, store `None`

So a message could be:

- text only
- file only
- both text and file
- neither (ignored)

#### `if text or file_name`

This prevents empty submissions.

- if there is no text and no file, nothing is saved
- if there is either text or file, then it is added to the in-memory list

#### `messages.append(...)`

This adds the message object to the list.

Example:

```python
messages.append({"text": "hello", "file": "notes.pdf"})
```

#### `redirect(url_for("home"))`

After the message is saved, the user is redirected back to the home page.

This makes the page refresh so the new message appears in the list.

---

### App startup

```python
if __name__ == "__main__":
    app.run(debug=True)
```

This is the standard Flask startup block.

- `__name__ == "__main__"` means this file is being run directly, not imported elsewhere
- `app.run(...)` starts the local web server
- `debug=True` turns on debug mode so Flask shows useful error messages while developing

---

## 4) The frontend template: `templates/index.html`

This is the HTML for the simple demo.

### Important pieces

```html
<form class="composer" method="POST" action="{{ url_for('send') }}" enctype="multipart/form-data">
```

This form does the submission:

- `method="POST"` means send data with HTTP POST
- `action="{{ url_for('send') }}"` tells the browser to send to the `/send` route
- `enctype="multipart/form-data"` is required when uploading files

### Text area

```html
<textarea name="message" rows="2" placeholder="How can I help you today?"></textarea>
```

This creates the text box where the user types their message. The `name="message"` matters because the Python server reads `request.form.get("message")`.

### File input

```html
<input type="file" name="attachment" id="attachment">
```

This lets the user choose a file. Its name is `attachment`, which matches the server-side `request.files.get("attachment")` call.

### Messages display loop

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

This is Jinja templating.

- `for m in messages` loops through every message
- if a message has a file, it shows a file tag
- then it displays the message text

This is how past messages appear on the page after submission.

---

## 5) Full demo: `Demo testing/Demo.py`

This version is more realistic and includes a chat UI and optional AI response.

### Imports

```python
import os
import requests
from flask import Flask, request, jsonify, render_template
```

- `os` lets the program read environment variables like API keys
- `requests` lets the server call external APIs such as OpenRouter
- `Flask` and `request` are used for web routes and incoming request data
- `jsonify` turns Python dictionaries into JSON responses

### App object

```python
app = Flask(__name__)
```

Same purpose as in the simpler app: create the Flask app.

### In-memory list

```python
messages = []
```

This stores message strings in memory during the server runtime.

---

### OpenRouter configuration

```python
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = "openai/gpt-4o-mini"
```

This is how the app configures AI integration:

- `os.environ.get(...)` checks the environment for a variable named `OPENROUTER_API_KEY`
- if missing, it becomes an empty string
- `OPENROUTER_URL` is the API endpoint for OpenRouter
- `OPENROUTER_MODEL` chooses which language model is used

#### Why this matters

If an API key is present, the server can send the user’s message to OpenRouter and get a reply. If no key is set, it falls back to a simple echo response.

### System prompt

```python
SYSTEM_PROMPT = (
    "You are a helpful assistant embedded in a website. "
    "Answer the user's message clearly and concisely."
)
```

A system prompt tells the AI how to behave. For example:

- be helpful
- be concise
- answer as a website assistant

This is part of the message payload sent to OpenRouter.

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

This function sends the user message to the OpenRouter API.

#### Breakdown

- `headers` adds the API key and tells the API the body is JSON
- `payload` contains the model and chat messages
- `requests.post(...)` sends the request to OpenRouter
- `timeout=30` means the server will stop waiting after 30 seconds
- `response.raise_for_status()` raises an error if the request fails (like 401, 500, etc.)
- `response.json()` turns the API response into a Python dictionary
- `data["choices"][0]["message"]["content"]` extracts the AI-generated text

So the app takes:

user message -> OpenRouter API -> AI reply -> send back to the browser

---

### Route: home page

```python
@app.route("/", methods=["GET"])
def home():
    return render_template("Demo.html")
```

This loads the advanced chat interface from `Demo testing/templates/Demo.html`.

---

### Route: send message

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

This is the main backend API for the chat demo.

#### Step-by-step flow

1. `request.get_json(silent=True) or {}`
   - reads JSON from the browser
   - if there is no JSON, uses an empty dictionary

2. `text = data.get("message", "").strip()`
   - extracts the user message
   - removes spaces around it

3. `if not text:`
   - reject empty messages
   - return a JSON error with HTTP 400

4. `messages.append(text)`
   - save the message into the in-memory list

5. `if OPENROUTER_API_KEY:`
   - if API key exists, call AI
   - otherwise use a simple echo reply

6. `return jsonify({"status": "ok", "reply": reply})`
   - send the reply back to the browser as JSON

#### Why this matters

This creates the back-end contract for the UI:

- frontend sends `{ "message": "hello" }`
- backend validates it
- backend stores it
- backend responds with `{ "status": "ok", "reply": "..." }`

---

### Route: get messages

```python
@app.route("/messages", methods=["GET"])
def get_messages():
    return jsonify({"messages": messages})
```

This returns the current message list as JSON. It is useful for debugging or for a client that wants to fetch the conversation history.

---

### Startup

```python
if __name__ == "__main__":
    app.run(debug=True, port=5000)
```

This starts the app on port 5000 in debug mode.

---

## 6) The advanced frontend: `Demo testing/templates/Demo.html`

This is the HTML for the richer chat UI.

Important elements:

- `div id="conversation"` — container for message bubbles
- `div id="editor" contenteditable="true"` — editable text area for user input
- `input type="file" id="fileInput"` — hidden file picker
- `button id="sendBtn"` — send button
- script tag loads `script.js`

The page is designed so JavaScript can manipulate the DOM and keep the conversation visually interactive.

---

## 7) JavaScript behavior: `Demo testing/static/script.js`

This file handles the real browser-side chat logic.

### DOM setup

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const composer     = document.getElementById('composer');
  const editor       = document.getElementById('editor');
  const sendBtn      = document.getElementById('sendBtn');
  const sendIcon     = document.getElementById('sendIcon');
  const attachBtn    = document.getElementById('attachBtn');
  const fileInput    = document.getElementById('fileInput');
  const attachWrap   = document.getElementById('attachments');
  const toast        = document.getElementById('toast');
  const conversation = document.getElementById('conversation');
```

This gets references to all interactive parts of the page.

### Focus effect

```javascript
editor.addEventListener('focus', () => composer.classList.add('focused'));
editor.addEventListener('blur',  () => composer.classList.remove('focused'));
```

The editor adds or removes a CSS class when the user focuses or leaves the input box, which gives the visual focus ring effect.

---

### `hasContent()`

```javascript
function hasContent(){
  return editor.textContent.trim().length > 0 || attachWrap.children.length > 0;
}
```

This checks whether the user has typed something or attached a file.

- if there is text in the editor, true
- if there are attachment chips, true
- otherwise false

This is used to decide whether the send button should be enabled.

---

### Paste plain text conversion

```javascript
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  const plainText = (e.clipboardData || window.clipboardData).getData('text/plain');
  insertPlainText(plainText);
});
```

This is a very important feature.

The browser normally pastes formatted rich text (HTML) if copied from a webpage, email, or Word document. This code blocks the default paste behavior and instead inserts only plain text.

This is done to make the app simpler and more consistent.

#### `insertPlainText(text)`

This function:

- gets the current selection in the editable area
- deletes the current selection
- splits the pasted text by lines
- inserts each line as text
- inserts `<br>` tags between lines

This makes pasted content appear as plain text with line breaks instead of hidden HTML formatting.

---

### Enter to send

```javascript
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    trySend();
  }
});
```

This means:

- pressing Enter sends the message
- pressing Shift+Enter allows a newline instead

This is a common chat UX pattern.

---

### `trySend()`

```javascript
async function trySend(){
  if (!hasContent() || sendBtn.classList.contains('loading')) return;

  const messageText = editor.textContent;

  addBubble(messageText, 'user');

  sendBtn.classList.remove('pulse');
  void sendBtn.offsetWidth;
  sendBtn.classList.add('pulse');

  editor.textContent = '';
  attachWrap.innerHTML = '';
  editor.focus();

  setLoading(true);

  try {
    const response = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: messageText })
    });

    const data = await response.json();

    if (!response.ok){
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

This is the main chat sending logic.

#### Behavior

1. If the editor has no content, stop.
2. Read the current text from the editor.
3. Add a user bubble to the conversation.
4. Clear the input and attachments.
5. Show a loading state.
6. Send a POST request to `/send` with JSON data.
7. Wait for the response.
8. If there is an error, show an error bubble.
9. Else, show the AI reply bubble.
10. Turn loading off.

#### `fetch('/send', {...})`

This is the browser sending an HTTP request to the Flask server.

- `method: 'POST'` tells the server it is a write operation
- `headers: { 'Content-Type': 'application/json' }` says the body is JSON
- `body: JSON.stringify({ message: messageText })` sends the user message in JSON form

The server receives:

```json
{ "message": "hello there" }
```

---

### `addBubble(text, who, isError)`

```javascript
function addBubble(text, who, isError){
  const bubble = document.createElement('div');
  bubble.className = `bubble ${who}` + (isError ? ' error' : '');
  bubble.textContent = text;
  conversation.appendChild(bubble);
  bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
}
```

This creates a chat bubble for either:

- user message
- AI message
- error message

It adds the bubble to the conversation container and scrolls it into view.

---

### `setLoading(isLoading)`

```javascript
function setLoading(isLoading){
  sendBtn.classList.toggle('loading', isLoading);
  sendBtn.disabled = isLoading;
  if (isLoading){
    sendIcon.innerHTML = '<div class="spinner"></div>';
  } else {
    sendIcon.innerHTML = `
      <svg ...>...</svg>`;
    refreshSendState();
  }
}
```

This gives the send button a loading state while waiting for the backend response.

- disables the button so the user cannot send again
- swaps the send icon to a spinner
- re-enables it after the request completes

---

### File attachment chips

```javascript
attachBtn.addEventListener('click', () => fileInput.click());
```

This opens the file picker when the user clicks the attach button.

```javascript
fileInput.addEventListener('change', () => {
  [...fileInput.files].forEach(addChip);
  fileInput.value = '';
  refreshSendState();
});
```

This handles file selection and turns each selected file into a visual chip.

```javascript
function addChip(file){
  const chip = document.createElement('div');
  chip.className = 'chip';
  chip.innerHTML = `...`;
  chip.querySelector('.chip-remove').addEventListener('click', () => {
    chip.remove();
    refreshSendState();
  });
  attachWrap.appendChild(chip);
}
```

This creates a small pill-like UI element showing the file name and a remove button.

---

## 8) App data flow (simple version)

### Flow A: page load

1. Browser requests `/`
2. Flask route `home()` runs
3. `render_template("index.html", messages=messages)` loads the page
4. Template displays saved messages
5. Browser renders the HTML

### Flow B: submit message

1. User types text and maybe chooses a file
2. Form posts to `/send`
3. Flask route `send()` reads:
   - `request.form.get("message")`
   - `request.files.get("attachment")`
4. It stores the result in `messages`
5. It redirects back to `/`
6. Browser loads the page again
7. Template shows all messages, including the new one

---

## 9) App data flow (advanced demo)

### Flow C: frontend chat request

1. User types in the contenteditable editor
2. JavaScript `trySend()` reads `editor.textContent`
3. JavaScript `fetch('/send')` sends JSON to the backend
4. Server route `send_message()` receives JSON and validates it
5. Message is appended to `messages`
6. If an API key exists, `call_openrouter()` sends the message to OpenRouter
7. OpenRouter returns a reply
8. Flask sends JSON back: `{ "status": "ok", "reply": "..." }`
9. JavaScript adds the AI reply as a bubble to the page

### Flow D: no API key

If `OPENROUTER_API_KEY` is empty:

- the server does not call OpenRouter
- it creates a fallback reply such as: `Server received: hello`
- the frontend still displays it as if it were an AI response

This is useful for testing the app without paying for or using an external service.

---

## 10) Important keywords explained

### `@app.route(...)`
A decorator that connects a URL path to a Python function.

Example:

```python
@app.route("/send", methods=["POST"])
```

This means: when the browser sends a POST request to `/send`, run that function.

### `methods=["POST"]`
Specifies which HTTP methods are allowed for the route.

- GET means read data
- POST means send data

### `request.form`
Contains data submitted from an HTML form.

Example:

```python
request.form.get("message")
```

### `request.files`
Contains uploaded files from a form using `multipart/form-data`.

### `render_template(...)`
Renders an HTML template from the `templates` folder.

### `redirect(...)`
Tells the browser to go to a different route.

### `url_for(...)`
Builds a route URL from the function name.

Example:

```python
url_for("home")
```

becomes `/`.

### `jsonify(...)`
Creates a JSON response from Python data.

### `messages = []`
A Python list used as temporary storage in memory.

### `if __name__ == "__main__":`
Runs the app only when the file is executed directly, not when imported elsewhere.

### `app.run(debug=True)`
Starts the Flask development server with debug mode enabled.

### `fetch(...)`
JavaScript function used to make an HTTP request from the browser to the server.

### `contenteditable="true"`
An HTML attribute that lets a div behave like an editable text field.

### `JSON.stringify(...)`
Converts a JavaScript object into a JSON string for sending to the backend.

---

## 11) Summary

This project is a very small web app that demonstrates:

- Flask route handling
- HTML forms and file uploads
- in-memory message storage
- template rendering
- JSON responses
- frontend JavaScript interaction
- optional AI integration through OpenRouter

The key idea is simple:

The browser sends data, the Flask backend reads it, stores or processes it, and responds. The frontend then updates the page to show the result.

That is the core of how most full-stack web apps work.
