// Resolves healthcare rows (scripts/healthcare-rows.json) to coordinates via Mapbox Search Box POI search
// (or forward geocoding when an explicit address is supplied) and writes scripts/locations-healthcare.json.
// Prints a review report of low-confidence matches. Usage: node scripts/resolve-healthcare.js
const fs = require('fs');
const path = require('path');

try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {}
const TOKEN = process.env.MAPBOX_TOKEN;
if (!TOKEN) { console.error('MAPBOX_TOKEN missing'); process.exit(1); }

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'healthcare-rows.json'), 'utf8'));
const OVERRIDES = JSON.parse(fs.readFileSync(path.join(__dirname, 'healthcare-overrides.json'), 'utf8'));

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(the|of|at|and|a|in|hospital|center|centre|health|healthcare|care|senior|living|rehabilitation|rehab|nursing|community|medical|post|acute)\b/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set(norm(s).split(' ').filter(Boolean));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit / Math.min(A.size, B.size);
}
const cityNorm = (c) => String(c || '').toLowerCase().split(/[\/(,]/)[0].trim();

async function poi(q, cityHint) {
  const url = `https://api.mapbox.com/search/searchbox/v1/forward?q=${encodeURIComponent(q)}&types=poi&country=us&limit=5&proximity=-104.99,39.74&access_token=${TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const d = await r.json();
  return (d.features || []).map((f) => ({
    name: f.properties.name,
    address: f.properties.full_address,
    place: f.properties.context && f.properties.context.place && f.properties.context.place.name,
    region: f.properties.context && f.properties.context.region && f.properties.context.region.region_code,
    cats: f.properties.poi_category || [],
    lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1]
  }));
}
async function geocode(address) {
  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(address)}&country=us&limit=1&access_token=${TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const d = await r.json();
  const f = d.features && d.features[0];
  if (!f) return null;
  return { address: f.properties.full_address, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], acc: (f.properties.match_code && f.properties.match_code.confidence) || f.properties.feature_type };
}

(async () => {
  const out = [], review = [];
  for (const row of rows) {
    const key = row.name;
    const ov = OVERRIDES[key];
    let rec = { sector: 'healthcare', type: row.type, name: row.name, city: row.city, region: row.region, parent: row.parent, care: row.care, beds: row.beds || null, stat: row.stat || (row.beds ? `${row.beds} beds` : ''), detail: [row.care, row.notes].filter(Boolean).join(' — ') };
    if (ov && ov.skip) { review.push(`SKIP     ${row.name} (${ov.reason || 'override'})`); continue; }
    if (ov && ov.lng != null) { out.push({ ...rec, address: ov.address || row.address || '', lng: ov.lng, lat: ov.lat, source: 'override' }); continue; }
    const address = (ov && ov.address) || row.address;
    if (address) {
      const g = await geocode(address);
      if (!g) { review.push(`NOGEO    ${row.name} :: ${address}`); continue; }
      out.push({ ...rec, address: g.address, lng: g.lng, lat: g.lat, source: 'geocode:' + g.acc });
      if (!['exact', 'high'].includes(g.acc)) review.push(`GEO-${g.acc} ${row.name} :: ${g.address}`);
      continue;
    }
    const q = `${row.name}, ${cityNorm(row.city)}, CO`;
    let hits;
    try { hits = await poi(q); } catch (e) { review.push(`ERR      ${row.name} :: ${e.message}`); continue; }
    hits = hits.filter((h) => h.region === 'CO');
    const scored = hits.map((h) => ({ ...h, sim: similarity(row.name, h.name), cityOk: cityNorm(h.place) === cityNorm(row.city) }));
    scored.sort((a, b) => (b.cityOk - a.cityOk) || (b.sim - a.sim));
    const best = scored[0];
    if (!best) { review.push(`NOMATCH  ${row.name} (${row.city})`); continue; }
    const conf = best.sim >= 0.66 && best.cityOk ? 'good' : best.sim >= 0.66 ? 'city?' : best.cityOk ? 'name?' : 'weak';
    if (conf !== 'good') review.push(`${conf.padEnd(8)} ${row.name} (${row.city}) => ${best.name} | ${best.address} | sim ${best.sim.toFixed(2)}`);
    if (conf === 'weak' || conf === 'name?') continue; // require a real name match
    out.push({ ...rec, address: best.address, matchedName: best.name, lng: best.lng, lat: best.lat, source: 'poi:' + conf });
  }
  fs.writeFileSync(path.join(__dirname, 'locations-healthcare.json'), JSON.stringify(out, null, 1));
  console.log(`Resolved ${out.length}/${rows.length}. Review:\n` + review.join('\n'));
})();
