import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWalls, squareUp, WallMap } from '../js/slam/walls.js';
import { World } from '../js/slam/world.js';

// Voxels for two walls of a room (an L), some furniture, floor, and scattered noise. The walls
// can be shifted by (dx, dz), as one-camera depth moves them a little from one look to the next.
function room(seed = 7, dx = 0, dz = 0) {
  const v = [];
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const add = (x, ht, z) => v.push({ x, y: -ht, z, n: 3 });
  for (let x = 0; x <= 4; x += 0.05) for (let ht = 0; ht <= 2.4; ht += 0.05) add(x + (rand() - 0.5) * 0.04, ht, 3 + dz + (rand() - 0.5) * 0.04);
  for (let z = 0; z <= 3; z += 0.05) for (let ht = 0; ht <= 2.4; ht += 0.05) add(4 + dx + (rand() - 0.5) * 0.04, ht, z);
  for (let x = 0; x < 4; x += 0.1) for (let z = 0; z < 3; z += 0.1) add(x, 0, z); // floor
  for (let x = 1; x <= 2; x += 0.05) for (let ht = 0; ht <= 1.8; ht += 0.05) add(x, ht, 1); // a fridge-ish front
  for (let k = 0; k < 400; k++) add(rand() * 4, rand() * 2.4, rand() * 3);
  return v;
}

test('two walls are found where they are, at their height; the object is not a wall', () => {
  const walls = extractWalls(room(), { exclude: [{ x: 1.5, z: 1.1, w: 1.1, d: 0.4, yaw: 0 }] });
  assert.equal(walls.length, 2, JSON.stringify(walls.map((w) => [w.x0, w.z0, w.x1, w.z1, w.n].map((v) => +v.toFixed(2)))));
  const along = walls.find((w) => Math.abs(w.z0 - w.z1) < 0.2), across = walls.find((w) => Math.abs(w.x0 - w.x1) < 0.2);
  assert.ok(along && across);
  assert.ok(Math.abs((along.z0 + along.z1) / 2 - 3) < 0.08 && Math.abs(Math.abs(along.x1 - along.x0) - 4) < 0.3);
  assert.ok(Math.abs((across.x0 + across.x1) / 2 - 4) < 0.08 && Math.abs(Math.abs(across.z1 - across.z0) - 3) < 0.3);
  assert.ok(along.top > 2 && along.top <= 2.45);
});

test("people's feet move the floor to where they stand", () => {
  const w = new World({ camHeight: 1.25 });
  w.align = w.assumedAlign();
  w.floor = 'assumed';
  // The camera is really 1.5 m up, so feet show up 0.25 m below the assumed floor.
  const feet = [[0, 0.25, 2], [1, 0.25, 3], [-1, 0.25, 2.5]];
  let moved = false;
  feet.forEach((p) => { moved = w.addFeet(p, 10) || moved; });
  assert.ok(moved);
  assert.equal(w.floor, 'people');
  assert.ok(Math.abs(w.toMap([0, 1.5, 2])[1]) < 1e-9); // a point 1.5 m below the camera is on the floor now
});

test('walls nearly square to each other are made square, pieces in line are joined, and odd ones dropped', () => {
  const deg = Math.PI / 180;
  const seg = (x, z, a, L) => ({ x0: x, z0: z, x1: x + L * Math.cos(a * deg), z1: z + L * Math.sin(a * deg), top: 2.4, n: 20 });
  const { walls, axis } = squareUp([seg(0, 0, 3, 4), seg(4, 0, 88, 3), seg(0, 3, 1, 1.5), seg(1.7, 3.02, 2, 2), seg(1, 1, 45, 1)]);
  const ang = (w) => Math.atan2(w.z1 - w.z0, w.x1 - w.x0) / deg;
  for (const w of walls) {
    assert.ok(w.square);
    const d = ((ang(w) - axis / deg) % 90 + 90) % 90;
    assert.ok(d < 1e-6 || 90 - d < 1e-6, `wall at ${ang(w).toFixed(2)}°`);
  }
  assert.equal(walls.length, 3, 'the two in-line pieces became one, and the 45° wall is gone');
});

const wall = (x0, z0, x1, z1, n = 30) => ({ x0, z0, x1, z1, top: 2.4, n, square: true });
// Whether segment w runs exactly along or across axis a.
const square = (w, a) => Math.abs(Math.sin(2 * (Math.atan2(w.z1 - w.z0, w.x1 - w.x0) - a))) < 1e-9;

