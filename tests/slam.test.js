import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig } from '../js/geometry.js';
import { angleOf, apply, compose, expSO3, identity, invert, logSO3, mul3, refinePose, tr3 } from '../js/slam/se3.js';
import { buildPyramid, goodFeatures, trackFB } from '../js/slam/klt.js';
import { disparityBM, localNormalize } from '../js/slam/dense.js';
import { rectification, remap } from '../js/slam/rectify.js';
import { buildingScene, CAM_HEIGHT, renderGray, tour } from '../js/slam/building.js';
import { StereoVO } from '../js/slam/vo.js';
import { World } from '../js/slam/world.js';
import { GoalPlanner } from '../js/slam/plan.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ± ${tol}, got ${a}`);

// A smooth random texture, so shifts and disparities are known exactly.
const tex = (x, y) => 128 + 45 * Math.sin(x * 0.31 + Math.cos(y * 0.17) * 2) * Math.cos(y * 0.23 - x * 0.05) + 35 * Math.sin(x * 0.11 - y * 0.29);
function image(w, h, fn) {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = fn(x, y);
  return a;
}

test('rotation exp/log round-trip and pose inverse', () => {
  const w = [0.3, -0.7, 0.2];
  const back = logSO3(expSO3(w));
  w.forEach((v, i) => near(back[i], v, 1e-9));
  const p = { R: expSO3([0.1, 0.4, -0.2]), t: [1, 2, 3] };
  const id = compose(p, invert(p));
  near(angleOf(id.R), 0, 1e-9);
  id.t.forEach((v) => near(v, 0, 1e-9));
});

test('pose refinement recovers a camera pose from 3D points', () => {
  const intr = { f: 230, cx: 160, cy: 90 };
  const truth = { R: expSO3([0.05, -0.2, 0.03]), t: [0.3, -0.1, 0.4] }; // world → camera
  const X = [], uv = [];
  for (let i = 0; i < 60; i++) {
    const Xw = [Math.sin(i) * 2, Math.cos(i * 1.3) * 1, 3 + (i % 7) * 0.4];
    const c = apply(truth, Xw);
    X.push(...Xw);
    uv.push(intr.f * c[0] / c[2] + intr.cx + (i % 5 === 0 ? 0.3 : 0), intr.f * c[1] / c[2] + intr.cy);
  }
  // Two gross outliers that Huber weighting has to shrug off.
  uv[0] += 40; uv[3] -= 35;
  const r = refinePose(identity(), Float64Array.from(X), Float64Array.from(uv), intr);
  near(angleOf(mul3(tr3(r.pose.R), truth.R)) * 180 / Math.PI, 0, 0.1, 'rotation (deg)');
  truth.t.forEach((v, i) => near(r.pose.t[i], v, 0.02, 'translation'));
});

test('KLT follows a known shift to a hundredth of a pixel', () => {
  const w = 200, h = 120, sx = 3.4, sy = -1.7;
  const a = image(w, h, tex), b = image(w, h, (x, y) => tex(x - sx, y - sy));
  const pa = buildPyramid(a, w, h, 3), pb = buildPyramid(b, w, h, 3);
  const pts = goodFeatures(pa[0], { maxCorners: 40, minDistance: 12 });
  assert.ok(pts.length / 2 >= 20, `${pts.length / 2} corners`);
  const r = trackFB(pa, pb, pts);
  const errs = [];
  for (let i = 0; i < pts.length / 2; i++) {
    if (r.ok[i]) errs.push(Math.hypot(r.pts[2 * i] - pts[2 * i] - sx, r.pts[2 * i + 1] - pts[2 * i + 1] - sy));
  }
  errs.sort((p, q) => p - q);
  assert.ok(errs.length >= 10, `${errs.length} tracked`);
  assert.ok(errs[errs.length >> 1] < 0.02, `median error ${errs[errs.length >> 1]}`);
  assert.ok(errs[errs.length - 1] < 0.1, `worst error ${errs[errs.length - 1]}`);
});

test('block matching finds a known disparity, even with different exposure', () => {
  const w = 160, h = 100, d = 12.4;
  const L = image(w, h, tex);
  const R = image(w, h, (x, y) => 0.8 * tex(x + d, y) + 20); // right camera darker and offset
  const nL = localNormalize(L, w, h), nR = localNormalize(R, w, h);
  const disp = disparityBM(nL.data, nR.data, w, h, { maxDisp: 32, texture: nL.std });
  const vals = [...disp].filter((v) => v > 0).sort((p, q) => p - q);
  assert.ok(vals.length > 0.5 * (w - 40) * (h - 10), `${vals.length} valid`);
  near(vals[vals.length >> 1], d, 0.15, 'median disparity');
});

