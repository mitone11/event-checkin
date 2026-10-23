const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: [path.join(__dirname, '.env'), path.join(__dirname, '.env.local')] });
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { parse } = require('csv-parse/sync');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CSV_PATH = path.join(__dirname, 'invitati.csv');
const LEGACY_CHECKINS_PATH = path.join(__dirname, 'checkins.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const STATION_PASSWORD = process.env.STATION_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_COOKIE = 'event_admin_session';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const STATION_LOCK_SECONDS = 90;
const STATIONS = ['Postazione 1', 'Postazione 2', 'Postazione 3', 'Postazione 4'];
const STORAGE_BUCKET = 'assets';
const storageConfigured = Boolean(
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_REGION
);
const storageClient = new S3Client({
  region: process.env.AWS_REGION,
  endpoint: process.env.AWS_ENDPOINT_URL_S3,
  forcePathStyle: true
});

if (!process.env.DATABASE_URL) throw new Error('Imposta DATABASE_URL con la stringa di connessione PostgreSQL.');
if (!ADMIN_PASSWORD || !STATION_PASSWORD) {
  throw new Error('Imposta le variabili d’ambiente ADMIN_PASSWORD e STATION_PASSWORD prima di avviare il server.');
}
if (ADMIN_PASSWORD === STATION_PASSWORD) throw new Error('ADMIN_PASSWORD e STATION_PASSWORD devono essere diverse.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000
});
pool.on('error', error => console.error('Errore inatteso nella connessione PostgreSQL:', error.message));

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

