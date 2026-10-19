// /dossier — private personal record (web page + small file API).
// Everything except the login page and its assets requires a session: a signed cookie for the
// browser, or the same signed token sent as "Authorization: Bearer <token>" by dossier/publish.js.
// No content lives in this repo; see dossier/store.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

// Read lazily: server.js loads .env files after requiring this module.
const password = () => process.env.DOSSIER_PASSWORD || '';
const secret = () => process.env.DOSSIER_SECRET || crypto.createHash('sha256').update(`dossier:${password()}`).digest('hex');
const COOKIE = 'dossier_session';
const WEB_SESSION_DAYS = 14;
const CLI_SESSION_HOURS = 1;
const WEB_DIR = path.join(__dirname, 'web');
const PUBLIC_FILES = new Set(['login.html', 'styles.css']);
const MAX_UPLOAD = 15e6;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
// Keep the whole section out of search engines and caches.
const PRIVATE_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS });
  res.end(JSON.stringify(payload));
}

// ── Sessions ──────────────────────────────────────────────────────────────────
function sign(expiresAt) {
  const payload = `dossier|${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verify(token) {
  if (!token || !password()) return false;
  let decoded;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch (_) { return false; }
  const [scope, expiresAt, sig] = decoded.split('|');
  if (scope !== 'dossier' || !expiresAt || !sig || Number(expiresAt) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret()).update(`dossier|${expiresAt}`).digest('hex');
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

function isAuthed(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return verify(auth.slice(7).trim());
  return verify(readCookie(req, COOKIE));
}

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
  if (!expected) { sendJson(res, 503, { error: 'DOSSIER_PASSWORD is not configured.' }); return; }
  if (tooManyFailures(ip)) { sendJson(res, 429, { error: 'Too many attempts. Try again later.' }); return; }
  const given = String(body.password || '');
  // Compare digests so the comparison is constant-time regardless of length.
  const ok = crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(expected).digest());
  if (!ok) {
    failures.get(ip).push(Date.now());
    setTimeout(() => sendJson(res, 401, { error: 'Incorrect password.' }), 600);
    return;
  }
  // The publish script gets a short-lived bearer token; the browser gets a cookie.
  const cli = body.client === 'cli';
  const expiresAt = Date.now() + (cli ? CLI_SESSION_HOURS * 36e5 : WEB_SESSION_DAYS * 864e5);
  const token = sign(expiresAt);
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...PRIVATE_HEADERS };
  if (!cli) headers['Set-Cookie'] = `${COOKIE}=${token}; Path=/dossier; HttpOnly; SameSite=Strict; Max-Age=${WEB_SESSION_DAYS * 86400}${secure}`;
  res.writeHead(200, headers);
  res.end(JSON.stringify(cli ? { ok: true, token } : { ok: true }));
}

// ── Static page ───────────────────────────────────────────────────────────────
function serveWeb(res, file) {
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR + path.sep)) { res.writeHead(404); res.end('Not Found'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain', ...PRIVATE_HEADERS }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ...PRIVATE_HEADERS });
    fs.createReadStream(full).pipe(res);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = (await readRaw(req, 1e4)).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch (_) { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}

// ── Router ────────────────────────────────────────────────────────────────────
// Returns true when the request belongs to /dossier (handled or rejected here).
function handleDossier(req, res, pathname) {
  if (pathname !== '/dossier' && !pathname.startsWith('/dossier/')) return false;
  route(req, res, pathname).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error('dossier error:', err);
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });
  return true;
}

async function route(req, res, pathname) {
  const method = req.method;

  if (!pathname.startsWith('/dossier/api/')) {
    if (method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (pathname === '/dossier' || pathname === '/dossier/') { serveWeb(res, isAuthed(req) ? 'index.html' : 'login.html'); return; }
    const file = pathname.slice('/dossier/'.length);
    if (!PUBLIC_FILES.has(file) && !isAuthed(req)) { res.writeHead(404, PRIVATE_HEADERS); res.end('Not Found'); return; }
    serveWeb(res, file);
    return;
  }

  const apiPath = pathname.slice('/dossier/api'.length);
  if (method === 'POST' && apiPath === '/login') { handleLogin(req, res, await readJson(req)); return; }
  if (method === 'POST' && apiPath === '/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; Path=/dossier; HttpOnly; SameSite=Strict; Max-Age=0`, ...PRIVATE_HEADERS });
    res.end('{"ok":true}');
    return;
  }
  if (!isAuthed(req)) { sendJson(res, 401, { error: 'Login required.' }); return; }

  if (method === 'GET' && apiPath === '/files') { sendJson(res, 200, { files: await store.listFiles() }); return; }

  const m = apiPath.match(/^\/files\/([^/]+)$/);
  if (m) {
    const name = m[1];
    if (!store.isValidName(name)) { sendJson(res, 400, { error: 'Invalid file name.' }); return; }
    if (method === 'GET') {
      const file = await store.getFile(name);
      if (!file) { sendJson(res, 404, { error: 'File not found.' }); return; }
      res.writeHead(200, { 'Content-Type': file.contentType, ...PRIVATE_HEADERS });
      res.end(file.body);
      return;
    }
    if (method === 'PUT') {
      const contentType = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
      await store.putFile(name, contentType, await readRaw(req, MAX_UPLOAD));
      sendJson(res, 200, { ok: true, name });
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found.' });
}

module.exports = { handleDossier };
