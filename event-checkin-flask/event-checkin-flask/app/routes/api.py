import json
import re
import time
from datetime import datetime, timezone
from io import BytesIO
import boto3
import requests
from botocore.exceptions import ClientError
from flask import Blueprint, current_app, jsonify, request, session, send_file
from app.db import connection, cursor

bp = Blueprint("api", __name__, url_prefix="/api")

def authenticated(fn):
    from functools import wraps
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("role") or not session.get("session_id"):
            return jsonify(error="Accesso richiesto"), 401
        return fn(*args, **kwargs)
    return wrapper

def admin_required(fn):
    from functools import wraps
    @wraps(fn)
    @authenticated
    def wrapper(*args, **kwargs):
        if session.get("role") != "admin":
            return jsonify(error="Funzione riservata all’amministratore"), 403
        return fn(*args, **kwargs)
    return wrapper

def storage_client():
    c = current_app.config
    if not all([c["AWS_ACCESS_KEY_ID"], c["AWS_SECRET_ACCESS_KEY"], c["AWS_ENDPOINT_URL_S3"], c["AWS_REGION"]]):
        return None
    return boto3.client("s3", endpoint_url=c["AWS_ENDPOINT_URL_S3"], region_name=c["AWS_REGION"], aws_access_key_id=c["AWS_ACCESS_KEY_ID"], aws_secret_access_key=c["AWS_SECRET_ACCESS_KEY"])

def release_station(session_id):
    with cursor(commit=True) as cur:
        cur.execute("DELETE FROM station_locks WHERE session_id = %s", (session_id,))

def guest_rows():
    with cursor() as cur:
        cur.execute("""
            SELECT g.codice_carta_identita, g.nome, g.cognome, g.invitante, g.numero_tavolo,
                   c.timestamp, c.postazione, c.codice_carta_identita AS checkin_code
            FROM guests g LEFT JOIN checkins c USING (codice_carta_identita)
            ORDER BY g.cognome, g.nome
        """)
        rows = cur.fetchall()
    return [{"codice_carta_identita": r["codice_carta_identita"], "nome": r["nome"], "cognome": r["cognome"], "invitante": r["invitante"], "numero_tavolo": r["numero_tavolo"], "checkin": ({"timestamp": r["timestamp"], "postazione": r["postazione"], "nome": r["nome"], "cognome": r["cognome"], "numero_tavolo": r["numero_tavolo"]} if r["checkin_code"] else None)} for r in rows]

@bp.before_request
def protect_api():
    if request.endpoint in {"api.static"}:
        return None
    if request.path in {"/api/auth/session", "/api/auth/login", "/api/auth/logout"}:
        return None
    if not session.get("role") or not session.get("session_id"):
        return jsonify(error="Accesso richiesto"), 401

@bp.get("/stations")
def stations():
    now = int(time.time())
    with cursor(commit=True) as cur:
        cur.execute("DELETE FROM station_locks WHERE expires_at <= %s", (now,))
        cur.execute("SELECT station, session_id FROM station_locks")
        locks = cur.fetchall()
    owned = next((x["station"] for x in locks if x["session_id"] == session["session_id"]), None)
    return jsonify(current=owned, stations=[{"name": name, "busy": any(x["station"] == name and x["session_id"] != session["session_id"] for x in locks), "selected": owned == name} for name in current_app.config["STATIONS"]])

@bp.post("/stations/<path:station>/claim")
def claim_station(station):
    if station not in current_app.config["STATIONS"]:
        return jsonify(error="Postazione non valida"), 400
    now = int(time.time())
    with connection() as conn:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_xact_lock(%s)", (784222,))
                cur.execute("DELETE FROM station_locks WHERE expires_at <= %s", (now,))
                cur.execute("SELECT session_id FROM station_locks WHERE station = %s FOR UPDATE", (station,))
                occupied = cur.fetchone()
                if occupied and occupied[0] != session["session_id"]:
                    conn.rollback()
                    return jsonify(error="Questa postazione è già in uso. Selezionane un’altra."), 409
                cur.execute("DELETE FROM station_locks WHERE session_id = %s", (session["session_id"],))
                cur.execute("INSERT INTO station_locks (station, session_id, expires_at) VALUES (%s, %s, %s)", (station, session["session_id"], now + current_app.config["STATION_LOCK_SECONDS"]))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    return jsonify(success=True, station=station, expiresIn=current_app.config["STATION_LOCK_SECONDS"])

