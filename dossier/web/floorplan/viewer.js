import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { buildModel, formatInches, inchesShort, snap, straighten, fitReport, snapFit, walkSolids, moveBody, groundAt, WALK, WALK_STARTS, BOUNDS, layout, loadLayout, pieceBounds } from './model.js';
import { FLOOR_TO_FLOOR, CEILING } from './apartment.js';

const notFloor = (b) => !/^(Floor|Patio|Grass|Rug)$/.test(b.name);
const LOW_CUT = 50; // just above the 48" sills and below the upper cabinets, so it reads like a floor plan
const MAX_FIT_SIZE = 400; // inches, larger than anything that could enter the apartment

// Plan (x east, y north, z up) to Three.js (x east, y up, -z north). 1 unit = 1 inch.
const toWorld = (x, y, z) => new THREE.Vector3(x, z, -y);
const toPlan = (v) => ({ x: v.x, y: -v.z, z: v.y });
const $ = (id) => document.getElementById(id);

// Browser storage can throw in private windows. The page works without it.
const local = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* see above */ } },
};

// On the website: Save writes to the server, and the service worker keeps the page working offline.
const onSite = location.pathname.startsWith('/dossier/floorplan');
if (onSite) navigator.serviceWorker?.register('sw.js').catch((err) => console.warn('offline copy not set up', err));

// The served layout.json as text: '' when there is none yet, null when it can't be reached.
// no-store asks the service worker for the server's copy, never an early offline one.
const fetchLayoutText = (cache) => fetch('layout.json', { cache }).then((r) => (r.ok ? r.text() : r.status === 404 ? '' : null)).catch(() => null);
const clearLayout = () => { for (const id of Object.keys(layout)) delete layout[id]; };

// Saved furniture positions. A missing or broken file just means everything stays where the model puts it.
// base is the server's text these moves started from, to notice another device saving in between.
let base = await fetchLayoutText('no-cache');
try {
  loadLayout(JSON.parse(base || '{}'));
} catch (err) {
  console.warn('layout.json not loaded', err);
}
// Moves not saved yet survive a closed app, a dead battery or no signal, and replace what the server has until saved or discarded.
const UNSAVED_KEY = 'floorplan-unsaved-layout', BASE_KEY = 'floorplan-unsaved-base';
let pending = null;
try {
  pending = JSON.parse(local.get(UNSAVED_KEY));
} catch (err) {
  console.warn('unsaved moves unreadable, ignored', err);
}
if (pending) {
  clearLayout();
  loadLayout(pending);
  base = local.get(BASE_KEY) ?? base;
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe9e5dc);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9182, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(-200, 500, 300);
scene.add(sun);

const center = toWorld((BOUNDS.x0 + BOUNDS.x1) / 2, (BOUNDS.y0 + BOUNDS.y1) / 2, 0);
const planLength = BOUNDS.x1 - BOUNDS.x0, planWidth = BOUNDS.y1 - BOUNDS.y0;
const persp = new THREE.PerspectiveCamera(45, 1, 5, 5000);
// Portrait phones look along the long axis from the street side, landscape looks across it from the south.
const startView = () => (innerHeight > innerWidth ? [640, 860, 240] : [-60, 560, 480]);
persp.position.copy(center).add(new THREE.Vector3(...startView()));
persp.rotation.order = 'YXZ';
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
ortho.position.set(center.x, 800, center.z);
ortho.up.set(0, 0, -1);
let camera = persp;

const controls = new OrbitControls(camera, canvas);
controls.target.copy(center);
controls.maxPolarAngle = Math.PI * 0.49;

// One mesh per box is fine at this count. shortcut: merge by color if furniture slows phones down.
const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitEdges = new THREE.EdgesGeometry(unitBox);
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x4a463f });
const ceilingMaterial = new THREE.MeshBasicMaterial({ color: 0xf2f0ea });
const materials = new Map();
const material = (color) => {
  if (!materials.has(color)) materials.set(color, new THREE.MeshLambertMaterial({ color }));
  return materials.get(color);
};

let model, group, level = 1, low = false, walking = false;
const labelBox = $('labels');
let labels = [];

