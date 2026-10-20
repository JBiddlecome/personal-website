// Downloads the journal entries written on the live site into the private dossier folder, so they
// can be read locally (by the subject, or by Claude) without ever touching this repo.
//
//   node dossier/pull.js [site-url]             default site: https://jakebiddlecome.com
//
// Saves journal-YYYY-MM-DD.json files to ~/Dossier/journal (override the folder with DOSSIER_DIR).
// Only entries that are new or changed since the last pull are downloaded.
const fs = require('fs');
const os = require('os');
const path = require('path');

function envFromFile(key) {
  for (const file of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env')]) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '');
    } catch (_) { /* missing file is fine */ }
  }
  return '';
}

const SITE = (process.argv[2] || 'https://jakebiddlecome.com').replace(/\/$/, '');
const DIR = path.join(process.env.DOSSIER_DIR || path.join(os.homedir(), 'Dossier'), 'journal');
const PASSWORD = process.env.DOSSIER_PASSWORD || envFromFile('DOSSIER_PASSWORD');
const JOURNAL_RE = /^journal-\d{4}-\d{2}-\d{2}\.json$/;

async function main() {
  if (!PASSWORD) throw new Error('Set DOSSIER_PASSWORD in the environment or in .env first.');
  const login = await fetch(`${SITE}/dossier/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, client: 'cli' })
  });
  const { token, error } = await login.json().catch(() => ({}));
  if (!login.ok) throw new Error(`Login failed (${login.status}): ${error || 'no details'}`);
  const auth = { Authorization: `Bearer ${token}` };

  const list = await fetch(`${SITE}/dossier/api/files`, { headers: auth });
  if (!list.ok) throw new Error(`Listing failed (${list.status})`);
  const entries = (await list.json()).files.filter((f) => JOURNAL_RE.test(f.name));

  fs.mkdirSync(DIR, { recursive: true });
  let pulled = 0;
  for (const f of entries) {
    const local = path.join(DIR, f.name);
    const remoteTime = new Date(f.updated_at).getTime();
    if (fs.existsSync(local) && fs.statSync(local).mtimeMs >= remoteTime) continue;
    const res = await fetch(`${SITE}/dossier/api/files/${encodeURIComponent(f.name)}`, { headers: auth });
    if (!res.ok) throw new Error(`${f.name}: ${res.status}`);
    fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
    fs.utimesSync(local, new Date(), new Date(remoteTime));
    pulled++;
    console.log(`pulled ${f.name}`);
  }
  console.log(`${entries.length} entries on the site, ${pulled} new or changed, saved in ${DIR}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
