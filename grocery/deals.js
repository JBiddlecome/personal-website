// Store price checks for the Deals tab. Ralphs comes through the Kroger public API (Ralphs is a
// Kroger chain). Credentials come from a Kroger developer app:
// KROGER_CLIENT_ID / KROGER_CLIENT_SECRET (client-credentials grant, product.compact scope).
//
// A check searches every "watching" item on the watchlist, has Claude sort out which results are
// really that item (match.js), and compares the matched prices with the usual price paid on receipts.
const db = require('./db');
const { classifyProducts, extractCoupons, classifyCouponProducts } = require('./match');
const email = require('./email');

const API = 'https://api.kroger.com/v1';
const STORE = 'Ralphs';
const TZ = 'America/Los_Angeles';
const RESULTS_PER_TERM = 6;
const DEFAULT_THRESHOLD = 0.15;
const DEFAULT_EMAIL_DAY = 3; // Wednesday, when Ralphs' weekly ad starts, until the daily checks show otherwise

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

// Ounces per unit of size. Weight units also give pounds; fluid ones only ounces.
const OZ_PER = { 'fl oz': 1, oz: 1, lb: 16, kg: 35.274, g: 0.035274, l: 33.814, ml: 0.033814, gal: 128, qt: 32, pt: 16 };
const WEIGHT = new Set(['oz', 'lb', 'kg', 'g']);
const UNIT_ALIASES = [
  [/^fl\.?\s*oz|^fluid ounces?/, 'fl oz'], [/^(oz|ounces?)$/, 'oz'], [/^(lbs?|pounds?)$/, 'lb'], [/^(kg|kilograms?)$/, 'kg'],
  [/^(g|grams?)$/, 'g'], [/^(l|lt|ltr|liters?|litres?)$/, 'l'], [/^(ml|milliliters?)$/, 'ml'], [/^(gal|gallons?)$/, 'gal'],
  [/^(qt|quarts?)$/, 'qt'], [/^(pt|pints?)$/, 'pt']
];
const AMOUNT = /(\d+(?:\.\d+)?|\d+\/\d+)\s*(fl\.?\s*oz|fluid ounces?|ounces?|oz|lbs?|pounds?|kilograms?|kg|grams?|g|liters?|litres?|ltr|lt|l|milliliters?|ml|gallons?|gal|quarts?|qt|pints?|pt)\b/;
const COUNT = /(\d+)\s*-?\s*(?:ct|count|pk|pack|packs|cans?|bottles?|(?:mega |double |family |huge |giant |regular |jumbo )?rolls?|eggs?|bags?|pods?|k-cups?|bars?|pieces?|pcs|x)\b/;

// Package size text → { count, lb, oz } for the whole package. Reads Kroger sizes ("12 ct / 12 fl oz",
// "2 L", "1.5 lb", "12 mega rolls") and receipt names ("Ginger Ale 10pk 7.5oz", "6-7.5 fl oz").
// oz is weight or fluid ounces, so drinks and dry goods can both be compared per ounce;
// lb is weight only. An amount with a count is taken as the size of each item in the pack.
function parseSize(size) {
  const s = String(size || '').toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  const num = (v) => (v.includes('/') ? Number(v.split('/')[0]) / Number(v.split('/')[1]) : Number(v));
  const out = {};
  let count = null;
  let amount = null;
  const dashed = s.match(/\b(\d{1,2})\s*-\s*(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz)\b/); // "6-7.5 fl oz" = 6 × 7.5 oz
  if (dashed) {
    count = Number(dashed[1]);
    amount = { value: Number(dashed[2]), unit: dashed[3].startsWith('fl') ? 'fl oz' : 'oz' };
  } else {
    const m = s.match(AMOUNT);
    if (m) amount = { value: num(m[1]), unit: UNIT_ALIASES.find(([re]) => re.test(m[2]))[1] };
    const c = s.match(COUNT);
    if (c) count = Number(c[1]);
  }
  if (count) out.count = count;
  if (amount && amount.value > 0) {
    const n = count || 1;
    out.oz = amount.value * OZ_PER[amount.unit] * n;
    if (WEIGHT.has(amount.unit)) out.lb = out.oz / 16;
  }
  return out;
}

