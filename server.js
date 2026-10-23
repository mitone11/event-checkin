require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DATABASE_PATH = path.join(DATA_DIR, 'checkin.sqlite');
const CSV_PATH = path.join(__dirname, 'invitati.csv');
const LEGACY_CHECKINS_PATH = path.join(__dirname, 'checkins.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const STATION_PASSWORD = process.env.STATION_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'event_admin_session';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const STATION_LOCK_SECONDS = 90;
const STATIONS = ['Postazione 1', 'Postazione 2', 'Postazione 3', 'Postazione 4'];

if (!ADMIN_PASSWORD || !STATION_PASSWORD) {
  throw new Error('Imposta le variabili d’ambiente ADMIN_PASSWORD e STATION_PASSWORD prima di avviare il server.');
}
if (ADMIN_PASSWORD === STATION_PASSWORD) throw new Error('ADMIN_PASSWORD e STATION_PASSWORD devono essere diverse.');

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
  CREATE TABLE IF NOT EXISTS station_locks (
    station TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL
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

function createSessionToken(role) {
  const session = {
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
    sessionId: crypto.randomUUID(),
    role
  };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getSession(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookie = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) return null;
  const token = cookie.slice(SESSION_COOKIE.length + 1);
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session.sessionId || !['admin', 'station'].includes(session.role) || session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

function requireAuthenticated(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Accesso richiesto' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') return res.status(403).json({ error: 'Funzione riservata all’amministratore' });
  next();
}

function releaseStation(sessionId) {
  db.prepare('DELETE FROM station_locks WHERE session_id = ?').run(sessionId);
}

app.get('/api/auth/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = getSession(req);
  const station = session
    ? db.prepare('SELECT station FROM station_locks WHERE session_id = ? AND expires_at > ?').get(session.sessionId, Math.floor(Date.now() / 1000))?.station || null
    : null;
  res.json({ authenticated: !!session, role: session?.role || null, station });
});

app.post('/api/auth/login', (req, res) => {
  const suppliedPassword = typeof req.body.password === 'string' ? req.body.password : '';
  const suppliedHash = crypto.createHash('sha256').update(suppliedPassword).digest();
  const adminHash = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  const stationHash = crypto.createHash('sha256').update(STATION_PASSWORD).digest();
  const isAdmin = crypto.timingSafeEqual(suppliedHash, adminHash);
  const isStation = crypto.timingSafeEqual(suppliedHash, stationHash);
  if (!isAdmin && !isStation) {
    return res.status(401).json({ error: 'Password non corretta' });
  }

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Cache-Control', 'no-store');
  const role = isAdmin ? 'admin' : 'station';
  res.set('Set-Cookie', `${SESSION_COOKIE}=${createSessionToken(role)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${secure}`);
  res.json({ authenticated: true, role });
});

app.post('/api/auth/logout', (req, res) => {
  const session = getSession(req);
  if (session) releaseStation(session.sessionId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ success: true });
});

// Le API applicative richiedono una sessione valida; le scritture admin hanno un controllo ruolo dedicato.
app.use('/api', requireAuthenticated);

app.get('/api/stations', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM station_locks WHERE expires_at <= ?').run(now);
  const locks = db.prepare('SELECT station, session_id FROM station_locks').all();
  const owned = locks.find(lock => lock.session_id === req.session.sessionId)?.station || null;
  res.json({
    current: owned,
    stations: STATIONS.map(station => ({
      name: station,
      busy: locks.some(lock => lock.station === station && lock.session_id !== req.session.sessionId),
      selected: owned === station
    }))
  });
});

app.post('/api/stations/:station/claim', (req, res) => {
  const station = req.params.station;
  if (!STATIONS.includes(station)) return res.status(400).json({ error: 'Postazione non valida' });
  const now = Math.floor(Date.now() / 1000);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM station_locks WHERE expires_at <= ?').run(now);
    const occupied = db.prepare('SELECT session_id FROM station_locks WHERE station = ?').get(station);
    if (occupied && occupied.session_id !== req.session.sessionId) {
      db.exec('ROLLBACK');
      return res.status(409).json({ error: 'Questa postazione è già in uso. Selezionane un’altra.' });
    }
    db.prepare('DELETE FROM station_locks WHERE session_id = ?').run(req.session.sessionId);
    db.prepare('INSERT INTO station_locks (station, session_id, expires_at) VALUES (?, ?, ?)')
      .run(station, req.session.sessionId, now + STATION_LOCK_SECONDS);
    db.exec('COMMIT');
    res.json({ success: true, station, expiresIn: STATION_LOCK_SECONDS });
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
});