@bp.post("/stations/heartbeat")
def station_heartbeat():
    with cursor(commit=True) as cur:
        cur.execute("UPDATE station_locks SET expires_at = %s WHERE session_id = %s", (int(time.time()) + current_app.config["STATION_LOCK_SECONDS"], session["session_id"]))
        updated = cur.rowcount
    if not updated:
        return jsonify(error="La postazione non è più riservata a questa sessione."), 409
    return jsonify(success=True, expiresIn=current_app.config["STATION_LOCK_SECONDS"])

@bp.delete("/stations/claim")
def unclaim_station():
    release_station(session["session_id"])
    return jsonify(success=True)

@bp.get("/guests")
def get_guests():
    return jsonify(guest_rows())

@bp.post("/checkin")
def checkin():
    body = request.get_json(silent=True) or {}
    code = body.get("codice_carta_identita")
    if session["role"] == "station":
        with cursor() as cur:
            cur.execute("SELECT station FROM station_locks WHERE session_id = %s AND expires_at > %s", (session["session_id"], int(time.time())))
            lock = cur.fetchone()
        if not lock:
            return jsonify(error="Seleziona una postazione disponibile prima di registrare gli ingressi."), 409
        station = lock["station"]
    else:
        station = body.get("postazione")
    if not code or not station:
        return jsonify(error="Dati mancanti"), 400
    if station not in current_app.config["STATIONS"]:
        return jsonify(error="Postazione non valida"), 400
    with cursor() as cur:
        cur.execute("SELECT * FROM guests WHERE codice_carta_identita = %s", (code,))
        guest = cur.fetchone()
    if not guest:
        return jsonify(error="Invitato non trovato"), 404
    stamp = datetime.now(timezone.utc).isoformat()
    with cursor(commit=True) as cur:
        cur.execute("""INSERT INTO checkins (codice_carta_identita, timestamp, postazione, nome, cognome, numero_tavolo)
                       VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (codice_carta_identita) DO NOTHING RETURNING codice_carta_identita""",
                    (code, stamp, station, guest["nome"], guest["cognome"], guest["numero_tavolo"]))
        inserted = cur.fetchone()
        if not inserted:
            cur.execute("SELECT * FROM checkins WHERE codice_carta_identita = %s", (code,))
            existing = dict(cur.fetchone())
            return jsonify(error="Già registrato", checkin=existing), 409
    return jsonify(success=True, guest=dict(guest), checkin={"timestamp": stamp, "postazione": station, "nome": guest["nome"], "cognome": guest["cognome"], "numero_tavolo": guest["numero_tavolo"]})

@bp.delete("/checkin/<path:code>")
def undo_checkin(code):
    with cursor(commit=True) as cur:
        cur.execute("DELETE FROM checkins WHERE codice_carta_identita = %s", (code,))
        deleted = cur.rowcount
    if not deleted:
        return jsonify(error="Check-in non trovato"), 404
    return jsonify(success=True)

@bp.get("/stats")
def stats():
    with cursor() as cur:
        cur.execute("SELECT (SELECT COUNT(*) FROM guests)::int AS total, (SELECT COUNT(*) FROM checkins)::int AS entered")
        counts = cur.fetchone()
        cur.execute("SELECT postazione, COUNT(*)::int AS count FROM checkins GROUP BY postazione")
        rows = cur.fetchall()
    by_station = {name: 0 for name in current_app.config["STATIONS"]}
    for row in rows:
        if row["postazione"] in by_station:
            by_station[row["postazione"]] = row["count"]
    return jsonify(total=counts["total"], entered=counts["entered"], pending=counts["total"]-counts["entered"], byPostazione=by_station)

@bp.post("/admin/guests")
@admin_required
def add_guest():
    body = request.get_json(silent=True) or {}
    guest = {"nome": str(body.get("nome") or "").strip(), "cognome": str(body.get("cognome") or "").strip(), "codice_carta_identita": str(body.get("codice_carta_identita") or "").strip().upper(), "invitante": str(body.get("invitante") or "").strip(), "numero_tavolo": str(body.get("numero_tavolo") or "").strip()}
    if not guest["nome"] or not guest["cognome"] or not guest["codice_carta_identita"]:
        return jsonify(error="Nome, cognome e codice carta d’identità sono obbligatori"), 400
    with cursor(commit=True) as cur:
        cur.execute("""INSERT INTO guests (codice_carta_identita, nome, cognome, invitante, numero_tavolo)
                       VALUES (%s, %s, %s, %s, %s) ON CONFLICT (codice_carta_identita) DO NOTHING RETURNING codice_carta_identita""",
                    (guest["codice_carta_identita"], guest["nome"], guest["cognome"], guest["invitante"], guest["numero_tavolo"]))
        inserted = cur.fetchone()
    if not inserted:
        return jsonify(error="Esiste già un invitato con questo codice"), 409
    guest["checkin"] = None
    return jsonify(success=True, guest=guest), 201