function rebuild() {
  if (group) {
    scene.remove(group);
    // Moving furniture rebuilds often, so free the one-off shapes. The box shapes are shared.
    group.traverse((o) => { if (o.geometry && o.geometry !== unitBox && o.geometry !== unitEdges) o.geometry.dispose(); });
  }
  group = new THREE.Group();
  model = buildModel({
    level: walking ? 'both' : level,
    cut: !walking && (low || camera === ortho) ? LOW_CUT : Infinity,
    ceilings: walking,
  });
  for (const b of model.boxes) {
    if (b.hidden) continue;
    // Ceilings ignore the lighting, which only reaches their undersides as a tan glow from below.
    const mesh = new THREE.Mesh(unitBox, b.name === 'Ceiling' ? ceilingMaterial : material(b.color));
    mesh.userData.piece = b.piece;
    // An angled box's x and y are its outline, so it draws from its true size, turned about the same center.
    mesh.scale.set(b.turn?.w ?? b.x1 - b.x0, b.z1 - b.z0, b.turn?.d ?? b.y1 - b.y0);
    if (b.turn) mesh.rotation.y = -b.turn.rad;
    mesh.position.copy(toWorld((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2));
    // Floors and ceilings are several boxes around the stairwell, and outlines would draw seams across rooms.
    if (b.name !== 'Floor' && b.name !== 'Ceiling') mesh.add(new THREE.LineSegments(unitEdges, edgeMaterial));
    group.add(mesh);
  }
  for (const beam of model.beams) {
    const a = toWorld(...beam.a), b = toWorld(...beam.b);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(beam.r, beam.r, a.distanceTo(b), 20), material(beam.color));
    mesh.userData.piece = beam.piece;
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(mesh);
  }
  // Sloped pieces: an (x, z) outline extruded north-south.
  for (const p of model.prisms) {
    const shape = new THREE.Shape(p.points.map(([x, z]) => new THREE.Vector2(x, z)));
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: p.y1 - p.y0, bevelEnabled: false });
    const mesh = new THREE.Mesh(geometry, material(p.color));
    mesh.position.z = -p.y1;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial));
    group.add(mesh);
  }
  scene.add(group);

  // Both floors at once would stack the labels, and they'd clutter the view while walking.
  labelBox.replaceChildren();
  labels = level === 'both' || walking ? [] : model.rooms.map((r) => {
    const el = document.createElement('div');
    el.className = 'label';
    el.textContent = `${r.name}\n${Math.round((r.x1 - r.x0) * (r.y1 - r.y0) / 144)} sq ft`;
    labelBox.append(el);
    return { el, at: toWorld((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, r.z) };
  });
}
rebuild();

// Inches per screen pixel at a given point, for snap tolerances and marker size.
function viewScale(cam, at) {
  return cam.isOrthographicCamera
    ? (cam.top - cam.bottom) / cam.zoom / canvas.clientHeight
    : cam.position.distanceTo(at) * 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / canvas.clientHeight;
}

const raycaster = new THREE.Raycaster();
function aim(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -(clientY - r.top) / r.height * 2 + 1), camera);
}
const pieceUnder = (clientX, clientY) => {
  aim(clientX, clientY);
  return raycaster.intersectObject(group, true).find((h) => h.object.isMesh);
};

// Measure tool. Finished measurements stay on screen until Clear, so walls and furniture can be compared.
const readout = $('readout');
const measureGroup = new THREE.Group();
scene.add(measureGroup);
const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xd1341f, depthTest: false });
const measureLineMaterial = new THREE.LineBasicMaterial({ color: 0xd1341f, depthTest: false });
const marker = new THREE.SphereGeometry(1, 12, 8);
let measuring = false, points = [], firstRaw = null, measures = [], measureLabels = [];

function drawMeasure() {
  measureGroup.clear();
  $('measureLabels').replaceChildren();
  measureLabels = [];
  for (const pair of [...measures, points]) {
    const world = pair.map((p) => toWorld(p.x, p.y, p.z));
    for (const w of world) {
      const m = new THREE.Mesh(marker, markerMaterial);
      m.position.copy(w);
      m.renderOrder = 2;
      measureGroup.add(m);
    }
    if (world.length < 2) continue;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(world), measureLineMaterial);
    line.renderOrder = 2;
    measureGroup.add(line);
    const el = document.createElement('div');
    el.className = 'label measure';
    el.textContent = inchesShort(world[0].distanceTo(world[1]));
    $('measureLabels').append(el);
    measureLabels.push({ el, at: world[0].clone().add(world[1]).multiplyScalar(0.5) });
  }
  const last = measures.at(-1);
  if (points.length || !last) {
    readout.textContent = points.length ? 'Tap the second point' : 'Tap the first point';
    return;
  }
  const [a, b] = last;
  const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
  const parts = [['east-west', dx], ['north-south', dy], ['height', dz]].filter(([, d]) => d > 0.01);
  readout.innerHTML = `<strong>${formatInches(Math.hypot(dx, dy, dz))}</strong>` +
    (parts.length > 1 ? parts.map(([n, d]) => `${n} ${formatInches(d)}`).join('<br>') : parts[0]?.[0] ?? '') +
    '<button id="measureClear" type="button">Clear</button>';
}

function clearMeasures() {
  points = [];
  measures = [];
  drawMeasure();
}
readout.onclick = (e) => { if (e.target.id === 'measureClear') clearMeasures(); };

function tapAt(clientX, clientY) {
  const hit = pieceUnder(clientX, clientY);
  if (!hit) return;
  const raw = toPlan(hit.point);
  // An angled piece's outline isn't its real surface, so measuring doesn't snap to it.
  const flat = model.boxes.filter((b) => !b.turn);
  let p = snap(fit ? [...flat, fitBounds()] : flat, raw, viewScale(camera, hit.point) * 12);
  // The top view measures floor distance, whichever surface was tapped.
  if (camera === ortho) raw.z = p.z = 0;
  if (points.length === 1) {
    measures.push([points[0], straighten(points[0], p, firstRaw, raw)]);
    points = [];
  } else {
    firstRaw = raw;
    points = [p];
  }
  drawMeasure();
}

// Test fit box
let fit = null, fitSolids = [], fitLines = [];
const fitMaterial = new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.6 });
const fitMesh = new THREE.Mesh(unitBox, fitMaterial);
fitMesh.add(new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: 0x1d1b18 })));
fitMesh.visible = false;
scene.add(fitMesh);
const fitLineGroup = new THREE.Group();
scene.add(fitLineGroup);
const fitLineMaterial = new THREE.LineBasicMaterial({ color: 0x1f5fbf, depthTest: false });

