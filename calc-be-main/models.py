from pymongo import MongoClient
from datetime import datetime
import bcrypt
import os

# MongoDB connection
MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
client = MongoClient(MONGO_URI)
db = client.neuron_db

# Collections
users_collection = db.users
history_collection = db.history

class User:
    @staticmethod
    def create_user(username, email, password):
        hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
        user_doc = {
            "username": username,
            "email": email,
            "password": hashed,
            "created_at": datetime.utcnow(),
            "last_login": None
        }
        result = users_collection.insert_one(user_doc)
        return str(result.inserted_id)

    @staticmethod
    def find_by_username(username):
        return users_collection.find_one({"username": username})

    @staticmethod
    def find_by_email(email):
        return users_collection.find_one({"email": email})

    @staticmethod
    def verify_password(stored_password, provided_password):
        return bcrypt.checkpw(provided_password.encode('utf-8'), stored_password)

    @staticmethod
    def update_last_login(username):
        users_collection.update_one(
            {"username": username},
            {"$set": {"last_login": datetime.utcnow()}}
        )

class History:
    @staticmethod
    def save_calculation(username, calculation_data):
        history_doc = {
            "username": username,
            "type": calculation_data.get("type", "text"),
            "input": calculation_data.get("input", ""),
            "result": calculation_data.get("result", ""),
            "timestamp": datetime.utcnow(),
            "metadata": calculation_data.get("metadata", {})
        }
        result = history_collection.insert_one(history_doc)
        return str(result.inserted_id)

    @staticmethod
    def get_user_history(username, limit=50):
        return list(history_collection.find(
            {"username": username}
        ).sort("timestamp", -1).limit(limit))

    @staticmethod
    def delete_user_history(username):
        history_collection.delete_many({"username": username})








