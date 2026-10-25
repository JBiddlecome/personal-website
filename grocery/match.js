// Decides which store search results really are the watch item (so "chicken breast" doesn't
// count breaded nuggets). Only products without a verdict are sent; the user can override any
// verdict on the Deals tab, and user verdicts are never replaced.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.GROCERY_MODEL || 'claude-opus-5-5';
const BATCH = 25; // watch items per request

let client = null;
const getClient = () => (client ||= new Anthropic());

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

const SYSTEM_PROMPT = `You match grocery store search results to a shopper's watchlist. For each candidate product, decide whether buying it would satisfy the watch item, so its price can be compared with what the shopper usually pays.

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

async function classifyBatch(entries) {
  const text = entries.map(({ watch, products }) => [
    describe(watch),
    ...products.map((p) => `  - product_id ${p.product_id}: ${p.description}${p.brand ? ` [brand: ${p.brand}]` : ''}${p.size ? ` (${p.size})` : ''}`)
  ].join('\n')).join('\n\n');

  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: text }]
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
    throw new Error(`product matching stopped early (${message.stop_reason})`);
  }
  const body = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(body).verdicts;
}

// entries: [{ watch, products }] where products have no verdict yet.
// Returns [{ watch_id, product_id, verdict: 'match'|'reject', source: 'claude', reason }].
// Matching is best-effort: on failure the products stay unreviewed and the error is reported.
async function classifyProducts(entries) {
  const pending = entries.filter((e) => e.products.length);
  if (!pending.length) return { verdicts: [], error: null };
  if (!process.env.ANTHROPIC_API_KEY) return { verdicts: [], error: 'ANTHROPIC_API_KEY is not configured, so products were not matched.' };

  const wanted = new Set(pending.flatMap((e) => e.products.map((p) => `${e.watch.id}|${p.product_id}`)));
  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));
  const results = await Promise.allSettled(batches.map(classifyBatch));

  const verdicts = [];
  let error = null;
  for (const r of results) {
    if (r.status === 'rejected') {
      const err = r.reason;
      console.error('grocery match:', err instanceof Anthropic.APIError ? `Anthropic API error ${err.status} ${err.message}` : err.message);
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

module.exports = { classifyProducts };
