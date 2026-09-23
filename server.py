from flask import Flask, request, render_template, Response
from google import genai
from google.genai import types

app = Flask(__name__)

def build_task(language):
    return f"""Convert the given code to {language}.
Return only the code. No explanations, no comments, no markdown.
Format it like a normal {language} file: one statement per line, and proper indentation for each nested level."""
client = genai.Client(api_key="")  # Replace with your actual API key


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()
    language = request.form.get("language", "Java").strip() or "Java"
    def generate():
        if not text:
            return
        try:
            # generate_content_stream gives the answer in small chunks
            for chunk in client.models.generate_content_stream(
                model="gemini-3.6-flash",
                contents=text,
                config=types.GenerateContentConfig(system_instruction=build_task(language)),
            ):
                if chunk.text:
                    yield chunk.text      # send each chunk to the browser immediately
        except Exception as e:
            yield f"Error: {e}"

    return Response(generate(), mimetype="text/plain")


if __name__ == "__main__":
    app.run(debug=True)