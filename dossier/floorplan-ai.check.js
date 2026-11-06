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

  console.log('floorplan AI tools: all checks passed');
  console.log(JSON.stringify({ gap, sofa: ai.checkFit(M, floors, { width: 84, depth: 38, height: 34, room: 'Living Room' }) }, null, 1).slice(0, 2500));
})().catch((err) => { console.error(err); process.exit(1); });
