// Turns apartment.js into plain lists of shapes, with no Three.js here, so check.mjs can test it in Node.
import * as A from './apartment.js';

const E = A.EXTERIOR_WALL, L = A.LENGTH, W = A.WIDTH, FF = A.FLOOR_TO_FLOOR, P = A.PATIO;

// Furniture moved by hand, by piece name: { dx, dy, rot } with rot in degrees clockwise. Saved as layout.json.
// Two reserved keys ride along, so saving, undo and unsaved changes cover them too:
//   _colors: { 'Shoe rack': '#e0b020' }  a new color for a piece or a named part of the building
//   _added:  [{ name, shape: 'box' | 'cylinder' | 'parts', w, d, h, x, y, z, level, color, parts? }]  extra objects;
//            x and y are the center, z the bottom above that floor, and a cylinder's diameter is w. They move like
//            furniture. A 'parts' object is built from up to 24 upright shapes, each placed relative to the object's
//            center and bottom: { shape: 'box' | 'cylinder' | 'cone' | 'sphere', x, y, z, w, d, h, top, color }.
//            w is a round part's diameter, top a cone's top diameter, and a sphere's size is w alone.
export const layout = {};
const HEX = /^#[0-9a-f]{6}$/i;
const size = (n) => Number.isFinite(n) && n > 0 && n <= 400;
const near = (n) => Number.isFinite(n) && Math.abs(n) <= 400;
const validPart = (p) => ['box', 'cylinder', 'cone', 'sphere'].includes(p?.shape) && near(p.x) && near(p.y) && near(p.z) && p.z >= 0
  && size(p.w) && size(p.d) && size(p.h) && (p.shape !== 'cone' || (Number.isFinite(p.top) && p.top >= 0 && p.top <= 400)) && HEX.test(p.color);
const validAdded = (a) => typeof a?.name === 'string' && a.name.length > 0 && a.name.length <= 60 && !a.name.startsWith('_')
  && ['box', 'cylinder', 'parts'].includes(a.shape) && size(a.w) && size(a.d) && size(a.h)
  && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z) && a.z >= 0 && a.z <= 400
  && (a.level === 1 || a.level === 2) && HEX.test(a.color)
  && (a.shape !== 'parts' || (Array.isArray(a.parts) && a.parts.length > 0 && a.parts.length <= 24 && a.parts.every(validPart)));
const keepPart = ({ shape, x, y, z, w, d, h, top, color }) => ({ shape, x, y, z, w, d, h, ...(shape === 'cone' && { top }), color });
export function loadLayout(data) {
  for (const [id, m] of Object.entries(data ?? {})) {
    if (id === '_colors') {
      const colors = Object.entries(m ?? {}).filter(([name, c]) => name.length <= 80 && HEX.test(c));
      if (colors.length) layout._colors = Object.fromEntries(colors);
    } else if (id === '_added') {
      const names = new Set();
      const added = (Array.isArray(m) ? m : []).filter((a) => validAdded(a) && !names.has(a.name) && names.add(a.name)).slice(0, 100)
        .map(({ name, shape, w, d, h, x, y, z, level, color, parts }) => ({ name, shape, w, d, h, x, y, z, level, color, ...(shape === 'parts' && { parts: parts.map(keepPart) }) }));
      if (added.length) layout._added = added;
    } else if (Number.isFinite(m?.dx) && Number.isFinite(m?.dy) && Number.isInteger(m?.rot)) {
      layout[id] = { dx: m.dx, dy: m.dy, rot: m.rot };
    }
  }
}

// Footprint of a movable piece, from the boxes of a model built with it in.
export function pieceBounds(boxes, id) {
  const own = boxes.filter((b) => b.piece === id);
  const edge = (key, pick) => pick(...own.map((b) => b[key]));
  return { name: id, x0: edge('x0', Math.min), x1: edge('x1', Math.max), y0: edge('y0', Math.min), y1: edge('y1', Math.max), z0: edge('z0', Math.min), z1: edge('z1', Math.max) };
}

// Plan area of the whole property, for fitting the top view.
export const BOUNDS = { x0: -E - P.depth - P.fenceThick, x1: L + E, y0: W - P.width - P.fenceThick, y1: W + E };

