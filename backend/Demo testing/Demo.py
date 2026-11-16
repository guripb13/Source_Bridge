import os
import requests
from flask import Flask, request, jsonify, render_template

app = Flask(__name__)

# In-memory store, just so you can see messages piling up (optional)
messages = []

# ---------------------------------------------------------------------------
# OpenRouter configuration (optional — leave OPENROUTER_API_KEY unset to
# just get a plain echo reply instead of calling the API)
# ---------------------------------------------------------------------------
# Get a key at https://openrouter.ai/keys
#   Windows (PowerShell):  $env:OPENROUTER_API_KEY="sk-or-..."
#   macOS/Linux:            export OPENROUTER_API_KEY="sk-or-..."
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = "openai/gpt-4o-mini"   # swap for any model OpenRouter supports

# EDIT THIS: your own instruction/prompt sent alongside every user message.
SYSTEM_PROMPT = (
    "You are a helpful assistant embedded in a website. "
    "Answer the user's message clearly and concisely."
)


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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/", methods=["GET"])
def home():
    # Renders templates/claude-input-box.html, which links
    # static/style.css and static/script.js
    return render_template("Demo.html")


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
        # No API key set — just echo the message back so you can test the
        # plumbing before wiring up OpenRouter.
        reply = f"Server received: {text}"

    return jsonify({
        "status": "ok",
        "reply": reply
    })


@app.route("/messages", methods=["GET"])
def get_messages():
    return jsonify({"messages": messages})


if __name__ == "__main__":
    # pip install flask requests
    app.run(debug=True, port=5000)
