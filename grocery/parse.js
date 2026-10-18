// Reads a grocery receipt (photos and/or PDF) with Claude and returns a draft
// receipt for the user to review before it is saved.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.GROCERY_MODEL || 'claude-opus-5-5';

const DEPARTMENTS = [
  'Alcohol', 'Baby', 'Bakery', 'Baking', 'Beverages', 'Breakfast', 'Candy', 'Coffee & Tea', 'Dairy', 'Deli',
  'Floral', 'Frozen', 'Household', 'Kitchen', 'Meat', 'Other', 'Pantry', 'Paper Goods', 'Party & Stationery',
  'Personal Care', 'Pet Care', 'Produce', 'Refrigerated', 'Seafood', 'Snacks'
];

const money = { type: 'number' };
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_receipt', 'store', 'store_address', 'date', 'subtotal', 'savings', 'tax', 'fees', 'total', 'items', 'warnings'],
  properties: {
    is_receipt: { type: 'boolean' },
    store: { type: 'string' },
    store_address: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
    subtotal: money,
    savings: money,
    tax: money,
    fees: money,
    total: money,
    warnings: { type: 'array', items: { type: 'string' } },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['raw_name', 'name', 'brand', 'item_basic', 'department', 'quantity', 'unit', 'unit_price', 'line_total', 'savings'],
        properties: {
          raw_name: { type: 'string' },
          name: { type: 'string' },
          brand: { type: 'string' },
          item_basic: { type: 'string' },
          department: { type: 'string', enum: DEPARTMENTS },
          quantity: { type: 'number' },
          unit: { type: 'string', enum: ['each', 'lb', 'oz', 'kg'] },
          unit_price: money,
          line_total: money,
          savings: money
        }
      }
    }
  }
};

