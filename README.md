# Event Check-in App

Applicativo web per la gestione degli ingressi a un evento con lista invitati da CSV.

## Struttura file

```
event-checkin/
├── server.js          ← Backend Node.js (API REST)
├── invitati.csv       ← Lista invitati (da modificare)
├── checkins.json      ← Generato automaticamente al primo check-in
├── public/
│   └── index.html     ← Frontend (servito dal backend)
└── package.json
```

## Formato CSV (invitati.csv)

```csv
nome,cognome,codice_carta_identita,invitante
Mario,Rossi,AB1234567,Giovanni Bianchi
Lucia,Verdi,CD2345678,Giovanni Bianchi
```

Le colonne obbligatorie sono:
- `nome`
- `cognome`
- `codice_carta_identita`
- `invitante`

## Installazione e avvio

```bash
# Entra nella cartella
cd event-checkin

# Installa le dipendenze (solo la prima volta)
npm install

# Avvia il server
node server.js
```

Il server parte su: http://localhost:3000

## Utilizzo con più postazioni in rete

1. Avvia il server su un PC connesso alla stessa rete (o su un server cloud)
2. Trova l'indirizzo IP del PC server (es. `192.168.1.50`)
3. Da ogni postazione apri il browser su: `http://192.168.1.50:3000`
4. Ogni postazione seleziona il proprio nome (Postazione 1/2/3) in alto a destra
5. La selezione viene salvata nel browser locale

## Funzionalità

- Visualizza lista invitati con stato ingresso in tempo reale
- Filtra per: Tutti / In attesa / Entrati / Per invitante
- Ricerca rapida per nome, cognome o codice CI
- Registra ingresso con un click (indicando la postazione)
- Annulla un check-in se registrato per errore
- Aggiornamento automatico ogni 10 secondi
- Dashboard con statistiche (totale, entrati, in attesa, %)

## API disponibili

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | /api/guests | Lista completa con stato checkin |
| POST | /api/checkin | Registra ingresso |
| DELETE | /api/checkin/:ci | Annulla ingresso |
| GET | /api/stats | Statistiche aggregate |
