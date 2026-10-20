// File storage for /dossier. The dossier's content is personal and must never be committed to this
// (public) repo, so it lives outside it:
//   - production: the Railway Postgres database (DATABASE_URL), uploaded with dossier/publish.js
//   - local dev without DATABASE_URL: read straight from the private folder DOSSIER_DIR (default ~/Dossier);
//     journal entries written locally land in DOSSIER_DIR/journal
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const LOCAL_SUBDIRS = ['data', 'photos', 'documents', 'journal'];
const JOURNAL_RE = /^journal-\d{4}-\d{2}-\d{2}\.json$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

let pool = null;
function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const url = process.env.DATABASE_URL;
    // Railway's private network (*.railway.internal) is plain TCP; the public proxy needs TLS.
    const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 3 });
    pool.on('error', (err) => console.error('dossier db pool error:', err.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dossier_files (
  name         TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  body         BYTEA NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let ready = null;
function ensureSchema() {
  if (!ready) ready = getPool().query(SCHEMA).catch((err) => { ready = null; throw err; });
  return ready;
}

const localDir = () => process.env.DOSSIER_DIR || path.join(os.homedir(), 'Dossier');

const MIME = {
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf'
};

const isValidName = (name) => NAME_RE.test(name) && !name.includes('..');

// Returns { contentType, body } or null.
async function getFile(name) {
  if (!isValidName(name)) return null;
  if (getPool()) {
    await ensureSchema();
    const { rows } = await getPool().query('SELECT content_type, body FROM dossier_files WHERE name = $1', [name]);
    return rows[0] ? { contentType: rows[0].content_type, body: rows[0].body } : null;
  }
  for (const sub of LOCAL_SUBDIRS) {
    const full = path.join(localDir(), sub, name);
    try {
      return { contentType: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', body: await fs.promises.readFile(full) };
    } catch (_) { /* try the next folder */ }
  }
  return null;
}

async function putFile(name, contentType, body) {
  if (!isValidName(name)) throw Object.assign(new Error('Invalid file name.'), { status: 400 });
  if (!getPool()) {
    if (!JOURNAL_RE.test(name)) throw Object.assign(new Error('Publishing needs DATABASE_URL; locally the page reads DOSSIER_DIR directly.'), { status: 503 });
    await fs.promises.mkdir(path.join(localDir(), 'journal'), { recursive: true });
    await fs.promises.writeFile(path.join(localDir(), 'journal', name), body);
    return;
  }
  await ensureSchema();
  await getPool().query(
    `INSERT INTO dossier_files (name, content_type, body, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (name) DO UPDATE SET content_type = EXCLUDED.content_type, body = EXCLUDED.body, updated_at = now()`,
    [name, contentType, body]
  );
}

async function listFiles() {
  if (!getPool()) {
    const rows = [];
    for (const sub of LOCAL_SUBDIRS) {
      const dir = path.join(localDir(), sub);
      for (const name of await fs.promises.readdir(dir).catch(() => [])) {
        if (!isValidName(name)) continue;
        const st = await fs.promises.stat(path.join(dir, name)).catch(() => null);
        if (st && st.isFile()) rows.push({ name, content_type: MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', size: st.size, updated_at: st.mtime });
      }
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  await ensureSchema();
  const { rows } = await getPool().query('SELECT name, content_type, octet_length(body) AS size, updated_at FROM dossier_files ORDER BY name');
  return rows;
}

module.exports = { getFile, putFile, listFiles, isValidName };
