// Claude does three judgment calls for the Deals tab, all best-effort:
//  - classifyProducts: which store search results really are a watch item (so "chicken breast"
//    doesn't count breaded nuggets). The user can override any verdict; user verdicts are never replaced.
//  - extractCoupons: turns the text of the store's digital coupon page into structured coupons.
//  - classifyCouponProducts: which matched products a coupon actually covers (brand, size, variety).
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.GROCERY_MODEL || 'claude-opus-5-5';
const BATCH = 25; // watch items (or coupons) per request
const COUPON_CHUNK = 12000; // characters of coupon page text per request

let client = null;
const getClient = () => (client ||= new Anthropic());

async function structured(system, text, schema) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: text }]
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
    throw new Error(`Claude stopped early (${message.stop_reason})`);
  }
  return JSON.parse(message.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

const logError = (what, err) =>
  console.error(`grocery ${what}:`, err instanceof Anthropic.APIError ? `Anthropic API error ${err.status} ${err.message}` : err.message);

const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const noKey = () => !process.env.ANTHROPIC_API_KEY;

// ── Product matching ──────────────────────────────────────────────────────────

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['watch_id', 'product_id', 'match', 'reason'],
        properties: {
          watch_id: { type: 'integer' },
          product_id: { type: 'string' },
          match: { type: 'boolean' },
          reason: { type: 'string', description: 'A few words, e.g. "breaded, not raw breast"' }
        }
      }
    }
  }
};

const MATCH_PROMPT = `You match grocery store search results to a shopper's watchlist. For each candidate product, decide whether buying it would satisfy the watch item, so its price can be compared with what the shopper usually pays.

Rules:
- Match the kind of product, not the brand, unless the watch item's name or notes name a brand (then only that brand matches).
- Different forms are different products: raw vs breaded/cooked/seasoned, fresh vs frozen vs canned, whole vs sliced/shredded, ground vs whole cuts, and different flavors when the item names one.
- Organic, store-brand and different package sizes of the same product still match.
- Reject kits, meals, snacks or drinks that merely contain the item, and pet, baby or novelty versions.
- When genuinely unsure, reject: a missed deal costs less than a false alert.
Return one verdict for every candidate.`;

function describe(watch) {
  const notes = watch.notes ? ` (notes: ${watch.notes})` : '';
  return `Watch item ${watch.id}: "${watch.name}"${notes}`;
}

const productLine = (p) => `  - product_id ${p.product_id}: ${p.description}${p.brand ? ` [brand: ${p.brand}]` : ''}${p.size ? ` (${p.size})` : ''}`;

async function classifyBatch(entries) {
  const text = entries.map(({ watch, products }) => [describe(watch), ...products.map(productLine)].join('\n')).join('\n\n');
  return (await structured(MATCH_PROMPT, text, VERDICT_SCHEMA)).verdicts;
}

// entries: [{ watch, products }] where products have no verdict yet.
// Returns [{ watch_id, product_id, verdict: 'match'|'reject', source: 'claude', reason }].
// Matching is best-effort: on failure the products stay unreviewed and the error is reported.
async function classifyProducts(entries) {
  const pending = entries.filter((e) => e.products.length);
  if (!pending.length) return { verdicts: [], error: null };
  if (noKey()) return { verdicts: [], error: 'ANTHROPIC_API_KEY is not configured, so products were not matched.' };

  const wanted = new Set(pending.flatMap((e) => e.products.map((p) => `${e.watch.id}|${p.product_id}`)));
  const results = await Promise.allSettled(chunks(pending, BATCH).map(classifyBatch));

  const verdicts = [];
  let error = null;
  for (const r of results) {
    if (r.status === 'rejected') {
      logError('match', r.reason);
      error = 'Some products could not be matched automatically; they are marked for review.';
      continue;
    }
    for (const v of r.value) {
      const key = `${v.watch_id}|${v.product_id}`;
      if (!wanted.delete(key)) continue; // ignore anything we didn't ask about, and duplicates
      verdicts.push({ watch_id: v.watch_id, product_id: v.product_id, verdict: v.match ? 'match' : 'reject', source: 'claude', reason: v.reason.slice(0, 200) });
    }
  }
  return { verdicts, error };
}

// ── Coupons from the coupon page ──────────────────────────────────────────────

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

const COUPON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coupons'],
  properties: {
    coupons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['offer', 'brand', 'product', 'kind', 'amount', 'min_qty', 'expires', 'in_store', 'watch_ids'],
        properties: {
          offer: { type: 'string', description: 'The coupon headline, as written, e.g. "SAVE $1.00 on 2 General Mills Cereals"' },
          brand: { type: 'string', description: 'Brand the coupon is limited to, or "" if any brand' },
          product: { type: 'string', description: 'What it is for, e.g. "cereal", "ground turkey"' },
          kind: { type: 'string', enum: ['price', 'off', 'percent', 'other'] },
          amount: nullable('number'),
          min_qty: { type: 'integer' },
          expires: nullable('string'),
          in_store: { type: 'boolean' },
          watch_ids: { type: 'array', items: { type: 'integer' } }
        }
      }
    }
  }
};

