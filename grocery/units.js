// Standard measures for comparing prices: grams for things sold by weight, millilitres for liquids,
// and a counted unit (roll, egg, each) for things sold by count. Prices are shown per 100 g,
// per 100 ml, or per counted unit. Used by the server (baselines, deals) and the API.

// Grams or millilitres per unit of size.
const UNITS = {
  g: { measure: 'g', factor: 1 }, kg: { measure: 'g', factor: 1000 }, oz: { measure: 'g', factor: 28.3495 }, lb: { measure: 'g', factor: 453.592 },
  ml: { measure: 'ml', factor: 1 }, l: { measure: 'ml', factor: 1000 }, 'fl oz': { measure: 'ml', factor: 29.5735 },
  gal: { measure: 'ml', factor: 3785.41 }, qt: { measure: 'ml', factor: 946.353 }, pt: { measure: 'ml', factor: 473.176 }
};
const SIZE_UNITS = Object.keys(UNITS);
const MEASURES = ['g', 'ml', 'count'];

// Grams per unit of a weighed receipt line (quantity is the weight bought).
const WEIGHED = { lb: 453.592, oz: 28.3495, kg: 1000 };

const UNIT_ALIASES = [
  [/^fl\.?\s*oz|^fluid ounces?/, 'fl oz'], [/^(oz|ounces?)$/, 'oz'], [/^(lbs?|pounds?)$/, 'lb'], [/^(kg|kilograms?)$/, 'kg'],
  [/^(g|grams?)$/, 'g'], [/^(l|lt|ltr|liters?|litres?)$/, 'l'], [/^(ml|milliliters?)$/, 'ml'], [/^(gal|gallons?)$/, 'gal'],
  [/^(qt|quarts?)$/, 'qt'], [/^(pt|pints?)$/, 'pt']
];
const AMOUNT = /(\d+(?:\.\d+)?|\d+\/\d+)\s*(fl\.?\s*oz|fluid ounces?|ounces?|oz|lbs?|pounds?|kilograms?|kg|grams?|g|liters?|litres?|ltr|lt|l|milliliters?|ml|gallons?|gal|quarts?|qt|pints?|pt)\b/;
const GENERIC_COUNT = new Set(['ct', 'count', 'pk', 'pack', 'x', 'pc', 'piece']);
const COUNT = /(\d+)\s*-?\s*(ct|count|pk|pack|packs|cans?|bottles?|(?:mega |double |family |huge |giant |regular |jumbo |triple )?rolls?|eggs?|bags?|pods?|k-cups?|bars?|pieces?|pcs|sheets?|x)\b/;

// Size text → { pack_count, amount, unit, count_unit }, or {} when nothing is readable. Reads store
// sizes ("12 ct / 12 fl oz", "2 L", "1.5 lb", "12 mega rolls") and receipt text ("10pk 7.5oz",
// "6-7.5 fl oz"). An amount with a count is the size of each item in the pack. A bare "oz" is
// returned as "oz" (weight); toStandard can read it as fluid ounces for liquids.
function parseSize(text) {
  const s = String(text || '').toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  const num = (v) => (v.includes('/') ? Number(v.split('/')[0]) / Number(v.split('/')[1]) : Number(v));
  const out = {};
  const dashed = s.match(/\b(\d{1,2})\s*-\s*(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz)\b/); // "6-7.5 fl oz" = 6 × 7.5 oz
  if (dashed) {
    out.pack_count = Number(dashed[1]);
    out.amount = Number(dashed[2]);
    out.unit = dashed[3].startsWith('fl') ? 'fl oz' : 'oz';
    return out;
  }
  const m = s.match(AMOUNT);
  if (m && num(m[1]) > 0) { out.amount = num(m[1]); out.unit = UNIT_ALIASES.find(([re]) => re.test(m[2]))[1]; }
  const c = s.match(COUNT);
  if (c && Number(c[1]) > 0) {
    out.pack_count = Number(c[1]);
    const noun = c[2].replace(/^(mega|double|family|huge|giant|regular|jumbo|triple) /, '').replace(/s$/, '');
    if (!GENERIC_COUNT.has(noun)) out.count_unit = noun;
  }
  return out;
}

