# models.py
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)      # this is your UID
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)  # never store plain passwords
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    history = db.relationship("History", backref="user", lazy=True)

class History(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("user.id"), nullable=False)
    input_code = db.Column(db.Text)
    target_language = db.Column(db.String(50))
    output_code = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)