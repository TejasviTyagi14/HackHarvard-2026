import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksView, boxBlur, ellipse, headingR, rayHit } from '../js/view3d-math.js';

// The 3D view's own math (js/view3d-math.js): frames and signs are where it goes wrong. Map frame:
// x right, y down, z forward; three: (x, −y, −z). Walls are packed [ax, az, bx, bz, top] in three's frame.
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const wallsOf = (...ws) => Float32Array.from(ws.flatMap(({ x0, z0, x1, z1, top }) => [x0, -z0, x1, -z1, top]));
const v3 = (x, y, z) => ({ x, y, z });

test('headingR: the camera faces the heading, x stays to its right, y down', () => {
  for (const h of [0, 0.7, -2.2, Math.PI]) {
    const R = headingR(h);
    // Columns are the camera's axes in the map frame.
    assert.ok(near(Math.atan2(R[2], R[8]), Math.atan2(Math.sin(h), Math.cos(h)), 1e-9), 'forward');
    assert.deepEqual([R[1], R[4], R[7]], [0, 1, 0]);
    // x = y × z = (0, 1, 0) × (zx, 0, zz) = (zz, 0, −zx): a right-handed camera frame.
    assert.ok(near(R[0], R[8]) && near(R[3], 0) && near(R[6], -R[2]), 'right');
  }
  // Heading 0 is map +z: in three (S·R, S = diag(1, −1, −1)) that's −z, three's "forward".
  const R = headingR(0);
  assert.ok(near(R[2], 0) && near(-R[5], 0) && near(-R[8], -1));
});

