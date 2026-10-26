// Postgres storage for the grocery tracker. DATABASE_URL comes from the Railway
// Postgres service (reference variable ${{Postgres.DATABASE_URL}} on this service).
const { Pool, types } = require('pg');

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects,
// which can shift a day depending on the server's timezone.
types.setTypeParser(1082, (v) => v);

let pool = null;

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const url = process.env.DATABASE_URL;
    // Railway's private network (*.railway.internal) is plain TCP; the public proxy needs TLS.
    const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 5 });
    pool.on('error', (err) => console.error('grocery db pool error:', err.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grocery_receipts (
  id            SERIAL PRIMARY KEY,
  store         TEXT NOT NULL,
  store_address TEXT NOT NULL DEFAULT '',
  purchased_on  DATE NOT NULL,
  subtotal      NUMERIC(10,2),
  savings       NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax           NUMERIC(10,2) NOT NULL DEFAULT 0,
  fees          NUMERIC(10,2) NOT NULL DEFAULT 0,
  total         NUMERIC(10,2),
  source        TEXT NOT NULL DEFAULT 'app',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grocery_receipts_date_idx ON grocery_receipts (purchased_on);

CREATE TABLE IF NOT EXISTS grocery_items (
  id           SERIAL PRIMARY KEY,
  receipt_id   INTEGER NOT NULL REFERENCES grocery_receipts(id) ON DELETE CASCADE,
  line_no      INTEGER NOT NULL,
  raw_name     TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  brand        TEXT NOT NULL DEFAULT '',
  item_basic   TEXT NOT NULL,
  department   TEXT NOT NULL,
  quantity     NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit         TEXT NOT NULL DEFAULT 'each',
  unit_price   NUMERIC(10,2) NOT NULL,
  line_total   NUMERIC(10,2) NOT NULL,
  savings      NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS grocery_items_receipt_idx ON grocery_items (receipt_id);
CREATE INDEX IF NOT EXISTS grocery_items_basic_idx ON grocery_items (item_basic);

-- Deals: small key/value settings (chosen store, test search terms).
CREATE TABLE IF NOT EXISTS grocery_settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- One row per price check (manual button or the daily background check).
CREATE TABLE IF NOT EXISTS grocery_price_runs (
  id            SERIAL PRIMARY KEY,
  kind          TEXT NOT NULL,
  store         TEXT NOT NULL,
  location_id   TEXT NOT NULL,
  run_date      DATE NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  term_count    INTEGER NOT NULL DEFAULT 0,
  product_count INTEGER NOT NULL DEFAULT 0,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS grocery_price_runs_date_idx ON grocery_price_runs (kind, run_date);

-- Every product price seen in a run: the store's own price history.
CREATE TABLE IF NOT EXISTS grocery_price_checks (
  id            SERIAL PRIMARY KEY,
  run_id        INTEGER NOT NULL REFERENCES grocery_price_runs(id) ON DELETE CASCADE,
  term          TEXT NOT NULL,
  rank          INTEGER NOT NULL,
  product_id    TEXT NOT NULL,
  upc           TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL,
  size          TEXT NOT NULL DEFAULT '',
  sold_by       TEXT NOT NULL DEFAULT '',
  regular       NUMERIC(10,2),
  promo         NUMERIC(10,2),
  promo_expires DATE
);
CREATE INDEX IF NOT EXISTS grocery_price_checks_run_idx ON grocery_price_checks (run_id);
CREATE INDEX IF NOT EXISTS grocery_price_checks_product_idx ON grocery_price_checks (product_id);

-- Watchlist: what to look for, and how to judge a good price.
--   status: watching | paused | never      basis: lb | oz | package | unit (per roll, per egg, ...)
--   item_basics: receipt item types whose prices form the "usual price" baseline.
CREATE TABLE IF NOT EXISTS grocery_watch (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'watching',
  search_term  TEXT NOT NULL,
  item_basics  TEXT[] NOT NULL DEFAULT '{}',
  department   TEXT NOT NULL DEFAULT 'Other',
  basis        TEXT NOT NULL DEFAULT 'package',
  pack_count   NUMERIC(10,2),
  target_price NUMERIC(10,2),
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS grocery_watch_name_idx ON grocery_watch (lower(name));

-- Whether a store product counts as a given watch item (decided by Claude or overridden by the user).
CREATE TABLE IF NOT EXISTS grocery_watch_products (
  watch_id    INTEGER NOT NULL REFERENCES grocery_watch(id) ON DELETE CASCADE,
  store       TEXT NOT NULL,
  product_id  TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  source      TEXT NOT NULL,
  reason      TEXT NOT NULL DEFAULT '',
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (watch_id, store, product_id)
);

ALTER TABLE grocery_price_checks ADD COLUMN IF NOT EXISTS watch_id INTEGER;

-- Digital coupons, imported weekly from the store's coupon page (see deals.importCoupons).
--   kind: price (coupon sets the price) | off (amount off, per min_qty items) | percent | other (points, spend-X offers)
--   watch_ids: watchlist items the coupon might apply to; grocery_coupon_products decides per product.
CREATE TABLE IF NOT EXISTS grocery_coupons (
  id          SERIAL PRIMARY KEY,
  store       TEXT NOT NULL,
  coupon_key  TEXT NOT NULL,
  offer       TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT '',
  product     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,
  amount      NUMERIC(10,2),
  min_qty     INTEGER NOT NULL DEFAULT 1,
  expires     DATE,
  in_store    BOOLEAN NOT NULL DEFAULT true,
  watch_ids   INTEGER[] NOT NULL DEFAULT '{}',
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store, coupon_key)
);

CREATE TABLE IF NOT EXISTS grocery_coupon_products (
  coupon_id  INTEGER NOT NULL REFERENCES grocery_coupons(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  applies    BOOLEAN NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (coupon_id, product_id)
);

-- A package size the user corrected for a receipt line (e.g. "10 x 7.5 fl oz"), for price-per-oz baselines.
ALTER TABLE grocery_items ADD COLUMN IF NOT EXISTS size_text TEXT NOT NULL DEFAULT '';
`;

let ready = null;
function ensureSchema() {
  const p = getPool();
  if (!p) return Promise.reject(new Error('DATABASE_URL is not configured.'));
  if (!ready) ready = p.query(SCHEMA).catch((err) => { ready = null; throw err; });
  return ready;
}

async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

function receiptRow(r) {
  return {
    id: r.id, store: r.store, store_address: r.store_address, date: iso(r.purchased_on),
    subtotal: num(r.subtotal), savings: num(r.savings), tax: num(r.tax), fees: num(r.fees),
    total: num(r.total), source: r.source, item_count: r.item_count === undefined ? undefined : Number(r.item_count),
    items_total: r.items_total === undefined ? undefined : num(r.items_total)
  };
}

function itemRow(i) {
  return {
    id: i.id, receipt_id: i.receipt_id, line_no: i.line_no, raw_name: i.raw_name, name: i.name,
    brand: i.brand, item_basic: i.item_basic, department: i.department, quantity: num(i.quantity),
    unit: i.unit, unit_price: num(i.unit_price), line_total: num(i.line_total), savings: num(i.savings)
  };
}

async function listReceipts() {
  const { rows } = await query(`
    SELECT r.*, COUNT(i.id) AS item_count, COALESCE(SUM(i.line_total), 0) AS items_total
    FROM grocery_receipts r LEFT JOIN grocery_items i ON i.receipt_id = r.id
    GROUP BY r.id ORDER BY r.purchased_on DESC, r.id DESC`);
  return rows.map(receiptRow);
}

async function getReceipt(id) {
  const { rows } = await query('SELECT * FROM grocery_receipts WHERE id = $1', [id]);
  if (!rows.length) return null;
  const items = await query('SELECT * FROM grocery_items WHERE receipt_id = $1 ORDER BY line_no', [id]);
  return { ...receiptRow(rows[0]), items: items.rows.map(itemRow) };
}

// Every line item joined with its receipt's store/date: the dataset the dashboards chart.
async function listItems() {
  const { rows } = await query(`
    SELECT i.id, i.receipt_id, r.store, r.purchased_on, i.raw_name, i.name, i.brand, i.item_basic, i.department,
           i.quantity, i.unit, i.unit_price, i.line_total, i.savings, i.size_text
    FROM grocery_items i JOIN grocery_receipts r ON r.id = i.receipt_id
    ORDER BY r.purchased_on, i.receipt_id, i.line_no`);
  return rows.map((i) => ({
    id: i.id, receipt_id: i.receipt_id, store: i.store, date: iso(i.purchased_on), raw_name: i.raw_name, name: i.name,
    brand: i.brand, item_basic: i.item_basic, department: i.department, quantity: num(i.quantity),
    unit: i.unit, unit_price: num(i.unit_price), line_total: num(i.line_total), savings: num(i.savings),
    size_text: i.size_text
  }));
}

// Category vocabulary plus how past raw receipt names were classified, so new
// receipts reuse the same item_basic names and price histories line up.
async function classificationContext() {
  const vocab = await query(`
    SELECT item_basic, department, COUNT(*) AS n FROM grocery_items
    GROUP BY item_basic, department ORDER BY item_basic`);
  const known = await query(`
    SELECT DISTINCT ON (lower(raw_name)) raw_name, name, brand, item_basic, department
    FROM grocery_items i JOIN grocery_receipts r ON r.id = i.receipt_id
    WHERE raw_name <> '' ORDER BY lower(raw_name), r.purchased_on DESC`);
  return { vocab: vocab.rows.map((v) => ({ item_basic: v.item_basic, department: v.department, count: Number(v.n) })), known: known.rows };
}

async function findDuplicate(store, date, total, excludeId = null) {
  const { rows } = await query(`
    SELECT id FROM grocery_receipts
    WHERE lower(store) = lower($1) AND purchased_on = $2 AND total IS NOT DISTINCT FROM $3 AND ($4::int IS NULL OR id <> $4)
    LIMIT 1`, [store, date, total, excludeId]);
  return rows[0]?.id ?? null;
}

// sizes: corrected package sizes by item name, carried over when a receipt is edited.
async function insertItems(client, receiptId, items, sizes = new Map()) {
  let lineNo = 0;
  for (const it of items) {
    lineNo += 1;
    await client.query(`
      INSERT INTO grocery_items (receipt_id, line_no, raw_name, name, brand, item_basic, department,
                                 quantity, unit, unit_price, line_total, savings, size_text)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [receiptId, lineNo, it.raw_name || '', it.name, it.brand || '', it.item_basic, it.department,
       it.quantity, it.unit, it.unit_price, it.line_total, it.savings || 0, sizes.get(it.name) || '']);
  }
}

async function saveReceipt(r, source) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO grocery_receipts (store, store_address, purchased_on, subtotal, savings, tax, fees, total, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [r.store, r.store_address || '', r.date, r.subtotal, r.savings || 0, r.tax || 0, r.fees || 0, r.total, source]);
    await insertItems(client, rows[0].id, r.items);
    return rows[0].id;
  });
}