async function initializeDatabase() {
  await pool.query(`
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
  `);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [784221]);
    const migration = await client.query('SELECT 1 FROM app_migrations WHERE name = $1', ['import_legacy_csv_json_v1']);
    if (migration.rowCount) {
      await client.query('COMMIT');
      return;
    }
    if (!fs.existsSync(CSV_PATH)) throw new Error('File invitati.csv assente; impossibile importare gli invitati iniziali.');

    const guests = readLegacyGuests();
    const checkins = fs.existsSync(LEGACY_CHECKINS_PATH)
      ? JSON.parse(fs.readFileSync(LEGACY_CHECKINS_PATH, 'utf-8').replace(/^\uFEFF/, ''))
      : {};
    let imported = 0;
    for (const guest of guests) {
      const code = (guest.codice_carta_identita || '').trim();
      if (!code) continue;
      const inserted = await client.query(`
        INSERT INTO guests (codice_carta_identita, nome, cognome, invitante, numero_tavolo)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (codice_carta_identita) DO NOTHING
      `, [code, guest.nome || '', guest.cognome || '', guest.invitante || '', guest.numero_tavolo || '']);
      if (!inserted.rowCount) continue;
      imported++;

      const checkin = checkins[code];
      if (checkin) {
        await client.query(`
          INSERT INTO checkins (codice_carta_identita, timestamp, postazione, nome, cognome, numero_tavolo)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (codice_carta_identita) DO NOTHING
        `, [
          code,
          checkin.timestamp || new Date().toISOString(),
          checkin.postazione || '',
          checkin.nome || guest.nome || '',
          checkin.cognome || guest.cognome || '',
          checkin.numero_tavolo || guest.numero_tavolo || ''
        ]);
      }
    }
    await client.query('INSERT INTO app_migrations (name) VALUES ($1)', ['import_legacy_csv_json_v1']);
    await client.query('COMMIT');
    console.log(`Importati ${imported} invitati da CSV/JSON in PostgreSQL.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

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

async function releaseStation(sessionId) {
  await pool.query('DELETE FROM station_locks WHERE session_id = $1', [sessionId]);
}

app.get('/api/auth/session', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const session = getSession(req);
  const result = session
    ? await pool.query('SELECT station FROM station_locks WHERE session_id = $1 AND expires_at > $2', [session.sessionId, Math.floor(Date.now() / 1000)])
    : { rows: [] };
  res.json({ authenticated: !!session, role: session?.role || null, station: result.rows[0]?.station || null });
});

app.post('/api/auth/login', (req, res) => {
  const suppliedPassword = typeof req.body.password === 'string' ? req.body.password : '';
  const suppliedHash = crypto.createHash('sha256').update(suppliedPassword).digest();
  const adminHash = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  const stationHash = crypto.createHash('sha256').update(STATION_PASSWORD).digest();
  const isAdmin = crypto.timingSafeEqual(suppliedHash, adminHash);
  const isStation = crypto.timingSafeEqual(suppliedHash, stationHash);
  if (!isAdmin && !isStation) return res.status(401).json({ error: 'Password non corretta' });

  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Cache-Control', 'no-store');
  const role = isAdmin ? 'admin' : 'station';
  res.set('Set-Cookie', `${SESSION_COOKIE}=${createSessionToken(role)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${secure}`);
  res.json({ authenticated: true, role });
});

app.post('/api/auth/logout', async (req, res) => {
  const session = getSession(req);
  if (session) await releaseStation(session.sessionId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.set('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ success: true });
});

// Le API applicative richiedono una sessione valida; le scritture admin hanno un controllo ruolo dedicato.
app.use('/api', requireAuthenticated);

app.get('/api/stations', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  await pool.query('DELETE FROM station_locks WHERE expires_at <= $1', [now]);
  const { rows: locks } = await pool.query('SELECT station, session_id FROM station_locks');
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

app.post('/api/stations/:station/claim', async (req, res) => {
  const station = req.params.station;
  if (!STATIONS.includes(station)) return res.status(400).json({ error: 'Postazione non valida' });
  const now = Math.floor(Date.now() / 1000);
  const client = await pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    // Serializza le prenotazioni per evitare che due sessioni ottengano la stessa postazione.
    await client.query('SELECT pg_advisory_xact_lock($1)', [784222]);
    await client.query('DELETE FROM station_locks WHERE expires_at <= $1', [now]);
    const occupied = await client.query('SELECT session_id FROM station_locks WHERE station = $1 FOR UPDATE', [station]);
    if (occupied.rowCount && occupied.rows[0].session_id !== req.session.sessionId) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(409).json({ error: 'Questa postazione è già in uso. Selezionane un’altra.' });
    }
    await client.query('DELETE FROM station_locks WHERE session_id = $1', [req.session.sessionId]);
    await client.query('INSERT INTO station_locks (station, session_id, expires_at) VALUES ($1, $2, $3)', [station, req.session.sessionId, now + STATION_LOCK_SECONDS]);
    await client.query('COMMIT');
    transactionOpen = false;
    res.json({ success: true, station, expiresIn: STATION_LOCK_SECONDS });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/stations/heartbeat', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const result = await pool.query('UPDATE station_locks SET expires_at = $1 WHERE session_id = $2', [now + STATION_LOCK_SECONDS, req.session.sessionId]);
  if (!result.rowCount) return res.status(409).json({ error: 'La postazione non è più riservata a questa sessione.' });
  res.json({ success: true, expiresIn: STATION_LOCK_SECONDS });
});

app.delete('/api/stations/claim', async (req, res) => {
  await releaseStation(req.session.sessionId);
  res.json({ success: true });
});

async function getGuests() {
  const { rows } = await pool.query(`
    SELECT g.*, c.timestamp, c.postazione,
      c.codice_carta_identita AS checkin_code
    FROM guests g
    LEFT JOIN checkins c USING (codice_carta_identita)
    ORDER BY g.cognome, g.nome
  `);
  return rows.map(row => ({
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

app.get('/api/guests', async (req, res) => {
  res.json(await getGuests());
});

app.post('/api/checkin', async (req, res) => {
  const { codice_carta_identita } = req.body;
  const stationLock = req.session.role === 'station'
    ? await pool.query('SELECT station FROM station_locks WHERE session_id = $1 AND expires_at > $2', [req.session.sessionId, Math.floor(Date.now() / 1000)])
    : null;
  if (req.session.role === 'station' && !stationLock.rowCount) {
    return res.status(409).json({ error: 'Seleziona una postazione disponibile prima di registrare gli ingressi.' });
  }
  const postazione = req.session.role === 'station' ? stationLock.rows[0].station : req.body.postazione;
  if (!codice_carta_identita || !postazione) return res.status(400).json({ error: 'Dati mancanti' });
  if (!STATIONS.includes(postazione)) return res.status(400).json({ error: 'Postazione non valida' });

  const guestResult = await pool.query('SELECT * FROM guests WHERE codice_carta_identita = $1', [codice_carta_identita]);
  if (!guestResult.rowCount) return res.status(404).json({ error: 'Invitato non trovato' });
  const guest = guestResult.rows[0];
  const timestamp = new Date().toISOString();
  const result = await pool.query(`
    INSERT INTO checkins (codice_carta_identita, timestamp, postazione, nome, cognome, numero_tavolo)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (codice_carta_identita) DO NOTHING
    RETURNING codice_carta_identita
  `, [codice_carta_identita, timestamp, postazione, guest.nome, guest.cognome, guest.numero_tavolo]);
  if (!result.rowCount) {
    const checkin = await pool.query('SELECT * FROM checkins WHERE codice_carta_identita = $1', [codice_carta_identita]);
    return res.status(409).json({ error: 'Già registrato', checkin: checkin.rows[0] });
  }
  res.json({ success: true, guest, checkin: { timestamp, postazione, nome: guest.nome, cognome: guest.cognome, numero_tavolo: guest.numero_tavolo } });
});

app.delete('/api/checkin/:codice', async (req, res) => {
  const result = await pool.query('DELETE FROM checkins WHERE codice_carta_identita = $1', [req.params.codice]);
  if (!result.rowCount) return res.status(404).json({ error: 'Check-in non trovato' });
  res.json({ success: true });
});

app.get('/api/stats', async (req, res) => {
  const counts = await pool.query(`
    SELECT (SELECT COUNT(*)::int FROM guests) AS total,
           (SELECT COUNT(*)::int FROM checkins) AS entered
  `);
  const total = counts.rows[0].total;
  const entered = counts.rows[0].entered;
  const byPostazione = Object.fromEntries(STATIONS.map(station => [station, 0]));
  const stations = await pool.query('SELECT postazione, COUNT(*)::int AS count FROM checkins GROUP BY postazione');
  for (const row of stations.rows) {
    if (byPostazione[row.postazione] !== undefined) byPostazione[row.postazione] = row.count;
  }
  res.json({ total, entered, pending: total - entered, byPostazione });
});

app.post('/api/admin/guests', requireAdmin, async (req, res) => {
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
  const result = await pool.query(`
    INSERT INTO guests (codice_carta_identita, nome, cognome, invitante, numero_tavolo)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (codice_carta_identita) DO NOTHING
    RETURNING codice_carta_identita
  `, [guest.codice_carta_identita, guest.nome, guest.cognome, guest.invitante, guest.numero_tavolo]);
  if (!result.rowCount) return res.status(409).json({ error: 'Esiste già un invitato con questo codice' });
  res.status(201).json({ success: true, guest: { ...guest, checkin: null } });
});

app.delete('/api/admin/guests/:codice', requireAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM guests WHERE codice_carta_identita = $1', [req.params.codice]);
  if (!result.rowCount) return res.status(404).json({ error: 'Invitato non trovato' });
  res.json({ success: true });
});

app.get('/api/admin/backups', requireAdmin, async (req, res) => {
  if (!storageConfigured) return res.status(503).json({ error: 'Object storage non configurato sul server' });
  try {
    const result = await storageClient.send(new ListObjectsV2Command({ Bucket: STORAGE_BUCKET, Prefix: 'backups/' }));
    const backups = (result.Contents || [])
      .filter(item => item.Key && /^backups\/event-checkin-[\dTZ-]+-[a-f0-9]{8}\.json$/.test(item.Key))
      .map(item => ({ name: item.Key.slice('backups/'.length), size: item.Size || 0, createdAt: item.LastModified || null }))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json({ backups });
  } catch (error) {
    console.error('Errore lettura backup object storage:', error.message);
    res.status(502).json({ error: 'Impossibile leggere i backup da Neon Object Storage' });
  }
});

app.post('/api/admin/backups', requireAdmin, async (req, res) => {
  if (!storageConfigured) return res.status(503).json({ error: 'Object storage non configurato sul server' });
  try {
    const [guests, checkins] = await Promise.all([
      pool.query('SELECT * FROM guests ORDER BY cognome, nome'),
      pool.query('SELECT * FROM checkins ORDER BY timestamp')
    ]);
    const createdAt = new Date().toISOString();
    const filename = `event-checkin-${createdAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json`;
    const backup = Buffer.from(JSON.stringify({ version: 1, createdAt, guests: guests.rows, checkins: checkins.rows }, null, 2));
    await storageClient.send(new PutObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: `backups/${filename}`,
      Body: backup,
      ContentType: 'application/json'
    }));
    res.status(201).json({ success: true, backup: { name: filename, size: backup.length, createdAt } });
  } catch (error) {
    console.error('Errore creazione backup object storage:', error.message);
    res.status(502).json({ error: 'Impossibile salvare il backup su Neon Object Storage' });
  }
});

app.get('/api/admin/backups/:name', requireAdmin, async (req, res) => {
  if (!storageConfigured) return res.status(503).json({ error: 'Object storage non configurato sul server' });
  const filename = req.params.name;
  if (!/^event-checkin-[\dTZ-]+-[a-f0-9]{8}\.json$/.test(filename)) {
    return res.status(400).json({ error: 'Nome backup non valido' });
  }
  try {
    const result = await storageClient.send(new GetObjectCommand({
      Bucket: STORAGE_BUCKET,
      Key: `backups/${filename}`
    }));
    const bytes = await result.Body.transformToByteArray();
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store'
    });
    res.send(Buffer.from(bytes));
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Backup non trovato' });
    }
    console.error('Errore download backup object storage:', error.message);
    res.status(502).json({ error: 'Impossibile scaricare il backup da Neon Object Storage' });
  }
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
  } catch {
    res.status(502).json({ error: 'Errore di rete verso Telegram' });
  }
});

const PORT = process.env.PORT || 3000;
initializeDatabase()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Server avviato sulla porta ${PORT}.`)))
  .catch(error => {
    console.error('Impossibile inizializzare PostgreSQL:', error.message);
    process.exit(1);
  });
