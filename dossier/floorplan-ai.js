// Answers questions about the apartment (/floorplan) with Claude. Claude picks what to look up; every number comes
// from the same model code the 3D page runs (web/floorplan/model.js), never from Claude's own estimate.
// Read-only for now: nothing here moves furniture or saves anything.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { z } = require('zod');
const Anthropic = require('@anthropic-ai/sdk');
const { betaZodTool } = require('@anthropic-ai/sdk/helpers/beta/zod');
const store = require('./store');

const MODEL = 'claude-opus-5-5';
const MODEL_JS = path.join(__dirname, 'web', 'floorplan', 'model.js');
const FLOORS = { downstairs: 1, upstairs: 2 };
const FLOOR_NAME = { 1: 'downstairs', 2: 'upstairs' };
const notFloor = (b) => !/^(Floor|Patio|Grass|Rug)$/.test(b.name);
// Structure that would only clutter the object list. Walls, doors and windows stay so gaps to them can be measured.
const SKIP = /^(Floor|Floor band|Ceiling|Grass|Patio)$|trim$|baluster$/i;

const SYSTEM = `You answer questions about the user's apartment from a measured 3D model, using the tools.

The apartment has two floors, downstairs and upstairs. Plan coordinates are in inches: x runs west to east and y runs south to north. The patio is on the west side and the street is to the east.

Rules:
- Every distance and size in your answer must come from a tool result. Never estimate one yourself.
- Match the user's words to object names from list_objects (for example "sofa" is probably "Couch"). If the match is a guess, say which object you used.
- Gaps next to an object marked angled are measured to its outer rectangle, so the real space is a little larger. Say so when it matters.
- Give lengths in feet and inches, like 6' 2 1/2".
- Answer in a few short sentences of plain text, without headings or tables. Lead with the answer.
- You can't move furniture or place anything in the 3D view yet. If asked, say so, and answer the fit question instead.`;

// The apartment's measurements are private and live in the store, so the model is assembled in a temp folder
// and imported from there. Cached until apartment.js or model.js changes.
let cached = null;
async function loadModel() {
  const apartment = await store.getFile('floorplan-apartment.js');
  if (!apartment) throw Object.assign(new Error('The apartment model has not been uploaded.'), { status: 503 });
  const modelSource = await fs.promises.readFile(MODEL_JS);
  const hash = crypto.createHash('sha256').update(apartment.body).update(modelSource).digest('hex').slice(0, 16);
  if (cached?.hash === hash) return cached.model;
  const dir = path.join(os.tmpdir(), `floorplan-ai-${hash}`);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'apartment.js'), apartment.body);
  await fs.promises.writeFile(path.join(dir, 'model.js'), modelSource);
  const model = await import(pathToFileURL(path.join(dir, 'model.js')).href);
  const { CEILING, FLOOR_TO_FLOOR } = await import(pathToFileURL(path.join(dir, 'apartment.js')).href);
  cached = { hash, model: { ...model, CEILING, FLOOR_TO_FLOOR } };
  return cached.model;
}

async function savedLayout() {
  const file = await store.getFile('floorplan-layout.json');
  try { return file ? JSON.parse(file.body.toString('utf8')) : {}; } catch (_) { return {}; }
}

const round = (n) => Math.round(n * 8) / 8;
const inches = (M, n) => (Number.isFinite(n) ? { inches: round(n), text: M.formatInches(n) } : null);

