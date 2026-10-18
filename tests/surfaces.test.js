import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSurfaces } from '../js/slam/surfaces.js';

const V = 0.05;
const cellOf = (x, y, z) => `${Math.floor(x / V)},${Math.floor(y / V)},${Math.floor(z / V)}`;
// The voxel World would put a point at (x, height ht, z) in.
const at = (x, ht, z, n = 3) => ({ x: (Math.floor(x / V) + 0.5) * V, y: (Math.floor(-ht / V) + 0.5) * V, z: (Math.floor(z / V) + 0.5) * V, n, g: 90 });

// A room turned by `turn` (rad) about the origin, as World would hold it: 5 cm voxels (centres at
// (i + ½)·V) on the map's own grid, each tagged with what it really is. Room coordinates: x along
// the walls' direction, z across; heights above the floor.
function room(turn = 0) {
  let s = 11;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const c = Math.cos(turn), sn = Math.sin(turn);
  const vox = new Map();
  const add = (x, ht, z, what, n = 3) => {
    const mx = x * c - z * sn, mz = x * sn + z * c, key = cellOf(mx, -ht, mz);
    if (vox.has(key)) return;
    const [i, j, k] = key.split(',').map(Number);
    vox.set(key, { x: (i + 0.5) * V, y: (j + 0.5) * V, z: (k + 0.5) * V, n, g: 120, what });
  };
  const step = 0.02;
  for (let x = 0; x <= 4; x += step) for (let z = 0; z <= 3; z += step) add(x, (rand() - 0.5) * 0.08, z, 'floor');
  for (let k = 0; k < 300; k++) add(rand() * 4, -0.05 - rand() * 0.1, rand() * 3, 'floor'); // noise under the floor
  for (let x = 0; x <= 4; x += step) for (let ht = 0.05; ht <= 2.4; ht += step) add(x, ht, 3 + (rand() - 0.5) * 0.06, 'wall');
  for (let z = 0; z <= 3; z += step) for (let ht = 0.05; ht <= 2.4; ht += step) add(4 + (rand() - 0.5) * 0.06, ht, z, 'wall');
  // Table: a 1.2 × 0.8 m top at 0.75 m (a little noisy, as from one camera) on four legs.
  for (let x = 1.0; x <= 2.2; x += step) for (let z = 1.0; z <= 1.8; z += step) add(x, 0.75 + (rand() - 0.5) * 0.04, z, 'top');
  for (const [lx, lz] of [[1.05, 1.05], [2.1, 1.05], [1.05, 1.7], [2.1, 1.7]]) {
    for (let ht = 0.1; ht < 0.7; ht += step) for (let a = 0; a < 0.06; a += step) for (let b = 0; b < 0.06; b += step) add(lx + a, ht, lz + b, 'leg');
  }
  // A detected box (its top is flat, but it's an object, not a slab): faces only.
  const box = { cls: 'suitcase', x: 3.0, z: 0.8, bottom: 0, w: 0.6, h: 0.6, d: 0.45, yaw: 0.3 };
  const bc = Math.cos(box.yaw), bs = Math.sin(box.yaw);
  const onBox = (u, ht, v) => add(box.x + u * bc + v * bs, ht, box.z - u * bs + v * bc, 'object');
  for (let u = -box.w / 2; u <= box.w / 2; u += step) {
    for (let v = -box.d / 2; v <= box.d / 2; v += step) onBox(u, box.h, v);
    for (let ht = 0.1; ht <= box.h; ht += step) { onBox(u, ht, -box.d / 2); onBox(u, ht, box.d / 2); }
  }
  for (let v = -box.d / 2; v <= box.d / 2; v += step) for (let ht = 0.1; ht <= box.h; ht += step) { onBox(-box.w / 2, ht, v); onBox(box.w / 2, ht, v); }
  // Clutter: a floor lamp, a 10 cm pole with a shade. It should stay as points.
  for (let ht = 0.05; ht <= 1.4; ht += step) for (let a = 0; a < 0.1; a += step) for (let b = 0; b < 0.1; b += step) add(0.6 + a, ht, 0.6 + b, 'lamp');
  for (let ht = 1.4; ht <= 1.65; ht += step) for (let a = -0.1; a <= 0.2; a += step) for (let b = -0.1; b <= 0.2; b += step) add(0.6 + a, ht, 0.6 + b, 'lamp');
  // Lone specks in the air (no shown voxel next to them), and some voxels seen only once.
  const near = (x, ht, z) => {
    const mx = x * c - z * sn, mz = x * sn + z * c, [i, j, k] = cellOf(mx, -ht, mz).split(',').map(Number);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) if (vox.has(`${i + a},${j + b},${k + d}`)) return true;
    return false;
  };
  let specks = 0;
  for (let k = 0; k < 400 && specks < 150; k++) {
    const x = 0.2 + rand() * 3.6, ht = 0.3 + rand() * 2, z = 0.2 + rand() * 2.6;
    if (!near(x, ht, z)) { add(x, ht, z, 'speck'); specks++; }
  }
  for (let k = 0; k < 200; k++) add(rand() * 4, 0.3 + rand() * 2, rand() * 3, 'weak', 1);
  const turnPt = (x, z) => [x * c - z * sn, x * sn + z * c];
  const wall = (id, a, b) => { const [x0, z0] = turnPt(...a), [x1, z1] = turnPt(...b); return { id, x0, z0, x1, z1, top: 2.4, n: 60, square: true }; };
  const [bx, bz] = turnPt(box.x, box.z);
  return {
    voxels: [...vox.values()],
    walls: [wall(1, [0, 3], [4, 3]), wall(2, [4, 0], [4, 3])],
    // Turning the map by `turn` turns an object's yaw the other way (inObject's convention).
    objects: [{ ...box, x: bx, z: bz, yaw: box.yaw - turn }],
    table: { center: turnPt(1.6, 1.4), w: 1.2, d: 0.8, h: 0.75 },
  };
}