const fitBounds = () => ({
  name: 'Test fit box',
  x0: fit.x - fit.spanX / 2, x1: fit.x + fit.spanX / 2,
  y0: fit.y - fit.spanY / 2, y1: fit.y + fit.spanY / 2,
  z0: fit.z, z1: fit.z + fit.h,
});

const validSize = (values) => values.every((v) => Number.isFinite(v) && v > 0 && v <= MAX_FIT_SIZE);
function readFitSize() {
  const values = ['fitW', 'fitD', 'fitH'].map((id) => Number($(id).value));
  return validSize(values) ? values : null;
}

function showFitStatus(text, cls = '') {
  $('fitStatus').textContent = text;
  $('fitStatus').className = cls;
}

function updateFit() {
  fitLineGroup.clear();
  $('fitLabels').replaceChildren();
  fitLines = [];
  const visible = fit && (walking || level === 'both' || level === fit.level);
  fitMesh.visible = !!visible;
  if (!fit) {
    showFitStatus('Enter a size in inches or pick a saved one, then tap Place.');
    return;
  }
  const f = fitBounds();
  fitMesh.scale.set(fit.spanX, fit.h, fit.spanY);
  fitMesh.position.copy(toWorld(fit.x, fit.y, fit.z + fit.h / 2));

  const { hits, clear } = fitReport(fitSolids, f);
  if (fit.h > CEILING) hits.push('Ceiling');
  fitMaterial.color.set(hits.length ? 0xd1341f : 0x3f9a4a);
  showFitStatus(hits.length ? `Doesn't fit, hits: ${hits.join(', ')}` : 'Fits', hits.length ? 'bad' : 'good');

  if (!visible) return;
  // A blue line and a number across each open side of the box.
  const midZ = fit.z + fit.h / 2;
  const sides = [
    ['north', fit.x, f.y1, fit.x, f.y1 + clear.north],
    ['south', fit.x, f.y0, fit.x, f.y0 - clear.south],
    ['east', f.x1, fit.y, f.x1 + clear.east, fit.y],
    ['west', f.x0, fit.y, f.x0 - clear.west, fit.y],
  ];
  for (const [side, x0, y0, x1, y1] of sides) {
    if (!Number.isFinite(clear[side])) continue;
    const a = toWorld(x0, y0, midZ), b = toWorld(x1, y1, midZ);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), fitLineMaterial);
    line.renderOrder = 2;
    fitLineGroup.add(line);
    const el = document.createElement('div');
    el.className = 'label clearance';
    el.textContent = inchesShort(clear[side]);
    $('fitLabels').append(el);
    fitLines.push({ el, at: a.clone().add(b).multiplyScalar(0.5) });
  }
}

function placeFit() {
  const size = readFitSize();
  if (!size) {
    showFitStatus('Enter a width, depth and height, each from 1 to 400 inches.', 'bad');
    return;
  }
  const lv = level === 2 ? 2 : 1;
  const z = lv === 2 ? FLOOR_TO_FLOOR : 0;
  const floor = buildModel({ level: lv });
  // Walking: a few feet ahead. Otherwise the middle of the floor's main room, ready to drag.
  const main = floor.rooms[0];
  const spot = walking
    ? { x: body.x - Math.sin(yaw) * 60, y: body.y + Math.cos(yaw) * 60 }
    : { x: (main.x0 + main.x1) / 2, y: (main.y0 + main.y1) / 2 };
  const [w, d, h] = size;
  fit = { x: spot.x, y: spot.y, z, level: lv, spanX: w, spanY: d, h, rotated: false };
  fitSolids = floor.boxes.filter(notFloor);
  updateFit();
}

// Editing the size updates a box that's already placed, keeping its spot and its rotation.
function resizeFit() {
  const size = readFitSize();
  if (!fit || !size) return;
  const [w, d, h] = size;
  fit.spanX = fit.rotated ? d : w;
  fit.spanY = fit.rotated ? w : d;
  fit.h = h;
  updateFit();
}

// Sizes to test, kept by name. On the site they live on the server, so the phone in a store sees what the laptop entered.
const FITS_URL = '/dossier/api/files/floorplan-fits.json', FITS_KEY = 'floorplan-fits';
let fits = [], fitsLoaded = false;

function showFits() {
  $('fitSaved').replaceChildren(new Option(fits.length ? 'Saved sizes' : 'No saved sizes yet', ''),
    ...fits.map((f, i) => new Option(`${f.name} (${f.w} × ${f.d} × ${f.h})`, i)));
}

async function loadFits() {
  try {
    const data = onSite
      ? await fetch(FITS_URL, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : r.status === 404 ? [] : Promise.reject(new Error(r.status))))
      : JSON.parse(local.get(FITS_KEY) ?? '[]');
    fits = (Array.isArray(data) ? data : []).filter((f) => typeof f?.name === 'string' && validSize([f.w, f.d, f.h]));
    fitsLoaded = true;
  } catch (err) {
    console.warn('saved sizes not loaded', err);
  }
  showFits();
}

