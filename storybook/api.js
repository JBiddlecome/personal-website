// /storybook — a team of AI agents that researches, writes, edits and illustrates a children's picture book.
// Every page and API call except the login page and its stylesheet requires a session (signed cookie),
// because every book costs real money in API fees.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const pipeline = require('./pipeline');
const { BookRequest } = require('./models');

// Read lazily: server.js loads .env files after requiring this module.
const password = () => process.env.STORYBOOK_PASSWORD || '';
const secret = () => process.env.STORYBOOK_SECRET || crypto.createHash('sha256').update(`storybook:${password()}`).digest('hex');
const COOKIE = 'storybook_session';
const SESSION_DAYS = 30;
const WEB_DIR = path.join(__dirname, 'web');
const PUBLIC_FILES = new Set(['login.html', 'styles.css']);
const PAGES = { '/storybook': 'index.html', '/storybook/': 'index.html', '/storybook/how-it-works': 'how-it-works.html' };
const IMAGE_NAME = /^(characters|cover|page_\d{2})$/;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const PRIVATE_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS });
  res.end(JSON.stringify(payload));
}

// ── Sessions ──────────────────────────────────────────────────────────────────
function sign(expiresAt) {
  const payload = `storybook|${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verify(token) {
  if (!token || !password()) return false;
  let decoded;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch (_) { return false; }
  const [scope, expiresAt, sig] = decoded.split('|');
  if (scope !== 'storybook' || !expiresAt || !sig || Number(expiresAt) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret()).update(`storybook|${expiresAt}`).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch (_) { return null; }
    }
  }
  return null;
}

const isAuthed = (req) => verify(readCookie(req, COOKIE));

// Brute-force brake: at most 5 failed logins per IP per 30 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < 30 * 60 * 1000);
  failures.set(ip, recent);
  return recent.length >= 5;
}

function handleLogin(req, res, body) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const expected = password();
  if (!expected) { sendJson(res, 503, { error: 'STORYBOOK_PASSWORD is not configured.' }); return; }
  if (tooManyFailures(ip)) { sendJson(res, 429, { error: 'Too many attempts. Try again later.' }); return; }
  const given = String(body.password || '');
  const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(expected).digest());
  if (!ok) {
    failures.get(ip).push(Date.now());
    setTimeout(() => sendJson(res, 401, { error: 'Incorrect password.' }), 600);
    return;
  }
  const expiresAt = Date.now() + SESSION_DAYS * 864e5;
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS,
    'Set-Cookie': `${COOKIE}=${sign(expiresAt)}; Path=/storybook; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  });
  res.end('{"ok":true}');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function serveWeb(res, file) {
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR + path.sep)) { res.writeHead(404); res.end('Not Found'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain', ...PRIVATE_HEADERS }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ...PRIVATE_HEADERS });
    fs.createReadStream(full).pipe(res);
  });
}

function readJson(req, limit = 2e5) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch (_) { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function sendBytes(res, bytes, type, filename) {
  if (!bytes) { sendJson(res, 404, { error: 'Not found.' }); return; }
  const headers = { 'Content-Type': type, 'Content-Length': bytes.length, ...PRIVATE_HEADERS };
  if (filename) headers['Content-Disposition'] = `inline; filename="${filename}"`;
  res.writeHead(200, headers);
  res.end(bytes);
}

const slug = (text) => String(text || 'storybook').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'storybook';

// ── Router ────────────────────────────────────────────────────────────────────
// Returns true when the request belongs to /storybook (handled or rejected here).
function handleStorybook(req, res, pathname) {
  if (pathname !== '/storybook' && !pathname.startsWith('/storybook/')) return false;
  route(req, res, pathname).catch((err) => {
    const status = err.status || (err.name === 'ZodError' ? 400 : 500);
    if (status >= 500) console.error('storybook error:', err);
    const message = err.name === 'ZodError' ? 'Some of the details are missing or invalid.' : err.message;
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server.' : message });
  });
  return true;
}

async function route(req, res, pathname) {
  const method = req.method;

  if (!pathname.startsWith('/storybook/api/')) {
    if (method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (PAGES[pathname]) { serveWeb(res, isAuthed(req) ? PAGES[pathname] : 'login.html'); return; }
    const file = pathname.slice('/storybook/'.length);
    if (!PUBLIC_FILES.has(file) && !isAuthed(req)) { res.writeHead(404, PRIVATE_HEADERS); res.end('Not Found'); return; }
    serveWeb(res, file);
    return;
  }

  const apiPath = pathname.slice('/storybook/api'.length);
  if (method === 'POST' && apiPath === '/login') { handleLogin(req, res, await readJson(req, 1e4)); return; }
  if (method === 'POST' && apiPath === '/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; Path=/storybook; HttpOnly; SameSite=Lax; Max-Age=0`, ...PRIVATE_HEADERS });
    res.end('{"ok":true}');
    return;
  }
  if (!isAuthed(req)) { sendJson(res, 401, { error: 'Login required.' }); return; }

  if (apiPath === '/books' && method === 'GET') { sendJson(res, 200, { books: await store.listBooks(), busy: pipeline.isBusy() }); return; }
  if (apiPath === '/books' && method === 'POST') {
    if (pipeline.isBusy()) { sendJson(res, 409, { error: 'The agents are busy with another book. Try again when it finishes or stops to ask you something.' }); return; }
    const request = BookRequest.parse(await readJson(req, 1e4));
    sendJson(res, 201, { id: await pipeline.startBook(request) });
    return;
  }

  const m = apiPath.match(/^\/books\/(\d{1,9})(\/[a-z]+)?(?:\/([a-z0-9_]+))?$/);
  if (!m) { sendJson(res, 404, { error: 'Not found.' }); return; }
  const id = Number(m[1]);
  const [, , sub, name] = m;
  const book = await store.getBook(id);
  if (!book) { sendJson(res, 404, { error: 'No such book.' }); return; }

  if (!sub && method === 'GET') {
    const after = Number(new URL(req.url, 'http://x').searchParams.get('after')) || 0;
    sendJson(res, 200, { book, events: await store.getEvents(id, after) });
    return;
  }
  if (!sub && method === 'DELETE') {
    if (book.status === 'running') { sendJson(res, 409, { error: 'Wait for the agents to stop before deleting this book.' }); return; }
    await store.deleteBook(id);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (sub === '/decision' && method === 'POST') {
    await pipeline.decide(id, await readJson(req));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (sub === '/images' && method === 'GET' && name && IMAGE_NAME.test(name)) {
    sendBytes(res, await store.getImage(id, name), 'image/jpeg');
    return;
  }
  if (sub === '/pdf' && method === 'GET') {
    sendBytes(res, await store.getPdf(id), 'application/pdf', `${slug(book.title)}.pdf`);
    return;
  }
  sendJson(res, 404, { error: 'Not found.' });
}

// On startup, books that were mid-run when the server stopped are marked as stopped, so they can be resumed.
function startStorybook() {
  store.markInterrupted().catch((err) => console.error('storybook startup:', err.message));
}

module.exports = { handleStorybook, startStorybook };