// "10 × 7.5 fl oz" style summary of a parsed size, for showing how a size was read.
function describeSize(parsed) {
  const parts = [];
  if (parsed.count) parts.push(`${parsed.count} ct`);
  if (parsed.oz) parts.push(`${+parsed.oz.toFixed(1)} oz total`);
  return parts.join(', ');
}

// A store price expressed on the watch item's basis, or null when the size can't be read.
function storeUnitPrice(product, watch, value) {
  if (value == null) return null;
  const size = parseSize(product.size);
  if (watch.basis === 'lb') {
    if (product.sold_by === 'WEIGHT') return value;
    return size.lb ? value / size.lb : null;
  }
  if (watch.basis === 'oz') {
    if (product.sold_by === 'WEIGHT') return value / 16;
    return size.oz ? value / size.oz : null;
  }
  if (watch.basis === 'unit') return size.count ? value / size.count : null;
  return product.sold_by === 'WEIGHT' ? null : value; // package
}

// One receipt line's price on the watch item's basis, and the size it was read from.
// Weighed lines (unit lb/oz/kg) already carry a per-weight price; packaged lines need a size,
// taken from the user's correction or else read from the item name.
function purchaseUnitPrice(p, watch) {
  const sizeText = p.size_text || '';
  let size = parseSize(sizeText);
  let source = sizeText ? 'you' : null;
  if (!sizeText) {
    size = parseSize(p.name);
    if (!size.oz && !size.count) size = parseSize(p.raw_name);
    if (size.oz || size.count) source = 'name';
  }
  const perLb = p.unit === 'lb' ? p.unit_price : p.unit === 'oz' ? p.unit_price * 16 : p.unit === 'kg' ? p.unit_price / 2.2046 : null;
  let value = null;
  if (watch.basis === 'lb') value = perLb ?? (size.lb ? p.unit_price / size.lb : null);
  else if (watch.basis === 'oz') value = perLb != null ? perLb / 16 : size.oz ? p.unit_price / size.oz : null;
  else if (perLb == null) {
    if (watch.basis === 'package') value = p.unit_price;
    else { const n = size.count || watch.pack_count; value = n ? p.unit_price / n : null; } // unit
  }
  return { value, size: describeSize(size), source: perLb != null ? 'weighed' : source };
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
// Per-ounce prices are a few cents, so unit prices keep four decimals.
const round4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

// What the shopper usually pays, on the watch item's basis, from the last year of receipts.
// A target price set on the item takes precedence. `lines` lists each purchase and how it counted.
function baselineFor(watch, purchases) {
  const lines = purchases.map((p) => {
    const u = purchaseUnitPrice(p, watch);
    return {
      id: p.id, date: p.date, store: p.store, name: p.name, unit: p.unit, unit_price: p.unit_price,
      size_text: p.size_text || '', size_read: u.size, size_source: u.source, basis_price: round4(u.value)
    };
  });
  const paid = lines.map((l) => l.basis_price).filter((v) => v != null);
  const usual = paid.length ? median(paid) : null;
  return {
    usual: round4(usual),
    lowest: paid.length ? Math.min(...paid) : null,
    purchases: paid.length,
    target: watch.target_price,
    compare_to: watch.target_price ?? round4(usual),
    lines
  };
}

// ── Digital coupons ───────────────────────────────────────────────────────────

// The price after a coupon, per item (or per lb for products sold by weight), or null when the
// coupon doesn't lower it. Dollars-off coupons on weighed products are skipped as ambiguous.
function couponPrice(coupon, product, base) {
  let final = null;
  if (coupon.kind === 'price') final = Math.min(base, coupon.amount);
  else if (coupon.kind === 'percent' && coupon.amount < 100) final = base * (1 - coupon.amount / 100);
  else if (coupon.kind === 'off' && product.sold_by !== 'WEIGHT') final = base - coupon.amount / coupon.min_qty;
  return final != null && final > 0 && final < base ? round2(final) : null;
}

// Adds the best applicable coupon to each check: one linked to its watch item, usable in store,
// and judged to cover that product. `decisions` is from db.listCouponProducts.
function applyCoupons(checks, coupons, decisions) {
  const usable = coupons.filter((c) => c.in_store && c.kind !== 'other' && c.amount != null);
  return checks.map((c) => {
    const base = c.promo ?? c.regular;
    let best = null;
    for (const cp of usable) {
      if (!cp.watch_ids.includes(c.watch_id) || !decisions.get(`${cp.id}|${c.product_id}`)?.applies) continue;
      const final = couponPrice(cp, c, base);
      if (final != null && (!best || final < best.final)) {
        best = { id: cp.id, offer: cp.offer, final, min_qty: cp.min_qty, expires: cp.expires };
      }
    }
    return { ...c, coupon: best };
  });
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
    const now = c.coupon?.final ?? c.promo ?? c.regular;
    const unit = watch ? storeUnitPrice(c, watch, now) : null;
    const base = watch ? baselines.get(watch.id) : null;
    let deal = null;
    // Paused or not-interested items never produce deals, even from a check made before the change.
    if (watch?.status === 'watching' && v?.verdict === 'match') {
      if (base?.compare_to && unit != null) {
        const pct = (base.compare_to - unit) / base.compare_to;
        if (pct >= threshold) deal = { kind: base.target != null ? 'below_target' : 'below_usual', pct: round2(pct) };
      } else if (!base?.compare_to && now < c.regular) {
        const pct = (c.regular - now) / c.regular;
        if (pct >= threshold) deal = { kind: 'sale_no_history', pct: round2(pct) };
      }
    }
    return { ...c, verdict: v?.verdict || null, verdict_source: v?.source || null, verdict_reason: v?.reason || '', unit_price: round4(unit), deal };
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
  const couponError = await matchCoupons(checks);

  const run = await db.saveRun({
    kind, store: STORE, location_id: location.location_id, run_date: pacificDate(started),
    started_at: started, term_count: list.length
  }, checks);
  return { run, failed, match_error: [matchError, couponError].filter(Boolean).join(' ') || null };
}

// Asks Claude which matched products each linked coupon covers, for pairs not decided before.
async function matchCoupons(checks) {
  const coupons = (await db.activeCoupons(STORE, pacificDate())).filter((c) => c.in_store && c.kind !== 'other' && c.watch_ids.length);
  if (!coupons.length) return null;
  const [verdicts, known] = await Promise.all([db.listVerdicts(STORE), db.listCouponProducts(coupons.map((c) => c.id))]);
  const matched = checks.filter((c) => verdicts.get(`${c.watch_id}|${c.product_id}`)?.verdict === 'match');
  const entries = coupons.map((coupon) => {
    const seen = new Set();
    const products = matched.filter((c) => coupon.watch_ids.includes(c.watch_id) && !known.has(`${coupon.id}|${c.product_id}`)
      && !seen.has(c.product_id) && seen.add(c.product_id));
    return { coupon, products };
  });
  const { decisions, error } = await classifyCouponProducts(entries);
  await db.saveCouponProducts(decisions);
  return error;
}

// Reads the text of the Ralphs digital coupon page (sent by the bookmark button), stores the
// coupons, and checks them against the latest prices so deals reflect them right away.
async function importCoupons(text) {
  const today = pacificDate();
  const watchList = (await db.listWatch()).filter((w) => w.status !== 'never');
  const { coupons, error } = await extractCoupons(text, watchList, today);
  if (!coupons.length) {
    throw Object.assign(new Error(error || 'No coupons were found in that page. Open the Ralphs digital coupons page, let the coupons load, then press the bookmark.'), { status: 400 });
  }
  const added = await db.upsertCoupons(STORE, coupons, today);
  const latest = await db.latestRun();
  const matchError = latest ? await matchCoupons(latest.checks.filter((c) => c.watch_id != null)) : null;
  const summary = {
    at: new Date().toISOString(), found: coupons.length, added,
    linked: coupons.filter((c) => c.watch_ids.length).length, error: [error, matchError].filter(Boolean).join(' ') || null
  };
  await db.setSetting('coupons_last_import', summary);
  return summary;
}

// Everything the Deals tab shows: watchlist with baselines, and the latest run evaluated.
async function dealsView() {
  const [watchList, latest, threshold] = await Promise.all([db.listWatch(), db.latestRun(), getThreshold()]);
  const baselines = await baselinesFor(watchList);
  const watch = watchList.map((w) => ({ ...w, baseline: baselines.get(w.id) }));
  const active = await db.activeCoupons(STORE, pacificDate());
  const coupons = {
    last_import: await db.getSetting('coupons_last_import'),
    active: active.length,
    linked: active.filter((c) => c.watch_ids.length)
  };
  if (!latest) return { watch, threshold, coupons, latest: null, deals: [] };
  const withCoupons = applyCoupons(latest.checks.filter((c) => c.watch_id != null), active, await db.listCouponProducts(active.map((c) => c.id)));
  const { checks, deals } = evaluate(watchList, baselines, withCoupons, await db.listVerdicts(STORE), threshold);
  return { watch, threshold, coupons, latest: { run: latest.run, checks }, deals };
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

// ── Weekly email ──────────────────────────────────────────────────────────────

const pacificWeekday = (d = new Date()) => // ISO: 1 = Monday … 7 = Sunday
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' })) + 1;

// weekday 'auto' follows the day the daily checks see the most sale-price changes (once there
// are about two weeks of them), and Wednesday until then.
async function emailSettings() {
  const saved = (await db.getSetting('deals_email')) || {};
  const settings = { enabled: false, to: '', weekday: 'auto', ...saved };
  const cycle = await db.promoChangesByWeekday();
  const detected = cycle.daily_runs >= 8 && cycle.by_weekday.length
    ? [...cycle.by_weekday].sort((a, b) => b.changes - a.changes)[0].dow : null;
  return {
    ...settings,
    send_day: settings.weekday === 'auto' ? detected || DEFAULT_EMAIL_DAY : settings.weekday,
    detected_day: detected,
    configured: email.isConfigured(),
    last: await db.getSetting('deals_email_last')
  };
}

async function sendDealsEmail(to) {
  const message = email.buildDealsEmail(await dealsView(), STORE);
  await email.sendEmail(to, message);
  return message.subject;
}

// Sent once on the chosen weekday, right after that morning's daily check.
async function maybeSendWeekly(today) {
  const s = await emailSettings();
  if (!s.enabled || !s.to || !s.configured || s.send_day !== pacificWeekday() || s.last?.date === today) return;
  const last = { date: today, at: new Date().toISOString(), to: s.to };
  try {
    last.subject = await sendDealsEmail(s.to);
    console.log(`deals: weekly email sent (${last.subject})`);
  } catch (err) {
    last.error = err.message; // recorded so a bad address doesn't retry every half hour
    console.error('deals: weekly email failed:', err.message);
  }
  await db.setSetting('deals_email_last', last);
}

// Daily background check, used to learn which weekday Ralphs changes its sale prices, and
// followed by the weekly email on its day. Runs once per Pacific day after 6am;
// the database record makes it safe across restarts.
let dailyBusy = false;
async function dailyTick() {
  if (dailyBusy || !isConfigured() || !process.env.DATABASE_URL || pacificHour() < 6) return;
  dailyBusy = true;
  try {
    const today = pacificDate();
    if (!(await getLocation())) return;
    if (!(await db.hasRunOn('daily', today))) {
      if (!(await db.listWatch()).some((w) => w.status === 'watching')) return;
      const { run, failed } = await runCheck('daily');
      console.log(`deals: daily check saved ${run.product_count} prices${failed.length ? `, ${failed.length} item(s) failed` : ''}`);
    }
    await maybeSendWeekly(today);
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
  describeSize, STORE, DEFAULT_THRESHOLD, isConfigured, findLocations, getLocation, getThreshold, runCheck,
  dealsView, seedWatchlist, startDailyChecks, emailSettings, sendDealsEmail, importCoupons, couponPrice, applyCoupons, parseSize, baselineFor, evaluate
};
