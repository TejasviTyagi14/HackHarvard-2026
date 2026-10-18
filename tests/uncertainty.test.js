import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig, pixelRay } from '../js/geometry.js';
import { apply, invert, logSO3, mul3, mulv, refinePose, rotX, rotY, tr3 } from '../js/slam/se3.js';
import { buildingScene, firstHit, poseAt, renderGray, tour } from '../js/slam/building.js';
import { StereoVO } from '../js/slam/vo.js';
import { DriftTracker, combine, floorCovariance, inverseSPD, poseCovariance } from '../js/slam/uncertainty.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ± ${tol}, got ${a}`);
const DEG = Math.PI / 180;
const intr = { f: 230, cx: 160, cy: 90 };

// Repeatable noise.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Camera → world for these tests: turned 30° right and moved, so the frame conversion is exercised.
const camWc = { R: rotY(30 * DEG), t: [1, -0.2, 2] }, camCw = invert(camWc);
/** n world points in view, between z0 and z1 m ahead of the camera. */
function points(n, z0, z1) {
  const X = [];
  for (let i = 0; i < n; i++) {
    const z = z0 + (z1 - z0) * rnd();
    X.push(...apply(camWc, [(rnd() * 2 - 1) * 0.55 * z, (rnd() * 2 - 1) * 0.35 * z, z]));
  }
  return Float64Array.from(X);
}
const image = (X, sigma) => {
  const uv = [];
  for (let i = 0; i < X.length / 3; i++) {
    const c = apply(camCw, [X[3 * i], X[3 * i + 1], X[3 * i + 2]]);
    uv.push(intr.f * c[0] / c[2] + intr.cx + sigma * gauss(), intr.f * c[1] / c[2] + intr.cy + sigma * gauss());
  }
  return Float64Array.from(uv);
};
// A compass-like prior on the turn (towards the truth), weighted like 15 tracked points.
const compass = (R) => {
  const k = (15 * 2 * intr.f * intr.f) / 3, r = logSO3(mul3(R, tr3(camCw.R))), H = new Array(36).fill(0);
  H[0] = H[7] = H[14] = k;
  return { H, g: [k * r[0], k * r[1], k * r[2], 0, 0, 0] };
};
const cov3 = (rows) => {
  const m = [0, 1, 2].map((i) => rows.reduce((s, r) => s + r[i], 0) / rows.length), S = new Array(9).fill(0);
  for (const r of rows) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i * 3 + j] += ((r[i] - m[i]) * (r[j] - m[j])) / (rows.length - 1);
  return S;
};
const trace = (S) => S[0] + S[4] + S[8];
const conj = (R, S) => mul3(mul3(R, S), tr3(R));

/**
 * `fits` fits of n points seen with sigma px of noise on each image axis: what the info predicts
 * (from each fit's own rmse, the way vo.js calls it) against where the camera really scatters.
 */
function scatter(n, sigma, huber, fits) {
  const X = points(n, 2, 5), pos = [], rot = [], pred = { pos: new Array(9).fill(0), rot: new Array(9).fill(0) };
  for (let k = 0; k < fits; k++) {
    const r = refinePose(camCw, X, image(X, sigma), intr, { huber });
    const u = poseCovariance(r.info, r.rmse, r.pose.R, { n: r.err.filter((e) => e < 3).length });
    for (let i = 0; i < 9; i++) { pred.pos[i] += u.pos[i] / fits; pred.rot[i] += u.rot[i] / fits; }
    const wc = invert(r.pose);
    pos.push(wc.t.map((v, i) => v - camWc.t[i]));
    rot.push(logSO3(mul3(wc.R, tr3(camWc.R))));
  }
  return { pred, P: cov3(pos), Q: cov3(rot), X };
}

