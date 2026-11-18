import csv
import json
from datetime import datetime, timezone
from app.db import connection

MIGRATION_NAME = "import_legacy_csv_json_v1"

def initialize_database(config):
    with connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS guests (
                    codice_carta_identita TEXT PRIMARY KEY,
                    nome TEXT NOT NULL DEFAULT '',
                    cognome TEXT NOT NULL DEFAULT '',
                    invitante TEXT NOT NULL DEFAULT '',
                    numero_tavolo TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS checkins (
                    codice_carta_identita TEXT PRIMARY KEY REFERENCES guests(codice_carta_identita) ON DELETE CASCADE,
                    timestamp TEXT NOT NULL,
                    postazione TEXT NOT NULL,
                    nome TEXT NOT NULL DEFAULT '',
                    cognome TEXT NOT NULL DEFAULT '',
                    numero_tavolo TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS station_locks (
                    station TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL UNIQUE,
                    expires_at BIGINT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS station_locks_expires_at_idx ON station_locks(expires_at);
                CREATE TABLE IF NOT EXISTS app_migrations (
                    name TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
            """)
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (784221,))
            cur.execute("SELECT 1 FROM app_migrations WHERE name = %s", (MIGRATION_NAME,))
            if cur.fetchone():
                conn.commit()
                return
            csv_path = config["GUESTS_CSV"]
            if not csv_path.exists():
                raise RuntimeError("File data/invitati.csv assente: impossibile importare gli invitati iniziali.")
            with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
                guests = list(csv.DictReader(handle, delimiter=","))
            checkins_path = config["LEGACY_CHECKINS_JSON"]
            checkins = json.loads(checkins_path.read_text(encoding="utf-8-sig")) if checkins_path.exists() else {}
            imported = 0
            for guest in guests:
                code = (guest.get("codice_carta_identita") or "").strip()
                if not code:
                    continue
                cur.execute("""
                    INSERT INTO guests (codice_carta_identita, nome, cognome, invitante, numero_tavolo)
                    VALUES (%s, %s, %s, %s, %s) ON CONFLICT (codice_carta_identita) DO NOTHING
                    RETURNING codice_carta_identita
                """, (code, guest.get("nome") or "", guest.get("cognome") or "", guest.get("invitante") or "", guest.get("numero_tavolo") or ""))
                if not cur.fetchone():
                    continue
                imported += 1
                old = checkins.get(code)
                if old:
                    cur.execute("""
                        INSERT INTO checkins (codice_carta_identita, timestamp, postazione, nome, cognome, numero_tavolo)
                        VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (codice_carta_identita) DO NOTHING
                    """, (code, old.get("timestamp") or datetime.now(timezone.utc).isoformat(), old.get("postazione") or "", old.get("nome") or guest.get("nome") or "", old.get("cognome") or guest.get("cognome") or "", old.get("numero_tavolo") or guest.get("numero_tavolo") or ""))
            cur.execute("INSERT INTO app_migrations (name) VALUES (%s)", (MIGRATION_NAME,))
        conn.commit()
    print(f"Importati {imported} invitati da CSV/JSON in PostgreSQL.")