@bp.delete("/admin/guests/<path:code>")
@admin_required
def delete_guest(code):
    with cursor(commit=True) as cur:
        cur.execute("DELETE FROM guests WHERE codice_carta_identita = %s", (code,))
        deleted = cur.rowcount
    if not deleted:
        return jsonify(error="Invitato non trovato"), 404
    return jsonify(success=True)

@bp.get("/admin/backups")
@admin_required
def list_backups():
    client = storage_client()
    if not client:
        return jsonify(error="Object storage non configurato sul server"), 503
    try:
        result = client.list_objects_v2(Bucket=current_app.config["STORAGE_BUCKET"], Prefix="backups/")
        pattern = re.compile(r"^backups/event-checkin-[\dTZ-]+-[a-f0-9]{8}\.json$")
        backups = [{"name": item["Key"].split("/", 1)[1], "size": item.get("Size", 0), "createdAt": item.get("LastModified").isoformat() if item.get("LastModified") else None} for item in result.get("Contents", []) if pattern.match(item.get("Key", ""))]
        backups.sort(key=lambda item: item["createdAt"] or "", reverse=True)
        return jsonify(backups=backups)
    except Exception:
        current_app.logger.exception("Errore lettura backup object storage")
        return jsonify(error="Impossibile leggere i backup da Neon Object Storage"), 502

@bp.post("/admin/backups")
@admin_required
def create_backup():
    client = storage_client()
    if not client:
        return jsonify(error="Object storage non configurato sul server"), 503
    try:
        with cursor() as cur:
            cur.execute("SELECT * FROM guests ORDER BY cognome, nome")
            guests = [dict(x) for x in cur.fetchall()]
            cur.execute("SELECT * FROM checkins ORDER BY timestamp")
            checkins = [dict(x) for x in cur.fetchall()]
        created = datetime.now(timezone.utc).isoformat()
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
        import secrets
        name = f"event-checkin-{stamp}-{secrets.token_hex(4)}.json"
        payload = json.dumps({"version": 1, "createdAt": created, "guests": guests, "checkins": checkins}, ensure_ascii=False, indent=2).encode("utf-8")
        client.put_object(Bucket=current_app.config["STORAGE_BUCKET"], Key=f"backups/{name}", Body=payload, ContentType="application/json")
        return jsonify(success=True, backup={"name": name, "size": len(payload), "createdAt": created}), 201
    except Exception:
        current_app.logger.exception("Errore creazione backup object storage")
        return jsonify(error="Impossibile salvare il backup su Neon Object Storage"), 502

@bp.get("/admin/backups/<path:name>")
@admin_required
def download_backup(name):
    if not re.fullmatch(r"event-checkin-[\dTZ-]+-[a-f0-9]{8}\.json", name):
        return jsonify(error="Nome backup non valido"), 400
    client = storage_client()
    if not client:
        return jsonify(error="Object storage non configurato sul server"), 503
    try:
        obj = client.get_object(Bucket=current_app.config["STORAGE_BUCKET"], Key=f"backups/{name}")
        response = send_file(BytesIO(obj["Body"].read()), mimetype="application/json", as_attachment=True, download_name=name)
        response.headers["Cache-Control"] = "private, no-store"
        return response
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404"}:
            return jsonify(error="Backup non trovato"), 404
        current_app.logger.exception("Errore download backup")
        return jsonify(error="Impossibile scaricare il backup da Neon Object Storage"), 502

@bp.post("/sos")
def sos():
    token, chat_id = current_app.config["TG_TOKEN"], current_app.config["TG_CHAT_ID"]
    if not token or not chat_id:
        return jsonify(error="Assistenza non configurata sul server"), 503
    body = request.get_json(silent=True) or {}
    station = body.get("postazione") if isinstance(body.get("postazione"), str) else "non selezionata"
    try:
        response = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", json={"chat_id": chat_id, "text": f"🚨 Assistenza urgente richiesta alla {station}"}, timeout=10)
        result = response.json()
        if not response.ok or not result.get("ok"):
            return jsonify(error=result.get("description", "Errore Telegram")), 502
        return jsonify(success=True)
    except requests.RequestException:
        return jsonify(error="Errore di rete verso Telegram"), 502
