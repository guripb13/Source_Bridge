from flask import Flask, request, jsonify, render_template,redirect, url_for

app  = Flask(__name__)                                   # Initialize the Flask application
messages = []                                             # Initialize an empty list to store messages

@app.route("/")                                          # Define the route for the home page
def home():
    return render_template("index.html", messages=messages)                # Render the index.html template

@app.route("/send", methods=["POST"])
def send():
    text = request.form.get("message", "").strip()   # the typed text
    file = request.files.get("attachment")           # the attached file (if any)

    # Get the file name, or None if no file was chosen.
    file_name = file.filename if file and file.filename else None

    # Only save the message if there is text or a file.
    if text or file_name:
        messages.append({"text": text, "file": file_name})

    # Go back to the main page.
    return redirect(url_for("home"))

if __name__ == "__main__":                                # Check if the script is run directly
    app.run(debug=True)                                   # Run the Flask application in debug mode