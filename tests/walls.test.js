import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWalls } from '../js/slam/walls.js';
import { World } from '../js/slam/world.js';

// Voxels for two walls of a room (an L), some furniture, floor, and scattered noise.
function room() {
  const v = [];
  let s = 7;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const add = (x, ht, z) => v.push({ x, y: -ht, z, n: 3 });
  for (let x = 0; x <= 4; x += 0.05) for (let ht = 0; ht <= 2.4; ht += 0.05) add(x + (rand() - 0.5) * 0.04, ht, 3 + (rand() - 0.5) * 0.04);
  for (let z = 0; z <= 3; z += 0.05) for (let ht = 0; ht <= 2.4; ht += 0.05) add(4 + (rand() - 0.5) * 0.04, ht, z);
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

test('walls nearly square to each other are made square, and pieces in line are joined', async () => {
  const { squareUp } = await import('../js/slam/walls.js');
  const deg = Math.PI / 180;
  const seg = (x, z, a, L) => ({ x0: x, z0: z, x1: x + L * Math.cos(a * deg), z1: z + L * Math.sin(a * deg), top: 2.4, n: 20 });
  const { walls, axis } = squareUp([seg(0, 0, 3, 4), seg(4, 0, 88, 3), seg(0, 3, 1, 1.5), seg(1.7, 3.02, 2, 2), seg(1, 1, 45, 1)]);
  const ang = (w) => Math.atan2(w.z1 - w.z0, w.x1 - w.x0) / deg;
  const sq = walls.filter((w) => w.square);
  for (const w of sq) {
    const d = ((ang(w) - axis / deg) % 90 + 90) % 90;
    assert.ok(d < 1e-6 || 90 - d < 1e-6, `wall at ${ang(w).toFixed(2)}°`);
  }
  assert.equal(walls.length, 4, 'the two in-line pieces became one');
  assert.ok(walls.some((w) => !w.square), 'a 45° wall stays as it is');
});
