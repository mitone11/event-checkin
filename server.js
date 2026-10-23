const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DATABASE_PATH = path.join(DATA_DIR, 'checkin.sqlite');
const CSV_PATH = path.join(__dirname, 'invitati.csv');
const LEGACY_CHECKINS_PATH = path.join(__dirname, 'checkins.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DATABASE_PATH, { timeout: 5000 });
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
db.exec(`
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
`);

function readLegacyGuests() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const cleaned = raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      line = line.replace(/;+\s*$/, '').trim();
      if (line.startsWith('"') && line.endsWith('"')) line = line.slice(1, -1);
      return line.replace(/""/g, '"');
    })
    .join('\n');
  return parse(cleaned, { columns: true, skip_empty_lines: true, trim: true });
}

function migrateLegacyData() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM guests').get().count;
  if (count > 0) return;
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`Database vuoto e file invitati.csv assente: ${DATABASE_PATH}`);
  }

  const guests = readLegacyGuests();
  const checkins = fs.existsSync(LEGACY_CHECKINS_PATH)
    ? JSON.parse(fs.readFileSync(LEGACY_CHECKINS_PATH, 'utf-8').replace(/^\uFEFF/, ''))
    : {};

  const insertGuest = db.prepare(`
    INSERT INTO guests (codice_carta_identita, nome, cognome, invitante, numero_tavolo)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertCheckin = db.prepare(`
    INSERT OR IGNORE INTO checkins
      (codice_carta_identita, timestamp, postazione, nome, cognome, numero_tavolo)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN');
  try {
    for (const guest of guests) {
      const code = (guest.codice_carta_identita || '').trim();
      if (!code) continue;
      insertGuest.run(code, guest.nome || '', guest.cognome || '', guest.invitante || '', guest.numero_tavolo || '');
      const checkin = checkins[code];
      if (checkin) {
        insertCheckin.run(
          code,
          checkin.timestamp || new Date().toISOString(),
          checkin.postazione || '',
          checkin.nome || guest.nome || '',
          checkin.cognome || guest.cognome || '',
          checkin.numero_tavolo || guest.numero_tavolo || ''
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`Importati ${guests.length} invitati nel database SQLite.`);
}

migrateLegacyData();

function getGuests() {
  return db.prepare(`
    SELECT g.*, c.timestamp, c.postazione,
      c.codice_carta_identita AS checkin_code
    FROM guests g
    LEFT JOIN checkins c USING (codice_carta_identita)
    ORDER BY g.cognome, g.nome
  `).all().map(row => ({
    codice_carta_identita: row.codice_carta_identita,
    nome: row.nome,
    cognome: row.cognome,
    invitante: row.invitante,
    numero_tavolo: row.numero_tavolo,
    checkin: row.checkin_code ? {
      timestamp: row.timestamp,
      postazione: row.postazione,
      nome: row.nome,
      cognome: row.cognome,
      numero_tavolo: row.numero_tavolo
    } : null
  }));
}

app.get('/api/guests', (req, res) => {
  res.json(getGuests());
});

app.post('/api/checkin', (req, res) => {
  const { codice_carta_identita, postazione } = req.body;
  if (!codice_carta_identita || !postazione) {
    return res.status(400).json({ error: 'Dati mancanti' });
  }

  const guest = db.prepare('SELECT * FROM guests WHERE codice_carta_identita = ?').get(codice_carta_identita);
  if (!guest) return res.status(404).json({ error: 'Invitato non trovato' });

  const timestamp = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO checkins (codice_carta_identita, timestamp, postazione, nome, cognome, numero_tavolo)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(codice_carta_identita) DO NOTHING
  `).run(codice_carta_identita, timestamp, postazione, guest.nome, guest.cognome, guest.numero_tavolo);
  if (!result.changes) {
    const checkin = db.prepare('SELECT * FROM checkins WHERE codice_carta_identita = ?').get(codice_carta_identita);
    return res.status(409).json({ error: 'Già registrato', checkin });
  }

  res.json({ success: true, guest, checkin: { timestamp, postazione, nome: guest.nome, cognome: guest.cognome, numero_tavolo: guest.numero_tavolo } });
});

app.delete('/api/checkin/:codice', (req, res) => {
  const result = db.prepare('DELETE FROM checkins WHERE codice_carta_identita = ?').run(req.params.codice);
  if (!result.changes) return res.status(404).json({ error: 'Check-in non trovato' });
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS count FROM guests').get().count;
  const entered = db.prepare('SELECT COUNT(*) AS count FROM checkins').get().count;
  const byPostazione = { 'Postazione 1': 0, 'Postazione 2': 0, 'Postazione 3': 0 };
  for (const row of db.prepare('SELECT postazione, COUNT(*) AS count FROM checkins GROUP BY postazione').all()) {
    if (byPostazione[row.postazione] !== undefined) byPostazione[row.postazione] = row.count;
  }
  res.json({ total, entered, pending: total - entered, byPostazione });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato su http://localhost:${PORT}`));