test('rectification lines up a toed-in pair on the same rows', () => {
  const params = { baselineCm: 12, angleDeg: 4, hfovDeg: 70 };
  const w = 320, h = 180;
  const rig = buildRig(params, { w, h });
  const rect = rectification(params, w, h);
  // A point 3 m ahead: after rectification both views put it on the same row.
  const X = [0.4, -0.3, 3];
  const proj = (cam) => {
    const p = [X[0] - cam.pos[0], X[1], X[2]];
    const xc = cam.cos * p[0] - cam.sin * p[2], zc = cam.sin * p[0] + cam.cos * p[2];
    return [cam.cx + cam.f * xc / zc, cam.cy + cam.f * p[1] / zc];
  };
  const find = (map, target) => {
    let best = null, bd = Infinity;
    for (let i = 0; i < w * h; i++) {
      const dd = Math.hypot(map[2 * i] - target[0], map[2 * i + 1] - target[1]);
      if (dd < bd) { bd = dd; best = [i % w, (i / w) | 0]; }
    }
    return best;
  };
  const a = find(rect.mapL, proj(rig.left)), b = find(rect.mapR, proj(rig.right));
  assert.ok(Math.abs(a[1] - b[1]) <= 1, `rows ${a[1]} vs ${b[1]}`);
  // and the disparity matches depth: d = f·B / Z
  near(a[0] - b[0], (rect.f * 0.12) / 3, 1.5, 'disparity');
  assert.ok(remap(new Float32Array(w * h).fill(7), w, h, rect.mapL).every((v) => v === 7));
});

test('walking through the demo building: tracking, the map, and a route back', () => {
  const W = 320, H = 180, params = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
  const rig = buildRig(params, { w: W, h: H }), scene = buildingScene();
  const frames = tour({ fps: 10 });
  const vo = new StereoVO(params, W, H), world = new World({ camHeight: CAM_HEIGHT });
  let walked = 0, worst = 0, lost = 0, last = null, prev = null;
  for (const fr of frames) {
    const r = vo.process({ left: renderGray(rig.left, fr.pose, scene, W, H), right: renderGray(rig.right, fr.pose, scene, W, H), t: fr.t });
    if (r.status === 'lost') lost++;
    if (r.keyframe) world.addKeyframe(r.keyframe);
    // Odometry frame = left camera at the start; compare with where the left camera really is.
    const cam = apply(fr.pose, [-0.06, 0, 0]);
    const truth = [cam[0] + 0.06, cam[1], cam[2]];
    if (prev) walked += Math.hypot(truth[0] - prev[0], truth[2] - prev[2]);
    prev = truth;
    worst = Math.max(worst, Math.hypot(r.pose.t[0] - truth[0], r.pose.t[2] - truth[2]));
    last = { r, fr };
  }
  assert.equal(lost, 0, 'never lost track');
  assert.ok(walked > 12, `walked ${walked.toFixed(1)} m`);
  assert.ok(worst < 0.03 * walked, `worst drift ${worst.toFixed(3)} m over ${walked.toFixed(1)} m`);
  const heading = angleOf(mul3(tr3(last.r.pose.R), last.fr.pose.R)) * 180 / Math.PI;
  assert.ok(heading < 3, `heading error ${heading.toFixed(2)}°`);

  // The floor was found and sits where it really is.
  assert.equal(world.floor, 'fitted');
  const camInMap = world.mapPose(identity()).t;
  near(-camInMap[1], CAM_HEIGHT, 0.06, 'camera height above the floor');

  // The floor grid knows the walls and the doorway.
  const g = world.gridSnapshot();
  const at = (x, z) => g.data[Math.floor((z - g.z0) / g.cell) * g.w + Math.floor((x - g.x0) / g.cell)];
  const near3 = (x, z) => [-0.1, -0.05, 0, 0.05, 0.1].some((d) => at(x + d, z) === 1);
  assert.ok([0.5, 1.5, 2.5].filter((z) => near3(2.5, z)).length >= 2, 'shared wall below the door is blocked');
  assert.ok([3.3, 3.5, 3.7].every((z) => at(2.5, z) === 0), 'the doorway is free');
  assert.ok([4.0, 4.5].some((x) => at(x, 3.5) === 0), 'room B is free');

  // From the end of the walk back to the start: through the doorway, not through the wall.
  const mp = world.mapPose(last.r.pose);
  const user = { x: mp.t[0], z: mp.t[2] };
  const route = new GoalPlanner(g, { x: 0, z: 0 }, user).route(user);
  assert.ok(route.ok, route.reason);
  const crossing = route.path.find((p, i) => i && (p[0] - 2.5) * (route.path[i - 1][0] - 2.5) <= 0);
  const k = route.path.indexOf(crossing);
  const [a, b] = [route.path[k - 1], route.path[k]];
  const zAtWall = a[1] + ((2.5 - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  assert.ok(zAtWall > 3.1 && zAtWall < 3.9, `crosses the wall at z = ${zAtWall.toFixed(2)}`);
  assert.ok(route.length < 8, `route ${route.length.toFixed(1)} m`);

  // Save and load: the rebuilt map has the same floor grid.
  const copy = World.deserialize(JSON.parse(JSON.stringify(world.serialize())));
  assert.deepEqual(copy.gridSnapshot().data, g.data);
  assert.ok(new Uint8Array(world.toPLY()).length > 100000, 'PLY export');
});