test('ellipse: axes and angle of a floor covariance, in the map frame', () => {
  let e = ellipse(4, 0, 1);
  assert.ok(near(e.a, 2) && near(e.b, 1) && near(e.th, 0));
  e = ellipse(1, 0, 4);
  assert.ok(near(e.a, 2) && near(e.b, 1) && near(Math.abs(e.th), Math.PI / 2));
  // A 2 m × 1 m ellipse whose long axis runs 30° from map +x toward map +z.
  const t = (30 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  e = ellipse(4 * c * c + s * s, 3 * c * s, 4 * s * s + c * c);
  assert.ok(near(e.a, 2, 1e-9) && near(e.b, 1, 1e-9) && near(e.th, t, 1e-9));
  // rotation.y = th turns three's local x to (cos th, 0, −sin th), which is map (cos th, sin th): the long axis.
  const threeX = [Math.cos(e.th), -Math.sin(e.th)], mapX = [threeX[0], -threeX[1]];
  assert.ok(near(mapX[0], c, 1e-9) && near(mapX[1], s, 1e-9));
  // Degenerate input stays finite.
  for (const [a, b, d] of [[0, 0, 0], [1e-12, 0, -1e-12], [1, 1, 1]]) {
    const q = ellipse(a, b, d);
    assert.ok([q.a, q.b, q.th].every(Number.isFinite) && q.a >= q.b && q.b >= 0);
  }
});

test('rayHit: the floor, at the right distance', () => {
  const t = (40 * Math.PI) / 180, d = v3(0, -Math.sin(t), -Math.cos(t));
  const r = rayHit(v3(0, 1.3, 0), d, new Float32Array(0), 0);
  assert.equal(r.hit, 1);
  assert.ok(near(r.len, 1.3 / Math.sin(t), 1e-9));
  // Looking level or up meets nothing within the range.
  assert.deepEqual(rayHit(v3(0, 1.3, 0), v3(0, 0, -1), new Float32Array(0), 0, Infinity, {}, 6), { len: 6, hit: 0, nx: 0, nz: 0 });
  assert.equal(rayHit(v3(0, 1.3, 0), v3(0, 0.6, -0.8), new Float32Array(0), 0).hit, 0);
});

test('rayHit: a wall ahead stops the ray at its face, facing you; one behind does not', () => {
  const W = wallsOf({ x0: -3, z0: 2, x1: 3, z1: 2, top: 2.5 }, { x0: -2, z0: -1, x1: 2, z1: -1, top: 2.5 });
  const o = v3(0, 1.3, 0), out = {};
  const r = rayHit(o, v3(0, 0, -1), W, 2, Infinity, out, 6, 0.05); // facing map +z
  assert.equal(r, out, 'writes into out');
  assert.equal(r.hit, 2);
  assert.ok(near(r.len, 1.95, 1e-6), String(r.len));
  assert.ok(near(r.nx, 0) && near(r.nz, 1), 'normal points back at the camera (three +z)');
  // At 45° the face is half / cos 45° nearer along the ray.
  const k = Math.SQRT1_2, r45 = rayHit(o, v3(k, 0, -k), W, 2, Infinity, {}, 6, 0.05);
  assert.equal(r45.hit, 2);
  assert.ok(near(r45.len, 2 / k - 0.05 / k, 1e-5), String(r45.len));
  // Facing map −z: the wall at z = −1 is hit, not the one at +2.
  const back = rayHit(o, v3(0, 0, 1), W, 2, Infinity, {}, 6, 0.05);
  assert.ok(back.hit === 2 && near(back.len, 0.95, 1e-6) && near(back.nz, -1));
});

test('rayHit: over a low wall, above "Hide above", past hidden walls; the floor when nearer', () => {
  const o = v3(0, 1.3, 0), fwd = v3(0, 0, -1);
  const low = wallsOf({ x0: -2, z0: 2, x1: 2, z1: 2, top: 1 });
  assert.equal(rayHit(o, fwd, low, 1).hit, 0);
  const tall = wallsOf({ x0: -2, z0: 2, x1: 2, z1: 2, top: 2.5 });
  assert.equal(rayHit(o, fwd, tall, 1, 1.0).hit, 0, 'the wall is cut at 1 m, below the ray');
  assert.equal(rayHit(o, fwd, tall, 1, 2.0).hit, 2);
  assert.equal(rayHit(o, fwd, tall, 0).hit, 0, 'walls hidden: n = 0');
  // Steeply down: the floor at 1.3 / sin 60° ≈ 1.5 m comes before the wall at 2 m.
  const t = Math.PI / 3, r = rayHit(o, v3(0, -Math.sin(t), -Math.cos(t)), tall, 1);
  assert.ok(r.hit === 1 && near(r.len, 1.3 / Math.sin(t), 1e-9));
  // Past the wall's end, or along it, or a zero-length wall: no hit and nothing NaN.
  assert.equal(rayHit(o, fwd, wallsOf({ x0: 1, z0: 2, x1: 3, z1: 2, top: 2.5 }), 1).hit, 0);
  assert.equal(rayHit(o, v3(1, 0, 0), wallsOf({ x0: -2, z0: 0, x1: 2, z1: 0, top: 2.5 }), 1).hit, 0);
  const z = rayHit(o, fwd, wallsOf({ x0: 0, z0: 2, x1: 0, z1: 2, top: 2.5 }), 1);
  assert.ok(z.hit === 0 && [z.len, z.nx, z.nz].every(Number.isFinite));
});

test('blocksView: only a wall between the view and your spot, below its top, fades', () => {
  const W = wallsOf(
    { x0: -1, z0: -2, x1: 1, z1: -2, top: 2.5 }, // between (three z = 2)
    { x0: 5, z0: -2, x1: 7, z1: -2, top: 2.5 }, // off to the side
    { x0: -1, z0: 2, x1: 1, z1: 2, top: 2.5 }, // beyond you
    { x0: -1, z0: -6, x1: 1, z1: -6, top: 2.5 }, // behind the view
    { x0: 0, z0: -1, x1: 0, z1: -3, top: 2.5 }, // along the sight line
    { x0: -1, z0: -2, x1: 1, z1: -2, top: 1 }, // between but low: the line passes over at 1.5 m
  );
  const c = v3(0, 3, 4); // three frame: 4 m behind you (map z = −4), 3 m up
  const got = [0, 1, 2, 3, 4, 5].map((i) => blocksView(c, 0, 0, W, i));
  assert.deepEqual(got, [true, false, false, false, false, false]);
  assert.equal(blocksView(c, 0, 0, W, 0, 1.0), false, 'cut by "Hide above" to 1 m, it no longer blocks');
  // Just past the wall's end still counts (it's drawn 10 cm longer).
  const end = wallsOf({ x0: 0.05, z0: -2, x1: 2, z1: -2, top: 2.5 });
  assert.equal(blocksView(c, 0, 0, end, 0, Infinity, 0.1), true);
});

test('boxBlur: keeps a flat field flat and spreads a speck evenly', () => {
  const w = 9, h = 7, tmp = new Float32Array(w * h);
  const flat = new Float32Array(w * h).fill(1);
  boxBlur(flat, tmp, w, h, 2);
  assert.ok(flat.every((v) => near(v, 1, 1e-6)));
  const a = new Float32Array(w * h);
  a[3 * w + 4] = 1;
  boxBlur(a, tmp, w, h, 1);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const inside = Math.abs(i - 4) <= 1 && Math.abs(j - 3) <= 1;
    assert.ok(near(a[j * w + i], inside ? 1 / 9 : 0, 1e-6), `${i},${j}`);
  }
});