const COUPON_PROMPT = `You read text copied from a grocery store's digital coupon page and list each coupon in it.

For every coupon:
- kind "price": the coupon sets the price ("$3.99 Jennie-O Ground Turkey", "99¢ Barilla Pasta"); amount is that price.
- kind "off": a dollar amount off ("Save $2.00 on NIVEA"); amount is the dollars off and min_qty how many items must be bought ("on 2" means min_qty 2).
- kind "percent": a percentage off; amount is the percent (25 for 25%).
- kind "other": points, gift card, fuel, or "save $X when you spend $Y" offers; amount null.
- min_qty is 1 unless the coupon requires buying several.
- expires: YYYY-MM-DD from "Exp. Nov. 03" style dates, using the year that puts it on or after today; null if not shown.
- in_store: false when the coupon says pickup or delivery only.
- watch_ids: ids of the shopper's watchlist items this coupon could apply to (same kind of product; respect brands named in the item). Empty when none.
Skip filter labels, navigation and other page text that isn't a coupon. Don't invent coupons; prices in the page text may be missing the decimal point ("$399" means $3.99).`;

// Splits the page text at line breaks so no coupon is cut between two requests.
function splitText(text) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur.length + line.length > COUPON_CHUNK && cur) { parts.push(cur); cur = ''; }
    cur += `${line}\n`;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// Returns { coupons, error }. Coupons are de-duplicated by offer text and expiry.
async function extractCoupons(text, watchList, today) {
  if (noKey()) return { coupons: [], error: 'ANTHROPIC_API_KEY is not configured, so coupons could not be read.' };
  const ids = new Set(watchList.map((w) => w.id));
  const watchText = watchList.map((w) => `${w.id}: ${w.name}${w.notes ? ` (${w.notes})` : ''}`).join('\n');
  const results = await Promise.allSettled(splitText(text).map((part) =>
    structured(COUPON_PROMPT, `Today is ${today}.\n\nWatchlist:\n${watchText}\n\nCoupon page text:\n${part}`, COUPON_SCHEMA)));

  const byKey = new Map();
  let error = null;
  for (const r of results) {
    if (r.status === 'rejected') { logError('coupons', r.reason); error = 'Part of the page could not be read; try importing again.'; continue; }
    for (const c of r.value.coupons) {
      const expires = /^\d{4}-\d{2}-\d{2}$/.test(c.expires || '') ? c.expires : null;
      const coupon = {
        offer: c.offer.slice(0, 300), brand: c.brand.slice(0, 100), product: c.product.slice(0, 100), kind: c.kind,
        amount: typeof c.amount === 'number' && c.amount > 0 ? c.amount : null,
        min_qty: Math.min(Math.max(c.min_qty || 1, 1), 20), expires, in_store: c.in_store,
        watch_ids: [...new Set(c.watch_ids.filter((id) => ids.has(id)))]
      };
      if (coupon.kind !== 'other' && coupon.amount === null) coupon.kind = 'other';
      coupon.coupon_key = `${coupon.offer.toLowerCase().replace(/\s+/g, ' ').trim()}|${expires || ''}`;
      byKey.set(coupon.coupon_key, coupon);
    }
  }
  return { coupons: [...byKey.values()], error };
}

// ── Which products a coupon covers ────────────────────────────────────────────

const APPLIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['coupon_id', 'product_id', 'applies', 'reason'],
        properties: {
          coupon_id: { type: 'integer' },
          product_id: { type: 'string' },
          applies: { type: 'boolean' },
          reason: { type: 'string', description: 'A few words' }
        }
      }
    }
  }
};

const APPLIES_PROMPT = `You decide which store products a digital coupon can be used on. For each coupon and candidate product, answer whether the coupon covers that exact product.
- A coupon naming a brand only covers that brand (the store brand is "Kroger" unless the coupon says otherwise; Simple Truth and Private Selection are Kroger brands but count as their own names).
- Respect any size, variety or product type the coupon names.
- When unsure, say it does not apply: an overstated deal is worse than a missed one.
Return one decision per pair.`;

// entries: [{ coupon, products }] for pairs without a decision yet. Returns { decisions, error }.
async function classifyCouponProducts(entries) {
  const pending = entries.filter((e) => e.products.length);
  if (!pending.length) return { decisions: [], error: null };
  if (noKey()) return { decisions: [], error: 'ANTHROPIC_API_KEY is not configured, so coupons were not applied.' };

  const wanted = new Set(pending.flatMap((e) => e.products.map((p) => `${e.coupon.id}|${p.product_id}`)));
  const results = await Promise.allSettled(chunks(pending, BATCH).map((batch) => structured(APPLIES_PROMPT,
    batch.map(({ coupon, products }) => [`Coupon ${coupon.id}: "${coupon.offer}"`, ...products.map(productLine)].join('\n')).join('\n\n'),
    APPLIES_SCHEMA)));

  const decisions = [];
  let error = null;
  for (const r of results) {
    if (r.status === 'rejected') { logError('coupon match', r.reason); error = 'Some coupons could not be checked against products.'; continue; }
    for (const d of r.value.decisions) {
      if (!wanted.delete(`${d.coupon_id}|${d.product_id}`)) continue;
      decisions.push({ coupon_id: d.coupon_id, product_id: d.product_id, applies: d.applies, reason: d.reason.slice(0, 200) });
    }
  }
  return { decisions, error };
}

module.exports = { classifyProducts, extractCoupons, classifyCouponProducts };
