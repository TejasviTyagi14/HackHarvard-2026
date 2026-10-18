// Records the landing-page hero: runs the real stereo pipeline (StereoVO + World) headlessly over
// the demo tour in an enlarged, furnished building, and writes
//   data/tour.json        frames (map-frame camera poses), boxes, walls, layout of the points file
//   data/tour-points.bin  every point with the time it appears (pipeline voxels + surface samples)
// Run: node tools/record-tour.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildRig } from '../js/geometry.js';
import { buildingScene, CAM_HEIGHT, renderGray, tour, firstHit } from '../js/slam/building.js';
import { texture } from '../js/demo.js';
import { apply } from '../js/slam/se3.js';
import { StereoVO } from '../js/slam/vo.js';
import { World } from '../js/slam/world.js';

const W = 320, H = 180, params = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
const PATH = [[0, 0], [0, 2.2], [0.9, 3.4], [2.5, 3.5], [4.5, 3.5], [5.6, 2.6], [6.7, 3.0], [6.6, 4.0], [5.2, 4.3], [3.6, 3.6]];
const block = (cls, x, z, w, d, h, color, seed) => ({ kind: 'furniture', cls, min: [x - w / 2, CAM_HEIGHT - h, z - d / 2], max: [x + w / 2, CAM_HEIGHT, z + d / 2], seed, color });

const scene = buildingScene();
let seed = 300;
const add = (cls, x, z, w, d, h, color) => scene.boxes.push(block(cls, x, z, w, d, h, color, seed++));
// Room A
add('chair', -1.5, 0.95, 0.45, 0.45, 0.9, 150); add('chair', -0.9, 0.95, 0.45, 0.45, 0.9, 135);
add('chair', -1.5, 2.25, 0.45, 0.45, 0.9, 145); add('chair', -0.9, 2.25, 0.45, 0.45, 0.9, 155);
add('bed', 1.6, 0.0, 1.4, 2.0, 0.55, 165);
add('book', -1.5, -1.22, 1.0, 0.35, 1.8, 125);
add('potted plant', -2.1, -1.05, 0.4, 0.4, 1.0, 100); add('potted plant', 2.1, 4.6, 0.4, 0.4, 1.1, 105);
add('couch', -0.9, 3.6, 1.4, 0.8, 0.8, 115);
add('tv', -1.0, 4.8, 1.2, 0.2, 1.05, 90);
add('person', 1.5, 2.2, 0.45, 0.3, 1.75, 160); add('person', -1.9, -0.2, 0.45, 0.3, 1.7, 150);
// Room B
add('bed', 7.05, 1.6, 1.7, 1.0, 0.55, 170);
add('dining table', 4.2, 5.2, 1.0, 0.7, 0.75, 140);
add('chair', 3.35, 5.2, 0.45, 0.45, 0.9, 150); add('chair', 5.05, 5.2, 0.45, 0.45, 0.9, 140);
add('shelf', 7.75, 4.2, 0.35, 1.2, 1.9, 120);
add('tv', 3.4, 1.2, 1.0, 0.25, 1.2, 95);
add('potted plant', 2.85, 1.35, 0.4, 0.4, 1.0, 100); add('potted plant', 7.6, 5.6, 0.4, 0.4, 1.2, 110); add('potted plant', 2.85, 5.6, 0.35, 0.35, 0.9, 105);
add('person', 5.5, 1.5, 0.45, 0.3, 1.75, 165); add('person', 7.55, 2.9, 0.3, 0.45, 1.7, 155);

// Clearance from the tour path.
function segDist(px, pz, [ax, az], [bx, bz]) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const s = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L));
  return Math.hypot(px - ax - s * dx, pz - az - s * dz);
}
for (const b of scene.boxes) {
  if (b.kind !== 'furniture') continue;
  let best = Infinity;
  for (let i = 1; i < PATH.length; i++) {
    for (let u = 0; u <= 10; u++) for (let v = 0; v <= 10; v++) {
      const x = b.min[0] + (b.max[0] - b.min[0]) * u / 10, z = b.min[2] + (b.max[2] - b.min[2]) * v / 10;
      best = Math.min(best, segDist(x, z, PATH[i - 1], PATH[i]));
    }
  }
  if (best < 0.6) console.warn(`  ! ${b.cls} at ${b.min[0].toFixed(2)},${b.min[2].toFixed(2)} only ${best.toFixed(2)} m from the path`);
}

// Map frame: odometry origin = left camera at the start (world x − 0.06), y shifted so floor = 0.
const OX = 0.06;
const toMap = (p) => [p[0] + OX, p[1] - CAM_HEIGHT, p[2]];
const r3 = (v) => Math.round(v * 1000) / 1000;