async function storeFits(next) {
  // Writing a list that never loaded would wipe the one on the server.
  if (!fitsLoaded) {
    showFitStatus('Saved sizes did not load, so saving now would replace them. Reload when you have signal.', 'bad');
    return false;
  }
  const text = JSON.stringify(next, null, 2);
  if (onSite) {
    let problem = null;
    try {
      const res = await fetch(FITS_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: text });
      if (res.status === 401) problem = 'Your sign-in expired. Reload to sign in.';
      else if (!res.ok) problem = `The server said ${res.status}.`;
    } catch {
      problem = 'No connection.';
    }
    if (problem) {
      showFitStatus(`Not saved. ${problem}`, 'bad');
      return false;
    }
  } else {
    local.set(FITS_KEY, text);
  }
  fits = next;
  showFits();
  return true;
}

// Grabbing and dragging the box along its floor
let dragging = null;
const floorPoint = (clientX, clientY, z = fit.z) => {
  aim(clientX, clientY);
  return raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -z), new THREE.Vector3());
};

function dragTo(clientX, clientY) {
  const hit = floorPoint(clientX, clientY);
  if (!hit) return;
  const p = toPlan(hit);
  fit.x = Math.min(BOUNDS.x1, Math.max(BOUNDS.x0, p.x + dragging.dx));
  fit.y = Math.min(BOUNDS.y1, Math.max(BOUNDS.y0, p.y + dragging.dy));
  const pull = snapFit(fitSolids, fitBounds(), viewScale(camera, hit) * 10);
  fit.x += pull.dx;
  fit.y += pull.dy;
  updateFit();
}

// Moving furniture. Drags along a flat plane at the height it was grabbed, so the piece stays under the pointer.
let moving = false, selected = null, moveDrag = null, unsaved = !!pending, saveFile = null, overwrite = false;
// Undo steps, as layout snapshots. The saved layout is the one at depth savedAt, so undoing back to it is clean again.
const history = [];
let savedAt = pending ? -1 : 0;
const selectionBox = new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ color: 0x1f5fbf, depthTest: false }));
selectionBox.renderOrder = 2;
selectionBox.visible = false;
scene.add(selectionBox);

function othersOf(id) {
  return buildModel({ level: 'both' }).boxes.filter((b) => b.piece !== id && notFloor(b));
}

function showMoveStatus(text, cls = '') {
  $('moveStatus').textContent = text;
  $('moveStatus').className = cls;
}