test('pose fit information: symmetric positive definite, and its spread matches noisy fits', () => {
  seed = 7;
  const X = points(60, 2, 5), r = refinePose(camCw, X, image(X, 1), intr);
  assert.equal(r.info.length, 36);
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) near(r.info[a * 6 + b], r.info[b * 6 + a], 1e-9 * Math.abs(r.info[a * 6 + b]) + 1e-12, 'symmetric');
  assert.ok(inverseSPD(r.info, 6, 1e-6), 'positive definite (and well conditioned)');
  for (let k = 0; k < 20; k++) {
    const x = Array.from({ length: 6 }, gauss);
    let q = 0;
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) q += x[a] * r.info[a * 6 + b] * x[b];
    assert.ok(q > 0, 'xᵀ·info·x > 0');
  }
  // Where the camera centre and its turn really scatter (world frame) vs what the info predicts.
  // The rmse is of the whole (u, v) miss, √2 × the noise on each axis: taking it as the per-axis
  // noise would double every variance.
  const plain = scatter(60, 1, 1e9, 150);
  near(trace(plain.pred.pos) / trace(plain.P), 1, 0.25, 'position spread, predicted / seen');
  near(trace(plain.pred.rot) / trace(plain.Q), 1, 0.25, 'turn spread, predicted / seen');
  for (const i of [0, 4, 8]) near(plain.pred.pos[i] / plain.P[i], 1, 0.45, `position variance ${i}`);
  // As vo.js fits (Huber at 1 px, so many points are weighed down), and at the 10 points tracking
  // gets by on, where the fit's own share of the residual matters.
  const robust = scatter(60, 0.7, 1, 150), few = scatter(10, 1, 1e9, 300);
  near(trace(robust.pred.pos) / trace(robust.P), 1, 0.25, 'Huber 1 px: position spread, predicted / seen');
  near(trace(few.pred.pos) / trace(few.P), 1, 0.2, '10 points: position spread, predicted / seen');
  near(trace(few.pred.rot) / trace(few.Q), 1, 0.2, '10 points: turn spread, predicted / seen');
  // A singular fit (all points in one spot) has no covariance.
  const one = Float64Array.from([...Array(8)].flatMap(() => [X[0], X[1], X[2]]));
  assert.equal(poseCovariance(refinePose(camCw, one, image(one, 0), intr).info, 1, camCw.R), null);
});

test('fewer or farther points: a wider spread; far points with the turn known: longest along the view', () => {
  const spread = (n, z0, z1, extra = null) => {
    seed = 11;
    const X = points(n, z0, z1), r = refinePose(camCw, X, image(X, 0), intr, { extra });
    const u = poseCovariance(r.info, r.rmse, r.pose.R);
    return { u, cam: conj(camCw.R, u.pos) }; // position spread in the camera's own axes
  };
  const base = spread(120, 2, 5), few = spread(20, 2, 5), far = spread(120, 8, 16);
  assert.ok(trace(few.u.pos) > 3 * trace(base.u.pos), 'fewer points');
  assert.ok(trace(far.u.pos) > 3 * trace(base.u.pos), 'farther points');
  assert.ok(trace(few.u.rot) > trace(base.u.rot), 'fewer points: the turn too');
  // A noise floor: a perfect fit (rmse 0) still counts as 0.5 px of noise.
  assert.ok(trace(base.u.pos) > 0);
  // Far away, with the compass knowing the turn: how far forward is the weak direction…
  const fc = spread(40, 8, 16, compass);
  assert.ok(fc.cam[8] > 1.3 * fc.cam[0], `forward ${Math.sqrt(fc.cam[8]).toFixed(3)} m vs sideways ${Math.sqrt(fc.cam[0]).toFixed(3)} m`);
  // …and in the world frame the long axis points where the camera looks (30° right).
  const P = fc.u.pos, a = 0.5 * Math.atan2(2 * P[2], P[8] - P[0]);
  near(a / DEG, 30, 10, 'long axis heading (°)');
  // Points alone: a sideways step looks like a small turn, so sideways is the weak one.
  assert.ok(far.cam[0] > far.cam[8], 'points only, far: sideways wider than forward');
});

test('floorCovariance turns with the map alignment', () => {
  const unc = { pos: [1e-4, 0, 0, 0, 2e-4, 0, 0, 0, 9e-4], rot: [1e-6, 0, 0, 0, 4e-6, 0, 0, 0, 9e-6] };
  const same = floorCovariance(unc, null);
  assert.deepEqual([same.cxx, same.cxz, same.czz, same.yawVar], [1e-4, 0, 9e-4, 4e-6]);
  const th = 30 * DEG, c = Math.cos(th), s = Math.sin(th), f = floorCovariance(unc, rotY(th));
  near(f.cxx, c * c * 1e-4 + s * s * 9e-4, 1e-12);
  near(f.czz, s * s * 1e-4 + c * c * 9e-4, 1e-12);
  near(f.cxz, s * c * (9e-4 - 1e-4), 1e-12);
  near(f.yawVar, 4e-6, 1e-15, 'a turn about the vertical stays one');
  // Odometry tipped 90° about x: its z axis is now the map's vertical.
  const tip = floorCovariance(unc, rotX(90 * DEG));
  near(tip.yawVar, 9e-6, 1e-15);
  near(tip.czz, 2e-4, 1e-12);
  assert.equal(floorCovariance(null, rotY(th)), null);
});

