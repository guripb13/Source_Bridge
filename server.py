from flask import Flask, request, jsonify, render_template

app  = Flask(__name__)                                   # Initialize the Flask application

@app.route("/")                                          # Define the route for the home page
def index():
    return render_template("index.html")                 # Render the index.html template


if __name__ == "__main__":                                # Check if the script is run directly
    app.run(debug=True)                                   # Run the Flask application in debug mode