function run(turn) {
  const r = room(turn);
  const out = buildSurfaces(r.voxels, { minHits: 2, voxel: V, walls: r.walls, objects: r.objects, axis: turn });
  const left = new Set();
  for (let i = 0; i < out.clean.xyz.length; i += 3) left.add(cellOf(out.clean.xyz[i], out.clean.xyz[i + 1], out.clean.xyz[i + 2]));
  const share = (what) => {
    const all = r.voxels.filter((v) => v.what === what);
    return all.filter((v) => left.has(cellOf(v.x, v.y, v.z))).length / all.length;
  };
  return { r, out, share };
}

for (const turn of [0, 0.5]) {
  test(`room turned ${turn} rad: floor, walls, object and table top go; the lamp stays; specks go`, () => {
    const { r, out, share } = run(turn);
    assert.equal(share('floor'), 0, 'floor (and the noise under it)');
    assert.equal(share('wall'), 0, 'walls');
    assert.equal(share('object'), 0, 'the box');
    assert.ok(share('top') < 0.05, `table top left: ${share('top')}`);
    assert.equal(share('speck'), 0, 'specks');
    assert.equal(share('weak'), 0, 'voxels seen once');
    assert.ok(share('lamp') > 0.9, `lamp kept: ${share('lamp')}`);
    assert.ok(out.clean.gray.length === out.clean.xyz.length / 3 && out.clean.gray.every((g) => g === 120));

    assert.equal(out.slabs.length, 1, JSON.stringify(out.slabs));
    const [s] = out.slabs, t = r.table;
    assert.ok(Math.abs(s.h - t.h) < 0.03, `height ${s.h}`);
    assert.ok(Math.abs(s.w - t.w) < 0.15 && Math.abs(s.d - t.d) < 0.15, `size ${s.w} × ${s.d}`);
    assert.ok(Math.hypot(s.x - t.center[0], s.z - t.center[1]) < 0.1, `centre ${s.x}, ${s.z}`);
    assert.equal(s.yaw, turn);
    assert.ok(s.n > 300);
  });
}