function showSelection(f, others) {
  selectionBox.scale.set(f.x1 - f.x0, f.z1 - f.z0, f.y1 - f.y0);
  selectionBox.position.copy(toWorld((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, (f.z0 + f.z1) / 2));
  const { hits, clear } = fitReport(others, f);
  const gaps = Object.entries(clear).filter(([, d]) => Number.isFinite(d)).map(([side, d]) => `${side} ${inchesShort(d)}`).join(', ');
  showMoveStatus(hits.length ? `${selected} overlaps: ${hits.join(', ')}` : `${selected}: ${gaps}`, hits.length ? 'bad' : '');
}

function updateSelection() {
  selectionBox.visible = !!selected;
  $('moveRotate').disabled = $('moveRotate90').disabled = $('moveReset').disabled = !selected;
  $('moveUndo').disabled = !history.length;
  $('moveSave').disabled = $('moveDiscard').disabled = !unsaved;
  if (!selected) {
    const keysHint = matchMedia('(pointer: fine)').matches ? ' Arrow keys nudge it 1", with Shift 1/4".' : '';
    showMoveStatus(unsaved ? 'You have moves that are not saved yet.' : `Tap a piece of furniture, then drag it.${keysHint}`);
    return;
  }
  showSelection(pieceBounds(buildModel({ level: 'both' }).boxes, selected), othersOf(selected));
}

function layoutChanged() {
  unsaved = history.length !== savedAt;
  local.set(UNSAVED_KEY, unsaved ? JSON.stringify(layout) : null);
  local.set(BASE_KEY, unsaved ? base : null);
  rebuild();
  updateSelection();
  if (fit) { fitSolids = buildModel({ level: fit.level }).boxes.filter(notFloor); updateFit(); }
}

function remember() {
  // A new change after undoing past the save means the saved layout can't be reached by undo any more.
  if (history.length < savedAt) savedAt = -1;
  history.push(JSON.stringify(layout));
}

function change(edit) {
  remember();
  edit();
  layoutChanged();
}

function undo() {
  if (!history.length || moveDrag) return;
  clearLayout();
  Object.assign(layout, JSON.parse(history.pop()));
  layoutChanged();
}

function startMoveDrag(e) {
  const hit = pieceUnder(e.clientX, e.clientY);
  const id = hit?.object.userData.piece;
  if (!id) return;
  selected = id;
  const { dx = 0, dy = 0, rot = 0 } = layout[id] ?? {};
  const from = pieceBounds(buildModel({ level: 'both' }).boxes, id);
  const meshes = group.children.filter((o) => o.userData.piece === id).map((o) => [o, o.position.clone()]);
  moveDrag = { pointer: e.pointerId, screenX: e.clientX, screenY: e.clientY, started: false, height: hit.point.y, grab: toPlan(hit.point), dx, dy, rot, from, meshes, others: othersOf(id) };
  controls.enabled = false;
  updateSelection();
}

function moveDragTo(e) {
  const d = moveDrag, f = d.from;
  // A click that wobbles only selects, it doesn't nudge the piece or snap it to something. Fingers wobble more than a mouse.
  if (!d.started) {
    if (Math.hypot(e.clientX - d.screenX, e.clientY - d.screenY) < (e.pointerType === 'touch' ? 10 : 4)) return;
    d.started = true;
    remember();
  }
  const hit = floorPoint(e.clientX, e.clientY, d.height);
  if (!hit) return;
  const p = toPlan(hit);
  const quarter = (n) => Math.round(n * 4) / 4;
  let mx = quarter(p.x - d.grab.x), my = quarter(p.y - d.grab.y);
  mx = Math.min(BOUNDS.x1 - f.x1, Math.max(BOUNDS.x0 - f.x0, mx));
  my = Math.min(BOUNDS.y1 - f.y1, Math.max(BOUNDS.y0 - f.y0, my));
  const pull = snapFit(d.others, { ...f, x0: f.x0 + mx, x1: f.x1 + mx, y0: f.y0 + my, y1: f.y1 + my }, viewScale(camera, hit) * 10);
  const ox = mx + pull.dx, oy = my + pull.dy;
  layout[selected] = { dx: d.dx + ox, dy: d.dy + oy, rot: d.rot };
  // Only the piece's meshes slide while dragging. Rebuilding the whole model on every move stutters on phones; letting go rebuilds once.
  const shift = toWorld(ox, oy, 0);
  for (const [o, at] of d.meshes) o.position.copy(at).add(shift);
  showSelection({ ...f, x0: f.x0 + ox, x1: f.x1 + ox, y0: f.y0 + oy, y1: f.y1 + oy }, d.others);
}

function endMoveDrag() {
  const started = moveDrag.started;
  moveDrag = null;
  controls.enabled = !walking;
  if (started) layoutChanged();
}

function setMoving(on) {
  moving = on;
  press('move', on);
  $('movePanel').hidden = !on;
  if (!on) selected = null;
  hoverName.hidden = true;
  canvas.style.cursor = '';
  updateSelection();
  resize();
}

// Arrow keys move the selected piece the way the arrow points on screen, along the nearest wall direction.
const ARROWS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
function screenAxis(v) {
  v.applyQuaternion(camera.quaternion);
  const x = v.x, y = -v.z;
  return Math.abs(x) > Math.abs(y) ? { x: Math.sign(x), y: 0 } : { x: 0, y: Math.sign(y) };
}
function nudge([right, up], step) {
  const r = screenAxis(new THREE.Vector3(1, 0, 0));
  // The top view looks straight down, so screen-up is the camera's up. In 3D it's the way the camera faces.
  const u = screenAxis(camera === ortho ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1));
  const m = layout[selected] ?? { dx: 0, dy: 0, rot: 0 };
  change(() => { layout[selected] = { ...m, dx: m.dx + (r.x * right + u.x * up) * step, dy: m.dy + (r.y * right + u.y * up) * step }; });
}

// On the website, writes to the server. The local copy writes layout.json over the project's file.
// Either way the page reads it back to check it landed. On the site that also refreshes the offline copy.
async function saveLayout() {
  const text = JSON.stringify(layout, null, 2);
  // Another device may have saved since these moves began. Say so once; a second Save replaces it.
  const current = await fetchLayoutText('no-store');
  if (!overwrite && base != null && current != null && current !== base && current !== text) {
    overwrite = true;
    showMoveStatus('Another device saved a different layout after you started these moves. Save again to replace it with yours, or Discard to load theirs.', 'bad');
    return;
  }
  if (onSite) {
    showMoveStatus('Saving...');
    let message = null;
    try {
      const res = await fetch('/dossier/api/files/floorplan-layout.json', { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: text });
      if (res.status === 401) message = 'Your sign-in expired. Reload to sign in, then Save again.';
      else if (!res.ok) message = `The server said ${res.status}.`;
    } catch {
      message = 'No connection. Save again when you have signal.';
    }
    if (!message && await fetchLayoutText('no-store') !== text) message = 'The server did not keep the change. Try again.';
    if (message) {
      showMoveStatus(`Not saved. ${message} Your moves are kept on this device.`, 'bad');
      return;
    }
    markSaved(text, 'Saved. Every device gets this on its next load.');
    return;
  }
  if (!window.showSaveFilePicker) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = 'layout.json';
    link.click();
    URL.revokeObjectURL(link.href);
    showMoveStatus('Downloaded layout.json. Put it in the Apartment Floorplan folder, replacing the old one.');
    return;
  }
  try {
    saveFile ??= await window.showSaveFilePicker({ suggestedName: 'layout.json', types: [{ description: 'Furniture layout', accept: { 'application/json': ['.json'] } }] });
    const out = await saveFile.createWritable();
    await out.write(text);
    await out.close();
  } catch (err) {
    if (err.name === 'AbortError') return;
    saveFile = null;
    showMoveStatus(`Not saved: ${err.message}`, 'bad');
    return;
  }
  if (await fetchLayoutText('no-store') !== text) {
    saveFile = null;
    showMoveStatus('Saved, but not in the Apartment Floorplan folder, so the phone will not see it. Save again and pick layout.json in that folder.', 'bad');
    return;
  }
  markSaved(text, 'Saved. Refresh the phone to see it.');
}

