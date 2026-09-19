from flask import Flask, request, jsonify, render_template,redirect, url_for
from google import genai                                 # Import the Google GenAI library
from google.genai import types                           # Import types from the Google GenAI library
app  = Flask(__name__)                                   # Initialize the Flask application
messages = []                                            # Initialize an empty list to store messages

TASK = "return the given code in Java with no useless text (just the code, no comments, no explanations, no text, no markdown, no formatting, no extra words, no extra lines, no extra spaces, no extra characters, no extra symbols, no extra punctuation, no extra anything) and nothing else"  # Define a task for the GenAI model
client = genai.Client(api_key="Your-API-Key")                                  # Create a GenAI client instance
@app.route("/")                                          # Define the route for the home page
def home():
    return render_template("index.html", messages=messages)                # Render the index.html template



def ask_ai(user_text):
    """Send the user's text to Gemini and return its reply."""
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=user_text,                                   # the user's message
        config=types.GenerateContentConfig(
            system_instruction=TASK,                          # the instructions
        ),
    )
    return response.text




@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()
    file = request.files.get("attachment")
    file_name = file.filename if file and file.filename else None

    if text or file_name:
        reply = ""
        if text:
            try:
                reply = ask_ai(text)          # 👈 send to Gemini
            except Exception as e:
                reply = f"Error: {e}"         # show the problem instead of crashing

        messages.append({"text": text, "file": file_name, "reply": reply})

    return redirect(url_for("home"))

if __name__ == "__main__":                                # Check if the script is run directly
    app.run(debug=True)                                   # Run the Flask application in debug mode