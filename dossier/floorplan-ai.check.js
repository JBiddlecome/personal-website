// Checks the floorplan AI's tools against the private apartment model, with no AI calls.
// Run: node dossier/floorplan-ai.check.js   (reads the apartment model folder; override with FLOORPLAN_DIR)
const assert = require('assert/strict');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const ai = require('./floorplan-ai');

const DIR = process.env.FLOORPLAN_DIR || path.join(os.homedir(), 'GitHub Local', 'Apartment Floorplan');

(async () => {
  const model = await import(pathToFileURL(path.join(DIR, 'model.js')).href);
  const { CEILING, FLOOR_TO_FLOOR } = await import(pathToFileURL(path.join(DIR, 'apartment.js')).href);
  const M = { ...model, CEILING, FLOOR_TO_FLOOR };
  const floors = ai.snapshot(M, JSON.parse(fs.readFileSync(path.join(DIR, 'layout.json'), 'utf8')));

  const rooms = ai.listRooms(M, floors);
  assert.ok(rooms.some((r) => r.name === 'Living Room' && r.floor === 'downstairs'));
  assert.ok(rooms.some((r) => r.name === 'Closet 2'), 'repeated room names get numbers');

  const objects = ai.listObjects(M, floors, { room: 'Living Room' });
  assert.ok(objects.some((o) => o.name === 'Couch'), 'the couch is in the living room');
  assert.ok(!objects.some((o) => /trim$/i.test(o.name)), 'trim is left out');

  // A gap is never negative, and an object is 0 from itself.
  const gap = ai.measureGap(M, floors, { a: 'Couch', b: 'TV' });
  assert.ok(gap.closest_distance_in_plan.inches >= 0);
  assert.equal(ai.measureGap(M, floors, { a: 'Couch', b: 'Couch' }).closest_distance_in_plan.inches, 0);
  assert.throws(() => ai.measureGap(M, floors, { a: 'Couchh', b: 'TV' }), /No object named/);
  assert.throws(() => ai.measureGap(M, floors, { a: 'South wall', b: 'TV' }), /both floors/);

  // A small box fits somewhere, nothing bigger than the room does, nothing taller than the ceiling does.
  const small = ai.checkFit(M, floors, { width: 12, depth: 12, height: 12, room: 'Living Room' });
  assert.equal(small.fits, true);
  assert.ok(small.spots.length > 0 && small.spots.length <= 5);
  assert.equal(ai.checkFit(M, floors, { width: 399, depth: 399, height: 10, room: 'Living Room' }).fits, false);
  assert.equal(ai.checkFit(M, floors, { width: 10, depth: 10, height: CEILING + 1, room: 'Office' }).fits, false);
  // A named spot inside the couch is a hit on the couch.
  const couch = objects.find((o) => o.name === 'Couch');
  const spot = ai.checkFit(M, floors, { width: 4, depth: 4, height: 4, room: 'Living Room', x: (couch.x0 + couch.x1) / 2, y: (couch.y0 + couch.y1) / 2 });
  assert.ok(spot.hits.includes('Couch'), JSON.stringify(spot.hits));

  // Changes: the user's two examples, then moving, removing and the limits.
  const state = {};
  ai.commit(M, state, {});
  ai.setColor(M, state, { object: 'Shoe rack', color: '#E0B020' });
  assert.equal(state.work._colors['Shoe rack'], '#e0b020');
  assert.ok(M.buildModel({ level: 1 }).boxes.filter((b) => b.piece === 'Shoe rack').every((b) => b.color === 0xe0b020), 'shoe rack drawn yellow');
  const table = ai.listObjects(M, state.floors, {}).find((o) => o.name === 'End table 1');
  const lamp = ai.addObject(M, state, { name: 'Red lamp 1', shape: 'cylinder', width: 3, height: 12, color: '#c0392b', on: 'End table 1' }).added;
  assert.equal(lamp.bottom_above_floor, table.height, 'lamp sits on the table top');
  assert.equal(lamp.east_west, 3);
  assert.equal(lamp.color, '#c0392b', 'color comes from the cylinder, not its outline');
  assert.ok(M.buildModel({ level: 1 }).beams.some((b) => b.piece === 'Red lamp 1'), 'drawn as a cylinder');
  assert.throws(() => ai.addObject(M, state, { name: 'red lamp 1', shape: 'box', width: 3, height: 3, color: '#000000', on: 'Couch' }), /already taken/);
  const before = ai.listObjects(M, state.floors, {}).find((o) => o.name === 'Red lamp 1');
  ai.moveObject(M, state, { object: 'Red lamp 1', dx: 10, dy: 0 });
  assert.equal(ai.listObjects(M, state.floors, {}).find((o) => o.name === 'Red lamp 1').x0, before.x0 + 10, 'added objects move like furniture');
  assert.throws(() => ai.moveObject(M, state, { object: 'Front door', dx: 5 }), /doesn't move/);
  assert.throws(() => ai.removeObject(M, state, { object: 'Couch' }), /Only objects added/);
  ai.removeObject(M, state, { object: 'Red lamp 1' });
  assert.ok(!state.work._added && !state.work['Red lamp 1'], 'removing also clears its move');
  ai.setColor(M, state, { object: 'Shoe rack', color: 'original' });
  assert.ok(!state.work._colors, 'empty colors are dropped');
  // Malformed saved entries are ignored, not drawn.
  ai.commit(M, state, { _colors: { Couch: 'red' }, _added: [{ name: 'Bad', shape: 'cone', w: 1, d: 1, h: 1, x: 0, y: 0, z: 0, level: 1, color: '#000000' }] });
  assert.deepEqual(state.work, {});

  console.log('floorplan AI tools: all checks passed');
  console.log(JSON.stringify({ gap, sofa: ai.checkFit(M, floors, { width: 84, depth: 38, height: 34, room: 'Living Room' }) }, null, 1).slice(0, 2500));
})().catch((err) => { console.error(err); process.exit(1); });