function markSaved(text, message) {
  unsaved = overwrite = false;
  base = text;
  savedAt = history.length;
  local.set(UNSAVED_KEY, null);
  local.set(BASE_KEY, null);
  $('moveSave').disabled = $('moveDiscard').disabled = true;
  showMoveStatus(message, 'good');
}

// Walking
const body = { x: 0, y: 0, feet: 0 };
let yaw = 0, pitch = 0, solidsForWalk = null, look = null;
const keys = new Set();
const stick = { x: 0, y: 0, id: null };

function goToStart(lv) {
  const s = WALK_STARTS[lv === 2 ? 2 : 1];
  Object.assign(body, s);
  delete body.yaw;
  yaw = s.yaw;
  pitch = 0;
}

function stepWalk(dt) {
  let forward = stick.y + (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  let right = stick.x + (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  const len = Math.hypot(forward, right);
  if (len > 1) { forward /= len; right /= len; }
  const dist = WALK.speed * Math.min(dt, 0.1);
  const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * dist;
  const dy = (Math.cos(yaw) * forward + Math.sin(yaw) * right) * dist;
  Object.assign(body, moveBody(solidsForWalk, body, dx, dy));
  // Ease the height so each stair step reads as a slope rather than a jerk.
  body.feet += (groundAt(solidsForWalk, body.x, body.y, body.feet) - body.feet) * Math.min(1, dt * 10);
  persp.position.copy(toWorld(body.x, body.y, body.feet + WALK.eye));
  persp.rotation.set(pitch, yaw, 0);
}

const STICK_RADIUS = 44;
const setStick = (e) => {
  const r = $('stick').getBoundingClientRect();
  let x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
  const len = Math.hypot(x, y);
  if (len > STICK_RADIUS) { x *= STICK_RADIUS / len; y *= STICK_RADIUS / len; }
  $('stickKnob').style.transform = `translate(${x}px, ${y}px)`;
  stick.x = x / STICK_RADIUS;
  stick.y = -y / STICK_RADIUS;
};
$('stick').addEventListener('pointerdown', (e) => {
  stick.id = e.pointerId;
  $('stick').setPointerCapture(e.pointerId);
  setStick(e);
});
$('stick').addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) setStick(e); });
const releaseStick = (e) => {
  if (e.pointerId !== stick.id) return;
  stick.id = null;
  stick.x = stick.y = 0;
  $('stickKnob').style.transform = '';
};
$('stick').addEventListener('pointerup', releaseStick);
$('stick').addEventListener('pointercancel', releaseStick);

const typing = (e) => ['INPUT', 'SELECT'].includes(e.target.tagName);
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (walking) { keys.add(e.code); return; }
  if (moving && (e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
    e.preventDefault();
    undo();
    return;
  }
  if (moving && selected && !moveDrag && ARROWS[e.key]) {
    e.preventDefault();
    nudge(ARROWS[e.key], e.shiftKey ? 0.25 : 1);
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));

// Canvas gestures. Capture runs before OrbitControls, so grabbing the box can switch orbiting off.
let down = null;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, id: e.pointerId };
  if (walking) {
    look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    return;
  }
  if (moving) {
    startMoveDrag(e);
    return;
  }
  if (fit && fitMesh.visible && !measuring) {
    aim(e.clientX, e.clientY);
    if (raycaster.intersectObject(fitMesh, false).length) {
      const p = toPlan(floorPoint(e.clientX, e.clientY));
      dragging = { id: e.pointerId, dx: fit.x - p.x, dy: fit.y - p.y };
      controls.enabled = false;
    }
  }
}, { capture: true });

addEventListener('pointermove', (e) => {
  if (look && e.pointerId === look.id) {
    yaw -= (e.clientX - look.x) * 0.005;
    pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - look.y) * 0.005));
    look.x = e.clientX;
    look.y = e.clientY;
  }
  if (dragging && e.pointerId === dragging.id) dragTo(e.clientX, e.clientY);
  if (moveDrag && e.pointerId === moveDrag.pointer) moveDragTo(e);
});

// With a mouse in Move mode, the piece under the pointer shows its name.
const hoverName = $('hoverName');
canvas.addEventListener('pointermove', (e) => {
  if (!moving || moveDrag || e.pointerType !== 'mouse' || e.buttons) { hoverName.hidden = true; return; }
  const id = pieceUnder(e.clientX, e.clientY)?.object.userData.piece;
  hoverName.hidden = !id;
  canvas.style.cursor = id ? 'grab' : '';
  if (!id) return;
  hoverName.textContent = id;
  hoverName.style.left = `${e.clientX}px`;
  hoverName.style.top = `${e.clientY - 20}px`;
});
canvas.addEventListener('pointerleave', () => { hoverName.hidden = true; });

// On the window, so letting go over the button bar still drops what was being dragged.
const endPointer = (e) => {
  if (measuring && down && down.id === e.pointerId && e.type === 'pointerup' && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8) {
    tapAt(e.clientX, e.clientY);
  }
  if (down && down.id === e.pointerId) down = null;
  if (look && look.id === e.pointerId) look = null;
  if (dragging && dragging.id === e.pointerId) {
    dragging = null;
    controls.enabled = !walking;
  }
  if (moveDrag && moveDrag.pointer === e.pointerId) endMoveDrag();
};
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);