test('drift grows with the walk and while lost, and a loop closure takes most of it away', () => {
  const d = new DriftTracker();
  for (let k = 0; k < 100; k++) d.step({ dt: 0.1, moved: 0.1, turned: 0, status: 'ok', compassOk: true });
  near(d.posSd, 0.2, 1e-9, '2% of 10 m');
  near(d.yawSd / DEG, 3, 1e-9, '0.3°/m');
  const blind = new DriftTracker();
  for (let k = 0; k < 100; k++) blind.step({ dt: 0.1, moved: 0.1, turned: 0, status: 'ok', compassOk: false });
  near(blind.yawSd / DEG, 15, 1e-9, '1.5°/m without the compass');
  const turn = new DriftTracker();
  turn.step({ dt: 0.1, moved: 0, turned: Math.PI, status: 'ok', compassOk: false });
  assert.ok(turn.yawSd > 3 * DEG && turn.posSd === 0, 'turning on the spot');
  // Standing still while tracking: nothing grows.
  const still = new DriftTracker();
  still.step({ dt: 5, moved: 0, turned: 0, status: 'ok', compassOk: true });
  assert.equal(still.posSd + still.yawSd, 0);
  // Lost for a second (10 frames).
  const p0 = d.posSd, y0 = d.yawSd;
  for (let k = 0; k < 10; k++) d.step({ dt: 0.1, moved: 0, turned: 0, status: 'lost', compassOk: true });
  near(d.posSd - p0, 0.3, 1e-9, '0.3 m/s lost');
  near((d.yawSd - y0) / DEG, 1, 1e-9, '1°/s lost, with the compass');
  const before = d.posSd;
  d.loopClosed();
  near(d.posSd, 0.3 * before, 1e-12);
  // A jump (a correction, not walking) is capped; long blind losses are clamped to a full turn.
  const j = new DriftTracker();
  j.step({ dt: 0.1, moved: 40, status: 'ok' });
  assert.ok(j.posSd <= 0.04 + 1e-12);
  for (let k = 0; k < 100; k++) j.step({ dt: 1, status: 'lost', compassOk: false });
  assert.ok(j.yawSd <= Math.PI);
  j.reset();
  assert.equal(j.posSd + j.yawSd, 0);
});

test('combine: frame spread plus drift, and how good it is', () => {
  const fresh = new DriftTracker(), small = { cxx: 1e-4, cxz: 2e-5, czz: 4e-4, yawVar: (0.5 * DEG) ** 2 };
  const ok = combine(small, fresh, { status: 'ok', compassOk: true });
  assert.equal(ok.level, 'good');
  assert.deepEqual([ok.cxx, ok.cxz, ok.czz], [1e-4, 2e-5, 4e-4]);
  near(ok.yawSd, 0.5 * DEG, 1e-12);
  const walked = new DriftTracker();
  for (let k = 0; k < 100; k++) walked.step({ dt: 0.1, moved: 0.1, status: 'ok', compassOk: true });
  const w = combine(small, walked, { status: 'ok', compassOk: true });
  near(w.cxx, 1e-4 + 0.04, 1e-12, 'drift added to both axes');
  assert.equal(w.level, 'good', '2σ ≈ 0.4 m after 10 m is still normal');
  for (let k = 0; k < 150; k++) walked.step({ dt: 0.1, moved: 0.1, status: 'ok', compassOk: true });
  assert.equal(combine(small, walked, { status: 'ok', compassOk: true }).level, 'weak', '2σ ≈ 1 m after 25 m');
  const turnedBlind = new DriftTracker();
  for (let k = 0; k < 50; k++) turnedBlind.step({ dt: 0.1, moved: 0.1, status: 'ok', compassOk: false });
  assert.equal(combine(small, turnedBlind, { status: 'ok', compassOk: false }).level, 'weak', 'heading 7.5°');
  assert.equal(combine(null, fresh, { status: 'lost', compassOk: true }).level, 'lost');
  assert.equal(combine(small, fresh, { status: 'reloc', compassOk: true }).level, 'lost');
  assert.equal(combine(null, fresh, { status: 'ok', compassOk: true }).level, 'weak', 'tracking without a spread');
  const huge = combine({ cxx: Infinity, cxz: NaN, czz: 1e9, yawVar: 1e9 }, fresh, { status: 'ok' });
  assert.ok(Number.isFinite(huge.cxx) && Number.isFinite(huge.czz) && huge.cxz === 0 && huge.yawSd <= Math.PI);
});

