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
    SELECT i.id, i.receipt_id, r.store, r.purchased_on, i.name, i.brand, i.item_basic, i.department,
           i.quantity, i.unit, i.unit_price, i.line_total, i.savings
    FROM grocery_items i JOIN grocery_receipts r ON r.id = i.receipt_id
    ORDER BY r.purchased_on, i.receipt_id, i.line_no`);
  return rows.map((i) => ({
    id: i.id, receipt_id: i.receipt_id, store: i.store, date: iso(i.purchased_on), name: i.name,
    brand: i.brand, item_basic: i.item_basic, department: i.department, quantity: num(i.quantity),
    unit: i.unit, unit_price: num(i.unit_price), line_total: num(i.line_total), savings: num(i.savings)
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

async function insertItems(client, receiptId, items) {
  let lineNo = 0;
  for (const it of items) {
    lineNo += 1;
    await client.query(`
      INSERT INTO grocery_items (receipt_id, line_no, raw_name, name, brand, item_basic, department,
                                 quantity, unit, unit_price, line_total, savings)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [receiptId, lineNo, it.raw_name || '', it.name, it.brand || '', it.item_basic, it.department,
       it.quantity, it.unit, it.unit_price, it.line_total, it.savings || 0]);
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
    await client.query('DELETE FROM grocery_items WHERE receipt_id = $1', [id]);
    await insertItems(client, id, r.items);
    return true;
  });
}

async function deleteReceipt(id) {
  const { rowCount } = await query('DELETE FROM grocery_receipts WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = {
  getPool, ensureSchema, withTransaction, listReceipts, getReceipt, listItems,
  classificationContext, findDuplicate, saveReceipt, replaceReceipt, deleteReceipt
};