// Buttons
const press = (id, on) => $(id).setAttribute('aria-pressed', String(on));

// The view, floor and Low setting come back on the next visit. Walking starts fresh.
const VIEW_KEY = 'floorplan-view';
function refreshButtons() {
  const top = camera === ortho && !walking;
  $('view').value = walking ? 'walk' : top ? 'top' : '3d';
  $('floor').value = String(level);
  $('floor').querySelector('[value="both"]').disabled = top || walking;
  $('low').disabled = top || walking;
  $('move').disabled = walking;
  $('stick').hidden = !walking;
  local.set(VIEW_KEY, JSON.stringify({ top, level, low }));
}

function setView(cam) {
  walking = false;
  camera = cam;
  controls.object = cam;
  controls.enabled = true;
  const top = cam === ortho;
  // The top view shows one floor at a time.
  if (top && level === 'both') level = 1;
  center.y = level === 2 ? FLOOR_TO_FLOOR : 0;
  controls.target.copy(center);
  controls.enableRotate = !top;
  controls.mouseButtons.LEFT = top ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
  controls.touches.ONE = top ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
  if (top) ortho.position.set(center.x, 800, center.z);
  else {
    persp.fov = 45;
    persp.near = 5;
    persp.position.copy(center).add(new THREE.Vector3(...startView()));
    persp.updateProjectionMatrix();
  }
  cam.zoom = 1;
  cam.updateProjectionMatrix();
  controls.update();
  refreshButtons();
  rebuild();
  updateFit();
  clearMeasures();
  if (moving) { selected = null; updateSelection(); }
}

function startWalking() {
  if (moving) setMoving(false);
  walking = true;
  camera = persp;
  controls.enabled = false;
  if (level === 'both') level = 1;
  persp.fov = 70;
  persp.near = 1;
  persp.updateProjectionMatrix();
  solidsForWalk = walkSolids();
  goToStart(level);
  refreshButtons();
  rebuild();
  updateFit();
  clearMeasures();
}

// Blur after picking, so walking's arrow keys don't change the menu.
$('view').onchange = (e) => {
  const v = e.target.value;
  e.target.blur();
  if (v === 'walk') startWalking(); else setView(v === 'top' ? ortho : persp);
};
$('floor').onchange = (e) => {
  const v = e.target.value;
  e.target.blur();
  level = v === 'both' ? 'both' : Number(v);
  if (walking) { goToStart(level); refreshButtons(); updateFit(); } else setView(camera);
};

$('low').onclick = () => {
  low = !low;
  rebuild();
  press('low', low);
  refreshButtons();
};

$('move').onclick = () => {
  if (!moving && measuring) $('measure').click();
  setMoving(!moving);
};
const rotateBy = (deg) => () => {
  const m = layout[selected] ?? { dx: 0, dy: 0, rot: 0 };
  change(() => { layout[selected] = { ...m, rot: (m.rot + deg) % 360 }; });
};
$('moveRotate').onclick = rotateBy(30);
$('moveRotate90').onclick = rotateBy(90);
$('moveReset').onclick = () => change(() => { delete layout[selected]; });
$('moveUndo').onclick = undo;
$('moveSave').onclick = saveLayout;
$('moveDiscard').onclick = () => {
  local.set(UNSAVED_KEY, null);
  local.set(BASE_KEY, null);
  location.reload();
};

$('measure').onclick = () => {
  if (!measuring && moving) setMoving(false);
  measuring = !measuring;
  press('measure', measuring);
  readout.hidden = !measuring;
  clearMeasures();
};

$('fitToggle').onclick = () => {
  const open = $('fitPanel').hidden;
  $('fitPanel').hidden = !open;
  press('fitToggle', open);
  updateFit();
  resize();
};
$('fitPlace').onclick = placeFit;
$('fitRotate').onclick = () => {
  if (!fit) return;
  [fit.spanX, fit.spanY] = [fit.spanY, fit.spanX];
  fit.rotated = !fit.rotated;
  updateFit();
};
$('fitRemove').onclick = () => {
  fit = null;
  updateFit();
};
for (const id of ['fitW', 'fitD', 'fitH']) $(id).addEventListener('input', resizeFit);

$('fitSaved').onchange = (e) => {
  const f = fits[e.target.value];
  if (!f) return;
  $('fitW').value = f.w;
  $('fitD').value = f.d;
  $('fitH').value = f.h;
  $('fitName').value = f.name;
  if (fit) resizeFit(); else placeFit();
};
$('fitKeep').onclick = async () => {
  const size = readFitSize(), name = $('fitName').value.trim();
  if (!size || !name) {
    showFitStatus('Enter a name and a width, depth and height to save a size.', 'bad');
    return;
  }
  const [w, d, h] = size;
  // Saving under a name that's already there updates it.
  const next = [...fits.filter((f) => f.name !== name), { name, w, d, h }].sort((a, b) => a.name.localeCompare(b.name));
  if (!await storeFits(next)) return;
  $('fitSaved').value = String(next.findIndex((f) => f.name === name));
  showFitStatus(`Saved "${name}".`, 'good');
};
$('fitForget').onclick = async () => {
  const f = fits[$('fitSaved').value];
  if (!f) {
    showFitStatus('Pick a saved size to delete.', 'bad');
    return;
  }
  if (await storeFits(fits.filter((x) => x !== f))) showFitStatus(`Deleted "${f.name}".`, 'good');
};
loadFits();

