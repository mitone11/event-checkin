# Event Check-in App

Applicativo web per la gestione degli ingressi a un evento. I dati dell'evento sono conservati in un database SQLite locale.

## Requisiti

- Node.js 24 o superiore (`node:sqlite` è integrato in Node.js)

## Installazione e avvio

```bash
npm install
npm start
```

Il server parte su http://localhost:3000. Al primo avvio crea `data/checkin.sqlite` e importa automaticamente gli invitati da `invitati.csv` e gli eventuali check-in da `checkins.json`. I due file legacy restano intatti come copia dei dati di partenza; gli avvii successivi usano il database.

Il database contiene sia la lista invitati sia i check-in e non viene aggiunto a Git. Per conservarlo, includere `data/checkin.sqlite` nei backup del computer/server che esegue l'applicazione. Per aggiornare la lista dopo l'import iniziale, modificare il database con uno strumento compatibile con SQLite: modificare il CSV non aggiorna automaticamente il database.

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
