# Event Check-in App

Applicativo web per la gestione degli ingressi a un evento. I dati dell'evento sono conservati in un database SQLite locale.

## Requisiti

- Node.js 24 o superiore (`node:sqlite` è integrato in Node.js)
- Password admin e password postazione distinte, impostate nel file `.env`

## Installazione e avvio

```bash
npm install
npm start
```

Prima del primo avvio, crea il file locale `.env` copiando `.env.example` e sostituendo i valori segnaposto. Imposta due password diverse: `ADMIN_PASSWORD` per gli amministratori e `STATION_PASSWORD` per gli operatori di tutte le postazioni. Imposta anche un valore casuale lungo per `SESSION_SECRET`; il file `.env` è escluso da Git. In PowerShell:

```powershell
Copy-Item .env.example .env
```

Il server parte su http://localhost:3000. Il login viene verificato dal server e mantiene una sessione protetta per otto ore. Il login admin mostra il pannello admin; quello postazione accede al check-in senza poter modificare la lista invitati. Entrambi richiedono una sessione valida.

Una sessione può prenotare una sola postazione per volta. Le postazioni già prenotate vengono mostrate come non disponibili. Il server rinnova la prenotazione ogni 20 secondi e la libera dopo 90 secondi senza rinnovo o al logout. Un check-in fatto dalla password postazione viene registrato solo sulla postazione riservata a quella sessione.

Al primo avvio crea `data/checkin.sqlite` e importa automaticamente gli invitati da `invitati.csv` e gli eventuali check-in da `checkins.json`. I due file legacy restano intatti come copia dei dati di partenza; gli avvii successivi usano il database.

Il database contiene sia la lista invitati sia i check-in e non viene aggiunto a Git. Per conservarlo, includere `data/checkin.sqlite` nei backup del computer/server che esegue l'applicazione. Dopo l'import iniziale, gestire la lista dal pannello admin: modificare il CSV non aggiorna automaticamente il database.

L'assistenza Telegram legge `TG_TOKEN` e `TG_CHAT_ID` dal file `.env` e invia le richieste dal server. Il token Telegram usato in precedenza era incorporato nel JavaScript del sito: va revocato e sostituito tramite BotFather prima di usare nuovamente la funzione SOS.

## Utilizzo con più postazioni in rete

1. Avvia il server su un PC connesso alla stessa rete (o su un server cloud).
2. Trova l'indirizzo IP del PC server (es. `192.168.1.50`).
3. Da ogni postazione apri `http://192.168.1.50:3000`.
4. Ogni postazione seleziona il proprio nome in alto a destra.

Tutte le postazioni comunicano con lo stesso server e quindi con lo stesso database SQLite.

## Funzionalità

- Visualizza lista invitati con stato ingresso in tempo reale
- Filtra per: Tutti / In attesa / Entrati / Per invitante
- Ricerca rapida per nome, cognome o codice CI
- Registra ingresso con un click e la postazione
- Annulla un check-in registrato per errore
- Aggiornamento automatico ogni 10 secondi
- Dashboard con statistiche (totale, entrati, in attesa, %)

## API disponibili

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | /api/guests | Lista completa con stato check-in |
| POST | /api/checkin | Registra ingresso |
| DELETE | /api/checkin/:ci | Annulla ingresso |
| GET | /api/stats | Statistiche aggregate |