test('stats add up: every voxel seen often enough is counted once', () => {
  const { r, out } = run(0.5);
  const st = out.stats;
  assert.equal(st.total, r.voxels.filter((v) => v.n >= 2).length, 'voxels seen once are not in the total');
  assert.equal(st.floor + st.wall + st.object + st.slab + st.speck + st.kept + st.capped, st.total);
  assert.equal(st.kept, out.clean.gray.length);
  assert.equal(st.slab, out.slabs.reduce((a, s) => a + s.n, 0));
  assert.ok(st.speck >= r.voxels.filter((v) => v.what === 'speck').length);
  assert.equal(st.capped, 0);
});

test('too many leftover points: the best-seen ones are kept', () => {
  const vox = [];
  for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++) vox.push({ x: (i + 0.5) * V, y: -1.025, z: (j + 0.5) * V, n: 2 + ((i * 7 + j) % 5), g: 50 });
  // A 2 m × 2 m sheet at 1 m would be a slab; keep it a point cloud by asking for no slabs.
  const out = buildSurfaces(vox, { maxPoints: 500, maxSlabs: 0 });
  assert.equal(out.stats.kept, 500);
  assert.equal(out.stats.capped, 1100);
  const counts = vox.map((v) => v.n).sort((a, b) => b - a), cut = counts[499];
  const keptN = new Map(vox.map((v) => [cellOf(v.x, v.y, v.z), v.n]));
  for (let i = 0; i < 1500; i += 3) assert.ok(keptN.get(cellOf(out.clean.xyz[i], out.clean.xyz[i + 1], out.clean.xyz[i + 2])) >= cut);
});

test('shelves: two flat levels over the same footprint are two slabs; a bare upright surface is none', () => {
  const vox = [];
  const put = (x, ht, z) => vox.push({ x: (Math.floor(x / V) + 0.5) * V, y: (Math.floor(-ht / V) + 0.5) * V, z: (Math.floor(z / V) + 0.5) * V, n: 3, g: 90 });
  for (const ht of [0.61, 1.21]) for (let x = 0; x < 1.0; x += V) for (let z = 0; z < 0.4; z += V) put(x + 0.01, ht, z + 0.01);
  for (let x = 2; x < 3.5; x += V) for (let ht = 0.1; ht < 1.8; ht += V) put(x + 0.01, ht + 0.01, 1.01); // a wall nobody found
  const { slabs } = buildSurfaces(vox, {});
  assert.equal(slabs.length, 2, JSON.stringify(slabs));
  const hs = slabs.map((s) => s.h).sort();
  assert.ok(Math.abs(hs[0] - 0.625) < 0.03 && Math.abs(hs[1] - 1.225) < 0.03, hs.join());
});

test('empty input and nothing to explain it by', () => {
  const out = buildSurfaces([], {});
  assert.equal(out.clean.xyz.length, 0);
  assert.deepEqual(out.slabs, []);
  assert.equal(out.stats.total, 0);
});

test('floor: one-camera smear over the bottom two layers (0–10 cm) is all floor; a post on it stays', () => {
  const vox = [];
  for (let i = 0; i < 40; i++) for (let k = 0; k < 40; k++) for (const ht of [-0.04, 0.01, 0.06]) vox.push(at(i * V + 0.01, ht, k * V + 0.01));
  for (let ht = 0.11; ht < 0.5; ht += V) for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) vox.push(at(1.01 + a * V, ht, 1.01 + b * V));
  const { stats } = buildSurfaces(vox, {});
  assert.equal(stats.floor, 3 * 1600, 'the 5–10 cm layer is floor too');
  assert.equal(stats.kept, 32, JSON.stringify(stats));
});

test('a top seen often and smeared over five full voxel layers is still one slab, at its most-seen height', () => {
  // One camera: every layer from 0.625 to 0.825 m is full, but 0.725 m was seen most.
  const vox = [], views = [6, 30, 90, 40, 8];
  for (let i = 0; i < 24; i++) for (let k = 0; k < 16; k++) views.forEach((n, l) => vox.push(at(1.01 + i * V, 0.61 + l * V, 1.01 + k * V, n)));
  const { slabs, stats } = buildSurfaces(vox, { minHits: 3 });
  assert.equal(slabs.length, 1, JSON.stringify(slabs));
  const [s] = slabs;
  assert.ok(Math.abs(s.h - 0.725) < 0.03, `height ${s.h}`);
  assert.ok(Math.abs(s.w - 1.2) < 0.1 && Math.abs(s.d - 0.8) < 0.1, `size ${s.w} × ${s.d}`);
  assert.ok(stats.slab > 0.95 * stats.total, JSON.stringify(stats));
});

