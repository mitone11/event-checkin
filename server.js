const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CSV_PATH = path.join(__dirname, 'invitati.csv');
const CHECKINS_PATH = path.join(__dirname, 'checkins.json');

function loadGuests() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');

  // Il CSV è malformato: ogni riga è racchiusa in virgolette esterne
  // e ha punti e virgola in coda (artefatto di Excel italiano).
  // Puliamo prima di passare al parser.
  const cleaned = raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      line = line.replace(/;+\s*$/, '').trim(); // rimuove i ;;;; finali
      if (line.startsWith('"') && line.endsWith('"')) {
        line = line.slice(1, -1); // rimuove le virgolette esterne
      }
      line = line.replace(/""/g, '"'); // decode "" → "
      return line;
    })
    .join('\n');

  return parse(cleaned, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function loadCheckins() {
  if (!fs.existsSync(CHECKINS_PATH)) return {};
  const content = fs.readFileSync(CHECKINS_PATH, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(content);
}

function saveCheckins(checkins) {
  fs.writeFileSync(CHECKINS_PATH, JSON.stringify(checkins, null, 2));
}

// GET all guests with checkin status
app.get('/api/guests', (req, res) => {
  const guests = loadGuests();
  const checkins = loadCheckins();
  const result = guests.map(g => ({
    ...g,
    checkin: checkins[g.codice_carta_identita] || null
  }));
  res.json(result);
});

// POST checkin
app.post('/api/checkin', (req, res) => {
  const { codice_carta_identita, postazione } = req.body;
  if (!codice_carta_identita || !postazione) {
    return res.status(400).json({ error: 'Dati mancanti' });
  }
  const guests = loadGuests();
  const guest = guests.find(g => g.codice_carta_identita === codice_carta_identita);
  if (!guest) {
    return res.status(404).json({ error: 'Invitato non trovato' });
  }
  const checkins = loadCheckins();
  if (checkins[codice_carta_identita]) {
    return res.status(409).json({ error: 'Già registrato', checkin: checkins[codice_carta_identita] });
  }
  const entry = {
    timestamp: new Date().toISOString(),
    postazione,
    nome: guest.nome,
    cognome: guest.cognome,
    numero_tavolo: guest.numero_tavolo || ''
  };
  checkins[codice_carta_identita] = entry;
  saveCheckins(checkins);
  res.json({ success: true, guest, checkin: entry });
});

// DELETE checkin (annulla ingresso)
app.delete('/api/checkin/:codice', (req, res) => {
  const { codice } = req.params;
  const checkins = loadCheckins();
  if (!checkins[codice]) {
    return res.status(404).json({ error: 'Check-in non trovato' });
  }
  delete checkins[codice];
  saveCheckins(checkins);
  res.json({ success: true });
});

// GET stats
app.get('/api/stats', (req, res) => {
  const guests = loadGuests();
  const checkins = loadCheckins();
  const guestCodes = new Set(guests.map(g => g.codice_carta_identita).filter(Boolean));
  const total = guests.length;
  const validCheckins = Object.entries(checkins).filter(([code]) => guestCodes.has(code));
  const entered = validCheckins.length;
  const byPostazione = { 'Postazione 1': 0, 'Postazione 2': 0, 'Postazione 3': 0 };
  validCheckins.map(([, checkin]) => checkin).forEach(c => {
    if (byPostazione[c.postazione] !== undefined) byPostazione[c.postazione]++;
  });
  res.json({ total, entered, pending: total - entered, byPostazione });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato su http://localhost:${PORT}`));