test('noisy extractions of the same room settle on two walls that hardly move', () => {
  const map = new WallMap(), fridge = { x: 1.5, z: 1.1, w: 1.1, d: 0.4, yaw: 0 };
  let s = 123456789, axis = null, prev = null, steady = 0, jumpy = 0, prevRaw = null;
  const jitter = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1; // ±5 cm
  const key = (ws) => ws.map((w) => (w.x0 + w.z0 < w.x1 + w.z1 ? [w.x0, w.z0, w.x1, w.z1] : [w.x1, w.z1, w.x0, w.z0])).sort((p, q) => p[0] - q[0]);
  const move = (A, B) => Math.max(...A.flatMap((w, i) => w.map((v, j) => Math.abs(v - B[i][j]))));
  for (let i = 0; i < 10; i++) {
    const out = squareUp(extractWalls(room(11 + 17 * i, jitter(), jitter()), { exclude: [fridge] }), axis);
    axis = out.axis;
    map.update(out.walls, axis);
    const now = key(map.list()), raw = key(out.walls);
    assert.equal(now.length, 2);
    if (i >= 4) { steady = Math.max(steady, move(now, prev)); jumpy = Math.max(jumpy, move(raw, prevRaw)); }
    prev = now; prevRaw = raw;
  }
  assert.ok(steady < 0.025, `kept walls moved ${steady.toFixed(3)} m between extractions`);
  assert.ok(jumpy > 4 * steady, `raw ${jumpy.toFixed(3)} m vs kept ${steady.toFixed(3)} m`);
  const ws = map.list(), along = ws.find((w) => Math.abs(w.z0 - w.z1) < 0.1), across = ws.find((w) => Math.abs(w.x0 - w.x1) < 0.1);
  assert.ok(Math.abs((along.z0 + along.z1) / 2 - 3) < 0.07 && Math.abs((across.x0 + across.x1) / 2 - 4) < 0.07, JSON.stringify(ws));
  // The corner is closed: the two walls end on the same point.
  const gap = Math.min(...[[along.x0, along.z0], [along.x1, along.z1]].flatMap(([x, z]) => [Math.hypot(across.x0 - x, across.z0 - z), Math.hypot(across.x1 - x, across.z1 - z)]));
  assert.ok(gap < 1e-9, `corner gap ${gap}`);
  for (const w of ws) assert.ok(square(w, axis));
});

test('a wall is shown once two extractions found it, but everything at once after clear()', () => {
  const m = new WallMap();
  const A = wall(0, 0, 4, 0), B = wall(6, 1, 6, 3), C = wall(0, 5, 3, 5);
  m.update([A], 0); // the first extraction seeds the map
  assert.equal(m.list().length, 1);
  m.update([A, B], 0);
  assert.equal(m.list().length, 1, 'B seen once');
  m.update([A, B], 0);
  assert.equal(m.list().length, 2, 'B seen twice');
  m.update([A, C], 0);
  assert.equal(m.list().length, 2, 'C seen once');
  for (let i = 0; i < 3; i++) m.update([A], 0);
  assert.equal(m.size, 2, 'C not seen again: forgotten; B stays');
  m.clear();
  m.update([A, B, C], 0);
  assert.equal(m.list().length, 3);
  assert.ok(m.list().every((w) => w.n === 30), 'started afresh, not folded into the old walls');
  // Shown at once, but a stray piece in that one extraction isn't kept for good.
  m.update([A, B], 0);
  for (let i = 0; i < 5; i++) m.update([], null); // empty extractions (axis still unknown to squareUp)
  assert.deepEqual(m.list().map((w) => w.id), [4, 5], 'C, never found again, went; A and B stay');
});

test('a piece bridging two kept walls makes them one; the older keeps its id', () => {
  const m = new WallMap();
  for (let i = 0; i < 2; i++) m.update([wall(0, 0, 1, 0, 10)], 0); // shown, short
  m.update([wall(1.6, 0, 4, 0, 40)], 0); // past a 0.6 m gap: another wall
  assert.equal(m.size, 2);
  m.update([wall(0, 0.05, 4, 0.05, 40)], 0);
  const ws = m.list();
  assert.equal(m.size, 1);
  assert.equal(ws[0].id, 1);
  assert.ok(Math.abs(ws[0].x0) < 1e-9 && Math.abs(ws[0].x1 - 4) < 1e-9 && ws[0].z0 > 0 && ws[0].z0 < 0.05);
});