test('a ramp is no slab; a top a few degrees off level (an only roughly levelled map) still is', () => {
  const vox = [];
  for (let x = 0; x < 3; x += 0.02) for (let z = 0; z < 1; z += 0.02) vox.push(at(x, 0.3 + x * 0.2, z)); // 0.3 → 0.9 m
  const g = Math.tan((3 * Math.PI) / 180);
  for (let x = 0; x < 1.2; x += 0.02) for (let z = 3; z < 3.6; z += 0.02) vox.push(at(x, 0.8 + (x - 0.6) * g, z));
  const seen = new Set(), list = vox.filter((v) => !seen.has(cellOf(v.x, v.y, v.z)) && seen.add(cellOf(v.x, v.y, v.z)));
  const { slabs } = buildSurfaces(list, {});
  assert.equal(slabs.length, 1, JSON.stringify(slabs));
  assert.ok(Math.abs(slabs[0].h - 0.8) < 0.04 && Math.abs(slabs[0].z - 3.3) < 0.1, JSON.stringify(slabs[0]));
});

test('walls and objects take only what is on them; broken or zero-length ones take nothing', () => {
  // A solid block of voxels, a wall turned 0.5 rad across it, and a box raised 1 m (on a shelf, say).
  const vox = [];
  for (let i = -10; i < 50; i++) for (let k = -10; k < 30; k++) for (let j = 2; j < 40; j++) vox.push({ x: (i + 0.5) * V, y: -(j + 0.5) * V, z: (k + 0.5) * V, n: 3, g: 90 });
  const ux = Math.cos(0.5), uz = Math.sin(0.5), wall = { id: 1, x0: 0, z0: 0, x1: 2 * ux, z1: 2 * uz, top: 1.5, n: 9, square: true };
  const box = { cls: 'box', x: 1.5, z: -0.2, bottom: -1.0, w: 0.4, h: 0.3, d: 0.3, yaw: 0.4 };
  const junk = [{ id: 2, x0: 0.5, z0: 1, x1: 0.5, z1: 1, top: 2, n: 9 }, { id: 3, x0: NaN, z0: 0, x1: 1, z1: 0, top: 2, n: 9 }];
  const out = buildSurfaces(vox, { walls: [wall, ...junk], objects: [box, { ...box, x: NaN }], minNeighbors: 0, maxSlabs: 0 });
  // What each should take, from the contract: the wall's line ± 0.12 m, its ends ± 0.1 m, up to
  // top + 0.15 m; the box's footprint (inObject's) + 0.08 m, from its base − 0.05 to its top + 0.1 m.
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw);
  let wallN = 0, objN = 0;
  const left = new Set();
  for (const v of vox) {
    const ht = -v.y, t = v.x * ux + v.z * uz, off = Math.abs(v.z * ux - v.x * uz), dx = v.x - box.x, dz = v.z - box.z;
    if (t > -0.1 && t < 2.1 && off < 0.12 && ht < 1.65) wallN++;
    else if (Math.abs(dx * c - dz * s) < 0.28 && Math.abs(dx * s + dz * c) < 0.23 && ht > 0.95 && ht < 1.4) objN++;
    else left.add(cellOf(v.x, v.y, v.z));
  }
  assert.ok(wallN > 0 && objN > 0);
  assert.equal(out.stats.wall, wallN);
  assert.equal(out.stats.object, objN);
  assert.equal(out.stats.kept, left.size);
  for (let i = 0; i < out.clean.xyz.length; i += 3) assert.ok(left.has(cellOf(out.clean.xyz[i], out.clean.xyz[i + 1], out.clean.xyz[i + 2])));
});