const rig = buildRig(params, { w: W, h: H });
const frames = tour({ fps: 10 });
const vo = new StereoVO(params, W, H), world = new World({ camHeight: CAM_HEIGHT });
const TAN_H = Math.tan(35 * Math.PI / 180), TAN_V = TAN_H * 9 / 16;

// Visible-surface samples for every box face (not bottoms; walls skip tops too).
const samples = []; // { p:[x,y,z] world, n:[..], g, seen:-1, box }
function sampleFace(b, axis, sign, step) {
  const [a1, a2] = [0, 1, 2].filter((a) => a !== axis);
  const lo1 = b.min[a1], hi1 = b.max[a1], lo2 = b.min[a2], hi2 = b.max[a2];
  const fixed = sign > 0 ? b.max[axis] : b.min[axis];
  const n = [0, 0, 0]; n[axis] = sign;
  const light = axis === 1 ? 1.1 : axis === 0 ? 0.85 : 1;
  for (let s = lo1 + step / 2; s < hi1; s += step) for (let q = lo2 + step / 2; q < hi2; q += step) {
    const p = [0, 0, 0];
    p[axis] = fixed + sign * 0.002;
    p[a1] = Math.min(hi1, Math.max(lo1, s + (Math.random() - 0.5) * step * 0.6));
    p[a2] = Math.min(hi2, Math.max(lo2, q + (Math.random() - 0.5) * step * 0.6));
    const [ts, tq] = axis === 0 ? [p[2], p[1]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]];
    const g = Math.min(255, b.color * light * (0.5 + 0.85 * texture(ts, tq, b.seed)));
    samples.push({ p, n, g, seen: -1, box: b });
  }
}
for (const b of scene.boxes) {
  const step = b.kind === 'wall' ? 0.04 : 0.03;
  for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
    if (axis === 1 && (sign > 0 || b.kind === 'wall')) continue; // y down: sign −1 is the top
    sampleFace(b, axis, sign, step);
  }
}

const boxSeen = new Map(scene.boxes.map((b) => [b, -1]));
const outFrames = [], pipe = [], keys = new Set();
let lost = 0, worst = 0, kfs = 0;
const t0 = Date.now();
const inView = (pose, p, maxD) => {
  const d = [p[0] - pose.t[0], p[1] - pose.t[1], p[2] - pose.t[2]], R = pose.R;
  const x = R[0] * d[0] + R[3] * d[1] + R[6] * d[2], y = R[1] * d[0] + R[4] * d[1] + R[7] * d[2], z = R[2] * d[0] + R[5] * d[1] + R[8] * d[2];
  return z > 0.15 && z < maxD && Math.abs(x) < z * TAN_H && Math.abs(y) < z * TAN_V ? Math.hypot(x, y, z) : 0;
};

for (const fr of frames) {
  const r = vo.process({ left: renderGray(rig.left, fr.pose, scene, W, H), right: renderGray(rig.right, fr.pose, scene, W, H), t: fr.t });
  if (r.status === 'lost') lost++;
  const cam = apply(fr.pose, [-0.06, 0, 0]);
  worst = Math.max(worst, Math.hypot(r.pose.t[0] - cam[0] - 0.06, r.pose.t[2] - cam[2]));
  if (r.keyframe) {
    world.addKeyframe(r.keyframe);
    kfs++;
    const { xyz, gray } = world.takePoints();
    for (let i = 0; i < gray.length; i++) {
      const k = `${Math.round(xyz[3 * i] * 40)},${Math.round(xyz[3 * i + 1] * 40)},${Math.round(xyz[3 * i + 2] * 40)}`;
      if (keys.has(k)) continue;
      keys.add(k);
      pipe.push([xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2], gray[i], fr.t]);
    }
  }
  const mp = world.mapPose(r.pose);
  outFrames.push({ t: r3(fr.t), p: mp.t.map(r3), R: mp.R.map((v) => Math.round(v * 1e4) / 1e4), s: r.status });

  // Boxes first in view within 5 m (corners + centre, any inside the frustum).
  const eye = fr.pose.t;
  for (const b of scene.boxes) {
    if (boxSeen.get(b) >= 0) continue;
    const pts = [];
    for (const x of [b.min[0], (b.min[0] + b.max[0]) / 2, b.max[0]]) for (const y of [b.min[1], (b.min[1] + b.max[1]) / 2, b.max[1]]) for (const z of [b.min[2], (b.min[2] + b.max[2]) / 2, b.max[2]]) pts.push([x, y, z]);
    const visible = (p) => {
      const dist = inView(fr.pose, p, 5);
      if (!dist) return false;
      const hit = firstHit(eye, [(p[0] - eye[0]) / dist, (p[1] - eye[1]) / dist, (p[2] - eye[2]) / dist], scene);
      return !hit || hit.box === b || hit.t > dist - 0.05 || hit.box.kind !== 'wall';
    };
    if (pts.some(visible)) boxSeen.set(b, fr.t);
  }
  // Surface samples: facing the camera, inside the frustum within 6 m, not hidden behind another box.
  for (const s of samples) {
    if (s.seen >= 0) continue;
    const p = s.p, n = s.n;
    if ((eye[0] - p[0]) * n[0] + (eye[1] - p[1]) * n[1] + (eye[2] - p[2]) * n[2] <= 0) continue;
    const dist = inView(fr.pose, p, 6);
    if (!dist) continue;
    const d = [(p[0] - eye[0]) / dist, (p[1] - eye[1]) / dist, (p[2] - eye[2]) / dist];
    const hit = firstHit(eye, d, scene);
    if (hit && hit.t < dist - 0.03) continue;
    s.seen = fr.t;
  }
}

