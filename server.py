from flask import Flask, request, render_template, Response
from google import genai
from google.genai import types

app = Flask(__name__)

TASK = """Convert the given code to Java.
Return only the code. No explanations, no comments, no markdown.
Format it like a normal Java file: one statement per line, braces on their own lines where usual, and 4 spaces of indentation for each nested level."""
client = genai.Client(api_key="Your API Key")


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()

    def generate():
        if not text:
            return
        try:
            # generate_content_stream gives the answer in small chunks
            for chunk in client.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=text,
                config=types.GenerateContentConfig(system_instruction=TASK),
            ):
                if chunk.text:
                    yield chunk.text      # send each chunk to the browser immediately
        except Exception as e:
            yield f"Error: {e}"

    return Response(generate(), mimetype="text/plain")


if __name__ == "__main__":
    app.run(debug=True)