const SYSTEM_PROMPT = `You extract every purchased line item from a grocery store receipt so a personal spending tracker can chart prices over time. The receipt may be a photo (possibly crumpled, angled, or split across several photos given in order) or a digital PDF invoice.

Return the receipt as JSON matching the schema:
- store: the chain name only (e.g. "Ralphs", "Trader Joe's", "Costco"). store_address: street address if printed, else "".
- date: purchase date as YYYY-MM-DD.
- subtotal, tax, total: as printed (0 if absent). savings: total discounts/coupons/sales on the receipt. fees: bottle deposits (CRV / "CA Redem Val"), bag fees and similar non-product charges, summed.
- items: one entry per purchased product line, in receipt order. Do not include fees, deposits, $0.00 lines, subtotals, payment lines, or loyalty-point lines as items.
  - raw_name: the product text exactly as printed (expand nothing).
  - name: a clean, readable product name including size when known (e.g. "Kroger Black Beans 15.5oz"). Expand obvious receipt abbreviations ("SMPL TRTH ORG EGGS" -> "Simple Truth Organic Eggs").
  - brand: the brand if identifiable, else "" (store brands: Kroger, Simple Truth, Private Selection, Kirkland, Great Value, etc.).
  - item_basic: a short generic product type used to compare prices across brands and trips (e.g. "Eggs", "Ground Turkey", "Bananas"). Reuse a name from the known list below whenever it fits the product; only invent a new one (Title Case, singular-or-plural like the list) when nothing fits.
  - department: one of the allowed values.
  - quantity and unit: count of units ("each"), or the weight for items sold by weight ("lb"/"oz"/"kg"). If the weight is not legible for a weighed item, use quantity 1, unit "each".
  - unit_price: price per unit actually paid (line_total / quantity).
  - line_total: the amount actually charged for the line after any discounts that apply to it.
  - savings: discount on this line (sale, coupon, loyalty-card savings), 0 if none. On paper receipts, discount lines usually print just below the item they apply to; attribute them to that item and do not list them as items.
  - Receipts show discounts in one of two ways, so decide which this one uses before filling line_total. Either the printed item price is the regular price and the discount line is subtracted from it, or the printed price is already the sale price and the discount line is only informational (common on Ralphs/Kroger digital invoices, where "Item Coupon/Sale" lines follow prices that are already net). Use the totals to tell: if the printed prices plus tax and fees already add up to the total, they are net, so use them as line_total unchanged and record the discount only in savings.
- warnings: short notes about anything you could not read or are unsure of (e.g. "Line 12 price partly obscured; read as $3.49"). Empty when everything is clear.
- If the image is not a receipt, set is_receipt false and return empty items.

Check your work: the sum of line_total plus fees plus tax should match total. If it does not, re-read the receipt and add a warning if a gap remains.`;

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function contentBlocks(files) {
  return files.map((f) => (f.media_type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
    : { type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } }));
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function parseReceipt(files, context) {
  if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error('ANTHROPIC_API_KEY is not configured.'), { status: 503 });
  for (const f of files) {
    if (f.media_type !== 'application/pdf' && !IMAGE_TYPES.has(f.media_type)) {
      throw Object.assign(new Error(`Unsupported file type: ${f.media_type}`), { status: 400 });
    }
  }

  const vocabText = context.vocab.map((v) => `${v.item_basic} | ${v.department}`).join('\n');
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
    system: [
      { type: 'text', text: SYSTEM_PROMPT },
      { type: 'text', text: `Known item_basic | department pairs from this shopper's history:\n${vocabText || '(none yet)'}`, cache_control: { type: 'ephemeral' } }
    ],
    messages: [{
      role: 'user',
      content: [...contentBlocks(files), { type: 'text', text: files.length > 1 ? 'These files are consecutive parts of one receipt.' : 'Extract this receipt.' }]
    }]
  });
  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    // Upstream failures (bad key, rate limit, outage) shouldn't surface as the caller's own 4xx.
    if (err instanceof Anthropic.RateLimitError) throw Object.assign(new Error('Receipt reader is busy. Try again in a minute.'), { status: 503 });
    if (err instanceof Anthropic.APIError) {
      console.error('grocery parse: Anthropic API error', err.status, err.message);
      throw Object.assign(new Error('Receipt reader is unavailable right now. Try again later.'), { status: 502 });
    }
    throw err;
  }

  if (message.stop_reason === 'refusal') {
    throw Object.assign(new Error('The receipt could not be processed. Try a clearer photo.'), { status: 422 });
  }
  if (message.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('Receipt was too long to read in one pass. Try splitting it into fewer photos per upload.'), { status: 422 });
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let draft;
  try { draft = JSON.parse(text); } catch (_) {
    throw Object.assign(new Error('Could not understand the receipt. Try again with a clearer photo.'), { status: 502 });
  }
  if (!draft.is_receipt) {
    throw Object.assign(new Error("That doesn't look like a receipt."), { status: 422 });
  }

  // Reuse the exact classification from earlier purchases of the same printed item,
  // so repeat buys always land in the same price history.
  const known = new Map(context.known.map((k) => [normalize(k.raw_name), k]));
  draft.items = draft.items.map((it) => {
    const prev = known.get(normalize(it.raw_name));
    const merged = prev ? { ...it, name: prev.name, brand: prev.brand, item_basic: prev.item_basic, department: prev.department, matched_history: true } : { ...it, matched_history: false };
    return {
      ...merged,
      quantity: Number(merged.quantity) > 0 ? Number(merged.quantity) : 1,
      unit_price: round2(merged.unit_price),
      line_total: round2(merged.line_total),
      savings: round2(merged.savings)
    };
  });

  const itemsTotal = round2(draft.items.reduce((s, i) => s + i.line_total, 0));
  const expected = round2(itemsTotal + Number(draft.fees || 0) + Number(draft.tax || 0));
  if (draft.total && Math.abs(expected - draft.total) > 0.02) {
    draft.warnings.push(`Items + fees + tax add up to $${expected.toFixed(2)} but the receipt total is $${Number(draft.total).toFixed(2)}. Check for a missed or misread line.`);
  }
  delete draft.is_receipt;
  draft.items_total = itemsTotal;
  draft.model = message.model;
  draft.usage = { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
  return draft;
}

module.exports = { parseReceipt, DEPARTMENTS };