app.post('/api/stations/heartbeat', (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('UPDATE station_locks SET expires_at = ? WHERE session_id = ?')
    .run(now + STATION_LOCK_SECONDS, req.session.sessionId);
  if (!result.changes) return res.status(409).json({ error: 'La postazione non è più riservata a questa sessione.' });
  res.json({ success: true, expiresIn: STATION_LOCK_SECONDS });
});

app.delete('/api/stations/claim', (req, res) => {
  releaseStation(req.session.sessionId);
  res.json({ success: true });
});

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
  const { codice_carta_identita } = req.body;
  const stationLock = req.session.role === 'station'
    ? db.prepare('SELECT station FROM station_locks WHERE session_id = ? AND expires_at > ?')
      .get(req.session.sessionId, Math.floor(Date.now() / 1000))
    : null;
  if (req.session.role === 'station' && !stationLock) {
    return res.status(409).json({ error: 'Seleziona una postazione disponibile prima di registrare gli ingressi.' });
  }
  const postazione = req.session.role === 'station' ? stationLock?.station : req.body.postazione;
  if (!codice_carta_identita || !postazione) {
    return res.status(400).json({ error: 'Dati mancanti' });
  }
  if (!STATIONS.includes(postazione)) return res.status(400).json({ error: 'Postazione non valida' });

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
  const byPostazione = Object.fromEntries(STATIONS.map(station => [station, 0]));
  for (const row of db.prepare('SELECT postazione, COUNT(*) AS count FROM checkins GROUP BY postazione').all()) {
    if (byPostazione[row.postazione] !== undefined) byPostazione[row.postazione] = row.count;
  }
  res.json({ total, entered, pending: total - entered, byPostazione });
});

app.post('/api/admin/guests', requireAdmin, (req, res) => {
  const guest = {
    nome: typeof req.body.nome === 'string' ? req.body.nome.trim() : '',
    cognome: typeof req.body.cognome === 'string' ? req.body.cognome.trim() : '',
    codice_carta_identita: typeof req.body.codice_carta_identita === 'string' ? req.body.codice_carta_identita.trim().toUpperCase() : '',
    invitante: typeof req.body.invitante === 'string' ? req.body.invitante.trim() : '',
    numero_tavolo: typeof req.body.numero_tavolo === 'string' ? req.body.numero_tavolo.trim() : ''
  };
  if (!guest.nome || !guest.cognome || !guest.codice_carta_identita) {
    return res.status(400).json({ error: 'Nome, cognome e codice carta d’identità sono obbligatori' });
  }
  const result = db.prepare(`
    INSERT INTO guests (codice_carta_identita, nome, cognome, invitante, numero_tavolo)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(codice_carta_identita) DO NOTHING
  `).run(guest.codice_carta_identita, guest.nome, guest.cognome, guest.invitante, guest.numero_tavolo);
  if (!result.changes) return res.status(409).json({ error: 'Esiste già un invitato con questo codice' });
  res.status(201).json({ success: true, guest: { ...guest, checkin: null } });
});

app.delete('/api/admin/guests/:codice', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM guests WHERE codice_carta_identita = ?').run(req.params.codice);
  if (!result.changes) return res.status(404).json({ error: 'Invitato non trovato' });
  res.json({ success: true });
});

app.post('/api/sos', async (req, res) => {
  const { TG_TOKEN, TG_CHAT_ID } = process.env;
  if (!TG_TOKEN || !TG_CHAT_ID) return res.status(503).json({ error: 'Assistenza non configurata sul server' });
  const postazione = typeof req.body.postazione === 'string' ? req.body.postazione : 'non selezionata';
  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `🚨 Assistenza urgente richiesta alla ${postazione}` })
    });
    const result = await telegramResponse.json();
    if (!telegramResponse.ok || !result.ok) return res.status(502).json({ error: result.description || 'Errore Telegram' });
    res.json({ success: true });
  } catch (error) {
    res.status(502).json({ error: 'Errore di rete verso Telegram' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato su http://localhost:${PORT}`));
