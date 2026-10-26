// Size review: Claude reads every packaged receipt line and records its package size (pack count,
// amount per item, unit), so prices can be compared per 100 g, per 100 ml or per counted unit.
// Sizes printed on the receipt are recorded as such; otherwise Claude estimates the most likely
// size from the product, the price paid and the shopper's other purchases, with a confidence.
// Low-confidence estimates still count but are flagged for the user to check.
//
// Runs in the background (it can take several minutes for a full history) and only touches
// lines it hasn't reviewed; sizes the user entered or confirmed are never changed.
const db = require('./db');
const { structured, logError, chunks } = require('./match');
const { SIZE_UNITS, UNITS } = require('./units');

const ENTRIES_PER_REQUEST = 60;
const PARALLEL = 3;

const SIZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sizes'],
  properties: {
    sizes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entry', 'measure', 'pack_count', 'amount', 'unit', 'count_unit', 'source', 'confidence', 'note'],
        properties: {
          entry: { type: 'integer' },
          measure: { type: 'string', enum: ['weight', 'volume', 'count', 'unknown'] },
          pack_count: { type: 'number', description: 'Items in one package as bought: 6 for a 6-pack, 12 for 12 rolls, 1 for a single jar' },
          amount: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Net quantity of ONE item in the package; null for count' },
          unit: { anyOf: [{ type: 'string', enum: SIZE_UNITS }, { type: 'null' }] },
          count_unit: { type: 'string', description: 'Singular noun for what is counted: roll, egg, can, bag, each' },
          source: { type: 'string', enum: ['receipt', 'estimate', 'none'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string', description: 'A few words, e.g. "printed 15.5OZ" or "$24.99 fits 750 ml, not 1.75 L"' }
        }
      }
    }
  }
};

const SIZE_PROMPT = `You work out the package size of grocery purchases so a shopper can compare prices per 100 g, per 100 ml, or per counted unit. Each entry is one distinct receipt line: the product text as printed, a cleaned-up name, brand, store, and the price paid for one item (not the line total). Entries are grouped by product type, with sizes already known for that type (set by the shopper, or printed on other receipts).

For each entry decide:
- measure: "weight" when the package states a net weight (most food, coffee, pet food, powder detergent); "volume" for liquids sold by volume (drinks, alcohol, milk, juice, oil, vinegar, ice cream, liquid soap and detergent, shampoo); "count" only for things sold by count with no net weight or volume (toilet paper and paper towels per roll, eggs, produce sold each, trash bags, batteries, sponges); "unknown" only when you cannot reasonably tell what was bought (e.g. "MISC GROCERY").
- pack_count: how many items one package holds as bought (a 6-pack of cans is 6, a dozen eggs is 12, a 12-roll pack is 12, a single jar is 1). This is not how many packages were bought.
- amount and unit: the net quantity of ONE item in the package (a 6-pack of 12 fl oz cans is pack_count 6, amount 12, unit "fl oz"). Null for count. Units: g, kg, oz (weight ounces), lb, ml, l, fl oz, gal, qt, pt. On US receipts "OZ" on a drink or other liquid means fluid ounces: use "fl oz".
- count_unit: the counted thing, singular (roll, egg, can, bottle, bag, each). For weight and volume, the item in a multi-pack (can, bottle, bar) or "".
- source: "receipt" when the size is printed in the product text or name; otherwise "estimate" (or "none" with measure "unknown").
- confidence: "high" when printed, or when the product is essentially sold in one size (Kirkland bourbon comes in 1.75 L); "medium" when it is the most common size and the price fits; "low" when several sizes are plausible and you are guessing.
- note: a few words saying why.

Estimating: use general knowledge of US package sizes at Ralphs, Costco, Trader Joe's and similar stores (Costco sells bulk and multi-packs), and the price. The same product at very different prices was usually a different size: a bourbon at $25 where the shopper usually pays $45 for 1.75 L was probably a 750 ml bottle. Use the known sizes for the product type when they fit; ones the shopper set are the most reliable. Keep a product type in one measure where you reasonably can. Return exactly one size for every entry.`;

let job = null; // { status, total, done, started_at, finished_at, error }

const status = () => job;

// One entry per distinct line (same product text, store and price), so repeat purchases are sized once.
function groupLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = [l.item_basic, l.raw_name, l.name, l.brand, l.store, l.unit_price.toFixed(2)].join('|');
    let e = map.get(key);
    if (!e) map.set(key, (e = { ...l, entry: map.size + 1, ids: [], dates: [] }));
    e.ids.push(l.id);
    e.dates.push(l.date);
  }
  return [...map.values()];
}

