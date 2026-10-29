// Storage for /storybook: books (state + every agent's output), progress events, pictures and PDFs.
//   - production: the Railway Postgres database (DATABASE_URL), because Railway's disk is wiped on deploy
//   - local dev without DATABASE_URL: plain files under STORYBOOK_DIR (default ./.storybook-data, gitignored)
// Both backends expose the same functions, so the pipeline never knows which one it's using.
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
    pool = new Pool({ connectionString: url, ssl, max: 3 });
    pool.on('error', (err) => console.error('storybook db pool error:', err.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS storybook_books (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  stage       TEXT NOT NULL,
  request     JSONB NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  pending     JSONB,
  error       TEXT,
  costs       JSONB NOT NULL DEFAULT '{}',
  pdf         BYTEA,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS storybook_events (
  id       BIGSERIAL PRIMARY KEY,
  book_id  INTEGER NOT NULL REFERENCES storybook_books(id) ON DELETE CASCADE,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent    TEXT NOT NULL,
  message  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS storybook_events_book_idx ON storybook_events (book_id, id);
CREATE TABLE IF NOT EXISTS storybook_images (
  book_id  INTEGER NOT NULL REFERENCES storybook_books(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  bytes    BYTEA NOT NULL,
  PRIMARY KEY (book_id, name)
);
`;

let ready = null;
function ensureSchema() {
  if (!ready) ready = getPool().query(SCHEMA).catch((err) => { ready = null; throw err; });
  return ready;
}

async function q(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

const BOOK_FIELDS = ['title', 'status', 'stage', 'data', 'pending', 'error', 'costs'];
const JSON_FIELDS = new Set(['data', 'pending', 'costs']);

// ── Local folder backend ──────────────────────────────────────────────────────
const localDir = () => process.env.STORYBOOK_DIR || path.join(__dirname, '..', '.storybook-data');
const bookDir = (id) => path.join(localDir(), String(id));
const readJsonFile = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } };

const local = {
  async createBook(request) {
    fs.mkdirSync(localDir(), { recursive: true });
    const ids = fs.readdirSync(localDir()).map(Number).filter(Number.isInteger);
    const id = (ids.length ? Math.max(...ids) : 0) + 1;
    fs.mkdirSync(path.join(bookDir(id), 'images'), { recursive: true });
    const now = new Date().toISOString();
    const book = { id, title: '', status: 'running', stage: 'research', request, data: {}, pending: null, error: null, costs: {}, created_at: now, updated_at: now };
    fs.writeFileSync(path.join(bookDir(id), 'book.json'), JSON.stringify(book, null, 2));
    return id;
  },
  async getBook(id) {
    const book = readJsonFile(path.join(bookDir(id), 'book.json'), null);
    if (book) book.has_pdf = fs.existsSync(path.join(bookDir(id), 'book.pdf'));
    return book;
  },
  async updateBook(id, fields) {
    const file = path.join(bookDir(id), 'book.json');
    const book = { ...readJsonFile(file, {}), ...fields, updated_at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(book, null, 2));
  },
  async listBooks() {
    if (!fs.existsSync(localDir())) return [];
    return fs.readdirSync(localDir()).map(Number).filter(Number.isInteger).sort((a, b) => b - a)
      .map((id) => readJsonFile(path.join(bookDir(id), 'book.json'), null)).filter(Boolean)
      .map(({ id, title, status, stage, request, costs, created_at }) => ({ id, title, status, stage, request, costs, created_at }));
  },
  async addEvent(id, agent, message) {
    const file = path.join(bookDir(id), 'events.json');
    const events = readJsonFile(file, []);
    events.push({ id: events.length + 1, at: new Date().toISOString(), agent, message });
    fs.writeFileSync(file, JSON.stringify(events));
  },
  async getEvents(id, afterId = 0) {
    return readJsonFile(path.join(bookDir(id), 'events.json'), []).filter((e) => e.id > afterId);
  },
  async putImage(id, name, bytes) { fs.writeFileSync(path.join(bookDir(id), 'images', `${name}.jpg`), bytes); },
  async getImage(id, name) { try { return fs.readFileSync(path.join(bookDir(id), 'images', `${name}.jpg`)); } catch (_) { return null; } },
  async putPdf(id, bytes) { fs.writeFileSync(path.join(bookDir(id), 'book.pdf'), bytes); },
  async getPdf(id) { try { return fs.readFileSync(path.join(bookDir(id), 'book.pdf')); } catch (_) { return null; } },
  async deleteBook(id) { fs.rmSync(bookDir(id), { recursive: true, force: true }); },
  async markInterrupted() {
    for (const book of await local.listBooks()) {
      if (book.status === 'running') await local.updateBook(book.id, { status: 'failed', error: 'The server restarted while this book was being made.' });
    }
  },
};

// ── Postgres backend ──────────────────────────────────────────────────────────
const pg = {
  async createBook(request) {
    const { rows } = await q(`INSERT INTO storybook_books (status, stage, request) VALUES ('running', 'research', $1) RETURNING id`, [request]);
    return rows[0].id;
  },
  async getBook(id) {
    const { rows } = await q(`SELECT id, title, status, stage, request, data, pending, error, costs, created_at, updated_at,
      pdf IS NOT NULL AS has_pdf FROM storybook_books WHERE id = $1`, [id]);
    return rows[0] || null;
  },
  async updateBook(id, fields) {
    const keys = Object.keys(fields).filter((k) => BOOK_FIELDS.includes(k));
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = keys.map((k) => (JSON_FIELDS.has(k) && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k]));
    await q(`UPDATE storybook_books SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...values]);
  },
  async listBooks() {
    const { rows } = await q(`SELECT id, title, status, stage, request, costs, created_at FROM storybook_books ORDER BY id DESC LIMIT 200`);
    return rows;
  },
  async addEvent(id, agent, message) {
    await q(`INSERT INTO storybook_events (book_id, agent, message) VALUES ($1, $2, $3)`, [id, agent, message]);
  },
  async getEvents(id, afterId = 0) {
    const { rows } = await q(`SELECT id::int AS id, at, agent, message FROM storybook_events WHERE book_id = $1 AND id > $2 ORDER BY id`, [id, afterId]);
    return rows;
  },
  async putImage(id, name, bytes) {
    await q(`INSERT INTO storybook_images (book_id, name, bytes) VALUES ($1, $2, $3)
      ON CONFLICT (book_id, name) DO UPDATE SET bytes = EXCLUDED.bytes`, [id, name, bytes]);
  },
  async getImage(id, name) {
    const { rows } = await q(`SELECT bytes FROM storybook_images WHERE book_id = $1 AND name = $2`, [id, name]);
    return rows[0] ? rows[0].bytes : null;
  },
  async putPdf(id, bytes) { await q(`UPDATE storybook_books SET pdf = $2, updated_at = now() WHERE id = $1`, [id, bytes]); },
  async getPdf(id) {
    const { rows } = await q(`SELECT pdf FROM storybook_books WHERE id = $1`, [id]);
    return rows[0] ? rows[0].pdf : null;
  },
  async deleteBook(id) { await q(`DELETE FROM storybook_books WHERE id = $1`, [id]); },
  async markInterrupted() {
    await q(`UPDATE storybook_books SET status = 'failed', error = 'The server restarted while this book was being made.'
      WHERE status = 'running'`);
  },
};

// Pick the backend per call, so .env files loaded after this module still count.
module.exports = new Proxy({}, { get: (_, name) => (getPool() ? pg : local)[name] });
