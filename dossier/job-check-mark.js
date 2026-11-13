// Marks one application on the live Job Check grid (/dossier/job_check): today's next open square, in reading order
// (square 1 is top-left, then left to right, row by row). Used by the /apply skill each time an application is submitted.
//
//   node dossier/job-check-mark.js            mark the next square for today
//   node dossier/job-check-mark.js --dry      show today's count and the next square, change nothing
//   node dossier/job-check-mark.js --test     run the self-check
//
// Logs in like pull.js (DOSSIER_PASSWORD from the environment or .env) and rewrites job-check.json, keeping every other day.
const fs = require('fs');
const path = require('path');

const SITE = (process.env.DOSSIER_SITE || 'https://jakebiddlecome.com').replace(/\/$/, '');
const FILE = `${SITE}/dossier/api/files/job-check.json`;

function envFromFile(key) {
  for (const file of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env')]) {
    try {
      const m = fs.readFileSync(file, 'utf8').match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)\\s*$`, 'm'));
      if (m) return m[1].replace(/^["']|["']$/g, '');
    } catch (_) { /* missing file is fine */ }
  }
  return '';
}

// Lowest unmarked square, so a square Jake unmarks by hand is the next one filled. null when all 100 are used.
const nextSquare = (list) => { for (let n = 1; n <= 100; n++) if (!list.includes(n)) return n; return null; };
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

async function main() {
  const password = process.env.DOSSIER_PASSWORD || envFromFile('DOSSIER_PASSWORD');
  if (!password) throw new Error('Set DOSSIER_PASSWORD in the environment or in .env first.');
  const login = await fetch(`${SITE}/dossier/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, client: 'cli' })
  });
  const { token, error } = await login.json().catch(() => ({}));
  if (!login.ok) throw new Error(`Login failed (${login.status}): ${error || 'no details'}`);
  const auth = { Authorization: `Bearer ${token}` };

  const res = await fetch(FILE, { headers: auth, cache: 'no-store' });
  let data;
  if (res.status === 404) data = { days: {} };
  else if (!res.ok) throw new Error(`Reading the grid failed (${res.status})`); // never write over a file we could not read
  else data = await res.json();
  data.days = data.days || {};

  const day = today();
  const list = data.days[day] || [];
  const n = nextSquare(list);
  if (n === null) { console.log(`job check: all 100 squares already marked for ${day}`); return; }
  if (process.argv.includes('--dry')) { console.log(`job check (dry run): ${list.length} marked for ${day}, next would be square ${n}`); return; }
  data.days[day] = [...list, n].sort((a, b) => a - b);

  const put = await fetch(FILE, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(data)
  });
  if (!put.ok) throw new Error(`Saving the grid failed (${put.status})`);
  console.log(`job check: marked square ${n} for ${day} (${data.days[day].length} today)`);
}

if (process.argv.includes('--test')) {
  const assert = require('assert');
  assert.strictEqual(nextSquare([]), 1);
  assert.strictEqual(nextSquare([1, 2, 3]), 4);
  assert.strictEqual(nextSquare([1, 2, 4]), 3);
  assert.strictEqual(nextSquare(Array.from({ length: 100 }, (_, i) => i + 1)), null);
  console.log('ok');
} else {
  main().catch((err) => { console.error(`job check NOT marked: ${err.message}`); process.exit(1); });
}
