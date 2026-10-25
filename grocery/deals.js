// Store price checks for the Deals tab. Phase 1: Ralphs, through the Kroger public API
// (Ralphs is a Kroger chain). Credentials come from a Kroger developer app:
// KROGER_CLIENT_ID / KROGER_CLIENT_SECRET (client-credentials grant, product.compact scope).
const db = require('./db');

const API = 'https://api.kroger.com/v1';
const STORE = 'Ralphs';
const TZ = 'America/Los_Angeles';
const RESULTS_PER_TERM = 6;

// Staples to watch while we learn how the API and Ralphs' weekly cycle behave.
// Editable from the Deals tab; phase 2 replaces this with the real watchlist.
const DEFAULT_TERMS = [
  'chicken breast', 'ground turkey', 'salmon fillet', 'shrimp', 'eggs', 'egg whites', 'oat milk',
  'coconut yogurt', 'bananas', 'blueberries', 'broccoli', 'sweet potatoes', 'jasmine rice',
  'black beans', 'diced tomatoes', 'pasta', 'folgers coffee', 'pure leaf tea', 'avocado oil',
  'angel soft toilet paper'
];

const clientId = () => process.env.KROGER_CLIENT_ID || '';
const clientSecret = () => process.env.KROGER_CLIENT_SECRET || '';
const isConfigured = () => Boolean(clientId() && clientSecret());

// ── Kroger API ────────────────────────────────────────────────────────────────

let token = null; // { value, expiresAt }

async function accessToken() {
  if (token && token.expiresAt > Date.now() + 60e3) return token.value;
  if (!isConfigured()) throw Object.assign(new Error('KROGER_CLIENT_ID and KROGER_CLIENT_SECRET are not configured.'), { status: 503 });
  const res = await fetch(`${API}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64')}`
    },
    body: 'grant_type=client_credentials&scope=product.compact'
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw Object.assign(new Error(`Kroger sign-in failed (${res.status}): ${data.error_description || data.error || 'no token returned'}`), { status: 502 });
  }
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 1800) * 1000 };
  return token.value;
}

async function krogerGet(path, params) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 401 && attempt === 0) { token = null; continue; }
    if (res.status === 429 && attempt < 2) { await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); continue; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.errors?.reason || data.error_description || data.message || `HTTP ${res.status}`;
      throw Object.assign(new Error(`Kroger API error: ${msg}`), { status: 502 });
    }
    return data;
  }
}

async function findLocations(zip) {
  const data = await krogerGet('/locations', { 'filter.zipCode.near': zip, 'filter.chain': 'RALPHS', 'filter.limit': '10' });
  return (data.data || []).map((l) => ({
    location_id: l.locationId,
    name: l.name,
    address: [l.address?.addressLine1, l.address?.city, l.address?.zipCode].filter(Boolean).join(', ')
  }));
}

const price = (v) => (typeof v === 'number' && v > 0 ? Math.round(v * 100) / 100 : null);

function toProduct(p, term, rank) {
  const item = p.items?.[0] || {};
  const pr = item.price || {};
  const regular = price(pr.regular);
  let promo = price(pr.promo);
  if (promo !== null && regular !== null && promo >= regular) promo = null;
  const expires = pr.expirationDate?.value ? String(pr.expirationDate.value).slice(0, 10) : null;
  return {
    term, rank, product_id: String(p.productId), upc: p.upc || '', brand: p.brand || '',
    description: p.description || '', size: item.size || '', sold_by: item.soldBy || '',
    regular, promo, promo_expires: promo !== null && /^\d{4}-\d{2}-\d{2}$/.test(expires || '') ? expires : null
  };
}

async function searchProducts(term, locationId) {
  const data = await krogerGet('/products', {
    'filter.term': term, 'filter.locationId': locationId, 'filter.limit': String(RESULTS_PER_TERM)
  });
  // Products the store doesn't price (not carried at this location) are dropped.
  return (data.data || []).map((p, i) => toProduct(p, term, i + 1)).filter((p) => p.regular !== null);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

const pacificDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const pacificHour = (d = new Date()) => Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;

async function getLocation() { return db.getSetting('deals_location'); }
async function getTerms() { return (await db.getSetting('deals_terms')) || DEFAULT_TERMS; }

// Searches every term (a few at a time) and stores the prices as one run.
async function runCheck(kind, terms) {
  const location = await getLocation();
  if (!location) throw Object.assign(new Error('Pick your Ralphs store first.'), { status: 400 });
  const list = terms && terms.length ? terms : await getTerms();
  const started = new Date();
  const checks = [];
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const term = list[next++];
      try { checks.push(...(await searchProducts(term, location.location_id))); }
      catch (err) { failed.push(`${term}: ${err.message}`); }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (failed.length === list.length) throw Object.assign(new Error(failed[0]), { status: 502 });
  const order = new Map(list.map((t, i) => [t, i]));
  checks.sort((a, b) => order.get(a.term) - order.get(b.term) || a.rank - b.rank);
  const run = await db.saveRun({
    kind, store: STORE, location_id: location.location_id, run_date: pacificDate(started),
    started_at: started, term_count: list.length
  }, checks);
  return { run, checks, failed, location };
}

// Daily background check, used to learn which weekday Ralphs changes its sale prices.
// Runs once per Pacific day after 6am; the database record makes it safe across restarts.
let dailyBusy = false;
async function dailyTick() {
  if (dailyBusy || !isConfigured() || !process.env.DATABASE_URL || pacificHour() < 6) return;
  dailyBusy = true;
  try {
    if (!(await getLocation()) || (await db.hasRunOn('daily', pacificDate()))) return;
    const { checks, failed } = await runCheck('daily');
    console.log(`deals: daily check saved ${checks.length} prices${failed.length ? `, ${failed.length} term(s) failed` : ''}`);
  } catch (err) {
    console.error('deals: daily check failed:', err.message);
  } finally {
    dailyBusy = false;
  }
}

function startDailyChecks() {
  if (process.env.GROCERY_DAILY_CHECK === 'off') return;
  setTimeout(dailyTick, 60e3).unref();
  setInterval(dailyTick, 30 * 60e3).unref();
}

module.exports = {
  STORE, DEFAULT_TERMS, isConfigured, findLocations, getLocation, getTerms, runCheck, startDailyChecks
};