async function replaceReceipt(id, r) {
  return withTransaction(async (client) => {
    const { rowCount } = await client.query(`
      UPDATE grocery_receipts SET store=$2, store_address=$3, purchased_on=$4, subtotal=$5, savings=$6, tax=$7, fees=$8, total=$9
      WHERE id = $1`,
      [id, r.store, r.store_address || '', r.date, r.subtotal, r.savings || 0, r.tax || 0, r.fees || 0, r.total]);
    if (!rowCount) return false;
    const { rows: sized } = await client.query(`SELECT name, size_text FROM grocery_items WHERE receipt_id = $1 AND size_text <> ''`, [id]);
    await client.query('DELETE FROM grocery_items WHERE receipt_id = $1', [id]);
    await insertItems(client, id, r.items, new Map(sized.map((x) => [x.name, x.size_text])));
    return true;
  });
}

async function deleteReceipt(id) {
  const { rowCount } = await query('DELETE FROM grocery_receipts WHERE id = $1', [id]);
  return rowCount > 0;
}

// ── Deals ─────────────────────────────────────────────────────────────────────

async function getSetting(key) {
  const { rows } = await query('SELECT value FROM grocery_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function setSetting(key, value) {
  await query(`
    INSERT INTO grocery_settings (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);
}

function runRow(r) {
  return {
    id: r.id, kind: r.kind, store: r.store, location_id: r.location_id, run_date: iso(r.run_date),
    started_at: r.started_at, finished_at: r.finished_at, term_count: r.term_count,
    product_count: r.product_count, error: r.error
  };
}

async function hasRunOn(kind, runDate) {
  const { rows } = await query('SELECT 1 FROM grocery_price_runs WHERE kind = $1 AND run_date = $2 LIMIT 1', [kind, runDate]);
  return rows.length > 0;
}

// Saves a finished run and its price rows in one transaction.
async function saveRun(run, checks) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(`
      INSERT INTO grocery_price_runs (kind, store, location_id, run_date, started_at, finished_at, term_count, product_count, error)
      VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8) RETURNING *`,
      [run.kind, run.store, run.location_id, run.run_date, run.started_at, run.term_count, checks.length, run.error || null]);
    const runId = rows[0].id;
    for (const c of checks) {
      await client.query(`
        INSERT INTO grocery_price_checks (run_id, watch_id, term, rank, product_id, upc, brand, description, size, sold_by, regular, promo, promo_expires)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [runId, c.watch_id ?? null, c.term, c.rank, c.product_id, c.upc, c.brand, c.description, c.size, c.sold_by, c.regular, c.promo, c.promo_expires]);
    }
    return runRow(rows[0]);
  });
}