// level is 1, 2 or 'both'. cut is a height above the top visible floor, for the low-wall view.
// Returns { boxes, beams, prisms, rooms }.
// ceilings adds the room ceilings, which walk mode needs and the views from above must leave out.
// furniture: false gives the bare building, which check.mjs compares with the tape.
export function buildModel({ level = 'both', cut = Infinity, ceilings = false, furniture = true } = {}) {
  const cutZ = (level === 1 ? 0 : FF) + cut;
  const boxes = [], beams = [], prisms = [], rooms = [];
  let base = 0, show = true, extent = null;

  const section = (lv, b, fn) => { show = level === 'both' || level === lv; base = b; fn(); show = true; base = 0; };
  const box = (name, color, x0, x1, y0, y1, z0, z1, extra) => {
    if (!show) return;
    if (extent) {
      extent.x0 = Math.min(extent.x0, x0); extent.x1 = Math.max(extent.x1, x1);
      extent.y0 = Math.min(extent.y0, y0); extent.y1 = Math.max(extent.y1, y1);
    }
    z0 += base;
    z1 = Math.min(z1 + base, cutZ);
    if (x1 > x0 && y1 > y0 && z1 > z0) boxes.push({ name, color, x0, x1, y0, y1, z0, z1, ...extra });
  };
  const room = (name, x0, x1, y0, y1) => { if (show) rooms.push({ name, x0, x1, y0, y1, z: base }); };
  const C = A.COLORS;

  // A wall running along one axis, with its openings cut out. `along` is 'x' or 'y'.
  const wall = (name, along, a0, a1, t0, t1, openings = [], top = A.CEILING) => {
    const seg = (s0, s1, z0, z1) => along === 'x'
      ? box(name, C.wall, s0, s1, t0, t1, z0, z1)
      : box(name, C.wall, t0, t1, s0, s1, z0, z1);
    let at = a0;
    for (const o of [...openings].sort((p, q) => p.at - q.at)) {
      seg(at, o.at, 0, top);
      if (o.sill > 0) seg(o.at, o.at + o.w, 0, o.sill);
      if (o.head < top) seg(o.at, o.at + o.w, o.head, top);
      at = o.at + o.w;
    }
    seg(at, a1, 0, top);
  };

  // Glass plus trim on the room-facing side. `face` is the wall face, `dir` points into the room.
  const glazing = (name, along, o, tMid, face, dir, trim) => {
    const pane = (s0, s1, t0, t1, z0, z1, color, n) => along === 'x'
      ? box(n, color, s0, s1, t0, t1, z0, z1)
      : box(n, color, t0, t1, s0, s1, z0, z1);
    pane(o.at, o.at + o.w, tMid - 0.5, tMid + 0.5, o.sill, o.head, C.glass, name);
    const t0 = Math.min(face, face + dir * 0.75), t1 = Math.max(face, face + dir * 0.75);
    pane(o.at - trim, o.at, t0, t1, o.sill - trim, o.head + trim, C.trim, `${name} trim`);
    pane(o.at + o.w, o.at + o.w + trim, t0, t1, o.sill - trim, o.head + trim, C.trim, `${name} trim`);
    pane(o.at, o.at + o.w, t0, t1, o.head, o.head + trim, C.trim, `${name} trim`);
    if (o.sill > 0) pane(o.at, o.at + o.w, t0, t1, o.sill - trim, o.sill, C.trim, `${name} trim`);
  };
  const door = (at, w) => ({ at, w, sill: 0, head: A.DOOR_HEAD });
  const win = (at, w, h) => ({ at, w, sill: A.SILL, head: A.SILL + h });

  const southNorth = () => {
    wall('South wall', 'x', -E, L + E, -E, 0);
    wall('North wall', 'x', -E, L + E, W, W + E);
  };

  // A piece from its west and south edges and its size along each axis.
  const item = (name, color, x0, y0, dx, dy, z0, z1) => box(name, color, x0, x0 + dx, y0, y0 + dy, z0, z1);
  // Open shapes like a lamp or easel block walking and test fit across their whole taped outline.
  const outline = (name, x0, y0, dx, dy, h, z0 = 0) => box(name, C.trim, x0, x0 + dx, y0, y0 + dy, z0, h, { hidden: true });
  // rTop makes it a cone with its tip cut off (rTop 0 is a full cone). shortcut: the low-wall cut keeps the top radius.
  const column = (name, color, x, y, r, z0, z1, rTop) => {
    if (show && z0 + base < cutZ) beams.push({ name, color, r, rTop, a: [x, y, z0 + base], b: [x, y, Math.min(z1 + base, cutZ)] });
  };
  const ball = (name, color, x, y, zCenter, r) => {
    if (show && zCenter + base < cutZ) beams.push({ name, color, r, sphere: true, a: [x, y, zCenter + base], b: [x, y, zCenter + base] });
  };

  // Everything fn draws becomes one piece you can select, moved and turned about its own center.
  // The center comes from the uncut shapes, so the low-wall views turn a piece about the same point.
  const piece = (id, fn) => {
    const firstBox = boxes.length, firstBeam = beams.length;
    extent = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    fn();
    const cx = (extent.x0 + extent.x1) / 2, cy = (extent.y0 + extent.y1) / 2;
    extent = null;
    const { dx = 0, dy = 0, rot = 0 } = layout[id] ?? {};
    // Rounded so square turns land exactly on the grid and stay plain boxes.
    const rad = rot * Math.PI / 180, cos = Math.round(Math.cos(rad) * 1e12) / 1e12, sin = Math.round(Math.sin(rad) * 1e12) / 1e12;
    const place = (x, y) => {
      const rx = x - cx, ry = y - cy;
      return [cx + rx * cos + ry * sin + dx, cy - rx * sin + ry * cos + dy];
    };
    for (const b of boxes.slice(firstBox)) {
      const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => place(x, y));
      const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
      // shortcut: an angled box blocks walking and test fit across its whole square-on outline. Use true corners if that gets in the way.
      if (cos !== 0 && sin !== 0) b.turn = { w: b.x1 - b.x0, d: b.y1 - b.y0, rad };
      Object.assign(b, { piece: id, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
    }
    for (const c of beams.slice(firstBeam)) {
      c.piece = id;
      [c.a[0], c.a[1]] = place(c.a[0], c.a[1]);
      [c.b[0], c.b[1]] = place(c.b[0], c.b[1]);
    }
  };

  function livingRoom() {
    const F = A.LIVING, yStairSide = W - A.STAIRS.w;

    const R = F.rug, rx1 = L - R.fromEast, ry0 = F.cabinet.d;
    piece('Rug', () => {
      item('Rug', C.rugBorder, rx1 - R.short, ry0, R.short, R.long, 0, 0.5);
      item('Rug', C.rugField, rx1 - R.short + R.border, ry0 + R.border, R.short - 2 * R.border, R.long - 2 * R.border, 0.5, 0.6);
    });

    const c = F.couch, cx1 = L - c.fromEast, cx0 = cx1 - c.d, cy0 = c.fromSouth, cy1 = cy0 + c.w;
    piece('Couch', () => {
      box('Couch', C.couch, cx0, cx1, cy0, cy1, 0, c.seat);
      box('Couch', C.couch, cx1 - c.back, cx1, cy0, cy1, c.seat, c.h);
      box('Couch', C.couch, cx0, cx1 - c.back, cy0, cy0 + c.arm, c.seat, c.h);
      box('Couch', C.couch, cx0, cx1 - c.back, cy1 - c.arm, cy1, c.seat, c.h);
    });

    const o = F.ottoman;
    piece('Ottoman', () => item('Ottoman', C.ottoman, cx0 - o.d, o.fromSouth, o.d, o.w, 0, o.h));

    // End tables are a wooden C: top, bottom and one side.
    const T = F.endTable;
    [[F.southTableX0, cy0 - T.w], [cx0, cy1]].forEach(([x0, y0], i) => piece(`End table ${i + 1}`, () => {
      item('End table', C.endTable, x0, y0, T.d, T.w, 0, T.thick);
      item('End table', C.endTable, x0, y0, T.d, T.w, T.h - T.thick, T.h);
      item('End table', C.endTable, x0 + T.d - T.thick, y0, T.thick, T.w, T.thick, T.h - T.thick);
    }));

    const P = F.lamp, r = P.d / 2;
    [{ x: L - r, y: r }, F.northLamp].forEach(({ x, y }, i) => piece(`Floor lamp ${i + 1}`, () => {
      outline('Floor lamp', x - r, y - r, P.d, P.d, P.h);
      column('Floor lamp', C.chrome, x, y, P.baseR, 0, P.baseH);
      column('Floor lamp', C.chrome, x, y, P.pole, P.baseH, P.h - P.shade);
      column('Floor lamp', C.lampShade, x, y, r, P.h - P.shade, P.h);
    }));

    const K = F.cabinet;
    for (let i = 0; i < 3; i++) piece(`Green cabinet ${i + 1}`, () => item('Green cabinet', C.greenCabinet, F.southCabinetsX0 + i * K.w, 0, K.w, K.d, 0, K.h));
    for (let i = 0; i < 2; i++) piece(`Green cabinet ${i + 4}`, () => item('Green cabinet', C.greenCabinet, F.stairCabinetsX0 + i * K.w, yStairSide - K.d, K.w, K.d, 0, K.h));

    const M = F.armoire;
    piece('Armoire', () => item('Armoire', C.armoire, M.x0, 0, M.w, M.d, 0, M.h));

    const V = F.tv, S = F.tvStand, sx = S.x0 + S.w / 2, sy = S.y0 + S.d / 2;
    piece('TV', () => {
      item('TV stand', C.tvStand, S.x0, S.y0, S.w, S.d, 0, S.h);
      box('TV stand', C.tvStand, sx - S.pole / 2, sx + S.pole / 2, sy - S.pole / 2, sy + S.pole / 2, S.h, V.top);
      item('TV', C.tvScreen, V.x0, V.y0, V.w, V.thick, V.top - V.h, V.top);
    });

    // Easel: two base rails and a crossbar, the mast, and the canvas on its tray.
    const G = F.easel, ex1 = G.x0 + G.d, ey1 = G.y0 + G.w, mx = G.x0 + G.d / 2, my = G.y0 + G.w / 2;
    piece('Easel', () => {
      outline('Easel', G.x0, G.y0, G.d, G.w, G.h);
      box('Easel', C.easel, G.x0, ex1, G.y0, G.y0 + 3, 0, 4);
      box('Easel', C.easel, G.x0, ex1, ey1 - 3, ey1, 0, 4);
      box('Easel', C.easel, mx - 1.5, mx + 1.5, G.y0, ey1, 0, 4);
      box('Easel', C.easel, mx - 1.5, mx + 1.5, my - 2, my + 2, 4, G.h);
      box('Easel', C.easel, mx + 1.5, mx + 5, G.y0, ey1, 30, 32);
      box('Easel', C.canvas, mx + 1.5, mx + 3, G.y0, ey1, 32, 56);
    });

    const H = F.shoeRack;
    piece('Shoe rack', () => item('Shoe rack', C.shoeRack, H.x0, yStairSide - H.d, H.w, H.d, 0, H.h));

    const D = F.drawers;
    piece('Small drawers', () => item('Small drawers', C.drawers, D.x0, D.y0, D.d, D.w, 0, D.h));

    const xLiving = A.KITCHEN_WIDTH + A.BLOCK.westWall + A.BLOCK.inside + A.BLOCK.eastWall;
    const Q = F.heater, U = F.ac;
    item('Wall heater', C.heater, xLiving, Q.y0, Q.d, Q.w, 0, Q.h);
    item('Wall AC', C.ac, U.x0, 0, U.w, U.d, U.z0, U.z0 + U.h);
  }

  function diningRoom() {
    const F = A.DINING;

    const T = F.table, tx1 = T.x0 + T.w, ty1 = T.y0 + T.l, topZ = T.h - T.top;
    piece('Dining table', () => {
      item('Dining table', C.tableWood, T.x0, T.y0, T.w, T.l, topZ, T.h);
      for (const x of [T.x0, tx1 - T.leg]) for (const y of [T.y0, ty1 - T.leg]) item('Dining table', C.tableWood, x, y, T.leg, T.leg, 0, topZ);
    });

    // One chair on each long side, facing the table. dir points from the table to the chair back.
    const H = F.chair, cy = T.y0 + (T.l - H.w) / 2;
    [[T.x0 - H.d, -1], [tx1, 1]].forEach(([x0, dir], i) => piece(`Dining chair ${i + 1}`, () => {
      const x1 = x0 + H.d, backX0 = dir < 0 ? x0 : x1 - H.back;
      outline('Dining chair', x0, cy, H.d, H.w, H.h);
      for (const x of [x0, x1 - H.leg]) for (const y of [cy, cy + H.w - H.leg]) item('Dining chair', C.tableWood, x, y, H.leg, H.leg, 0, H.seat - H.cushion);
      item('Dining chair', C.cushion, x0, cy, H.d, H.w, H.seat - H.cushion, H.seat);
      item('Dining chair', C.tableWood, backX0, cy, H.back, H.w, H.seat, H.h);
    }));

    const P = F.plantStand, r = P.d / 2;
    piece('Plant stand', () => {
      outline('Plant stand', P.x - r, P.y - r, P.d, P.d, P.plantsTop);
      column('Plant stand', C.plantPot, P.x, P.y, P.poleR, 0, P.h);
      column('Plant stand', C.plant, P.x, P.y, r, P.h, P.plantsTop);
    });

    const L2 = F.pendant, px = T.x0 + T.w / 2, py = T.y0 + T.l / 2, pr = L2.d / 2;
    piece('Pendant lamp', () => {
      outline('Pendant lamp', px - pr, py - pr, L2.d, L2.d, L2.top, L2.bottom);
      column('Pendant lamp', C.wicker, px, py, pr, L2.bottom, L2.top);
      column('Pendant lamp', C.cord, px, py, 0.25, L2.top, A.CEILING);
    });

    const S = F.petStation, B = A.BLOCK, wallY = W - B.length;
    const sx1 = A.KITCHEN_WIDTH + B.westWall + B.inside - B.laundryOpening, sx0 = sx1 - S.w, sy0 = wallY - S.d;
    piece('Pet food station', () => {
      outline('Pet food station', sx0, sy0, S.w, S.d, S.h);
      item('Pet food station', C.petMat, sx0, sy0, S.w, S.d, 0, S.mat);
      column('Pet food station', C.feeder, sx1 - S.feederR - 1, wallY - S.feederR - 1, S.feederR, S.mat, S.h);
    });

    const K = F.cart;
    piece('Drink cart', () => item('Drink cart', C.cart, K.x0, 0, K.w, K.d, 0, K.h));
  }

  function kitchen() {
    const K = A.KITCHEN, xE = A.KITCHEN_WIDTH, yHall = W - A.BLOCK.length;
    const ctZ = K.h - K.counterThick, cab = K.depth - K.overhang;
    const upper = (x0, x1, y0, y1, h) => box('Upper cabinet', C.cabinet, x0, x1, y0, y1, K.upper.top - h, K.upper.top);

    // Patio wall, from the north wall back: sink cabinet, stove, short cabinet.
    const yStoveN = W - K.sinkBase, yStoveS = yStoveN - K.stove.w, ySouthBase = yStoveS - K.southBase;
    box('Base cabinet', C.cabinet, 0, cab, ySouthBase, yStoveS, 0, ctZ);
    // The taped run stops 1" short of the hallway corner; the photos show the counter overhanging there.
    box('Counter', C.counter, 0, K.depth, yHall, yStoveS, ctZ, K.h);
    box('Stove', C.stove, 0, K.stove.d, yStoveS, yStoveN, 0, K.stove.h);
    box('Stove backguard', C.stove, 0, K.stove.backguardD, yStoveS, yStoveN, K.stove.h, K.stove.h + K.stove.backguard);

    // Sink: the counter and the cabinet top go around the hole, with a metal liner inside it.
    const S = K.sink, sMid = W - A.KITCHEN_WINDOW.fromNorth - A.KITCHEN_WINDOW.w / 2;
    const sx0 = (K.depth - S.d) / 2, sx1 = sx0 + S.d, sy0 = sMid - S.w / 2, sy1 = sMid + S.w / 2, sz0 = K.h - S.depth;
    box('Base cabinet', C.cabinet, 0, cab, yStoveN, W, 0, sz0);
    const around = (name, color, xOut, z0, z1) => {
      box(name, color, 0, sx0, yStoveN, W, z0, z1);
      box(name, color, sx1, xOut, yStoveN, W, z0, z1);
      box(name, color, sx0, sx1, yStoveN, sy0, z0, z1);
      box(name, color, sx0, sx1, sy1, W, z0, z1);
    };
    around('Base cabinet', C.cabinet, cab, sz0, ctZ);
    around('Counter', C.counter, K.depth, ctZ, K.h);
    const t = S.wall;
    box('Sink', C.sink, sx0, sx1, sy0, sy1, sz0, sz0 + t);
    box('Sink', C.sink, sx0, sx0 + t, sy0, sy1, sz0 + t, K.h);
    box('Sink', C.sink, sx1 - t, sx1, sy0, sy1, sz0 + t, K.h);
    box('Sink', C.sink, sx0 + t, sx1 - t, sy0, sy0 + t, sz0 + t, K.h);
    box('Sink', C.sink, sx0 + t, sx1 - t, sy1 - t, sy1, sz0 + t, K.h);
    box('Sink', C.sink, sx0 + t, sx1 - t, sMid - t, sMid + t, sz0 + t, K.h);

    // Over the range: a tall cabinet each side, a short one in the middle, the hood under it.
    const Up = K.upper, H = K.hood, rangeZ = Up.top - K.rangeUpper.h;
    upper(0, Up.d, yStoveS - K.rangeSide, yStoveS, Up.h);
    upper(0, Up.d, yStoveS, yStoveN, K.rangeUpper.h);
    upper(0, Up.d, yStoveN, yStoveN + K.rangeSide, Up.h);
    box('Range hood', C.hood, 0, H.d, yStoveS, yStoveS + H.w, rangeZ - H.h, rangeZ);
    upper(0, Up.d, W - K.sinkUpper, W, Up.h);

    // Bath wall: fridge against the north wall, uppers running south from there, base lined up with them.
    const F = K.fridge, yUpperJoint = W - K.fridgeUpper.w, yEast0 = yUpperJoint - K.eastUpper;
    piece('Fridge', () => box('Fridge', C.fridge, xE - F.d, xE, W - F.w, W, 0, F.h));
    upper(xE - Up.d, xE, yUpperJoint, W, K.fridgeUpper.h);
    upper(xE - Up.d, xE, yEast0, yUpperJoint, Up.h);
    box('Base cabinet', C.cabinet, xE - cab, xE, yEast0, yEast0 + K.eastBase, 0, ctZ);
    box('Counter', C.counter, xE - K.depth, xE, yEast0, yEast0 + K.eastBase, ctZ, K.h);
  }

  // Tank against a north wall at wallY.
  const toilet = (id, x0, wallY) => piece(id, () => {
    const T = A.TOILET, bowlX0 = x0 + (T.w - T.bowlW) / 2;
    box('Toilet', C.porcelain, x0, x0 + T.w, wallY - T.tankD, wallY, 0, T.h);
    box('Toilet', C.porcelain, bowlX0, bowlX0 + T.bowlW, wallY - T.d, wallY - T.tankD, 0, T.bowlH);
  });
  const fan = (id, x, y) => piece(id, () => {
    const F = A.FAN, r = F.d / 2, t = F.blade / 2, top = A.CEILING, low = top - F.h;
    column('Ceiling fan', C.fanBowl, x, y, 8, low, low + 4);
    column('Ceiling fan', C.fan, x, y, 5, low + 4, top);
    box('Ceiling fan', C.fan, x - r, x + r, y - t, y + t, low + 5, low + 5.5);
    box('Ceiling fan', C.fan, x - t, x + t, y - r, y + r, low + 5, low + 5.5);
  });
  // On the south wall.
  const wallAC = (id, x0) => piece(id, () => {
    const U = A.WALL_AC;
    box('Wall AC', C.ac, x0, x0 + U.w, 0, U.d, U.z0, U.z0 + U.h);
  });

  function laundry() {
    const F = A.LAUNDRY, B = A.BLOCK, xW = A.KITCHEN_WIDTH + B.westWall, xE = xW + B.inside;
    const yL0 = W - B.length + B.endWall, yL1 = yL0 + B.laundry;
    const Wa = F.washer, Sh = F.shelf;
    piece('Washer and dryer', () => item('Washer and dryer', C.appliance, xW, yL1 - Wa.d, Wa.d, Wa.w, 0, Wa.h));
    piece('Laundry shelf', () => {
      outline('Laundry shelf', xW, yL0, Sh.d, Sh.w, Sh.h);
      for (const x of [xW, xW + Sh.d - 1]) for (const y of [yL0, yL0 + Sh.w - 1]) item('Laundry shelf', C.wireShelf, x, y, 1, 1, 0, Sh.h);
      for (const z of [12, 32, 52, Sh.h - 1]) item('Laundry shelf', C.wireShelf, xW, yL0, Sh.d, Sh.w, z, z + 1);
    });
    toilet('Half bath toilet', F.toiletX0, W);
    const S = F.sink, sx0 = xE - S.w;
    piece('Pedestal sink', () => {
      outline('Pedestal sink', sx0, W - S.d, S.w, S.d, S.h);
      item('Pedestal sink', C.porcelain, sx0, W - S.d, S.w, S.d, S.h - S.bowl, S.h);
      column('Pedestal sink', C.porcelain, sx0 + S.w / 2, W - S.d / 2, S.poleR, 0, S.h - S.bowl);
    });
    const Mi = F.mirror;
    piece('Half bath mirror 1', () => box('Mirror', C.mirror, xE - Mi.thick - Mi.w, xE - Mi.thick, W - Mi.thick, W, Mi.z0, Mi.z0 + Mi.h));
    piece('Half bath mirror 2', () => box('Mirror', C.mirror, xE - Mi.thick, xE, W - Mi.w, W, Mi.z0, Mi.z0 + Mi.h));
  }

  function primaryBedroom() {
    const F = A.PRIMARY, xW = L - A.UPSTAIRS.primary.length, yN = A.UPSTAIRS.primary.width;
    const Bd = F.bed, bx1 = Bd.x0 + Bd.w, Ns = F.nightstand;
    const R = F.rug, rx0 = Bd.x0 + (Bd.w - R.long) / 2;
    piece('Bedroom rug', () => item('Rug', C.bedroomRug, rx0, R.y0, R.long, R.short, 0, 0.5));
    piece('Bed', () => {
      item('Bed', C.weatheredGray, Bd.x0, 0, Bd.w, Bd.head, 0, Bd.h);
      item('Bed', C.weatheredGray, Bd.x0, Bd.head, Bd.w, Bd.l - Bd.head, 0, Bd.top - 12);
      item('Bed', C.bedding, Bd.x0, Bd.head, Bd.w, Bd.l - Bd.head, Bd.top - 12, Bd.top);
      item('Bed', C.blanket, Bd.x0, Bd.l - 40, Bd.w, 40, Bd.top, Bd.top + 0.5);
    });
    [Bd.x0 - Ns.w, bx1].forEach((x0, i) => piece(`Nightstand ${i + 1}`, () => item('Nightstand', C.weatheredGray, x0, 0, Ns.w, Ns.d, 0, Ns.h)));
    const De = F.desk, topZ = De.h - De.top;
    piece('Yellow desk', () => {
      item('Yellow desk', C.yellowDesk, xW, De.y0, De.d, De.w, topZ - De.apron, De.h);
      for (const x of [xW, xW + De.d - De.leg]) for (const y of [De.y0, De.y0 + De.w - De.leg]) item('Yellow desk', C.yellowDesk, x, y, De.leg, De.leg, 0, topZ - De.apron);
    });
    const Ha = F.hamper;
    piece('Hamper', () => {
      item('Hamper', C.hamper, xW, Ha.y0, Ha.d, Ha.w, 0, Ha.h - Ha.lid);
      item('Hamper', C.lid, xW, Ha.y0, Ha.d, Ha.w, Ha.h - Ha.lid, Ha.h);
    });
    const Dr = F.dresser, Tv = F.tv, tx0 = Dr.x0 + (Dr.w - Tv.w) / 2, ty0 = yN - Dr.d / 2 - Tv.thick / 2;
    piece('Dresser', () => {
      item('Dresser', C.weatheredGray, Dr.x0, yN - Dr.d, Dr.w, Dr.d, 0, Dr.h);
      item('Bedroom TV', C.tvScreen, tx0, ty0, Tv.w, Tv.thick, Dr.h + Tv.stand, Dr.h + Tv.stand + Tv.h);
      item('Bedroom TV', C.tvScreen, tx0 + Tv.w / 2 - 6, ty0 - 3, 12, 8, Dr.h, Dr.h + Tv.stand);
    });
    wallAC('Bedroom AC', F.acX0);
    fan('Bedroom fan', (xW + L) / 2, yN / 2);
  }

  function officeRoom() {
    const F = A.OFFICE, U = A.UPSTAIRS.office, De = F.desk, Ch = F.chair;
    F.deskX0.forEach((x0, i) => {
      piece(`Standing desk ${i + 1}`, () => {
        item('Standing desk', C.deskTop, x0, 0, De.w, De.d, De.h - De.top, De.h);
        for (const x of [x0 + 5, x0 + De.w - 5 - De.leg]) {
          item('Standing desk', C.deskLeg, x, De.d / 2 - De.leg / 2, De.leg, De.leg, 1, De.h - De.top);
          item('Standing desk', C.deskLeg, x, 1, De.leg, De.d - 2, 0, 1);
        }
      });
      const cx = x0 + De.w / 2;
      piece(`Office chair ${i + 1}`, () => {
        outline('Office chair', cx - Ch.w / 2, De.d, Ch.w, Ch.d, Ch.h);
        column('Office chair', C.chairBase, cx, De.d + Ch.d / 2, 9, 0, 1.5);
        column('Office chair', C.chairBase, cx, De.d + Ch.d / 2, 1, 1.5, Ch.seat - 3);
        item('Office chair', C.chair, cx - Ch.w / 2, De.d, Ch.w, Ch.d, Ch.seat - 3, Ch.seat);
        item('Office chair', C.chair, cx - Ch.w / 2, De.d + Ch.d - Ch.back, Ch.w, Ch.back, Ch.seat, Ch.h);
      });
    });
    const Dr = F.drawers;
    piece('White drawers', () => item('White drawers', C.whiteDrawers, Dr.x0, 0, Dr.w, Dr.d, 0, Dr.h));
    const P = F.lamp, r = P.d / 2;
    piece('Office floor lamp', () => {
      outline('Office floor lamp', P.x - r, P.y - r, P.d, P.d, P.h);
      column('Office floor lamp', C.deskLeg, P.x, P.y, P.baseR, 0, P.baseH);
      column('Office floor lamp', C.deskLeg, P.x, P.y, P.pole, P.baseH, P.h - P.shade);
      column('Office floor lamp', C.wicker2, P.x, P.y, r, P.h - P.shade, P.h);
    });
    const Fi = F.file, yN = U.width;
    piece('File cabinet', () => item('File cabinet', C.fileCabinet, Fi.x0, yN - Fi.d, Fi.w, Fi.d, 0, Fi.h));
    const Sh = F.shelving, sx0 = Sh.x1 - Sh.w, sy0 = yN - Sh.d;
    piece('Office shelving', () => {
      for (const x of [sx0, sx0 + Sh.w / 2 - Sh.post / 2, Sh.x1 - Sh.post]) for (const y of [sy0, yN - Sh.post]) item('Office shelving', C.pine, x, y, Sh.post, Sh.post, 0, Sh.h);
      for (const z of [...Sh.levels, Sh.h - Sh.thick]) item('Office shelving', C.pine, sx0, sy0, Sh.w, Sh.d, z, z + Sh.thick);
    });
    wallAC('Office AC', F.acX0);
    fan('Office fan', U.length / 2, U.width / 2);
  }

  function upstairsBath() {
    const F = A.UPBATH, Tu = F.tub, xBath = A.UPSTAIRS.bath.length, y0 = W - Tu.w, t = Tu.wall;
    piece('Tub', () => {
      item('Tub', C.porcelain, 0, y0, Tu.d, Tu.w, 0, t);
      item('Tub', C.porcelain, 0, y0, t, Tu.w, t, Tu.rim);
      item('Tub', C.porcelain, Tu.d - t, y0, t, Tu.w, t, Tu.rim);
      item('Tub', C.porcelain, t, y0, Tu.d - 2 * t, t, t, Tu.rim);
      item('Tub', C.porcelain, t, W - t, Tu.d - 2 * t, t, t, Tu.rim);
    });
    toilet('Upstairs toilet', F.toiletX0, W);
    const Va = F.vanity;
    piece('Vanity', () => {
      item('Vanity', C.vanity, xBath - Va.w, W - Va.d, Va.w, Va.d, 0, Va.h - Va.counter);
      item('Vanity', C.vanityTop, xBath - Va.w, W - Va.d, Va.w, Va.d, Va.h - Va.counter, Va.h);
    });
    const Ca = F.cabinet, yS = W - A.UPSTAIRS.bath.width;
    piece('Bath cabinet', () => item('Bath cabinet', C.bathCabinet, Ca.x0, yS, Ca.w, Ca.d, 0, Ca.h));
  }

  function upstairsHall() {
    const F = A.UPHALL, x0 = A.UPSTAIRS.bath.length + A.UPSTAIRS.wall, Dr = F.drawers, Ns = F.nightstand;
    piece('Plastic drawers', () => item('Plastic drawers', C.plastic, x0, W - Dr.d, Dr.w, Dr.d, 0, Dr.h));
    piece('White nightstand', () => item('White nightstand', C.whiteDrawers, x0 + Dr.w, W - Ns.d, Ns.w, Ns.d, 0, Ns.h));
  }

  section(1, 0, () => {
    const B = A.BLOCK;
    box('Floor', C.floor, 0, L, 0, W, -1, 0);
    southNorth();

    const slider = door(A.SLIDING_DOOR.fromSouth, A.SLIDING_DOOR.w);
    const kWin = win(W - A.KITCHEN_WINDOW.fromNorth - A.KITCHEN_WINDOW.w, A.KITCHEN_WINDOW.w, A.KITCHEN_WINDOW.h);
    wall('Patio wall', 'y', 0, W, -E, 0, [slider, kWin]);
    glazing('Sliding door', 'y', slider, -E / 2, 0, 1, 0);
    glazing('Kitchen window', 'y', kWin, -E / 2, 0, 1, A.KITCHEN_WINDOW.trim);

    const lWin = win(A.LIVING_WINDOW.fromSouth, A.LIVING_WINDOW.w, A.LIVING_WINDOW.h);
    const fDoor = door(W - A.FRONT_DOOR.fromNorth - A.FRONT_DOOR.w, A.FRONT_DOOR.w);
    wall('Street wall', 'y', 0, W, L, L + E, [lWin, fDoor]);
    glazing('Living room window', 'y', lWin, L + E / 2, L, -1, A.WINDOW_TRIM);
    // Front door stands open against the stair side, hinged at its north edge.
    box('Front door', C.door, L - fDoor.w, L, fDoor.at + fDoor.w - 1.5, fDoor.at + fDoor.w, 0, A.DOOR_HEAD);

    // Laundry and half bath block
    const yHall = W - B.length;                            // hallway face of the block
    const xW0 = A.KITCHEN_WIDTH, xW1 = xW0 + B.westWall;   // kitchen-side wall
    const xE1 = xW1 + B.inside, xE0 = xE1 + B.eastWall;    // living-side wall
    const yLaundry0 = yHall + B.endWall, yLaundry1 = yLaundry0 + B.laundry;
    const yBath0 = yLaundry1 + B.midWall;

    wall('Kitchen-bath wall', 'y', yHall, W, xW0, xW1);
    wall('Living-bath wall', 'y', yHall, W, xE1, xE0);
    // shortcut: the jog in the living room face of this wall isn't modeled, add it once it's measured.
    wall('Hallway-end wall', 'x', xW1, xE1 - B.laundryOpening, yHall, yLaundry0);
    wall('Laundry-bath wall', 'x', xW1, xE1, yLaundry1, yBath0, [door(xE1 - B.bathDoor, B.bathDoor)]);
    // Bath door stands open against the living-side wall, hinged on that side.
    box('Half bath door', C.door, xE1 - 1.5, xE1, yBath0, yBath0 + B.bathDoor, 0, A.DOOR_HEAD);

    // Header between dining and living room
    box('Opening header', C.wall, xE1, xE0, 0, yHall, A.OPENING_HEADER, A.CEILING);

    room('Living Room', xE0, L, 0, W);
    room('Dining', 0, xE1, 0, yHall);
    room('Kitchen', 0, xW0, yHall, W);
    room('Laundry', xW1, xE1, yLaundry0, yLaundry1);
    room('Half Bath', xW1, xE1, yBath0, W);

    // Patio: west of the patio wall's outside face. Its north end lines up with the inside of the north wall.
    const px1 = -E, px0 = px1 - P.depth, py1 = W, py0 = py1 - P.width, t = P.fenceThick;
    box('Patio', C.concrete, px0, px1, py0, py1, -1, 0);
    const g = P.grass, gy1 = py1 - g.fromNorth;
    box('Grass', C.grass, px0, px0 + g.d, gy1 - g.w, gy1, 0, 0.5);
    box('Patio fence', C.fence, px0 - t, px1, py1, py1 + t, 0, P.fenceHeight);
    box('Patio fence', C.fence, px0 - t, px1, py0 - t, py0, 0, P.fenceHeight);
    box('Patio fence', C.fence, px0 - t, px0, py0, py1, 0, P.fenceHeight);
    // Gate closes the gap between the fence and the south wall of the building.
    box('Gate', C.gate, px1, px1 + 1.5, py0, -E, 0, P.fenceHeight);
    room('Patio', px0, px1, py0, py1);

    if (furniture) { livingRoom(); diningRoom(); kitchen(); laundry(); }
  });

  // Stairs belong to both floors. They rise westward from the first step.
  const S = A.STAIRS, sx = L - S.fromEast, sy0 = W - S.w, rise = FF / S.treads, run = (sx - S.topAtX) / S.treads;
  const railAt = (x) => (sx - x) / run * rise + S.railHeight;
  for (let i = 0; i < S.treads; i++) {
    const top = rise * (i + 1);
    if (level === 1 && top > A.CEILING) break;   // the rest is above this floor's ceiling
    const x1 = sx - run * i;
    box('Stair tread', C.carpet, x1 - run, x1, sy0, W, top - 2, top);
    if (top < A.CEILING) box('Stair baluster', C.trim, x1 - 1, x1, sy0, sy0 + 1, top, Math.min(railAt(x1), A.CEILING));
  }
  const railEnd = sx - (A.CEILING - S.railHeight) / rise * run;
  if (cutZ >= A.CEILING) beams.push({ name: 'Stair rail', color: C.trim, r: 1,
    a: [sx, sy0 + 0.5, railAt(sx)], b: [railEnd, sy0 + 0.5, A.CEILING] });

  section(2, FF, () => {
    const U = A.UPSTAIRS, T = U.wall;
    const xPrimary = L - U.primary.length;        // inside face of the primary's west wall
    const yPrimary = U.primary.width;             // inside face of the primary's north wall
    const xWall0 = xPrimary - T;                  // hall side of that wall
    const yStair = sy0;                           // south edge of the stairs
    const yOfficeDoorWall = U.officeNotch.y0;
    const xOffice = U.office.length, yOffice = U.office.width;
    const yBathS = W - U.bath.width, xBath = U.bath.length;

    // Floor, with the stairwell left open. The closet floor covers the bottom of the stairs.
    box('Floor', C.floor, 0, L, 0, yStair, -(FF - A.CEILING), 0);
    box('Floor', C.floor, 0, S.topAtX, yStair, W, -(FF - A.CEILING), 0);
    box('Floor', C.floor, S.soffitStartX, L, yStair, W, -(FF - A.CEILING), 0);
    // The outside walls carry on past the floor, closing the band between the two stories.
    const band = -(FF - A.CEILING);
    box('Floor band', C.wall, -E, L + E, -E, 0, band, 0);
    box('Floor band', C.wall, -E, L + E, W, W + E, band, 0);
    box('Floor band', C.wall, -E, 0, 0, W, band, 0);
    box('Floor band', C.wall, L, L + E, 0, W, band, 0);

    southNorth();
    const oWin = win(U.officeWindow.fromSouth, U.officeWindow.w, U.officeWindow.h);
    const bWin = win(U.bathWindow.fromSouth, U.bathWindow.w, U.bathWindow.h);
    wall('Patio wall', 'y', 0, W, -E, 0, [oWin, bWin]);
    glazing('Office window', 'y', oWin, -E / 2, 0, 1, U.primaryWindow.trim);
    glazing('Upstairs bath window', 'y', bWin, -E / 2, 0, 1, 0);

    const pWin = win(U.primaryWindow.fromSouth, U.primaryWindow.w, U.primaryWindow.h);
    wall('Street wall', 'y', 0, W, L, L + E, [pWin]);
    glazing('Primary window', 'y', pWin, L + E / 2, L, -1, U.primaryWindow.trim);

    // Upstairs bath, north of the office
    wall('Bath south wall', 'x', 0, U.officeNotch.x1, yOffice, yBathS);
    wall('Bath east wall', 'y', yBathS, W, xBath, xBath + T, [door(U.bath.doorFromSouth, U.bath.doorW)]);
    // Bath door stands open against the south wall side.
    box('Upstairs bath door', C.door, xBath - U.bath.doorW, xBath, U.bath.doorFromSouth - 1.5, U.bath.doorFromSouth, 0, A.DOOR_HEAD);

    // Office, with the jog by its door
    wall('Office notch wall', 'y', yOfficeDoorWall, yOffice, U.officeNotch.x0, U.officeNotch.x1);
    wall('Office door wall', 'x', U.officeNotch.x1, xWall0, yOfficeDoorWall, yOfficeDoorWall + T,
      [door(U.officeNotch.x1, U.officeDoor.w)]);
    // Office door stands open into the office.
    const oHinge = U.officeNotch.x1 + U.officeDoor.w;
    box('Office door', C.door, oHinge, oHinge + 1.5, yOfficeDoorWall - U.officeDoor.w, yOfficeDoorWall, 0, A.DOOR_HEAD);

    const OC = U.officeCloset;
    wall('Office east wall', 'y', 0, yOfficeDoorWall, xOffice, xOffice + T, [door(OC.doorFromSouth, OC.doorW)]);
    box('Office closet door', C.door, xOffice + T / 2 - 0.75, xOffice + T / 2 + 0.75, OC.doorFromSouth, OC.doorFromSouth + OC.doorW, 0, A.DOOR_HEAD);

    // Small closet off the primary bedroom. It runs from the door wall back toward the office.
    const SC = U.smallCloset, scY1 = yOfficeDoorWall, scY0 = scY1 - SC.w, scX1 = xWall0, scX0 = scX1 - SC.depth;
    wall('Closet divider', 'x', xOffice + T, xWall0, OC.north, scY0);
    // shortcut: the hand 26 1/2 depth and AI office length leave this much solid wall behind the closet, check once the office is taped.
    box('Wall', C.wall, xOffice + T, scX0, scY0, scY1, 0, A.CEILING);

    // Primary bedroom west wall, with the small closet door and the door from the hall
    const SD = U.smallClosetDoor, PD = U.primaryDoor;
    wall('Primary west wall', 'y', 0, yPrimary, xWall0, xPrimary, [door(SD.fromSouth, SD.w), door(PD.fromSouth, PD.w)]);
    box('Small closet door', C.door, xWall0 + T / 2 - 0.75, xWall0 + T / 2 + 0.75, SD.fromSouth, SD.fromSouth + SD.w, 0, A.DOOR_HEAD);
    // Primary door stands open into the bedroom, hinged on its north edge.
    box('Primary door', C.door, xPrimary, xPrimary + PD.w, PD.fromSouth + PD.w, PD.fromSouth + PD.w + 1.5, 0, A.DOOR_HEAD);

    // Stairwell side: short wall at the top of the stairs, then full height along the primary bedroom.
    wall('Stair half wall', 'x', S.topAtX, xWall0, yPrimary, yStair, [], U.halfWall.h);
    const CL = U.closet, xCloset = L - CL.length, yCloset = W - CL.depth;
    wall('Stair wall', 'x', xWall0, xCloset, yPrimary, yStair);

    // Closet on the stair side of the primary bedroom
    const bifold = door(L - CL.doorFromEast - CL.doorW, CL.doorW);
    wall('Closet front wall', 'x', xCloset, L, yPrimary, yCloset, [bifold]);
    box('Closet doors', C.door, bifold.at, bifold.at + bifold.w, yPrimary + 0.75, yCloset - 0.75, 0, A.DOOR_HEAD);

    // The stairs pass under the back of the closet, so its floor humps up over them.
    const slope = rise / run;
    const soffit = (x) => A.CEILING + (S.soffitStartX - x) * slope;
    const fl = FF - A.CEILING;
    if (show) prisms.push({ name: 'Closet floor over stairs', color: C.floor, y0: yStair, y1: W, points: [
      [S.soffitStartX, soffit(S.soffitStartX)], [S.soffitStartX, soffit(S.soffitStartX) + fl],
      [xCloset, soffit(xCloset) + fl], [xCloset, soffit(xCloset)],
    ] });
    // Slope isn't a box, so walking and test fit use these invisible steps along the top of the hump.
    for (let x = S.soffitStartX; x > xCloset; x -= 5) {
      const x0 = Math.max(x - 5, xCloset);
      if (show) boxes.push({ name: 'Closet floor over stairs', color: C.floor, hidden: true,
        x0, x1: x, y0: yStair, y1: W, z0: soffit(x0), z1: soffit(x0) + fl });
    }
    const humpTop = soffit(xCloset) + fl - FF;
    box('Closet back wall', C.wall, xCloset - T, xCloset, yCloset, W, humpTop, A.CEILING);

    // Sloped ceiling over the stairs, solid up to the upstairs ceiling.
    if (show && cutZ >= FF + A.CEILING) prisms.push({ name: 'Stair ceiling', color: C.wall, y0: yStair, y1: W, points: [
      [xCloset, soffit(xCloset)], [xCloset, FF + A.CEILING], [S.topAtX, FF + A.CEILING], [S.topAtX, soffit(S.topAtX)],
    ] });

    room('Primary Bedroom', xPrimary, L, 0, yPrimary);
    room('Office', 0, xOffice, 0, yOffice);
    room('Bath', 0, xBath, yBathS, W);
    room('Hall', xBath + T, xWall0, yOfficeDoorWall + T, W);
    room('Closet', xCloset, L, yCloset, W);
    room('Closet', scX0, scX1, scY0, scY1);
    room('Closet', xOffice + T, xWall0, 0, OC.north);

    if (furniture) { primaryBedroom(); officeRoom(); upstairsBath(); upstairsHall(); }
  });

  if (furniture) {
    for (const a of layout._added ?? []) {
      const parts = a.parts ?? [{ shape: a.shape, x: 0, y: 0, z: 0, w: a.w, d: a.d, h: a.h, color: a.color }];
      section(a.level, a.level === 2 ? FF : 0, () => piece(a.name, () => {
        for (const p of parts) {
          const x = a.x + p.x, y = a.y + p.y, z = a.z + p.z, color = parseInt(p.color.slice(1), 16);
          if (p.shape === 'box') {
            box(a.name, color, x - p.w / 2, x + p.w / 2, y - p.d / 2, y + p.d / 2, z, z + p.h);
            continue;
          }
          // Round parts are drawn as cylinders or spheres, with an invisible box around each for walking and test fit.
          const across = p.shape === 'cone' ? Math.max(p.w, p.top) : p.w, tall = p.shape === 'sphere' ? p.w : p.h;
          if (p.shape === 'sphere') ball(a.name, color, x, y, z + p.w / 2, p.w / 2);
          else column(a.name, color, x, y, p.w / 2, z, z + p.h, p.shape === 'cone' ? p.top / 2 : undefined);
          outline(a.name, x - across / 2, y - across / 2, across, across, z + tall, z);
        }
      }));
    }
  }
  // New colors cover every part of a piece, or every box of a named part of the building.
  const colors = layout._colors ?? {};
  for (const b of [...boxes, ...beams]) {
    const c = colors[b.piece] ?? colors[b.name];
    if (c) b.color = parseInt(c.slice(1), 16);
  }

  if (ceilings) {
    const y = sy0, top = FF + A.CEILING, thin = 0.5;
    // Downstairs, with the same stairwell gap as the floor above it.
    box('Ceiling', C.trim, 0, L, 0, y, A.CEILING - thin, A.CEILING);
    box('Ceiling', C.trim, 0, S.topAtX, y, W, A.CEILING - thin, A.CEILING);
    box('Ceiling', C.trim, S.soffitStartX, L, y, W, A.CEILING - thin, A.CEILING);
    box('Ceiling', C.trim, 0, L, 0, W, top, top + thin);
  }
  return { boxes, beams, prisms, rooms };
}

// Whole inches and a fraction string, rounded to the nearest eighth.
function eighths(inches) {
  const e = Math.round(Math.abs(inches) * 8);
  const rem = e % 8;
  const div = rem === 0 ? 1 : rem % 4 === 0 ? 2 : rem % 2 === 0 ? 4 : 8;
  return { whole: Math.floor(e / 8), frac: rem ? ` ${rem / (8 / div)}/${div}` : '' };
}

export function formatInches(inches) {
  const { whole, frac } = eighths(inches);
  return `${Math.floor(whole / 12)}' ${whole % 12}${frac}" (${whole}${frac}")`;
}

export function inchesShort(inches) {
  const { whole, frac } = eighths(inches);
  return `${whole}${frac}"`;
}

// Test fit: names of what a box runs into, and the open distance on each side. Touching isn't a hit.
const overlap = (a0, a1, b0, b1) => a0 < b1 - 0.01 && b0 < a1 - 0.01;

export function fitReport(solids, f) {
  const hits = new Set();
  const clear = { north: Infinity, south: Infinity, east: Infinity, west: Infinity };
  for (const s of solids) {
    if (!overlap(f.z0, f.z1, s.z0, s.z1)) continue;
    const inX = overlap(f.x0, f.x1, s.x0, s.x1), inY = overlap(f.y0, f.y1, s.y0, s.y1);
    if (inX && inY) hits.add(s.name);
    else if (inX) {
      if (s.y0 >= f.y1 - 0.01) clear.north = Math.min(clear.north, s.y0 - f.y1);
      else clear.south = Math.min(clear.south, f.y0 - s.y1);
    } else if (inY) {
      if (s.x0 >= f.x1 - 0.01) clear.east = Math.min(clear.east, s.x0 - f.x1);
      else clear.west = Math.min(clear.west, f.x0 - s.x1);
    }
  }
  return { hits: [...hits], clear };
}

// Pulls a dragged box flush against a nearby wall or object, so a thumb can place it tight.
export function snapFit(solids, f, tolerance) {
  let bestX = tolerance, bestY = tolerance, dx = 0, dy = 0;
  for (const s of solids) {
    if (!overlap(f.z0, f.z1, s.z0, s.z1)) continue;
    if (f.y0 < s.y1 + tolerance && s.y0 < f.y1 + tolerance) {
      for (const d of [s.x1 - f.x0, s.x0 - f.x1]) if (Math.abs(d) < bestX) { bestX = Math.abs(d); dx = d; }
    }
    if (f.x0 < s.x1 + tolerance && s.x0 < f.x1 + tolerance) {
      for (const d of [s.y1 - f.y0, s.y0 - f.y1]) if (Math.abs(d) < bestY) { bestY = Math.abs(d); dy = d; }
    }
  }
  return { dx, dy };
}

// Walking. The body is a square footprint, and anything low enough to step onto counts as floor.
export const WALK = { half: 7, eye: 64, head: 69, step: 14, speed: 50 };
// Downstairs starts in line with the dining opening, looking toward the patio.
export const WALK_STARTS = { 1: { x: 262, y: 40, feet: 0, yaw: Math.PI / 2 }, 2: { x: 150, y: 130, feet: FF, yaw: -Math.PI / 2 } };

// Doors don't block walking, so closed closets stay reachable and open doors can't snag.
// The pet station is knee height at most, and people step past it on the way to the kitchen.
export const walkSolids = () => buildModel({ level: 'both' }).boxes.filter((b) => !/doors?$|^Pet food station$/i.test(b.name));

const blocked = (solids, x, y, feet) => solids.some((s) =>
  s.z0 < feet + WALK.head && s.z1 > feet + WALK.step &&
  x + WALK.half > s.x0 && x - WALK.half < s.x1 && y + WALK.half > s.y0 && y - WALK.half < s.y1);

// Tries each axis separately so walking into a wall at an angle slides along it.
export function moveBody(solids, pos, dx, dy) {
  const out = { ...pos };
  if (!blocked(solids, out.x + dx, out.y, out.feet)) out.x += dx;
  if (!blocked(solids, out.x, out.y + dy, out.feet)) out.y += dy;
  return out;
}

export function groundAt(solids, x, y, feet) {
  let ground = 0;
  for (const s of solids) {
    if (s.z1 <= feet + WALK.step && s.z1 > ground &&
      x + WALK.half > s.x0 && x - WALK.half < s.x1 && y + WALK.half > s.y0 && y - WALK.half < s.y1) ground = s.z1;
  }
  return ground;
}

// Straightens a line that's nearly along an axis, so two taps read as a clean wall-to-wall distance.
// Decides from the raw taps, because snapping can pull each end sideways toward a different wall.
export function straighten(a, b, rawA = a, rawB = b, ratio = 0.1) {
  const out = { ...b };
  const longest = Math.max(...['x', 'y', 'z'].map((axis) => Math.abs(rawA[axis] - rawB[axis])));
  for (const axis of ['x', 'y', 'z']) {
    if (Math.abs(rawA[axis] - rawB[axis]) < longest * ratio) out[axis] = a[axis];
  }
  return out;
}

// Snaps a point to nearby box faces on each axis, so a thumb tap lands on the true wall or corner.
export function snap(boxes, p, tolerance) {
  const out = { ...p };
  const near = boxes.filter((b) =>
    p.x > b.x0 - tolerance && p.x < b.x1 + tolerance &&
    p.y > b.y0 - tolerance && p.y < b.y1 + tolerance &&
    p.z > b.z0 - tolerance && p.z < b.z1 + tolerance);
  for (const axis of ['x', 'y', 'z']) {
    let best = tolerance;
    for (const b of near) {
      for (const plane of [b[`${axis}0`], b[`${axis}1`]]) {
        const d = Math.abs(p[axis] - plane);
        if (d < best) { best = d; out[axis] = plane; }
      }
    }
  }
  return out;
}