// A package size → { measure, qty } in grams, millilitres or counted units, or null.
// prefer: the measure the product is compared in; a bare "oz" counts as fluid ounces for liquids.
function toStandard({ pack_count, amount, unit }, prefer = null) {
  const pack = Number(pack_count) > 0 ? Number(pack_count) : 1;
  if (amount > 0 && unit) {
    const u = prefer === 'ml' && unit === 'oz' ? 'fl oz' : unit;
    const def = UNITS[u];
    return def ? { measure: def.measure, qty: amount * def.factor * pack } : null;
  }
  return Number(pack_count) > 0 ? { measure: 'count', qty: pack } : null;
}

const trim = (v) => +Number(v).toFixed(2);
const plural = (n, noun) => (n === 1 ? noun : /(s|sh|ch|x)$/.test(noun) ? `${noun}es` : `${noun}s`);

// "6 × 12 fl oz", "1.75 l", "12 rolls".
function sizeLabel({ pack_count, amount, unit, count_unit }) {
  const pack = Number(pack_count) > 0 ? Number(pack_count) : 1;
  if (amount > 0 && unit) return `${pack > 1 ? `${trim(pack)} × ` : ''}${trim(amount)} ${unit === 'l' ? 'L' : unit}`;
  if (Number(pack_count) > 0) return `${trim(pack)} ${plural(pack, count_unit || 'item')}`;
  return '';
}

// Everything the dashboard needs about one receipt line's size and standard price:
//   measure / qty (per package) / per (price per gram, ml or counted unit) / source / status.
// status: ok | review (AI guess with low confidence) | missing (no size, or not reviewed yet).
function lineStandard(i) {
  const grams = WEIGHED[i.unit];
  if (grams) {
    return {
      measure: 'g', qty: null, per: i.unit_price / grams, label: `weighed (${trim(i.quantity)} ${i.unit})`,
      count_unit: '', source: 'weighed', confidence: 'high', note: '', status: 'ok'
    };
  }
  const size = { pack_count: num(i.pack_count), amount: num(i.size_amount), unit: i.size_unit || null, count_unit: i.count_unit || '' };
  const std = i.size_source && i.size_source !== 'none' ? toStandard(size) : null;
  const status = !std ? 'missing' : i.size_source === 'estimate' && i.size_confidence === 'low' ? 'review' : 'ok';
  return {
    measure: std?.measure || null, qty: std ? std.qty : null, per: std ? i.unit_price / std.qty : null,
    label: std ? sizeLabel(size) : '', count_unit: std?.measure === 'count' ? size.count_unit || 'item' : '',
    source: i.size_source || (i.size_reviewed_at ? 'none' : 'pending'), confidence: i.size_confidence || '',
    note: i.size_note || '', status
  };
}

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// The measure most of a product's priced purchases use: the one it is compared in.
function dominantMeasure(stds) {
  const counts = {};
  for (const s of stds) if (s.per != null) counts[s.measure] = (counts[s.measure] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// The most common counted unit among count-measured purchases ("roll", "egg").
function dominantCountUnit(stds) {
  const counts = {};
  for (const s of stds) if (s.measure === 'count' && s.count_unit) counts[s.count_unit] = (counts[s.count_unit] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'item';
}

// Price per gram/ml/unit → the number shown: per 100 g, per 100 ml, or per counted unit.
const displayPrice = (per, measure) => (per == null ? null : measure === 'count' ? per : per * 100);

module.exports = { UNITS, SIZE_UNITS, MEASURES, WEIGHED, parseSize, toStandard, sizeLabel, lineStandard, dominantMeasure, dominantCountUnit, displayPrice };
