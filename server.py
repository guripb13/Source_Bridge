from flask import Flask, request, render_template, Response
from google import genai
from google.genai import types

app = Flask(__name__)
MAX_LINES = 50
LAST_LINE_MAX_CHARS = 10
def build_task(language, source_language):
    return f"""You are a code translation engine. The source code is written in {source_language}. Your target language is {language}.

Step 1 - Validation:
Check whether the given input is valid {source_language} source code that can be translated to {language}.
If the input is NOT code (e.g. plain text, gibberish, an empty/meaningless snippet), or is code written in a language/format that cannot be reasonably translated to {language}, do NOT attempt translation.
Instead, return only this single line, with no extra text:
ERROR: The provided input cannot be translated to {language}. Please provide valid source code in a supported language.

Step 2 - Syntax check:
If the input contains syntax errors, still translate as much as possible, but mark each problematic line in the output using a {language}-appropriate comment placed directly above or beside that line, in this format:
// SYNTAX ERROR: <short description of the issue>
(use the correct comment syntax for {language} instead of // if different)

Step 3 - Translation:
Convert the given code to {language}.
Return only the translated code (with syntax-error comments where applicable). No explanations, no markdown, no extra messages of any kind.
Format it like a normal {language} file: one statement per line, and proper indentation for each nested level."""
client = genai.Client(api_key="AQ.Ab8RN6LeU1KUeg3S3BOYlMb-kIGzcw5tdJJzqa14q1nCo2wsDQ")  # Replace with your actual API key


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()
    language = request.form.get("language", "Java").strip() or "Java"
    source_language = request.form.get("sourceLanguage", "").strip() or "the detected language"

    code_lines = text.splitlines()
    if len(code_lines) > MAX_LINES:
        return Response(f"Error: You can't enter more than {MAX_LINES} lines of code.", mimetype="text/plain")
    if len(code_lines) == MAX_LINES and len(code_lines[-1]) > LAST_LINE_MAX_CHARS:
        return Response(f"Error: Line {MAX_LINES} can have at most {LAST_LINE_MAX_CHARS} characters.", mimetype="text/plain")

    def generate():
        if not text:
            return
        try:
            # generate_content_stream gives the answer in small chunks
            for chunk in client.models.generate_content_stream(
                model="gemini-3.6-flash",
                contents=text,
                config=types.GenerateContentConfig(system_instruction=build_task(language, source_language)),
            ):
                if chunk.text:
                    yield chunk.text      # send each chunk to the browser immediately
        except Exception as e:
            yield f"Error: {e}"

    return Response(generate(), mimetype="text/plain")


if __name__ == "__main__":
    app.run(debug=True)