// Everything here reads one floor's model with the given furniture layout. It must stay synchronous: the model's
// layout is one shared object, so nothing may await between setting it and reading the result.
function snapshot(M, layoutData) {
  for (const id of Object.keys(M.layout)) delete M.layout[id];
  M.loadLayout(layoutData);
  const floors = {};
  for (const level of [1, 2]) {
    const built = M.buildModel({ level });
    const base = level === 2 ? M.FLOOR_TO_FLOOR : 0;
    // Room names repeat (three upstairs closets), so repeats get a number.
    const seen = {};
    const rooms = built.rooms.map((r) => {
      seen[r.name] = (seen[r.name] || 0) + 1;
      return { ...r, label: r.name };
    });
    for (const r of rooms) if (seen[r.name] > 1) r.label = `${r.name} ${rooms.filter((o) => o.name === r.name).indexOf(r) + 1}`;
    const roomAt = (x, y) => rooms.find((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)?.label ?? null;
    const groups = new Map();
    for (const b of built.boxes) {
      if (!b.piece && SKIP.test(b.name)) continue;
      const name = b.piece ?? (b.name === 'Stair tread' ? 'Stairs' : b.name);
      const g = groups.get(name);
      if (!g) groups.set(name, { name, furniture: !!b.piece, angled: !!b.turn, x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1 });
      else {
        g.x0 = Math.min(g.x0, b.x0); g.x1 = Math.max(g.x1, b.x1);
        g.y0 = Math.min(g.y0, b.y0); g.y1 = Math.max(g.y1, b.y1);
        g.z0 = Math.min(g.z0, b.z0); g.z1 = Math.max(g.z1, b.z1);
        g.angled ||= !!b.turn;
      }
    }
    const objects = [...groups.values()].map((o) => ({ ...o, floor: FLOOR_NAME[level], room: roomAt((o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2), base }));
    floors[level] = { rooms, objects, solids: built.boxes.filter(notFloor), base };
  }
  return floors;
}

function findObject(floors, name, floor) {
  const want = String(name).trim().toLowerCase();
  const levels = floor ? [FLOORS[floor]] : [1, 2];
  const all = levels.flatMap((lv) => floors[lv].objects);
  const exact = all.filter((o) => o.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`"${name}" is on both floors. Say which floor.`);
  const close = all.filter((o) => o.name.toLowerCase().includes(want) || want.includes(o.name.toLowerCase())).map((o) => `${o.name} (${o.floor})`);
  throw new Error(`No object named "${name}".${close.length ? ` Close matches: ${close.slice(0, 8).join(', ')}.` : ' Use list_objects for the names.'}`);
}

function findRoom(floors, name, floor) {
  const want = String(name).trim().toLowerCase();
  const levels = floor ? [FLOORS[floor]] : [1, 2];
  const hits = levels.flatMap((lv) => floors[lv].rooms.map((r) => ({ ...r, level: lv }))).filter((r) => r.label.toLowerCase() === want);
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${name}" is on both floors. Say which floor.` : `No room named "${name}". Use list_rooms for the names.`);
}

function describeObject(M, o) {
  return {
    name: o.name, floor: o.floor, room: o.room, furniture: o.furniture, angled: o.angled || undefined,
    east_west: round(o.x1 - o.x0), north_south: round(o.y1 - o.y0), height: round(o.z1 - o.z0), bottom_above_floor: round(o.z0 - o.base),
    x0: round(o.x0), x1: round(o.x1), y0: round(o.y0), y1: round(o.y1),
  };
}

function listRooms(M, floors) {
  return [1, 2].flatMap((lv) => floors[lv].rooms.map((r) => ({
    name: r.label, floor: FLOOR_NAME[lv],
    east_west: inches(M, r.x1 - r.x0), north_south: inches(M, r.y1 - r.y0),
    square_feet: Math.round((r.x1 - r.x0) * (r.y1 - r.y0) / 144),
    x0: round(r.x0), x1: round(r.x1), y0: round(r.y0), y1: round(r.y1),
  })));
}

function listObjects(M, floors, { floor, room }) {
  let list = (floor ? [FLOORS[floor]] : [1, 2]).flatMap((lv) => floors[lv].objects);
  if (room) list = list.filter((o) => o.room?.toLowerCase() === room.trim().toLowerCase());
  return list.map((o) => describeObject(M, o));
}

function measureGap(M, floors, { a, b, floor_a, floor_b }) {
  const A = findObject(floors, a, floor_a), B = findObject(floors, b, floor_b);
  const ew = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
  const ns = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1));
  const vertical = Math.max(0, Math.max(A.z0, B.z0) - Math.min(A.z1, B.z1));
  const where = [B.x0 >= A.x1 && 'east', B.x1 <= A.x0 && 'west', B.y0 >= A.y1 && 'north', B.y1 <= A.y0 && 'south'].filter(Boolean);
  return {
    a: describeObject(M, A), b: describeObject(M, B),
    b_is: where.length ? `${where.join(' and ')} of a` : 'overlapping a in the plan (one is above, below or on the other)',
    east_west_gap: inches(M, ew), north_south_gap: inches(M, ns), vertical_gap: inches(M, vertical),
    closest_distance_in_plan: inches(M, Math.hypot(ew, ns)),
    note: A.angled || B.angled ? 'An angled object is measured to its outer rectangle, so the true gap is a little larger.' : undefined,
  };
}

