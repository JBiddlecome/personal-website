// One-off build script: geocodes the Denver education account universe with Mapbox
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

// type: college | community | district
const LOCATIONS = [
  // ── 4-Year Colleges ──
  { type: 'college', name: 'University of Colorado Boulder', city: 'Boulder', region: 'Metro (NW)', enrollment: 41432, detail: 'Public research', address: '2055 Regent Dr, Boulder, CO 80309' },
  { type: 'college', name: 'Colorado State University', city: 'Fort Collins', region: 'Extended (~65 mi N)', enrollment: 34096, detail: 'Public research', address: '711 Oval Dr, Fort Collins, CO 80523' },
  { type: 'college', name: 'University of Colorado Denver (Downtown)', city: 'Denver', region: 'Metro (core)', enrollment: 23409, detail: 'Public research — enrollment shared with Anschutz', address: '1201 Larimer St, Denver, CO 80204' },
  { type: 'college', name: 'University of Colorado Anschutz Medical Campus', city: 'Aurora', region: 'Metro (E)', enrollment: null, detail: 'Public research — CU Denver | Anschutz medical campus', address: '13001 E 17th Pl, Aurora, CO 80045' },
  { type: 'college', name: 'Metropolitan State University of Denver', city: 'Denver (Auraria)', region: 'Metro (core)', enrollment: 17593, detail: 'Public', address: '890 Auraria Pkwy, Denver, CO 80204' },
  { type: 'college', name: 'University of Denver', city: 'Denver', region: 'Metro (core)', enrollment: 13387, detail: 'Private', address: '2199 S University Blvd, Denver, CO 80208' },
  { type: 'college', name: 'Colorado State University Global', city: 'Aurora', region: 'Metro (E)', enrollment: 9507, detail: 'Public (online) — HQ office only', address: '585 Salida Way, Aurora, CO 80011' },
  { type: 'college', name: 'University of Northern Colorado', city: 'Greeley', region: 'Extended (~50 mi N)', enrollment: 8869, detail: 'Public', address: '501 20th St, Greeley, CO 80639' },
  { type: 'college', name: 'Colorado Christian University', city: 'Lakewood', region: 'Metro (W)', enrollment: 8254, detail: 'Private — enrollment includes online', address: '8787 W Alameda Ave, Lakewood, CO 80226' },
  { type: 'college', name: 'Colorado School of Mines', city: 'Golden', region: 'Metro (W)', enrollment: 8044, detail: 'Public', address: '1500 Illinois St, Golden, CO 80401' },
  { type: 'college', name: 'Regis University', city: 'Denver', region: 'Metro (N)', enrollment: 4631, detail: 'Private', address: '3333 Regis Blvd, Denver, CO 80221' },
  { type: 'college', name: 'Naropa University', city: 'Boulder', region: 'Metro (NW)', enrollment: 1117, detail: 'Private', address: '2130 Arapahoe Ave, Boulder, CO 80302' },
  { type: 'college', name: 'Denver College of Nursing', city: 'Denver', region: 'Metro (core)', enrollment: 1008, detail: 'Private', address: '1401 19th St, Denver, CO 80202' },
  { type: 'college', name: 'Rocky Vista University', city: 'Parker', region: 'Metro (SE)', enrollment: 1000, detail: 'Private (health sci.)', address: '8401 S Chambers Rd, Parker, CO 80134' },
  { type: 'college', name: 'Denver Seminary', city: 'Littleton', region: 'Metro (S)', enrollment: 837, detail: 'Private graduate', address: '6399 S Santa Fe Dr, Littleton, CO 80120' },
  { type: 'college', name: 'Rocky Mountain College of Art + Design', city: 'Lakewood', region: 'Metro (W)', enrollment: 600, detail: 'Private', address: '1600 Pierce St, Lakewood, CO 80214' },
  { type: 'college', name: 'Iliff School of Theology', city: 'Denver', region: 'Metro (core)', enrollment: 200, detail: 'Private graduate', address: '2323 E Iliff Ave, Denver, CO 80210' },
  // ── Community Colleges ──
  { type: 'community', name: 'Front Range Community College', city: 'Westminster', region: 'Metro (N)', enrollment: 21970, detail: 'CCCS — Westminster campus (also Boulder County, Larimer)', address: '3645 W 112th Ave, Westminster, CO 80031' },
  { type: 'community', name: 'Arapahoe Community College', city: 'Littleton', region: 'Metro (S)', enrollment: 15012, detail: 'CCCS — Littleton campus (also Parker, Castle Rock)', address: '5900 S Santa Fe Dr, Littleton, CO 80120' },
  { type: 'community', name: 'Pikes Peak State College', city: 'Colorado Springs', region: 'Extended (~70 mi S)', enrollment: 12556, detail: 'CCCS — Centennial campus', address: '5675 S Academy Blvd, Colorado Springs, CO 80906' },
  { type: 'community', name: 'Aims Community College', city: 'Greeley', region: 'Extended (~50 mi N)', enrollment: 11372, detail: 'Independent district — Greeley campus', address: '5401 W 20th St, Greeley, CO 80634' },
  { type: 'community', name: 'Community College of Aurora', city: 'Aurora', region: 'Metro (E)', enrollment: 8833, detail: 'CCCS — CentreTech campus', address: '16000 E CentreTech Pkwy, Aurora, CO 80011' },
  { type: 'community', name: 'Red Rocks Community College', city: 'Lakewood', region: 'Metro (W)', enrollment: 8419, detail: 'CCCS — Lakewood campus (also Arvada)', address: '13300 W 6th Ave, Lakewood, CO 80228' },
  { type: 'community', name: 'Community College of Denver', city: 'Denver (Auraria)', region: 'Metro (core)', enrollment: 7965, detail: 'CCCS — Auraria campus', address: '1111 W Colfax Ave, Denver, CO 80204' },
  { type: 'community', name: 'Emily Griffith Technical College', city: 'Denver', region: 'Metro (core)', enrollment: 5914, detail: 'Denver Public Schools', address: '1860 Lincoln St, Denver, CO 80203' },
  { type: 'community', name: 'Pickens Technical College', city: 'Aurora', region: 'Metro (E)', enrollment: null, detail: 'Aurora Public Schools', address: '500 Airport Blvd, Aurora, CO 80011' },
  // ── School Districts (HQ / admin building) ──
  { type: 'district', name: 'Denver Public Schools (Denver County 1)', city: 'Denver', region: 'Denver County', enrollment: 90452, schools: 191, detail: 'Emily Griffith Campus (district HQ)', address: '1860 Lincoln St, Denver, CO 80203' },
  { type: 'district', name: 'Jefferson County Public Schools (Jeffco R-1)', city: 'Golden', region: 'Jefferson County', enrollment: 73532, schools: 146, detail: 'Covers Lakewood, Arvada, Golden, Littleton (west), Evergreen', address: '1829 Denver West Dr, Golden, CO 80401' },
  { type: 'district', name: 'Douglas County School District RE-1', city: 'Castle Rock', region: 'Douglas County', enrollment: 61243, schools: 89, detail: 'Covers Highlands Ranch, Parker, Castle Rock, Lone Tree', address: '620 Wilcox St, Castle Rock, CO 80104' },
  { type: 'district', name: 'Cherry Creek School District 5', city: 'Greenwood Village', region: 'Arapahoe County', enrollment: 51980, schools: 69, detail: 'Covers Centennial, Greenwood Village, south Aurora', address: '4700 S Yosemite St, Greenwood Village, CO 80111' },
  { type: 'district', name: 'Aurora Public Schools (Adams-Arapahoe 28J)', city: 'Aurora', region: 'Adams / Arapahoe', enrollment: 38702, schools: 58, detail: 'Also operates Pickens Technical College', address: '15701 E 1st Ave, Aurora, CO 80011' },
  { type: 'district', name: 'Adams 12 Five Star Schools', city: 'Thornton', region: 'Adams County', enrollment: 34466, schools: 54, detail: 'Covers Thornton, Northglenn, Federal Heights, part of Broomfield', address: '1500 E 128th Ave, Thornton, CO 80241' },
  { type: 'district', name: 'St. Vrain Valley School District RE-1J', city: 'Longmont', region: 'Boulder / Weld', enrollment: 31607, schools: 54, detail: 'Covers Longmont, Erie, Frederick, Firestone, Mead', address: '395 S Pratt Pkwy, Longmont, CO 80501' },
  { type: 'district', name: 'Boulder Valley School District RE-2', city: 'Boulder', region: 'Boulder County', enrollment: 27988, schools: 56, detail: 'Covers Boulder, Louisville, Lafayette, Superior, Nederland', address: '6500 Arapahoe Rd, Boulder, CO 80303' },
  { type: 'district', name: 'School District 27J', city: 'Brighton', region: 'Adams County', enrollment: 24046, schools: 33, detail: 'Fast-growing; covers Brighton, Commerce City (north), Lochbuie', address: '18551 E 160th Ave, Brighton, CO 80601' },
  { type: 'district', name: 'Colorado Charter School Institute', city: 'Denver (statewide)', region: 'Statewide', enrollment: 19960, schools: 42, detail: 'Statewide charter authorizer, NOT a geographic district — office location shown', address: '1600 Broadway, Denver, CO 80202' },
  { type: 'district', name: 'Littleton Public Schools 6', city: 'Littleton', region: 'Arapahoe County', enrollment: 13109, schools: 20, detail: '', address: '5776 S Crocker St, Littleton, CO 80120' },
  { type: 'district', name: 'Westminster Public Schools 50', city: 'Westminster', region: 'Adams County', enrollment: 7724, schools: 15, detail: '', address: '6933 Raleigh St, Westminster, CO 80030' },
  { type: 'district', name: 'Mapleton Public Schools 1', city: 'Thornton', region: 'Adams County', enrollment: 7095, schools: 20, detail: 'Small enrollment but 20 sites — high site-to-student ratio', address: '7350 Broadway, Denver, CO 80221' },
  { type: 'district', name: 'Adams County School District 14', city: 'Commerce City', region: 'Adams County', enrollment: 5221, schools: 12, detail: '', address: '5291 E 60th Ave, Commerce City, CO 80022' },
  { type: 'district', name: 'Weld County School District RE-8', city: 'Fort Lupton', region: 'Weld County', enrollment: 2503, schools: 7, detail: '', address: '301 Reynolds St, Fort Lupton, CO 80621' },
  { type: 'district', name: 'Englewood Schools 1', city: 'Englewood', region: 'Arapahoe County', enrollment: 2406, schools: 9, detail: '', address: '4101 S Bannock St, Englewood, CO 80110' },
  { type: 'district', name: 'Elizabeth School District C-1', city: 'Elizabeth', region: 'Elbert County', enrollment: 2282, schools: 7, detail: '', address: '634 S Elbert St, Elizabeth, CO 80107' },
  { type: 'district', name: 'Bennett School District 29J', city: 'Bennett', region: 'Adams / Arapahoe', enrollment: 1793, schools: 6, detail: '', address: '615 7th St, Bennett, CO 80102' },
  { type: 'district', name: 'Sheridan School District 2', city: 'Sheridan', region: 'Arapahoe County', enrollment: 1018, schools: 5, detail: '', address: '4000 S Lowell Blvd, Sheridan, CO 80236' }
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
    const g = await geocode(loc.address);
    if (!g) { console.error('NO MATCH:', loc.name, loc.address); continue; }
    console.log(`${loc.name.padEnd(48)} ${String(g.accuracy).padEnd(8)} ${g.matched}`);
    out.push({ id: out.length + 1, ...loc, lng: g.lng, lat: g.lat });
  }
  const dest = path.join(__dirname, '..', 'assets', 'maps', 'locations.json');
  fs.writeFileSync(dest, JSON.stringify({ generated: new Date().toISOString(), locations: out }, null, 2));
  console.log(`Wrote ${out.length} locations to ${dest}`);
})();