const seenSamples = samples.filter((s) => s.seen >= 0);
const last = outFrames[outFrames.length - 1], lastTrue = frames[frames.length - 1];
console.log(`frames ${frames.length}, keyframes ${kfs}, lost ${lost}, worst drift ${worst.toFixed(3)} m, floor ${world.floor}`);
console.log(`map pose at end ${last.p.join(', ')} vs truth→map ${toMap(apply(lastTrue.pose, [-0.06, 0, 0])).map(r3).join(', ')}`);

// Points: pipeline (kind 0) + surface samples (kind 1), sorted by time. Budget ~190k.
let surf = seenSamples;
const budget = 190000 - pipe.length;
if (surf.length > budget) { const keep = budget / surf.length; surf = surf.filter(() => Math.random() < keep); }
const all = [
  ...pipe.map(([x, y, z, g, t]) => ({ x, y, z, g, k: 0, t })),
  ...surf.map((s) => { const m = toMap(s.p); return { x: m[0], y: m[1], z: m[2], g: s.g, k: 1, t: s.seen }; }),
].sort((a, b) => a.t - b.t);
const N = all.length;
const buf = new ArrayBuffer(N * 10);
const X = new Int16Array(buf, 0, N), Y = new Int16Array(buf, 2 * N, N), Z = new Int16Array(buf, 4 * N, N);
const G = new Uint8Array(buf, 6 * N, N), K = new Uint8Array(buf, 7 * N, N), T = new Uint16Array(buf, 8 * N, N);
all.forEach((p, i) => { X[i] = Math.round(p.x * 1000); Y[i] = Math.round(p.y * 1000); Z[i] = Math.round(p.z * 1000); G[i] = Math.round(p.g); K[i] = p.k; T[i] = Math.round(p.t / 0.05); });

const conv = (b) => { const a = toMap(b.min), c = toMap(b.max); return { min: a.map(r3), max: c.map(r3) }; };
const boxes = scene.boxes.filter((b) => b.kind === 'furniture').map((b) => ({ cls: b.cls, ...conv(b), seen: boxSeen.get(b) }));
const walls = scene.boxes.filter((b) => b.kind === 'wall').map((b) => ({ ...conv(b), seen: boxSeen.get(b) }));
const duration = r3(frames[frames.length - 1].t + 0.1);
const json = {
  about: 'Prerecorded flythrough of the stereo pipeline on the demo building (tools/record-tour.mjs). Map frame: x right, y DOWN (floor y = 0), z forward; metres.',
  duration, fps: 10, hfovDeg: 70, camHeight: CAM_HEIGHT,
  frames: outFrames.map(({ t, p, R }) => ({ t, p, R })),
  boxes, walls,
  counts: { points: N, pipeline: pipe.length, surface: surf.length, frames: outFrames.length, boxes: boxes.length, walls: walls.length },
  points: {
    file: 'tour-points.bin', count: N, littleEndian: true,
    layout: 'struct-of-arrays, N points sorted by time: Int16 x[N] @0, Int16 y[N] @2N, Int16 z[N] @4N (millimetres, map frame), Uint8 gray[N] @6N, Uint8 kind[N] @7N (0 pipeline voxel, 1 surface sample), Uint16 time[N] @8N (units of 0.05 s). Total 10N bytes.',
  },
};
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/tour.json', import.meta.url), JSON.stringify(json));
writeFileSync(new URL('../data/tour-points.bin', import.meta.url), Buffer.from(buf));
const js = JSON.stringify(json).length;
console.log(`points ${N} (pipeline ${pipe.length}, surface ${surf.length} of ${samples.length} sampled), boxes ${boxes.length} (seen ${boxes.filter((b) => b.seen >= 0).length}), walls ${walls.length}`);
console.log(`tour.json ${(js / 1024).toFixed(0)} KB, tour-points.bin ${(N * 10 / 1024).toFixed(0)} KB, total ${((js + N * 10) / 1048576).toFixed(2)} MB, duration ${duration} s, took ${((Date.now() - t0) / 1000).toFixed(1)} s`);