// The 3D view as a PNG, room labels and measurements included. Phones get the share sheet, computers a download.
async function saveImage() {
  // WebGL only lets the picture be copied in the same moment it is drawn.
  renderer.render(scene, camera);
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  ctx.scale(canvas.width / canvas.clientWidth, canvas.width / canvas.clientWidth);
  ctx.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const { el } of [...labels, ...fitLines, ...measureLabels]) {
    if (el.hidden) continue;
    const x = parseFloat(el.style.left), y = parseFloat(el.style.top);
    const lines = el.textContent.split('\n'), bg = getComputedStyle(el).backgroundColor;
    lines.forEach((text, i) => {
      const ly = y + (i - (lines.length - 1) / 2) * 15;
      if (bg !== 'rgba(0, 0, 0, 0)') {
        const w = ctx.measureText(text).width + 8;
        ctx.fillStyle = bg;
        ctx.fillRect(x - w / 2, ly - 9, w, 18);
      } else {
        ctx.strokeStyle = 'rgba(0, 0, 0, .8)';
        ctx.lineWidth = 3;
        ctx.strokeText(text, x, ly);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x, ly);
    });
  }
  const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  const file = new File([blob], 'apartment.png', { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('share failed', err);
    }
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(link.href);
}
$('image').onclick = saveImage;

// Questions about the apartment, answered by Claude on the server from this same model. Only on the site,
// which holds the AI key. The conversation lasts until the page reloads.
const chat = [];
function addChatLine(cls, text) {
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  $('askLog').append(p);
  $('askLog').scrollTop = $('askLog').scrollHeight;
  resize();
  return p;
}
$('askToggle').hidden = !onSite;
$('askToggle').onclick = () => {
  const open = $('askPanel').hidden;
  $('askPanel').hidden = !open;
  press('askToggle', open);
  resize();
  if (open) $('askInput').focus();
};
$('askForm').onsubmit = async (e) => {
  e.preventDefault();
  const question = $('askInput').value.trim();
  if (!question || $('askSend').disabled) return;
  $('askInput').value = '';
  $('askSend').disabled = true;
  addChatLine('q', question);
  const wait = addChatLine('wait', 'Looking that up...');
  chat.push({ role: 'user', content: question });
  let reply = null, problem = null;
  try {
    // The server takes up to 39 earlier messages. An odd count keeps the oldest one a question.
    const res = await fetch('/dossier/api/floorplan/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chat.slice(-39), layout }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) reply = data.reply;
    else problem = res.status === 401 ? 'Your sign-in expired. Reload to sign in.' : data.error || `The server said ${res.status}.`;
  } catch {
    problem = 'No connection. Ask again when you have signal.';
  }
  wait.remove();
  if (reply) {
    chat.push({ role: 'assistant', content: reply.slice(0, 4000) });
    addChatLine('a', reply);
  } else {
    // Drop the unanswered question so the conversation still alternates question, answer.
    chat.pop();
    addChatLine('bad', problem);
  }
  $('askSend').disabled = false;
};

function resize() {
  const w = innerWidth, h = innerHeight - $('bar').offsetHeight;
  renderer.setSize(w, h);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  // Top view: on portrait the patio is up and north is right, the same as the printed plan.
  const aspect = w / h, portrait = aspect < 1;
  ortho.up.set(portrait ? -1 : 0, 0, portrait ? 0 : -1);
  ortho.lookAt(center);
  const across = portrait ? planWidth : planLength, along = portrait ? planLength : planWidth;
  const halfH = Math.max(along / 2, across / 2 / aspect) * 1.04;
  ortho.top = halfH; ortho.bottom = -halfH;
  ortho.left = -halfH * aspect; ortho.right = halfH * aspect;
  ortho.updateProjectionMatrix();
  $('stick').style.bottom = `${$('bar').offsetHeight + 16}px`;
}
addEventListener('resize', resize);

// Before anything calls refreshButtons, which saves the view it shows.
try {
  const last = JSON.parse(local.get(VIEW_KEY));
  if (last) {
    if ([1, 2, 'both'].includes(last.level)) level = last.level;
    low = last.low === true;
    press('low', low);
    setView(last.top ? ortho : persp);
  }
} catch (err) {
  console.warn('last view not restored', err);
}
resize();
refreshButtons();
updateFit();

const v = new THREE.Vector3();
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (walking) stepWalk(dt);
  else controls.update();
  // Keep markers the same size on screen, however far away they are.
  for (const m of measureGroup.children) if (m.isMesh) m.scale.setScalar(viewScale(camera, m.position) * 6);
  renderer.render(scene, camera);
  for (const { el, at } of [...labels, ...fitLines, ...measureLabels]) {
    v.copy(at).project(camera);
    // Anything behind a walking camera projects to a misleading spot, so hide it.
    el.hidden = v.z > 1;
    el.style.left = `${(v.x + 1) / 2 * canvas.clientWidth}px`;
    el.style.top = `${(1 - v.y) / 2 * canvas.clientHeight}px`;
  }
});
