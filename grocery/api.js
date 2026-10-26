// /grocery — personal grocery spending tracker (web dashboard + JSON API for the Android app).
// Everything except the login page and its assets requires a session: a signed cookie for the
// browser, or the same signed token sent as "Authorization: Bearer <token>" by the app.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('./db');
const { parseReceipt, DEPARTMENTS } = require('./parse');
const deals = require('./deals');

// Read lazily: server.js loads .env files after requiring this module.
const password = () => process.env.GROCERY_PASSWORD || '';
const secret = () => process.env.GROCERY_SECRET || crypto.createHash('sha256').update(`grocery:${password()}`).digest('hex');
const COOKIE = 'grocery_session';
const WEB_SESSION_DAYS = 30;
const APP_SESSION_DAYS = 365;
const WEB_DIR = path.join(__dirname, 'web');
const MAX_JSON = 1e6;
const MAX_UPLOAD = 40e6; // a few full-resolution receipt photos, base64-encoded

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

// ── Sessions ──────────────────────────────────────────────────────────────────
function sign(expiresAt) {
  const payload = `grocery|${expiresAt}`;
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('hex');
  return Buffer.from(`${payload}|${sig}`).toString('base64url');
}

function verify(token) {
  if (!token || !password()) return false;
  let decoded;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch (_) { return false; }
  const [scope, expiresAt, sig] = decoded.split('|');
  if (scope !== 'grocery' || !expiresAt || !sig || Number(expiresAt) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', secret()).update(`grocery|${expiresAt}`).digest('hex');
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

// Simple brute-force brake: at most 10 failed logins per IP per 15 minutes.
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  failures.set(ip, recent);
  return recent.length >= 10;
}

function handleLogin(req, res, body) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const expected = password();
  if (!expected) { sendJson(res, 503, { error: 'GROCERY_PASSWORD is not configured.' }); return; }
  if (tooManyFailures(ip)) { sendJson(res, 429, { error: 'Too many attempts. Try again later.' }); return; }
  const given = String(body.password || '');
  const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    failures.get(ip).push(Date.now());
    setTimeout(() => sendJson(res, 401, { error: 'Incorrect password.' }), 400);
    return;
  }
  const days = body.client === 'app' ? APP_SESSION_DAYS : WEB_SESSION_DAYS;
  const expiresAt = Date.now() + days * 864e5;
  const token = sign(expiresAt);
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': `${COOKIE}=${token}; Path=/grocery; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`
  });
  res.end(JSON.stringify({ ok: true, token, expires_at: new Date(expiresAt).toISOString() }));
}

// ── Validation ────────────────────────────────────────────────────────────────
const money = z.coerce.number().finite().min(-100000).max(100000);
const ItemSchema = z.object({
  raw_name: z.string().trim().max(300).default(''),
  name: z.string().trim().min(1).max(300),
  brand: z.string().trim().max(120).default(''),
  item_basic: z.string().trim().min(1).max(120),
  department: z.enum(DEPARTMENTS),
  quantity: z.coerce.number().positive().max(10000).default(1),
  unit: z.enum(['each', 'lb', 'oz', 'kg']).default('each'),
  unit_price: money,
  line_total: money,
  savings: money.default(0)
});
const ReceiptSchema = z.object({
  store: z.string().trim().min(1).max(120),
  store_address: z.string().trim().max(300).default(''),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  subtotal: money.nullable().default(null),
  savings: money.default(0),
  tax: money.default(0),
  fees: money.default(0),
  total: money.nullable().default(null),
  items: z.array(ItemSchema).min(1).max(500)
});
// Field rules shared by create and edit; defaults apply only when creating.
const watchFields = {
  name: z.string().trim().min(1).max(120),
  status: z.enum(['watching', 'paused', 'never']),
  search_term: z.string().trim().min(3).max(80),
  item_basics: z.array(z.string().trim().min(1).max(120)).max(20),
  department: z.enum(DEPARTMENTS),
  basis: z.enum(['lb', 'oz', 'package', 'unit']),
  pack_count: z.coerce.number().positive().max(10000).nullable(),
  target_price: z.coerce.number().positive().max(10000).nullable(),
  notes: z.string().trim().max(300)
};
const WatchSchema = z.object({
  ...watchFields,
  status: watchFields.status.default('watching'),
  item_basics: watchFields.item_basics.default([]),
  department: watchFields.department.default('Other'),
  basis: watchFields.basis.default('package'),
  pack_count: watchFields.pack_count.default(null),
  target_price: watchFields.target_price.default(null),
  notes: watchFields.notes.default('')
});
const WatchPatchSchema = z.object(watchFields).partial().strict();
const VerdictSchema = z.object({
  watch_id: z.coerce.number().int().positive(),
  product_id: z.string().trim().min(1).max(40),
  verdict: z.enum(['match', 'reject'])
});
const LocationSchema = z.object({
  location_id: z.string().trim().regex(/^[A-Za-z0-9]{1,20}$/),
  name: z.string().trim().max(120).default(''),
  address: z.string().trim().max(300).default('')
});
const UploadSchema = z.object({
  files: z.array(z.object({ media_type: z.string(), data: z.string().min(1) })).min(1).max(8)
});

