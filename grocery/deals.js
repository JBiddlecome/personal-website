// Store price checks for the Deals tab. Ralphs comes through the Kroger public API (Ralphs is a
// Kroger chain). Credentials come from a Kroger developer app:
// KROGER_CLIENT_ID / KROGER_CLIENT_SECRET (client-credentials grant, product.compact scope).
//
// A check searches every "watching" item on the watchlist, has Claude sort out which results are
// really that item (match.js), and compares the matched prices with the usual price paid on receipts.
const db = require('./db');
const { classifyProducts } = require('./match');

const API = 'https://api.kroger.com/v1';
const STORE = 'Ralphs';
const TZ = 'America/Los_Angeles';
const RESULTS_PER_TERM = 6;
const DEFAULT_THRESHOLD = 0.15;

// Added to a new watchlist when receipts don't already cover them (non-food items included).
const STARTER_ITEMS = [
  { name: 'Angel Soft toilet paper', search_term: 'angel soft toilet paper', department: 'Paper Goods', basis: 'unit', notes: 'Angel Soft only' }
];

// Departments worth buying in bulk on sale; anything else is fresh food to "buy for this week".
const STOCK_UP = new Set(['Pantry', 'Baking', 'Breakfast', 'Beverages', 'Coffee & Tea', 'Frozen', 'Household',
  'Paper Goods', 'Personal Care', 'Pet Care', 'Snacks', 'Candy', 'Kitchen']);
const FREEZE = new Set(['Meat', 'Seafood']);

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

// ── Prices on a common basis ──────────────────────────────────────────────────

// Kroger size strings ("16 oz", "1.5 lb", "12 ct", "12 mega rolls") → pounds and/or a count.
function parseSize(size) {
  const s = String(size || '').toLowerCase();
  const n = (v) => (v.includes('/') ? Number(v.split('/')[0]) / Number(v.split('/')[1]) : Number(v));
  const out = {};
  let m = s.match(/([\d.]+(?:\/\d+)?)\s*(lb|lbs|pound|pounds)\b/);
  if (m) out.lb = n(m[1]);
  else if ((m = s.match(/([\d.]+(?:\/\d+)?)\s*oz\b/)) && !/fl\.?\s*oz/.test(s)) out.lb = n(m[1]) / 16;
  m = s.match(/(\d+)\s*(ct|count|pk|pack|rolls?|mega rolls?|double rolls?|family rolls?|eggs?|bags?|pods?|k-cups?)\b/);
  if (m) out.count = Number(m[1]);
  return out;
}

