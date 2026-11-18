import os
from pathlib import Path
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")

class Config:
    SECRET_KEY = os.getenv("SECRET_KEY") or os.getenv("SESSION_SECRET") or ""
    DATABASE_URL = os.getenv("DATABASE_URL", "")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")
    STATION_PASSWORD = os.getenv("STATION_PASSWORD", "")
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Strict"
    SESSION_COOKIE_SECURE = os.getenv("FLASK_ENV") == "production" or os.getenv("NODE_ENV") == "production"
    PERMANENT_SESSION_LIFETIME = 8 * 60 * 60
    JSON_AS_ASCII = False
    TG_TOKEN = os.getenv("TG_TOKEN", "")
    TG_CHAT_ID = os.getenv("TG_CHAT_ID", "")
    AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID", "")
    AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY", "")
    AWS_ENDPOINT_URL_S3 = os.getenv("AWS_ENDPOINT_URL_S3", "")
    AWS_REGION = os.getenv("AWS_REGION", "")
    STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "assets")
    GUESTS_CSV = BASE_DIR / "data" / "invitati.csv"
    LEGACY_CHECKINS_JSON = BASE_DIR / "data" / "checkins.json"
    STATIONS = ["Postazione 1", "Postazione 2", "Postazione 3", "Postazione 4"]
    STATION_LOCK_SECONDS = 90
