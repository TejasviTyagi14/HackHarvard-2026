import test from 'node:test';
import assert from 'node:assert/strict';
import { measureBox, ObjectMap } from '../js/slam/objects.js';

const I = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, -1.3, 0] }; // camera 1.3 m above the floor, map y down

test('a chair 2 m ahead comes out chair-sized, on the floor, 2 m away', () => {
  const w = 320, h = 240, f = 250, cx = 160, cy = 120;
  const depth = new Float32Array(w * h).fill(5); // background wall
  // Chair front face 2 m away: 0.5 m wide, 0.9 m tall, standing on the floor (1.3 m below the camera).
  const Z = 2, x0 = cx - (0.25 * f) / Z, x1 = cx + (0.25 * f) / Z;
  const y0 = cy + ((1.3 - 0.9) * f) / Z, y1 = cy + (1.3 * f) / Z;
  for (let y = Math.ceil(y0); y < y1; y++) for (let x = Math.ceil(x0); x < x1; x++) depth[y * w + x] = Z;
  const b = measureBox({ class: 'chair', score: 0.9, bbox: [x0, y0, x1 - x0, y1 - y0] }, depth, { f, cx, cy, w, h }, I);
  assert.ok(Math.abs(b.w - 0.5) < 0.05 && Math.abs(b.h - 0.9) < 0.05, `size ${b.w} × ${b.h}`);
  assert.equal(b.bottom, 0);
  assert.ok(Math.abs(b.z - (Z + b.d / 2)) < 0.05 && Math.abs(b.x) < 0.05);
  assert.ok(Math.abs(b.yaw) < 1e-6);
});

test('classes that are not furniture-like (or people) are skipped', () => {
  const b = measureBox({ class: 'train', score: 0.9, bbox: [0, 0, 10, 10] }, new Float32Array(100).fill(2), { f: 100, cx: 5, cy: 5, w: 10, h: 10 }, I);
  assert.equal(b, null);
});

test('repeat sightings merge into one object; a different one nearby does not', () => {
  const m = new ObjectMap();
  m.add({ cls: 'chair', x: 1, z: 2, bottom: 0, w: 0.5, h: 0.9, d: 0.5, yaw: 0.1 });
  m.add({ cls: 'chair', x: 1.1, z: 2.1, bottom: 0, w: 0.6, h: 0.8, d: 0.5, yaw: -0.1 });
  m.add({ cls: 'dining table', x: 1.2, z: 2, bottom: 0, w: 1.4, h: 0.75, d: 0.8, yaw: 0 });
  m.add({ cls: 'chair', x: 3, z: 2, bottom: 0, w: 0.5, h: 0.9, d: 0.5, yaw: 0 });
  assert.equal(m.list.length, 3);
  const [c] = m.confirmed();
  assert.equal(c.n, 2);
  assert.ok(Math.abs(c.w - 0.55) < 1e-9 && Math.abs(c.yaw) < 1e-9);
});

test('a person stands on the floor, full height even with their feet cut off', () => {
  const w = 320, h = 240, f = 250, cx = 160, cy = 120, Z = 3;
  const depth = new Float32Array(w * h).fill(Z);
  // Head top 1.75 m above the floor, camera 1.3 m up: top row at cy − 0.45·f/Z; box runs off the bottom.
  const top = cy - (0.45 * f) / Z;
  const b = measureBox({ class: 'person', score: 0.9, bbox: [140, top, 40, h - top] }, depth, { f, cx, cy, w, h }, I);
  assert.equal(b.bottom, 0);
  assert.ok(Math.abs(b.h - 1.75) < 0.03, `height ${b.h}`);
  assert.equal(b.feet, null); // feet not in view
});

test('people follow their newest sighting and drop out when not seen', () => {
  const m = new ObjectMap();
  m.add({ cls: 'person', x: 0, z: 2, bottom: 0, w: 0.5, h: 1.7, d: 0.3, yaw: 0, t: 1 });
  m.add({ cls: 'person', x: 0.8, z: 2, bottom: 0, w: 0.5, h: 1.7, d: 0.3, yaw: 0, t: 2 });
  assert.equal(m.list.length, 1);
  assert.ok(m.list[0].x > 0.5);
  assert.equal(m.confirmed().length, 1);
  assert.equal(m.lasting().length, 0); // not a place to save or go to
  m.add({ cls: 'chair', x: 5, z: 5, bottom: 0, w: 0.5, h: 0.9, d: 0.5, yaw: 0, t: 20 });
  assert.equal(m.confirmed().length, 0);
});