// A store price expressed on the watch item's basis, or null when the size can't be read.
function storeUnitPrice(product, watch, value) {
  if (value == null) return null;
  if (watch.basis === 'lb') {
    if (product.sold_by === 'WEIGHT') return value;
    const { lb } = parseSize(product.size);
    return lb ? value / lb : null;
  }
  if (watch.basis === 'unit') {
    const { count } = parseSize(product.size);
    return count ? value / count : null;
  }
  return product.sold_by === 'WEIGHT' ? null : value; // package
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// What the shopper usually pays, on the watch item's basis, from the last year of receipts.
// A target price set on the item takes precedence.
function baselineFor(watch, purchases) {
  let paid = [];
  if (watch.basis === 'lb') {
    paid = purchases.filter((p) => p.unit !== 'each')
      .map((p) => (p.unit === 'oz' ? p.unit_price * 16 : p.unit === 'kg' ? p.unit_price / 2.2046 : p.unit_price));
  } else {
    const each = purchases.filter((p) => p.unit === 'each').map((p) => p.unit_price);
    paid = watch.basis === 'unit' ? (watch.pack_count ? each.map((v) => v / watch.pack_count) : []) : each;
  }
  const usual = paid.length ? median(paid) : null;
  return {
    usual: round2(usual),
    lowest: paid.length ? round2(Math.min(...paid)) : null,
    purchases: paid.length,
    target: watch.target_price,
    compare_to: watch.target_price ?? round2(usual)
  };
}

const stockAdvice = (dept) => (STOCK_UP.has(dept) ? 'stock up' : FREEZE.has(dept) ? 'stock up and freeze' : 'buy for this week');

// Annotates a run's checks with verdicts and unit prices, and picks out the deals:
// matched products at least `threshold` below the comparison price (usual or target), or,
// for items with no price history, on sale by at least `threshold` off the store's regular price.
function evaluate(watchList, baselines, checks, verdicts, threshold) {
  const byId = new Map(watchList.map((w) => [w.id, w]));
  const annotated = checks.map((c) => {
    const watch = byId.get(c.watch_id);
    const v = watch ? verdicts.get(`${watch.id}|${c.product_id}`) : null;
    const now = c.promo ?? c.regular;
    const unit = watch ? storeUnitPrice(c, watch, now) : null;
    const base = watch ? baselines.get(watch.id) : null;
    let deal = null;
    // Paused or not-interested items never produce deals, even from a check made before the change.
    if (watch?.status === 'watching' && v?.verdict === 'match') {
      if (base?.compare_to && unit != null) {
        const pct = (base.compare_to - unit) / base.compare_to;
        if (pct >= threshold) deal = { kind: base.target != null ? 'below_target' : 'below_usual', pct: round2(pct) };
      } else if (!base?.compare_to && c.promo) {
        const pct = (c.regular - c.promo) / c.regular;
        if (pct >= threshold) deal = { kind: 'sale_no_history', pct: round2(pct) };
      }
    }
    return { ...c, verdict: v?.verdict || null, verdict_source: v?.source || null, verdict_reason: v?.reason || '', unit_price: round2(unit), deal };
  });

  // One deal per watch item: its best-value matched product.
  const best = new Map();
  for (const c of annotated) {
    if (!c.deal) continue;
    const prev = best.get(c.watch_id);
    if (!prev || c.deal.pct > prev.deal.pct) best.set(c.watch_id, c);
  }
  const deals = [...best.values()].map((c) => {
    const watch = byId.get(c.watch_id);
    return { watch_id: watch.id, name: watch.name, department: watch.department, basis: watch.basis, advice: stockAdvice(watch.department), baseline: baselines.get(watch.id), product: c };
  }).sort((a, b) => b.product.deal.pct - a.product.deal.pct);
  return { checks: annotated, deals };
}

// ── Runs ──────────────────────────────────────────────────────────────────────

const pacificDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });
const pacificHour = (d = new Date()) => Number(d.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;

async function getLocation() { return db.getSetting('deals_location'); }
async function getThreshold() { return (await db.getSetting('deals_threshold')) ?? DEFAULT_THRESHOLD; }

async function baselinesFor(watchList) {
  const purchases = await db.purchasesFor([...new Set(watchList.flatMap((w) => w.item_basics))]);
  const map = new Map();
  for (const w of watchList) {
    const types = new Set(w.item_basics.map((b) => b.toLowerCase()));
    map.set(w.id, baselineFor(w, purchases.filter((p) => types.has(p.item_basic.toLowerCase()))));
  }
  return map;
}

// Searches every watched item (a few at a time), matches new products, and stores the run.
async function runCheck(kind, watchIds = null) {
  const location = await getLocation();
  if (!location) throw Object.assign(new Error('Pick your Ralphs store first.'), { status: 400 });
  let list = (await db.listWatch()).filter((w) => w.status === 'watching');
  if (watchIds) list = list.filter((w) => watchIds.includes(w.id));
  if (!list.length) throw Object.assign(new Error('Nothing on the watchlist is set to Watching.'), { status: 400 });

  const started = new Date();
  const checks = [];
  const failed = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const watch = list[next++];
      try {
        const found = await searchProducts(watch.search_term, location.location_id);
        checks.push(...found.map((p) => ({ ...p, watch_id: watch.id })));
      } catch (err) { failed.push(`${watch.name}: ${err.message}`); }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (failed.length === list.length) throw Object.assign(new Error(failed[0]), { status: 502 });
  const order = new Map(list.map((w, i) => [w.id, i]));
  checks.sort((a, b) => order.get(a.watch_id) - order.get(b.watch_id) || a.rank - b.rank);

  // Ask Claude only about products we haven't decided on before.
  const known = await db.listVerdicts(STORE);
  const undecided = list.map((watch) => ({
    watch, products: checks.filter((c) => c.watch_id === watch.id && !known.has(`${watch.id}|${c.product_id}`))
  }));
  const { verdicts, error: matchError } = await classifyProducts(undecided);
  await db.saveVerdicts(STORE, verdicts);

  const run = await db.saveRun({
    kind, store: STORE, location_id: location.location_id, run_date: pacificDate(started),
    started_at: started, term_count: list.length
  }, checks);
  return { run, failed, match_error: matchError };
}

// Everything the Deals tab shows: watchlist with baselines, and the latest run evaluated.
async function dealsView() {
  const [watchList, latest, threshold] = await Promise.all([db.listWatch(), db.latestRun(), getThreshold()]);
  const baselines = await baselinesFor(watchList);
  const watch = watchList.map((w) => ({ ...w, baseline: baselines.get(w.id) }));
  if (!latest) return { watch, threshold, latest: null, deals: [] };
  const { checks, deals } = evaluate(watchList, baselines, latest.checks.filter((c) => c.watch_id != null), await db.listVerdicts(STORE), threshold);
  return { watch, threshold, latest: { run: latest.run, checks }, deals };
}

// Starter watchlist: item types bought at least twice in the last year, plus STARTER_ITEMS.
// Alcohol starts paused (none kept in the house); everything can be changed afterwards.
async function seedWatchlist() {
  const types = await db.frequentItemTypes(2);
  const items = types.map((t) => ({
    name: t.item_basic,
    status: t.department === 'Alcohol' || /ground beef/i.test(t.item_basic) ? 'paused' : 'watching',
    search_term: t.item_basic.toLowerCase(),
    item_basics: [t.item_basic],
    department: t.department,
    basis: t.weighed * 2 > t.count ? 'lb' : 'package'
  }));
  const covered = new Set(items.map((i) => i.name.toLowerCase()));
  for (const s of STARTER_ITEMS) if (!covered.has(s.name.toLowerCase())) items.push(s);
  return db.createWatch(items);
}

// Daily background check, used to learn which weekday Ralphs changes its sale prices
// (and, from phase 3, to send the weekly email). Runs once per Pacific day after 6am;
// the database record makes it safe across restarts.
let dailyBusy = false;
async function dailyTick() {
  if (dailyBusy || !isConfigured() || !process.env.DATABASE_URL || pacificHour() < 6) return;
  dailyBusy = true;
  try {
    if (!(await getLocation()) || (await db.hasRunOn('daily', pacificDate()))) return;
    if (!(await db.listWatch()).some((w) => w.status === 'watching')) return;
    const { run, failed } = await runCheck('daily');
    console.log(`deals: daily check saved ${run.product_count} prices${failed.length ? `, ${failed.length} item(s) failed` : ''}`);
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
  STORE, DEFAULT_THRESHOLD, isConfigured, findLocations, getLocation, getThreshold, runCheck,
  dealsView, seedWatchlist, startDailyChecks, parseSize, baselineFor, evaluate
};