function checkFit(M, floors, { width, depth, height, room, floor, x, y }) {
  const R = findRoom(floors, room, floor);
  const F = floors[R.level];
  const result = { room: R.label, floor: FLOOR_NAME[R.level], size: { width, depth, height } };
  if (height > M.CEILING) return { ...result, fits: false, reason: `Taller than the ${M.formatInches(M.CEILING)} ceiling.` };
  const box = (cx, cy, sx, sy) => ({ x0: cx - sx / 2, x1: cx + sx / 2, y0: cy - sy / 2, y1: cy + sy / 2, z0: F.base, z1: F.base + height });
  const clearances = (clear) => Object.fromEntries(Object.entries(clear).map(([side, d]) => [side, inches(M, d)]));

  // One spot the user named: width runs east-west.
  if (x != null && y != null) {
    const { hits, clear } = M.fitReport(F.solids, box(x, y, width, depth));
    return { ...result, spot: { x, y }, fits: hits.length === 0, hits, clearances: clearances(clear) };
  }

  // Otherwise try every spot in the room, 1" apart, both ways round.
  const fits = [], blockers = {};
  const turns = width === depth ? [[width, depth]] : [[width, depth], [depth, width]];
  for (const [sx, sy] of turns) {
    for (let cx = R.x0 + sx / 2; cx <= R.x1 - sx / 2; cx += 1) {
      for (let cy = R.y0 + sy / 2; cy <= R.y1 - sy / 2; cy += 1) {
        const { hits, clear } = M.fitReport(F.solids, box(cx, cy, sx, sy));
        if (hits.length) { for (const h of hits) blockers[h] = (blockers[h] || 0) + 1; continue; }
        const touching = Object.entries(clear).filter(([, d]) => d < 1).map(([side]) => side);
        fits.push({ cx, cy, sx, sy, clear, touching });
      }
    }
  }
  if (!fits.length) {
    const tooBig = turns.every(([sx, sy]) => sx > R.x1 - R.x0 || sy > R.y1 - R.y0);
    return {
      ...result, fits: false,
      reason: tooBig ? 'Larger than the room in both directions it could face.' : 'Every spot runs into something.',
      most_often_in_the_way: Object.entries(blockers).sort((p, q) => q[1] - p[1]).slice(0, 5).map(([n]) => n),
    };
  }
  // A few spots spread around the room, snug ones first since furniture usually sits against something.
  fits.sort((p, q) => q.touching.length - p.touching.length);
  const picked = [];
  for (const f of fits) {
    if (picked.length === 5) break;
    if (picked.every((p) => Math.hypot(p.cx - f.cx, p.cy - f.cy) >= 24)) picked.push(f);
  }
  return {
    ...result, fits: true, open_spots: fits.length,
    spots: picked.map((f) => ({
      center: { x: round(f.cx), y: round(f.cy) },
      long_side_runs: f.sx >= f.sy ? 'east-west' : 'north-south',
      touching_something_on: f.touching.length ? f.touching : 'no side (free-standing)',
      clearances: clearances(f.clear),
    })),
  };
}

const floorParam = z.enum(['downstairs', 'upstairs']).optional();
const size = z.number().positive().max(400);

