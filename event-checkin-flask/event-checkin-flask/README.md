# Event Check-in — Flask

Applicazione per gestire gli ingressi agli eventi. Backend Python/Flask, pagine HTML renderizzate con Jinja2, CSS e JavaScript vanilla. Database PostgreSQL (compatibile con il database Neon già utilizzato dal progetto Node).

## Stack

- Python 3.12+
- Flask + Jinja2
- HTML, CSS e JavaScript vanilla
- PostgreSQL tramite psycopg2
- Neon Object Storage tramite boto3 (backup facoltativi)
- Telegram Bot API per il pulsante SOS (facoltativo)

## Avvio in locale

1. Crea un ambiente virtuale e installa le dipendenze:

   ```bash
   python -m venv .venv
   # Windows PowerShell
   .venv\\Scripts\\Activate.ps1
   # macOS/Linux
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. Crea il file `.env` partendo da `.env.example` e configura `DATABASE_URL`, `ADMIN_PASSWORD`, `STATION_PASSWORD` e `SECRET_KEY`. Puoi riutilizzare le credenziali Neon già configurate nel progetto precedente: non inserirle nel repository.
3. Avvia:

   ```bash
   python run.py
   ```

4. Apri http://127.0.0.1:5000.

Al primo avvio sul database esistente, l'applicazione crea le tabelle mancanti e registra una migrazione una tantum per importare i dati da `data/invitati.csv` e `data/checkins.json`. Se il database Node contiene già la migrazione `import_legacy_csv_json_v1`, non reimporta né sovrascrive i dati esistenti.

## Deploy

Con Docker: `docker build -t event-checkin .` e poi esegui il container passando le variabili d'ambiente. Su Render puoi usare il Dockerfile oppure il `Procfile` (runtime Python). Imposta `DATABASE_URL`, `ADMIN_PASSWORD`, `STATION_PASSWORD`, `SECRET_KEY`; le variabili `AWS_*` e `TG_*` sono facoltative.

## Struttura

```text
app/
  __init__.py          # application factory e registrazione blueprint
  config.py            # configurazione e variabili d'ambiente
  db.py                # pool PostgreSQL
  routes/
    auth.py             # login, sessione e logout
    api.py              # invitati, check-in, postazioni, admin, backup e SOS
  services/
    initialization.py  # schema DB e import iniziale
static/
  app.js
  style.css
templates/
  index.html
data/
  invitati.csv
  checkins.json
run.py
```

## Sicurezza e dati

- Non committare `.env` o `.env.local`.
- Il database PostgreSQL rimane la fonte principale dei dati persistenti.
- Le sessioni sono cookie firmati Flask, HttpOnly e SameSite Strict; in produzione abilita HTTPS (cookie Secure).
- Le postazioni sono bloccate lato database per 90 secondi e il browser rinnova il blocco ogni 20 secondi.
- I backup cloud sono disponibili solo se configuri le credenziali S3 di Neon.

## API principali

| Metodo | Endpoint | Descrizione |
|---|---|---|
| GET | `/api/auth/session` | Stato sessione |
| POST | `/api/auth/login` | Login admin/operatore |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/stations` | Stato postazioni |
| POST | `/api/stations/<station>/claim` | Prenota postazione |
| POST | `/api/stations/heartbeat` | Rinnova prenotazione |
| GET | `/api/guests` | Elenco invitati |
| POST | `/api/checkin` | Registra ingresso |
| DELETE | `/api/checkin/<code>` | Annulla ingresso |
| GET | `/api/stats` | Statistiche |
| POST/DELETE | `/api/admin/guests` | Gestione invitati |
| GET/POST | `/api/admin/backups` | Elenco e creazione backup |
| GET | `/api/admin/backups/<name>` | Download backup |
| POST | `/api/sos` | Notifica Telegram |