// Entries batched so a product type's entries stay together where possible.
function batchEntries(entries) {
  const byType = new Map();
  for (const e of entries) (byType.get(e.item_basic) ?? byType.set(e.item_basic, []).get(e.item_basic)).push(e);
  const batches = [];
  let cur = [];
  for (const group of byType.values()) {
    for (const part of chunks(group, ENTRIES_PER_REQUEST)) {
      if (cur.length + part.length > ENTRIES_PER_REQUEST && cur.length) { batches.push(cur); cur = []; }
      cur.push(...part);
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const known = (k) => {
  const size = k.size_amount ? `${k.pack_count > 1 ? `${k.pack_count} x ` : ''}${k.size_amount} ${k.size_unit}` : `${k.pack_count} ${k.count_unit || 'ct'}`;
  return `  - "${k.raw_name || k.name}" at ${k.store}, $${k.unit_price.toFixed(2)}: ${size} (${k.size_source === 'you' ? 'set by shopper' : 'printed'})`;
};

function batchText(batch, knownSizes) {
  const types = [...new Set(batch.map((e) => e.item_basic))];
  return types.map((t) => {
    const entries = batch.filter((e) => e.item_basic === t);
    const mine = knownSizes.filter((k) => k.item_basic === t);
    const when = (e) => (e.dates.length > 1 ? `bought ${e.dates.length}×, ${e.dates[0]} to ${e.dates.at(-1)}` : `bought ${e.dates[0]}`);
    return [
      `Product type: ${t} (${entries[0].department})`,
      ...(mine.length ? ['Known sizes:', ...mine.slice(0, 15).map(known)] : []),
      'Entries:',
      ...entries.map((e) => `  ${e.entry}: "${e.raw_name || e.name}" → ${e.name}${e.brand ? ` [${e.brand}]` : ''} at ${e.store}, $${e.unit_price.toFixed(2)} each, ${when(e)}`)
    ].join('\n');
  }).join('\n\n');
}

// Claude's answer for one entry → the stored size, made consistent (unit matches measure, etc.).
function toSize(r) {
  const amount = typeof r.amount === 'number' && r.amount > 0 ? r.amount : null;
  const unit = r.unit && UNITS[r.unit] ? r.unit : null;
  const pack = r.pack_count > 0 ? Math.min(r.pack_count, 10000) : 1;
  const base = { size_confidence: r.source === 'receipt' ? 'high' : r.confidence, size_note: String(r.note || '').slice(0, 200) };
  if (r.measure === 'unknown' || r.source === 'none') return { ...base, size_source: 'none', size_confidence: '' };
  if (r.measure !== 'count' && amount && unit) {
    return { ...base, size_source: r.source, pack_count: pack, size_amount: amount, size_unit: unit, count_unit: String(r.count_unit || '').slice(0, 30) };
  }
  if (r.measure === 'count' || !amount) {
    return { ...base, size_source: r.source, pack_count: pack, size_amount: null, size_unit: '', count_unit: String(r.count_unit || 'each').slice(0, 30) };
  }
  return { ...base, size_source: 'none', size_confidence: '' };
}

async function reviewBatch(batch) {
  const knownSizes = await db.knownSizes([...new Set(batch.map((e) => e.item_basic))]);
  const { sizes } = await structured(SIZE_PROMPT, batchText(batch, knownSizes), SIZE_SCHEMA);
  const byEntry = new Map(batch.map((e) => [e.entry, e]));
  for (const r of sizes) {
    const e = byEntry.get(r.entry);
    if (!e) continue;
    byEntry.delete(r.entry);
    await db.setItemSizes(e.ids, toSize(r));
  }
  return byEntry.size; // entries Claude skipped stay unreviewed for the next run
}

async function run() {
  try {
    const entries = groupLines(await db.linesToReview());
    const batches = batchEntries(entries);
    job.total = entries.length;
    let next = 0;
    let failed = 0;
    let skipped = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        try { skipped += await reviewBatch(batch); } catch (err) { logError('size review', err); failed += batch.length; }
        job.done += batch.length;
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    const left = failed + skipped;
    Object.assign(job, { status: 'done', finished_at: new Date().toISOString(), error: left ? `${left} item${left !== 1 ? 's' : ''} could not be reviewed; run the review again to retry them.` : null });
  } catch (err) {
    logError('size review', err);
    Object.assign(job, { status: 'error', finished_at: new Date().toISOString(), error: err.message });
  }
  await db.setSetting('size_review_last', job).catch(() => {});
  if (job.rerun) startReview().catch((err) => logError('size review', err)); // lines saved while this ran
}

// Starts a review of every unreviewed line (all: forget earlier estimates first, keeping the
// user's own sizes). Returns the job; a review already running is left to finish.
async function startReview({ all = false } = {}) {
  if (job?.status === 'running') return job;
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY is not configured.'), { status: 503 });
  job = { status: 'running', total: 0, done: 0, started_at: new Date().toISOString(), finished_at: null, error: null, all };
  if (all) await db.resetItemSizes();
  run();
  return job;
}

// After a receipt is saved: size its new lines in the background.
function reviewNewLines() {
  if (!process.env.ANTHROPIC_API_KEY) return;
  if (job?.status === 'running') { job.rerun = true; return; }
  startReview().catch((err) => logError('size review', err));
}

async function lastReview() {
  return job || (await db.getSetting('size_review_last'));
}

module.exports = { startReview, reviewNewLines, status, lastReview, groupLines, batchEntries, batchText, toSize, SIZE_PROMPT, SIZE_SCHEMA };