async function latestRun() {
  const { rows } = await query('SELECT * FROM grocery_price_runs WHERE error IS NULL ORDER BY started_at DESC LIMIT 1');
  if (!rows.length) return null;
  const checks = await query('SELECT * FROM grocery_price_checks WHERE run_id = $1 ORDER BY id', [rows[0].id]);
  return {
    run: runRow(rows[0]),
    checks: checks.rows.map((c) => ({
      watch_id: c.watch_id, term: c.term, rank: c.rank, product_id: c.product_id, upc: c.upc, brand: c.brand, description: c.description,
      size: c.size, sold_by: c.sold_by, regular: num(c.regular), promo: num(c.promo),
      promo_expires: c.promo_expires ? iso(c.promo_expires) : null
    }))
  };
}

async function lastRunOf(kind) {
  const { rows } = await query('SELECT * FROM grocery_price_runs WHERE kind = $1 ORDER BY started_at DESC LIMIT 1', [kind]);
  return rows.length ? runRow(rows[0]) : null;
}

// For the daily checks: how many products' sale price changed, keyed by the weekday (Pacific)
// of the first check that saw the new price. Shows which day the store's weekly ad turns over.
async function promoChangesByWeekday() {
  const { rows } = await query(`
    WITH seen AS (
      SELECT c.product_id, r.run_date, COALESCE(c.promo, 0) AS promo,
             LAG(COALESCE(c.promo, 0)) OVER (PARTITION BY r.location_id, c.product_id ORDER BY r.run_date) AS prev,
             LAG(r.run_date) OVER (PARTITION BY r.location_id, c.product_id ORDER BY r.run_date) AS prev_date
      FROM grocery_price_checks c JOIN grocery_price_runs r ON r.id = c.run_id
      WHERE r.kind = 'daily' AND r.error IS NULL
    )
    SELECT EXTRACT(ISODOW FROM run_date)::int AS dow, COUNT(*) AS changes
    FROM seen WHERE prev IS NOT NULL AND promo <> prev AND run_date - prev_date = 1
    GROUP BY 1 ORDER BY 1`);
  const days = await query(`SELECT COUNT(DISTINCT run_date) AS n FROM grocery_price_runs WHERE kind = 'daily' AND error IS NULL`);
  return { daily_runs: Number(days.rows[0].n), by_weekday: rows.map((r) => ({ dow: r.dow, changes: Number(r.changes) })) };
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

function watchRow(w) {
  return {
    id: w.id, name: w.name, status: w.status, search_term: w.search_term, item_basics: w.item_basics,
    department: w.department, basis: w.basis, pack_count: num(w.pack_count), target_price: num(w.target_price),
    notes: w.notes
  };
}

const WATCH_FIELDS = ['name', 'status', 'search_term', 'item_basics', 'department', 'basis', 'pack_count', 'target_price', 'notes'];

async function listWatch() {
  const { rows } = await query('SELECT * FROM grocery_watch ORDER BY lower(name)');
  return rows.map(watchRow);
}

async function getWatch(id) {
  const { rows } = await query('SELECT * FROM grocery_watch WHERE id = $1', [id]);
  return rows.length ? watchRow(rows[0]) : null;
}

// Inserts watch items, skipping any whose name already exists. Returns the ones created.
async function createWatch(items) {
  return withTransaction(async (client) => {
    const created = [];
    for (const w of items) {
      const { rows } = await client.query(`
        INSERT INTO grocery_watch (name, status, search_term, item_basics, department, basis, pack_count, target_price, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT ((lower(name))) DO NOTHING RETURNING *`,
        [w.name, w.status || 'watching', w.search_term, w.item_basics || [], w.department || 'Other',
         w.basis || 'package', w.pack_count ?? null, w.target_price ?? null, w.notes || '']);
      if (rows.length) created.push(watchRow(rows[0]));
    }
    return created;
  });
}

async function updateWatch(id, patch) {
  const keys = WATCH_FIELDS.filter((k) => patch[k] !== undefined);
  if (!keys.length) return getWatch(id);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await query(`UPDATE grocery_watch SET ${sets} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => patch[k])]);
  return rows.length ? watchRow(rows[0]) : null;
}

async function deleteWatch(id) {
  const { rowCount } = await query('DELETE FROM grocery_watch WHERE id = $1', [id]);
  return rowCount > 0;
}

// Map of `${watch_id}|${product_id}` -> { verdict, source, reason } for one store.
async function listVerdicts(store) {
  const { rows } = await query('SELECT watch_id, product_id, verdict, source, reason FROM grocery_watch_products WHERE store = $1', [store]);
  return new Map(rows.map((r) => [`${r.watch_id}|${r.product_id}`, { verdict: r.verdict, source: r.source, reason: r.reason }]));
}

// Claude's verdicts never overwrite a decision the user made.
async function saveVerdicts(store, verdicts) {
  for (const v of verdicts) {
    await query(`
      INSERT INTO grocery_watch_products (watch_id, store, product_id, verdict, source, reason)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (watch_id, store, product_id) DO UPDATE
        SET verdict = EXCLUDED.verdict, source = EXCLUDED.source, reason = EXCLUDED.reason, decided_at = now()
        WHERE grocery_watch_products.source <> 'user' OR EXCLUDED.source = 'user'`,
      [v.watch_id, store, v.product_id, v.verdict, v.source, v.reason || '']);
  }
}

// Receipt lines from the last year for the given item types: the raw material for baselines.
async function purchasesFor(itemBasics) {
  if (!itemBasics.length) return [];
  const { rows } = await query(`
    SELECT i.id, i.item_basic, i.name, i.raw_name, i.size_text, i.unit, i.quantity, i.unit_price, r.store, r.purchased_on
    FROM grocery_items i JOIN grocery_receipts r ON r.id = i.receipt_id
    WHERE lower(i.item_basic) = ANY($1) AND r.purchased_on >= CURRENT_DATE - INTERVAL '1 year'
    ORDER BY r.purchased_on DESC, i.id`,
    [itemBasics.map((b) => b.toLowerCase())]);
  return rows.map((r) => ({
    id: r.id, item_basic: r.item_basic, name: r.name, raw_name: r.raw_name, size_text: r.size_text,
    unit: r.unit, quantity: num(r.quantity), unit_price: num(r.unit_price), store: r.store, date: iso(r.purchased_on)
  }));
}

// Returns how many receipt lines were updated.
async function setItemSize(ids, sizeText) {
  const { rowCount } = await query('UPDATE grocery_items SET size_text = $2 WHERE id = ANY($1)', [ids, sizeText]);
  return rowCount;
}

// Item types bought at least `minCount` times in the last year, for building a starter watchlist.
async function frequentItemTypes(minCount) {
  const { rows } = await query(`
    SELECT i.item_basic, MODE() WITHIN GROUP (ORDER BY i.department) AS department, COUNT(*) AS n,
           SUM(CASE WHEN i.unit = 'each' THEN 0 ELSE 1 END) AS weighed
    FROM grocery_items i JOIN grocery_receipts r ON r.id = i.receipt_id
    WHERE r.purchased_on >= CURRENT_DATE - INTERVAL '1 year'
    GROUP BY i.item_basic HAVING COUNT(*) >= $1 ORDER BY COUNT(*) DESC`, [minCount]);
  return rows.map((r) => ({ item_basic: r.item_basic, department: r.department, count: Number(r.n), weighed: Number(r.weighed) }));
}

// ── Coupons ───────────────────────────────────────────────────────────────────

function couponRow(c) {
  return {
    id: c.id, offer: c.offer, brand: c.brand, product: c.product, kind: c.kind, amount: num(c.amount),
    min_qty: c.min_qty, expires: c.expires ? iso(c.expires) : null, in_store: c.in_store, watch_ids: c.watch_ids
  };
}

// Adds or refreshes coupons (keyed by offer text + expiry, so the same coupon keeps its id and
// product decisions across imports) and drops ones that expired before `today`.
async function upsertCoupons(store, coupons, today) {
  return withTransaction(async (client) => {
    let added = 0;
    for (const c of coupons) {
      const { rows } = await client.query(`
        INSERT INTO grocery_coupons (store, coupon_key, offer, brand, product, kind, amount, min_qty, expires, in_store, watch_ids)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (store, coupon_key) DO UPDATE SET brand = EXCLUDED.brand, product = EXCLUDED.product, kind = EXCLUDED.kind,
          amount = EXCLUDED.amount, min_qty = EXCLUDED.min_qty, in_store = EXCLUDED.in_store, watch_ids = EXCLUDED.watch_ids, imported_at = now()
        RETURNING (xmax = 0) AS inserted`,
        [store, c.coupon_key, c.offer, c.brand, c.product, c.kind, c.amount, c.min_qty, c.expires, c.in_store, c.watch_ids]);
      if (rows[0].inserted) added += 1;
    }
    await client.query('DELETE FROM grocery_coupons WHERE store = $1 AND expires < $2', [store, today]);
    return added;
  });
}

async function activeCoupons(store, today) {
  const { rows } = await query(`SELECT * FROM grocery_coupons WHERE store = $1 AND (expires IS NULL OR expires >= $2) ORDER BY id`, [store, today]);
  return rows.map(couponRow);
}

// Map of `${coupon_id}|${product_id}` → { applies, reason }.
async function listCouponProducts(couponIds) {
  if (!couponIds.length) return new Map();
  const { rows } = await query('SELECT * FROM grocery_coupon_products WHERE coupon_id = ANY($1)', [couponIds]);
  return new Map(rows.map((r) => [`${r.coupon_id}|${r.product_id}`, { applies: r.applies, reason: r.reason }]));
}

async function saveCouponProducts(decisions) {
  if (!decisions.length) return;
  await withTransaction(async (client) => {
    for (const d of decisions) {
      await client.query(`
        INSERT INTO grocery_coupon_products (coupon_id, product_id, applies, reason) VALUES ($1,$2,$3,$4)
        ON CONFLICT (coupon_id, product_id) DO UPDATE SET applies = EXCLUDED.applies, reason = EXCLUDED.reason`,
        [d.coupon_id, d.product_id, d.applies, d.reason]);
    }
  });
}

module.exports = {
  getPool, ensureSchema, withTransaction, listReceipts, getReceipt, listItems,
  classificationContext, findDuplicate, saveReceipt, replaceReceipt, deleteReceipt,
  getSetting, setSetting, hasRunOn, saveRun, latestRun, lastRunOf, promoChangesByWeekday,
  listWatch, getWatch, createWatch, updateWatch, deleteWatch, listVerdicts, saveVerdicts,
  purchasesFor, setItemSize, frequentItemTypes, upsertCoupons, activeCoupons, listCouponProducts, saveCouponProducts
};
