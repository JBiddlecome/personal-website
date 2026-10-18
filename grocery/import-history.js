// One-time seed of the grocery database from the original grocery tracker repo.
//
//   DATABASE_URL=... node grocery/import-history.js <grocery_data_classified.csv> [ralphs_receipts_parsed.json ralphs_classifications.json]
//
// CSV rows are grouped into one receipt per store + date (identical rows become a quantity).
// When the parsed Ralphs receipt JSON is given, those trips are imported from it instead, which
// keeps real subtotals/totals and coupon savings. Trips already in the database are skipped.
const fs = require('fs');
const db = require('./db');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const toIso = (mdy) => { const [m, d, y] = mdy.split('/').map(Number); return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; };
const round2 = (n) => Math.round(n * 100) / 100;

// Same cleanup parse_ralphs_receipts.py applies to names in the CSV.
const displayName = (raw) => raw.replace(/[®™*]/g, '').replace(/, /g, ' ')
  .replace(/(\d) (oz|lb|ct|l|fl oz|gal)\b/g, '$1$2').replace(/\s+/g, ' ').trim();

function receiptsFromCsv(rows) {
  const trips = new Map();
  for (const r of rows) {
    const price = Number(r['Price Paid']);
    if (!r.Store || !r.Date || !Number.isFinite(price)) continue;
    const key = `${r.Store}|${toIso(r.Date)}`;
    if (!trips.has(key)) trips.set(key, { store: r.Store, date: toIso(r.Date), lines: new Map() });
    const name = r['Product / Item Name'].trim();
    const lineKey = [name, r.Brand, price.toFixed(2), r.item_basic, r.department].join('|');
    const lines = trips.get(key).lines;
    if (lines.has(lineKey)) lines.get(lineKey).quantity += 1;
    else lines.set(lineKey, { raw_name: name, name, brand: r.Brand.trim(), item_basic: r.item_basic.trim() || 'Unknown',
      department: r.department.trim() || 'Other', quantity: 1, unit: 'each', unit_price: price, savings: 0 });
  }
  return [...trips.values()].map((t) => {
    const items = [...t.lines.values()].map((i) => ({ ...i, line_total: round2(i.unit_price * i.quantity) }));
    const total = round2(items.reduce((s, i) => s + i.line_total, 0));
    return { store: t.store, date: t.date, subtotal: null, savings: 0, tax: 0, fees: 0, total, items };
  });
}

function receiptsFromRalphsJson(parsed, classes) {
  return parsed.map((r) => {
    const items = r.items.map((i) => {
      const [brand, itemBasic, department] = classes[i.name];
      return { raw_name: i.name, name: displayName(i.name), brand, item_basic: itemBasic, department,
        quantity: i.qty, unit: 'each', unit_price: round2(i.line_total / i.qty), line_total: i.line_total, savings: i.coupons };
    });
    const savings = round2(items.reduce((s, i) => s + i.savings, 0));
    const itemsTotal = items.reduce((s, i) => s + i.line_total, 0);
    // fees = CA redemption values plus any "Other Fees" line: whatever the total holds beyond items and tax
    return { store: 'Ralphs', store_address: r.store_address, date: r.date, subtotal: r.subtotal, savings,
      tax: r.tax, fees: round2(r.total - itemsTotal - r.tax), total: r.total, items };
  });
}

async function main() {
  const [csvPath, ralphsPath, classesPath] = process.argv.slice(2);
  if (!csvPath) { console.error('usage: node grocery/import-history.js <csv> [ralphs.json classifications.json]'); process.exit(1); }

  let receipts = receiptsFromCsv(parseCsv(fs.readFileSync(csvPath, 'utf8')));
  if (ralphsPath) {
    const rich = receiptsFromRalphsJson(JSON.parse(fs.readFileSync(ralphsPath, 'utf8')), JSON.parse(fs.readFileSync(classesPath, 'utf8')));
    const richKeys = new Set(rich.map((r) => `Ralphs|${r.date}`));
    receipts = receipts.filter((r) => !richKeys.has(`${r.store}|${r.date}`)).concat(rich);
  }

  const existing = await db.listReceipts();
  const have = new Set(existing.map((r) => `${r.store}|${r.date}`));
  let added = 0, skipped = 0, rows = 0;
  for (const r of receipts.sort((a, b) => a.date.localeCompare(b.date))) {
    if (have.has(`${r.store}|${r.date}`)) { skipped++; continue; }
    await db.saveReceipt(r, 'import');
    added++; rows += r.items.length;
  }
  console.log(`Imported ${added} receipts (${rows} line items); skipped ${skipped} already present.`);
  await db.getPool().end();
}

main().catch((err) => { console.error(err); process.exit(1); });
