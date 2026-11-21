// Storage for the contact details typed into /maps (per-school phone/email/director/notes, per-region default director).
//   - production: the Railway Postgres database (DATABASE_URL), because Railway's disk is wiped on every deploy
//   - local dev without DATABASE_URL: one JSON file (MAPS_DATA_PATH, default data/maps-contacts.json)
// Both hold the same shape: { schools: { [id]: record }, regions: { [id]: record } }.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const url = process.env.DATABASE_URL;
    // Railway's private network (*.railway.internal) is plain TCP; the public proxy needs TLS.
    const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 2 });
    pool.on('error', (err) => console.error('maps db pool error:', err.message));
  }
  return pool;
}

// kind is 'schools' or 'regions'; data is the record as the page reads it (including updatedAt).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS maps_contacts (
  kind  TEXT NOT NULL,
  id    TEXT NOT NULL,
  data  JSONB NOT NULL,
  PRIMARY KEY (kind, id)
);
`;

let ready = null;
function ensureSchema() {
  if (!ready) ready = getPool().query(SCHEMA).catch((err) => { ready = null; throw err; });
  return ready;
}

const filePath = () => process.env.MAPS_DATA_PATH || path.join(__dirname, '..', 'data', 'maps-contacts.json');

function readFile() {
  try {
    const d = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    if (d && typeof d === 'object' && !Array.isArray(d)) return { schools: d.schools || {}, regions: d.regions || {} };
  } catch (_) { /* first run */ }
  return { schools: {}, regions: {} };
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  const tmp = filePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath());
}

// Everything, as { schools, regions }.
async function getAll() {
  if (!getPool()) return readFile();
  await ensureSchema();
  const { rows } = await getPool().query('SELECT kind, id, data FROM maps_contacts');
  const out = { schools: {}, regions: {} };
  for (const r of rows) if (out[r.kind]) out[r.kind][r.id] = r.data;
  return out;
}

// Saves one record, or removes it when record is null.
async function put(kind, id, record) {
  if (!getPool()) {
    const data = readFile();
    if (record) data[kind][id] = record; else delete data[kind][id];
    writeFile(data);
    return;
  }
  await ensureSchema();
  if (!record) { await getPool().query('DELETE FROM maps_contacts WHERE kind = $1 AND id = $2', [kind, id]); return; }
  await getPool().query(
    `INSERT INTO maps_contacts (kind, id, data) VALUES ($1, $2, $3)
     ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data`,
    [kind, id, JSON.stringify(record)]
  );
}

module.exports = { getAll, put };