test('lenient inputs: no axis yet gives slabs on the map x axis; a bad maxPoints keeps the default cap', () => {
  const vox = [];
  for (let i = 0; i < 20; i++) for (let k = 0; k < 10; k++) vox.push(at(i * V + 0.01, 0.8, k * V + 0.01));
  for (const axis of [null, NaN, undefined]) {
    const { slabs } = buildSurfaces(vox, { axis });
    assert.equal(slabs.length, 1);
    assert.equal(slabs[0].yaw, 0);
  }
  for (const maxPoints of [null, NaN, -1]) assert.equal(buildSurfaces(vox, { maxPoints, maxSlabs: 0 }).stats.kept, 200);
});

test('performance: 500k voxels in well under the worker budget', (t) => {
  const vox = bigMap(500000);
  const opts = { minHits: 2, voxel: V, walls: vox.walls, objects: vox.objects, axis: 0.2 };
  buildSurfaces(vox.list, opts); // warm up
  const t0 = performance.now(), out = buildSurfaces(vox.list, opts), ms = performance.now() - t0;
  t.diagnostic(`${vox.list.length} voxels in ${ms.toFixed(0)} ms: ${JSON.stringify(out.stats)}, ${out.slabs.length} slabs`);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
});

/** A big, noisy, turned map: floors, walls, tables, objects, clutter and specks; about `count` voxels. */
function bigMap(count) {
  let s = 5;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const turn = 0.2, c = Math.cos(turn), sn = Math.sin(turn);
  const seen = new Set(), list = [];
  const add = (x, ht, z) => {
    const mx = x * c - z * sn, mz = x * sn + z * c;
    const i = Math.floor(mx / V), j = Math.floor(-ht / V), k = Math.floor(mz / V), key = (i + 4096) * 67108864 + (j + 4096) * 8192 + (k + 4096);
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ n: 2 + ((rand() * 6) | 0), g: (rand() * 255) | 0, x: (i + 0.5) * V, y: (j + 0.5) * V, z: (k + 0.5) * V });
  };
  const walls = [], objects = [];
  const turnPt = (x, z) => [x * c - z * sn, x * sn + z * c];
  for (let x = 0; x < 20; x += 0.04) for (let z = 0; z < 15; z += 0.04) add(x, (rand() - 0.6) * 0.1, z); // floor
  for (let r = 0; r < 4; r++) {
    for (let q = 0; q < 2; q++) {
      const z = 3 + r * 3.5 + q * 0.1, [x0, z0] = turnPt(0, z), [x1, z1] = turnPt(20, z);
      if (!q) walls.push({ id: walls.length + 1, x0, z0, x1, z1, top: 2.5, n: 99, square: true });
      for (let x = 0; x < 20; x += 0.04) for (let ht = 0.05; ht < 2.5; ht += 0.04) if (rand() < 0.9) add(x, ht, z + (rand() - 0.5) * 0.08);
    }
  }
  for (let k = 0; k < 20; k++) { // tables
    const x0 = 1 + rand() * 17, z0 = 0.5 + rand() * 13, ht = 0.5 + rand() * 0.6;
    for (let x = x0; x < x0 + 1.2; x += 0.03) for (let z = z0; z < z0 + 0.8; z += 0.03) add(x, ht + (rand() - 0.5) * 0.05, z);
  }
  for (let k = 0; k < 10; k++) { // detected objects, as solid-ish blobs
    const x = 1 + rand() * 18, z = 1 + rand() * 13, [mx, mz] = turnPt(x, z);
    objects.push({ cls: 'chair', x: mx, z: mz, bottom: 0, w: 0.5, h: 0.9, d: 0.5, yaw: -turn });
    for (let a = -0.25; a < 0.25; a += 0.04) for (let b = -0.25; b < 0.25; b += 0.04) for (let ht = 0.1; ht < 0.9; ht += 0.04) if (rand() < 0.3) add(x + a, ht, z + b);
  }
  while (list.length < count * 0.9) { // clutter: smeared clumps, as one-camera depth leaves
    const x = rand() * 20, z = rand() * 15, ht = 0.1 + rand() * 2.2;
    for (let q = 0; q < 60; q++) add(x + (rand() - 0.5) * 0.4, ht + (rand() - 0.5) * 0.4, z + (rand() - 0.5) * 0.4);
  }
  while (list.length < count) add(rand() * 20, rand() * 2.5, rand() * 15); // specks
  return { list, walls, objects };
}