function tools(M, floors) {
  const run = (fn) => async (input) => {
    try {
      return JSON.stringify(fn(M, floors, input));
    } catch (err) {
      return JSON.stringify({ error: err.message });
    }
  };
  return [
    betaZodTool({
      name: 'list_rooms',
      description: 'Every room on both floors with its size, square feet and plan bounds in inches.',
      inputSchema: z.object({}),
      run: run(listRooms),
    }),
    betaZodTool({
      name: 'list_objects',
      description: 'Furniture, fixtures, doors, windows and walls, with each one\'s floor, room, size (east_west, north_south, height, in inches) and plan bounds. Filter by floor or room to keep it short.',
      inputSchema: z.object({ floor: floorParam, room: z.string().optional().describe('A room name from list_rooms') }),
      run: run((m, f, input) => listObjects(m, f, input)),
    }),
    betaZodTool({
      name: 'measure_gap',
      description: 'Open space between two objects: the east-west and north-south gaps, the closest distance in the plan, and which side b is on.',
      inputSchema: z.object({
        a: z.string().describe('Exact object name from list_objects'),
        b: z.string().describe('Exact object name from list_objects'),
        floor_a: floorParam, floor_b: floorParam,
      }),
      run: run(measureGap),
    }),
    betaZodTool({
      name: 'check_fit',
      description: 'Whether a box of the given size (inches) fits in a room without hitting anything. Without x and y it searches the whole room, both ways round, and returns a few open spots with the clearance on each side (a side with 0 touches a wall or another object; use list_objects to see which). With x and y it checks that one spot, with width running east-west.',
      inputSchema: z.object({
        width: size, depth: size, height: size,
        room: z.string().describe('A room name from list_rooms'),
        floor: floorParam,
        x: z.number().optional().describe('Center, inches east'),
        y: z.number().optional().describe('Center, inches north'),
      }),
      run: run(checkFit),
    }),
  ];
}

let client = null;
const fail = (status, message) => Object.assign(new Error(message), { status });

// messages: [{ role: 'user' | 'assistant', content: string }], oldest first, ending with the new question.
// Earlier turns go back as plain text with no thinking blocks, so there is no replayed history to keep identical.
// layout: the page's current furniture positions, unsaved moves included. Otherwise the saved layout.
async function ask({ messages, layout } = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) throw fail(400, 'Send 1 to 40 messages.');
  messages.forEach((m, i) => {
    if (m?.role !== (i % 2 ? 'assistant' : 'user') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 4000) {
      throw fail(400, 'Messages must alternate user and assistant, start and end with the user, and be 1 to 4000 characters.');
    }
  });
  if (messages.length % 2 === 0) throw fail(400, 'The last message must be the question.');
  if (!process.env.ANTHROPIC_API_KEY) throw fail(503, 'The AI key is not set up on the server.');

  const M = await loadModel();
  const floors = snapshot(M, layout && typeof layout === 'object' ? layout : await savedLayout());
  client ??= new Anthropic();
  let final;
  try {
    final = await client.beta.messages.toolRunner({
      model: MODEL,
      max_tokens: 16000,
      max_iterations: 12,
      output_config: { effort: 'medium' },
      // If a safety check declines the request, the API retries it on another model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools: tools(M, floors),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw fail(503, 'The AI key on the server was not accepted.');
    if (err instanceof Anthropic.RateLimitError) throw fail(503, 'Too many questions at once. Try again in a minute.');
    if (err instanceof Anthropic.APIError) throw fail(502, `The AI service said ${err.status ?? 'no'}: ${err.message}`);
    throw err;
  }
  if (final.stop_reason === 'refusal') return 'Claude declined to answer that one.';
  const text = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
  if (final.stop_reason === 'tool_use') return `${text}\n\n(I stopped after too many lookups. Try a narrower question.)`.trim();
  return text || 'No answer came back. Try asking again.';
}

module.exports = { ask, loadModel, snapshot, measureGap, checkFit, listRooms, listObjects };