function validationError(res, err) {
  const first = err.issues?.[0];
  sendJson(res, 400, { error: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request.' });
}

// ── Static web dashboard ──────────────────────────────────────────────────────
function serveWeb(res, file) {
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR + path.sep)) { res.writeHead(404); res.end('Not Found'); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(full).pipe(res);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : {}); } catch (_) { reject(Object.assign(new Error('Invalid JSON body.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
// Returns true when the request belongs to /grocery (handled or rejected here).
function handleGrocery(req, res, pathname) {
  if (pathname !== '/grocery' && !pathname.startsWith('/grocery/')) return false;
  route(req, res, pathname).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error('grocery error:', err);
    // Errors raised with a status (Kroger, Resend, validation) carry a message meant for the user.
    if (!res.headersSent) sendJson(res, status, { error: err.status ? err.message : 'Something went wrong on the server.' });
  });
  return true;
}

async function route(req, res, pathname) {
  const method = req.method;

  if (!pathname.startsWith('/grocery/api/')) {
    if (method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (pathname === '/grocery' || pathname === '/grocery/') { serveWeb(res, isAuthed(req) ? 'index.html' : 'login.html'); return; }
    serveWeb(res, pathname.slice('/grocery/'.length));
    return;
  }

  const apiPath = pathname.slice('/grocery/api'.length);
  if (method === 'POST' && apiPath === '/login') { handleLogin(req, res, await readBody(req, MAX_JSON)); return; }
  if (method === 'POST' && apiPath === '/logout') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${COOKIE}=; Path=/grocery; HttpOnly; SameSite=Lax; Max-Age=0` });
    res.end('{"ok":true}');
    return;
  }
  if (!isAuthed(req)) { sendJson(res, 401, { error: 'Login required.' }); return; }

  if (method === 'GET' && apiPath === '/session') { sendJson(res, 200, { ok: true }); return; }
  if (method === 'GET' && apiPath === '/items') { sendJson(res, 200, { items: await db.listItems() }); return; }
  if (method === 'GET' && apiPath === '/receipts') { sendJson(res, 200, { receipts: await db.listReceipts() }); return; }
  if (method === 'GET' && apiPath === '/vocab') {
    const ctx = await db.classificationContext();
    sendJson(res, 200, { departments: DEPARTMENTS, item_basics: ctx.vocab });
    return;
  }

  if (apiPath.startsWith('/deals/')) { await routeDeals(req, res, method, apiPath.slice('/deals'.length)); return; }

  if (method === 'POST' && apiPath === '/receipts/parse') {
    const parsed = UploadSchema.safeParse(await readBody(req, MAX_UPLOAD));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const draft = await parseReceipt(parsed.data.files, await db.classificationContext());
    draft.duplicate_of = draft.store && draft.date ? await db.findDuplicate(draft.store, draft.date, draft.total) : null;
    sendJson(res, 200, { draft });
    return;
  }

  if (method === 'POST' && apiPath === '/receipts') {
    const body = await readBody(req, MAX_JSON);
    const parsed = ReceiptSchema.safeParse(body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const dup = await db.findDuplicate(parsed.data.store, parsed.data.date, parsed.data.total);
    if (dup && !body.allow_duplicate) { sendJson(res, 409, { error: 'This receipt looks like one already saved.', duplicate_of: dup }); return; }
    const id = await db.saveReceipt(parsed.data, body.source === 'web' ? 'web' : 'app');
    sendJson(res, 201, { receipt: await db.getReceipt(id) });
    return;
  }

  const m = apiPath.match(/^\/receipts\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (method === 'GET') {
      const r = await db.getReceipt(id);
      if (!r) { sendJson(res, 404, { error: 'Receipt not found.' }); return; }
      sendJson(res, 200, { receipt: r });
      return;
    }
    if (method === 'PUT') {
      const parsed = ReceiptSchema.safeParse(await readBody(req, MAX_JSON));
      if (!parsed.success) { validationError(res, parsed.error); return; }
      if (!(await db.replaceReceipt(id, parsed.data))) { sendJson(res, 404, { error: 'Receipt not found.' }); return; }
      sendJson(res, 200, { receipt: await db.getReceipt(id) });
      return;
    }
    if (method === 'DELETE') {
      if (!(await db.deleteReceipt(id))) { sendJson(res, 404, { error: 'Receipt not found.' }); return; }
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found.' });
}

// ── Deals (store price checks; see deals.js) ──────────────────────────────────
async function routeDeals(req, res, method, sub) {
  if (method === 'GET' && sub === '/status') {
    const [location, view, daily, cycle] = await Promise.all([
      deals.getLocation(), deals.dealsView(), db.lastRunOf('daily'), db.promoChangesByWeekday()
    ]);
    sendJson(res, 200, {
      configured: deals.isConfigured(), store: deals.STORE, location, ...view, last_daily: daily, cycle,
      email: await deals.emailSettings()
    });
    return;
  }

  if (method === 'PUT' && sub === '/email') {
    const parsed = z.object({
      enabled: z.boolean(),
      to: z.union([z.literal(''), z.string().trim().email().max(200)]),
      weekday: z.union([z.literal('auto'), z.number().int().min(1).max(7)])
    }).strict().safeParse(await readBody(req, MAX_JSON));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    if (parsed.data.enabled && !parsed.data.to) { sendJson(res, 400, { error: 'Enter the address to send the weekly email to.' }); return; }
    await db.setSetting('deals_email', parsed.data);
    sendJson(res, 200, { email: await deals.emailSettings() });
    return;
  }

  if (method === 'POST' && sub === '/email/test') {
    const { to } = await deals.emailSettings();
    if (!to) { sendJson(res, 400, { error: 'Save an email address first.' }); return; }
    sendJson(res, 200, { subject: await deals.sendDealsEmail(to), to });
    return;
  }

  // Corrects the package size of one receipt line (e.g. "10 x 7.5 fl oz"); empty clears it.
  if (method === 'PUT' && sub === '/item-size') {
    const parsed = z.object({ item_id: z.number().int().positive(), size: z.string().trim().max(60) }).strict()
      .safeParse(await readBody(req, MAX_JSON));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const read = deals.parseSize(parsed.data.size);
    if (parsed.data.size && !read.oz && !read.count) {
      sendJson(res, 400, { error: `Couldn't read "${parsed.data.size}". Try "10 x 7.5 fl oz", "2 L", "1.5 lb" or "12 rolls".` });
      return;
    }
    if (!(await db.setItemSize(parsed.data.item_id, parsed.data.size))) { sendJson(res, 404, { error: 'Receipt item not found.' }); return; }
    sendJson(res, 200, { size: parsed.data.size, read: deals.describeSize(read) });
    return;
  }

  if (method === 'GET' && sub === '/locations') {
    const zip = new URL(req.url, 'http://localhost').searchParams.get('zip') || '';
    if (!/^\d{5}$/.test(zip)) { sendJson(res, 400, { error: 'Enter a 5-digit ZIP code.' }); return; }
    sendJson(res, 200, { locations: await deals.findLocations(zip) });
    return;
  }

  if (method === 'PUT' && sub === '/location') {
    const parsed = LocationSchema.safeParse(await readBody(req, MAX_JSON));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    await db.setSetting('deals_location', parsed.data);
    sendJson(res, 200, { location: parsed.data });
    return;
  }

  if (method === 'PUT' && sub === '/settings') {
    const parsed = z.object({ threshold: z.coerce.number().min(0.01).max(0.9) }).safeParse(await readBody(req, MAX_JSON));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    await db.setSetting('deals_threshold', parsed.data.threshold);
    sendJson(res, 200, { threshold: parsed.data.threshold });
    return;
  }

  if (method === 'POST' && sub === '/check') {
    const body = await readBody(req, MAX_JSON);
    const ids = z.array(z.coerce.number().int().positive()).max(500).nullable().default(null).safeParse(body.watch_ids ?? null);
    if (!ids.success) { validationError(res, ids.error); return; }
    const result = await deals.runCheck('manual', ids.data);
    sendJson(res, 200, { ...result, ...(await deals.dealsView()) });
    return;
  }

  if (method === 'PUT' && sub === '/verdict') {
    const parsed = VerdictSchema.safeParse(await readBody(req, MAX_JSON));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    await db.saveVerdicts(deals.STORE, [{ ...parsed.data, source: 'user', reason: '' }]);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && sub === '/watch/seed') {
    sendJson(res, 200, { created: await deals.seedWatchlist() });
    return;
  }

  if (method === 'POST' && sub === '/watch') {
    const parsed = WatchSchema.safeParse(await readBody(req, MAX_JSON));
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const [created] = await db.createWatch([parsed.data]);
    if (!created) { sendJson(res, 409, { error: `"${parsed.data.name}" is already on the watchlist.` }); return; }
    sendJson(res, 201, { watch: created });
    return;
  }

  const wm = sub.match(/^\/watch\/(\d+)$/);
  if (wm) {
    const id = Number(wm[1]);
    if (method === 'PUT') {
      const parsed = WatchPatchSchema.safeParse(await readBody(req, MAX_JSON));
      if (!parsed.success) { validationError(res, parsed.error); return; }
      let updated;
      try { updated = await db.updateWatch(id, parsed.data); } catch (err) {
        if (err.code === '23505') { sendJson(res, 409, { error: 'Another watch item already has that name.' }); return; }
        throw err;
      }
      if (!updated) { sendJson(res, 404, { error: 'Watch item not found.' }); return; }
      sendJson(res, 200, { watch: updated });
      return;
    }
    if (method === 'DELETE') {
      if (!(await db.deleteWatch(id))) { sendJson(res, 404, { error: 'Watch item not found.' }); return; }
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: 'Not found.' });
}

module.exports = { handleGrocery, startDailyChecks: deals.startDailyChecks };
