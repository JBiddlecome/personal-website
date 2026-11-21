// Where the contact-form submissions and chat prompts are kept.
//   - production: the Railway Postgres database (DATABASE_URL), because Railway's disk is wiped on every deploy
//   - local dev without DATABASE_URL: one JSON line per entry in a file, as before
const fs = require('fs');
const { Pool } = require('pg');

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const url = process.env.DATABASE_URL;
    // Railway's private network (*.railway.internal) is plain TCP; the public proxy needs TLS.
    const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 2 });
    pool.on('error', (err) => console.error('site log db pool error:', err.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_logs (
  id     BIGSERIAL PRIMARY KEY,
  kind   TEXT NOT NULL,
  at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry  JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS site_logs_kind_idx ON site_logs (kind, id);
`;

let ready = null;
function ensureSchema() {
  if (!ready) ready = getPool().query(SCHEMA).catch((err) => { ready = null; throw err; });
  return ready;
}

const appendFile = (filePath, entry) => fs.promises.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');

// kind: 'contact' or 'chat'. filePath is used only when there is no database, or if the database write fails,
// so a submission is never silently lost. Never throws.
async function append(kind, filePath, entry) {
  try {
    if (getPool()) {
      await ensureSchema();
      await getPool().query('INSERT INTO site_logs (kind, entry) VALUES ($1, $2)', [kind, JSON.stringify(entry)]);
      return;
    }
  } catch (err) {
    console.error(`site log: could not save a ${kind} entry to the database, writing it to the file instead:`, err.message);
  }
  await appendFile(filePath, entry).catch((err) => console.error(`Failed to write log at ${filePath}:`, err));
}

// The whole log as text, one JSON entry per line, oldest first. Returns '' when there is nothing yet.
async function readAll(kind, filePath) {
  if (getPool()) {
    await ensureSchema();
    const { rows } = await getPool().query('SELECT entry FROM site_logs WHERE kind = $1 ORDER BY id', [kind]);
    return rows.map((r) => JSON.stringify(r.entry) + '\n').join('');
  }
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

module.exports = { append, readAll };
