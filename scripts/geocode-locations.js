// Build script: geocodes the Denver education + government account universes with Mapbox
// and writes assets/maps/locations.json (consumed by /maps).
// Usage: node scripts/geocode-locations.js   (requires MAPBOX_TOKEN in .env)
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

const LOCATIONS = [
  ...require('./locations-education'),
  ...require('./locations-government')
];

async function geocode(address) {
  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(address)}&country=us&limit=1&access_token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  const f = data.features && data.features[0];
  if (!f) return null;
  return {
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    matched: f.properties.full_address,
    accuracy: (f.properties.match_code && f.properties.match_code.confidence) || f.properties.feature_type
  };
}

(async () => {
  const out = [];
  for (const loc of LOCATIONS) {
    if (loc.lng != null && loc.lat != null) {
      console.log(`${loc.name.padEnd(48)} override ${loc.lng},${loc.lat}`);
      out.push({ id: out.length + 1, ...loc });
      continue;
    }
    const g = await geocode(loc.address);
    if (!g) { console.error('NO MATCH:', loc.name, loc.address); continue; }
    console.log(`${loc.name.padEnd(48)} ${String(g.accuracy).padEnd(8)} ${g.matched}`);
    out.push({ id: out.length + 1, ...loc, lng: g.lng, lat: g.lat });
  }
  const dest = path.join(__dirname, '..', 'assets', 'maps', 'locations.json');
  fs.writeFileSync(dest, JSON.stringify({ generated: new Date().toISOString(), locations: out }, null, 2));
  console.log(`Wrote ${out.length} locations to ${dest}`);
})();