test('the axis turning a quarter turn leaves the walls where they are', () => {
  const m = new WallMap(), L = [wall(0, 0, 4, 0), wall(4, 0, 4, 3)];
  m.update(L, 0);
  const before = m.list();
  m.update(L, Math.PI / 2);
  const after = m.list();
  assert.equal(m.size, 2, 'matched, not doubled');
  const ends = (w) => [[w.x0, w.z0], [w.x1, w.z1]].sort((p, q) => p[0] - q[0] || p[1] - q[1]).flat();
  after.forEach((w, i) => ends(w).forEach((v, j) => assert.ok(Math.abs(v - ends(before[i])[j]) < 1e-9)));
});

test('walls with no length or not-a-number ends are ignored, not spread to the rest', () => {
  const ok = wall(0, 0, 4, 0), dot = wall(1, 0, 1, 0), bad = { x0: NaN, z0: 0, x1: 1, z1: 0, top: 2, n: 3 };
  const { walls, axis } = squareUp([dot, bad, ok], 0.1);
  assert.ok(Number.isFinite(axis));
  assert.equal(walls.length, 1);
  assert.ok([walls[0].x0, walls[0].z0, walls[0].x1, walls[0].z1].every(Number.isFinite));
  const m = new WallMap();
  m.update([dot, bad, ok], NaN);
  assert.equal(m.size, 1);
  assert.ok(m.list().every((w) => [w.x0, w.z0, w.x1, w.z1].every(Number.isFinite)));
});

test('walls meet exactly at L and T corners, and stay square when the axis settles', () => {
  const a = 0.3, c = Math.cos(a), s = Math.sin(a);
  const rot = (x, z) => [x * c - z * s, x * s + z * c];
  const turned = (x0, z0, x1, z1) => wall(...rot(x0, z0), ...rot(x1, z1));
  const m = new WallMap();
  // An L at (4, 3) that falls 0.25 m short on one side and overshoots 0.3 m on the other, a T at
  // (2, 3) that falls short, and a wall too far from anything to join.
  m.update([turned(0, 3, 3.75, 3), turned(4, 0, 4, 3.3), turned(2, 0.5, 2, 2.7), turned(6, 0, 6, 2)], a);
  const ws = m.list(), [cx, cz] = rot(4, 3), [tx, tz] = rot(2, 3), [fx, fz] = rot(6, 2);
  const has = (w, x, z) => Math.hypot(w.x0 - x, w.z0 - z) < 1e-9 || Math.hypot(w.x1 - x, w.z1 - z) < 1e-9;
  assert.equal(ws.length, 4);
  assert.ok(has(ws[0], cx, cz) && has(ws[1], cx, cz), 'L corner closed');
  assert.ok(has(ws[2], tx, tz) && !has(ws[0], tx, tz), 'T: the side wall ends on the long one, which goes on');
  assert.ok(has(ws[3], fx, fz), 'the far wall is left as it is');
  for (const w of ws) assert.ok(square(w, a));
  // The building's direction settles about 2°: every wall turns with it and is still exactly square.
  const b = a + (2 * Math.PI) / 180;
  const next = squareUp([turned(0, 3, 3.75, 3)], b);
  m.update(next.walls, next.axis);
  const [L0, L1] = m.list();
  for (const w of m.list()) assert.ok(square(w, next.axis), JSON.stringify(w));
  assert.ok(has(L0, L1.x0, L1.z0) || has(L0, L1.x1, L1.z1), 'the L is still closed');
});

test('a wall the floor grid later sees open floor through is removed', () => {
  const A = wall(0, 0, 4, 0), B = wall(0, 2, 2, 2), C = wall(5, 0, 5, 3);
  const isFree = (x, z) => Math.abs(z - 2) < 0.5 && x < 3; // open floor all around B
  const m = new WallMap(), keep = new WallMap();
  for (let i = 0; i < 2; i++) { m.update([A, B, C], 0); keep.update([A, B, C], 0); } // all confirmed
  for (let i = 0; i < 2; i++) m.update([A], 0, { isFree });
  assert.equal(m.list().length, 3, 'not until it has been missing for a few extractions');
  m.update([A], 0, { isFree });
  keep.update([A], 0);
  assert.deepEqual(m.list().map((w) => w.id).sort(), [1, 3], 'B was a person or clutter; C, unseen but not open floor, stays');
  assert.equal(keep.list().length, 3, 'without the grid, shown walls stay');
});
