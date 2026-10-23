# Event Check-in App

Applicativo web per la gestione degli ingressi a un evento. Il backend salva invitati, check-in e prenotazioni delle postazioni in PostgreSQL. Per Render Free si può usare un database PostgreSQL esterno persistente, ad esempio Neon.

## Avvio locale con Docker

Requisiti: Docker Desktop.

1. Copia `.env.example` in `.env` e imposta `ADMIN_PASSWORD`, `STATION_PASSWORD` e `SESSION_SECRET` con valori casuali e distinti. Le credenziali Telegram sono facoltative.
2. Avvia i container:

   ```bash
   docker compose up --build
   ```

3. Apri http://localhost:3000. PostgreSQL locale salva i dati nel volume Docker `postgres_data`, che resta anche dopo il riavvio dei container. Per fermarli usa `docker compose down`; non usare `docker compose down -v` se vuoi conservare il database.

Il container applicativo è anche utilizzabile come Docker deployment su Render; in quel caso configura `DATABASE_URL` per un database esterno persistente e le altre variabili d'ambiente nel pannello Render.

## Render Free con database persistente

Il disco del servizio Render Free è temporaneo. Non usare SQLite o file JSON come archivio dei dati di produzione: le modifiche possono sparire quando il servizio viene riavviato o ricreato. Il database Postgres di Render Free ha una durata limitata; usa un provider esterno con piano gratuito, come Neon.

1. Crea un progetto PostgreSQL gratuito su Neon e copia la stringa di connessione (abilita SSL, ad esempio con `sslmode=require`).
2. In Render apri il servizio web, poi **Environment**, e aggiungi:
   - `DATABASE_URL`: stringa di connessione copiata da Neon
   - `ADMIN_PASSWORD`: password amministratore
   - `STATION_PASSWORD`: password condivisa dagli operatori, diversa da quella admin
   - `SESSION_SECRET`: stringa casuale lunga
   - `TG_TOKEN` e `TG_CHAT_ID`: facoltative, per il pulsante SOS Telegram
3. Salva e fai il deploy. Il server crea le tabelle PostgreSQL all'avvio.

Se Render fa il deploy con Docker, seleziona il Dockerfile del repository. Se usa il runtime Node, il comando di avvio è `npm start`. In entrambi i casi il database è esterno al container.

Al primo avvio sul nuovo database, il server importa una sola volta invitati da `invitati.csv` e check-in da `checkins.json`. Dopo questa importazione il database diventa la fonte dei dati; le modifiche fatte dal pannello admin non vengono sovrascritte ai riavvii. Se il CSV contiene invitati che avevi già rimosso, eliminali nuovamente dal pannello admin dopo l'import iniziale.

Per lo sviluppo senza Docker, installa Node.js 24 o superiore, configura `DATABASE_URL` per un PostgreSQL raggiungibile dal computer e avvia:

```bash
npm install
npm start
```

Il server parte su http://localhost:3000. Il login admin mostra il pannello di amministrazione; il login postazione consente di fare check-in senza modificare la lista invitati. Entrambi richiedono una sessione valida di otto ore.

Una sessione può prenotare una postazione per volta. Le postazioni occupate non sono selezionabili da altre sessioni. Il server rinnova la prenotazione ogni 20 secondi e la libera dopo 90 secondi senza rinnovo o al logout. Il check-in degli operatori viene associato alla postazione riservata.

## Funzionalità

- Visualizza lista invitati con stato ingresso
- Filtra per tutti, in attesa, entrati o invitante
- Cerca per nome, cognome o codice CI
- Registra o annulla un check-in
- Aggiornamento automatico ogni 10 secondi
- Dashboard con statistiche aggregate
- Gestione invitati accessibile solo al ruolo admin

## Dati e backup

Il database PostgreSQL contiene la lista invitati, i check-in e le prenotazioni. Fai backup dal provider del database e non committare credenziali o stringhe di connessione. `.env` è escluso da Git; `.env.example` contiene solo valori segnaposto.

Il token Telegram era stato inserito nel JavaScript del sito in passato: revocalo tramite BotFather e configura quello nuovo solo sul server con `TG_TOKEN`.

## API

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/guests` | Lista invitati con stato check-in |
| POST | `/api/checkin` | Registra ingresso |
| DELETE | `/api/checkin/:ci` | Annulla ingresso |
| GET | `/api/stats` | Statistiche aggregate |
