import hashlib
import hmac
import secrets
from flask import Blueprint, current_app, jsonify, request, session
from app.db import cursor

bp = Blueprint("auth", __name__, url_prefix="/api/auth")

def _same_password(supplied, expected):
    return hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(expected.encode()).digest())

@bp.get("/session")
def current_session():
    station = None
    if session.get("session_id"):
        with cursor() as cur:
            cur.execute("SELECT station FROM station_locks WHERE session_id = %s AND expires_at > %s", (session["session_id"], int(__import__("time").time())))
            row = cur.fetchone()
        station = row["station"] if row else None
    response = jsonify({"authenticated": bool(session.get("role")), "role": session.get("role"), "station": station})
    response.headers["Cache-Control"] = "no-store"
    return response

@bp.post("/login")
def login():
    body = request.get_json(silent=True) or {}
    supplied = body.get("password") if isinstance(body.get("password"), str) else ""
    admin = current_app.config["ADMIN_PASSWORD"]
    station = current_app.config["STATION_PASSWORD"]
    if _same_password(supplied, admin):
        role = "admin"
    elif _same_password(supplied, station):
        role = "station"
    else:
        return jsonify(error="Password non corretta"), 401
    session.clear()
    session.permanent = True
    session["role"] = role
    session["session_id"] = secrets.token_urlsafe(24)
    response = jsonify(authenticated=True, role=role)
    response.headers["Cache-Control"] = "no-store"
    return response

@bp.post("/logout")
def logout():
    sid = session.get("session_id")
    if sid:
        with cursor(commit=True) as cur:
            cur.execute("DELETE FROM station_locks WHERE session_id = %s", (sid,))
    session.clear()
    return jsonify(success=True)
