// Uploads the private dossier content (kept outside this repo) to the live site.
//
//   node dossier/publish.js [site-url]          default site: https://jakebiddlecome.com
//   node dossier/publish.js --books [site-url]  also upload ~/Dossier/books/books.json. The library is edited on
//                                               the site, so run dossier/pull.js first or you overwrite those edits.
//
// Reads DOSSIER_PASSWORD from the environment or the repo's .env, logs in for a short-lived token,
// then uploads ~/Dossier/data/dossier.json (plus journal-prompts.json if present) and every image in ~/Dossier/photos (override the folder
// with DOSSIER_DIR). Nothing is written to this repo.
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

const args = process.argv.slice(2);
const WITH_BOOKS = args.includes('--books');
const SITE = (args.find((a) => !a.startsWith('--')) || 'https://jakebiddlecome.com').replace(/\/$/, '');
const DIR = process.env.DOSSIER_DIR || path.join(os.homedir(), 'Dossier');
const PASSWORD = process.env.DOSSIER_PASSWORD || envFromFile('DOSSIER_PASSWORD');
const TYPES = { '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

async function main() {
  if (!PASSWORD) throw new Error('Set DOSSIER_PASSWORD in the environment or in .env first.');
  const files = [path.join(DIR, 'data', 'dossier.json')];
  const prompts = path.join(DIR, 'data', 'journal-prompts.json');
  if (fs.existsSync(prompts)) files.push(prompts);
  if (WITH_BOOKS) files.push(path.join(DIR, 'books', 'books.json'));
  for (const f of fs.readdirSync(path.join(DIR, 'photos'))) if (TYPES[path.extname(f).toLowerCase()]) files.push(path.join(DIR, 'photos', f));
  for (const f of files) if (f.endsWith('.json')) JSON.parse(fs.readFileSync(f, 'utf8')); // fail early on a malformed data file

  const login = await fetch(`${SITE}/dossier/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD, client: 'cli' })
  });
  const { token, error } = await login.json().catch(() => ({}));
  if (!login.ok) throw new Error(`Login failed (${login.status}): ${error || 'no details'}`);

  for (const file of files) {
    const name = path.basename(file);
    const res = await fetch(`${SITE}/dossier/api/files/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': TYPES[path.extname(name).toLowerCase()] },
      body: fs.readFileSync(file)
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${name}: ${res.status} ${out.error || ''}`);
    console.log(`uploaded ${name} (${fs.statSync(file).size} bytes)`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