test('demo tour: every tracked frame has a small, finite uncertainty', () => {
  const W = 320, H = 180, params = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
  const rig = buildRig(params, { w: W, h: H }), scene = buildingScene();
  const vo = new StereoVO(params, W, H), drift = new DriftTracker();
  let seen = 0, last = null;
  const frames = tour({ fps: 10 }).slice(0, 40);
  for (const fr of frames) {
    const pair = { left: renderGray(rig.left, fr.pose, scene, W, H), right: renderGray(rig.right, fr.pose, scene, W, H), t: fr.t };
    const r = vo.process(pair);
    if (!last) {
      assert.equal(r.uncertainty, null, 'the first frame has no solve');
      // Two cameras: the depth-edge filter is off unless asked for, so the stereo cloud is as before.
      const plain = new StereoVO(params, W, H, { edgeFilter: false }).process(pair).keyframe;
      assert.deepEqual(Array.from(r.keyframe.points), Array.from(plain.points));
    }
    else if (r.status === 'ok') {
      const u = r.uncertainty;
      assert.ok(u && u.pos.length === 9 && u.rot.length === 9 && [...u.pos, ...u.rot].every(Number.isFinite));
      assert.ok(u.pos[0] > 0 && u.pos[4] > 0 && u.pos[8] > 0);
      assert.ok(Math.sqrt(trace(u.pos)) < 0.03, `position sd ${Math.sqrt(trace(u.pos)).toFixed(3)} m`);
      assert.ok(Math.sqrt(trace(u.rot)) < 0.5 * DEG, `turn sd ${(Math.sqrt(trace(u.rot)) / DEG).toFixed(2)}°`);
      seen++;
      const moved = Math.hypot(...r.pose.t.map((v, i) => v - last.pose.t[i]));
      drift.step({ dt: 0.1, moved, turned: Math.acos(Math.min(1, (trace(mul3(tr3(last.pose.R), r.pose.R)) - 1) / 2)), status: r.status, compassOk: !!r.compass?.ok });
      const c = combine(floorCovariance(u, null), drift, { status: r.status, compassOk: !!r.compass?.ok });
      assert.equal(c.level, 'good');
    }
    last = r;
  }
  assert.ok(seen >= 35, `${seen} frames with an uncertainty`);
  // Nothing to track (a blank view): lost, and no spread from a solve that didn't happen.
  const blank = vo.process({ left: new Uint8Array(W * H).fill(128), right: new Uint8Array(W * H).fill(128), t: frames.at(-1).t + 0.1 });
  assert.equal(blank.status, 'lost');
  assert.equal(blank.uncertainty, null);
});

test('one camera: the depth-edge filter drops points smeared between near and far, keeps the floor', () => {
  const W = 320, H = 180, params = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
  const rig = buildRig(params, { w: W, h: H }), scene = buildingScene(), cam = rig.left;
  const pose = poseAt(0, -0.5, -0.4); // room A: the table and the fridge in front of the far walls
  const origin = apply(pose, cam.pos);
  /** The first thing along world ray d: { t, floor } (the floor and the boxes). */
  const hit = (d) => {
    const b = firstHit(origin, d, scene), tf = d[1] > 1e-9 ? (scene.floorY - origin[1]) / d[1] : Infinity;
    return tf < (b ? b.t : Infinity) ? { t: tf, floor: true } : b ? { t: b.t, floor: false } : null;
  };
  // What a depth model gives: true depth, smeared over a few pixels (worst at edges).
  const Z = new Float32Array(W * H);
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      const d = pixelRay(cam, u, v).d, h = hit(mulv(pose.R, d));
      Z[v * W + u] = h ? h.t * d[2] : 0;
    }
  }
  const depth = new Float32Array(W * H), r = 3;
  for (let v = 0; v < H; v++) {
    for (let u = 0; u < W; u++) {
      let s = 0, m = 0;
      for (let dv = -r; dv <= r; dv++) for (let du = -r; du <= r; du++) {
        const z = Z[Math.min(H - 1, Math.max(0, v + dv)) * W + Math.min(W - 1, Math.max(0, u + du))];
        if (z > 0) { s += z; m++; }
      }
      depth[v * W + u] = m ? s / m : 0;
    }
  }
  const left = renderGray(cam, pose, scene, W, H);
  const cloud = (edgeFilter) => {
    const vo = new StereoVO(params, W, H, { mono: true, maxRange: 15, cloudRange: 10, edgeFilter });
    const kf = vo.process({ left, right: left, depth, t: 0 }).keyframe;
    let flying = 0, floor = 0;
    for (let i = 0; i < kf.points.length; i += 3) {
      const p = [kf.points[i], kf.points[i + 1], kf.points[i + 2]], n = Math.hypot(...p);
      const h = hit(mulv(pose.R, p.map((x) => x / n)));
      if (!h) continue;
      const e = Math.abs(n - h.t) / h.t;
      if (e > 0.1) flying++;
      else if (h.floor && e < 0.03) floor++;
    }
    return { flying, floor, n: kf.points.length / 3 };
  };
  const off = cloud(false), on = cloud(null); // null: on, since it's one camera
  assert.ok(off.flying > 40, `${off.flying} flying points without the filter`);
  assert.ok(on.flying < 0.35 * off.flying, `flying points ${off.flying} → ${on.flying}`);
  assert.ok(on.floor > 0.85 * off.floor, `floor points ${off.floor} → ${on.floor}`);
  assert.ok(on.n > 0.6 * off.n, `${off.n} → ${on.n} points in all`);
});
