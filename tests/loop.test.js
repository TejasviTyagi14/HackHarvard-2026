import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig } from '../js/geometry.js';
import { angleOf, apply, compose, expSO3, invert, mul3, rotY, tr3 } from '../js/slam/se3.js';
import { brief, blur, describeView, matchDescriptors, rigidAlign, thumbScore, verifyPlace } from '../js/slam/loop.js';
import { optimizePoses } from '../js/slam/posegraph.js';
import { buildPyramid } from '../js/slam/klt.js';
import { disparityBM, localNormalize } from '../js/slam/dense.js';
import { buildingScene, poseAt, renderGray } from '../js/slam/building.js';

const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} expected ${b} ± ${tol}, got ${a}`);

test('rigid alignment recovers a known rotation and shift', () => {
  const R = expSO3([0.2, -0.5, 0.1]), t = [0.4, -0.2, 1.1];
  const A = [], B = [];
  for (let i = 0; i < 20; i++) {
    const a = [Math.sin(i) * 2, Math.cos(i * 1.7), 2 + (i % 5) * 0.3];
    const b = apply({ R, t }, a);
    A.push(...a); B.push(...b);
  }
  const idx = [...Array(20).keys()];
  const T = rigidAlign(A, B, idx, idx);
  near(angleOf(mul3(tr3(T.R), R)), 0, 1e-9);
  T.t.forEach((v, d) => near(v, t[d], 1e-9));
});

test('BRIEF descriptors match a shifted copy of an image to the right points', () => {
  const w = 160, h = 100, tex = (x, y) => 128 + 60 * Math.sin(x * 0.47 + Math.sin(y * 0.31) * 3) * Math.cos(y * 0.37 - x * 0.11);
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { a[y * w + x] = tex(x, y); b[y * w + x] = tex(x - 7, y + 3); }
  const pts = [];
  for (let y = 20; y < 80; y += 9) for (let x = 25; x < 130; x += 11) pts.push(x, y);
  const shifted = pts.map((v, i) => (i % 2 ? v - 3 : v + 7));
  const da = brief(blur(a, w, h), w, Float32Array.from(pts)), db = brief(blur(b, w, h), w, Float32Array.from(shifted));
  const m = matchDescriptors(da, db);
  assert.ok(m.length > 0.6 * (pts.length / 2), `${m.length} matches of ${pts.length / 2}`);
  assert.ok(m.filter(([i, j]) => i === j).length >= 0.95 * m.length, 'matches pair each point with its own copy');
});

test('the same spot is recognised from a different viewpoint, with the right relative pose', () => {
  const W = 320, H = 180, params = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
  const rig = buildRig(params, { w: W, h: H }), scene = buildingScene();
  const intr = { f: rig.left.f, cx: W / 2, cy: H / 2 };
  const view = (pose) => {
    const L = renderGray(rig.left, pose, scene, W, H), R = renderGray(rig.right, pose, scene, W, H);
    const nL = localNormalize(L, W, H), nR = localNormalize(R, W, H);
    const disp = disparityBM(nL.data, nR.data, W, H, { maxDisp: 64, texture: nL.std });
    return describeView(L, W, H, disp, buildPyramid(L, W, H, 1)[0], intr, 0.12);
  };
  // Room A, looking at the table and the fridge, then 0.6 m to the side and turned 15°.
  const pa = poseAt(0, 0.5, -0.4), pb = poseAt(0.6, 0.7, -0.4 - 0.26);
  const a = view(pa), b = view(pb);
  assert.ok(a.uv.length / 2 > 150, `${a.uv.length / 2} described points`);
  const v = verifyPlace(b, a, intr);
  assert.ok(v, 'recognised');
  // True pose of b's left camera in a's left camera frame.
  const cam = (p) => ({ R: p.R, t: apply(p, [-0.06, 0, 0]) });
  const truth = compose(invert(cam(pa)), cam(pb));
  near(angleOf(mul3(tr3(v.pose.R), truth.R)) * 180 / Math.PI, 0, 1.5, 'rotation (deg)');
  near(Math.hypot(...v.pose.t.map((x, d) => x - truth.t[d])), 0, 0.08, 'translation error (m)');
  // A different room doesn't pass.
  const c = view(poseAt(6, 3.5, 0));
  assert.equal(verifyPlace(c, a, intr), null);
  assert.ok(thumbScore(a.thumb, b.thumb) > thumbScore(a.thumb, c.thumb), 'thumbnails rank the right view higher');
});

test('a loop constraint pulls a drifting square walk back into shape', () => {
  // True walk: a 4 m square, a keyframe every 0.5 m, turning 90° at each corner.
  const truth = [];
  let x = 0, z = 0, yaw = 0;
  for (let side = 0; side < 4; side++) {
    for (let k = 0; k < 8; k++) {
      truth.push({ R: rotY(yaw), t: [x, 0, z] });
      x += Math.sin(yaw) * 0.5; z += Math.cos(yaw) * 0.5;
    }
    yaw += Math.PI / 2;
  }
  truth.push({ R: rotY(yaw), t: [x, 0, z] }); // back at the start
  // Odometry that over-turns by 1° and over-counts distance by 3% at every step.
  const est = [truth[0]];
  for (let k = 1; k < truth.length; k++) {
    const rel = compose(invert(truth[k - 1]), truth[k]);
    const noisy = { R: mul3(rotY(Math.PI / 180), rel.R), t: rel.t.map((v) => v * 1.03) };
    est.push(compose(est[k - 1], noisy));
  }
  const endErr = (poses) => Math.hypot(poses.at(-1).t[0] - truth.at(-1).t[0], poses.at(-1).t[2] - truth.at(-1).t[2]);
  assert.ok(endErr(est) > 0.8, `drift before: ${endErr(est).toFixed(2)} m`);
  // Recognising the start again: the last keyframe is exactly where the first one was.
  const loops = [{ i: 0, j: truth.length - 1, rel: compose(invert(truth[0]), truth.at(-1)) }];
  const fixed = optimizePoses(est, loops);
  assert.ok(endErr(fixed) < 0.05, `drift after: ${endErr(fixed).toFixed(3)} m`);
  const worst = Math.max(...fixed.map((p, k) => Math.hypot(p.t[0] - truth[k].t[0], p.t[2] - truth[k].t[2])));
  assert.ok(worst < 0.35, `worst keyframe error after: ${worst.toFixed(2)} m`);
  assert.deepEqual(fixed[0].t, est[0].t, 'the first keyframe stays put');
});

test('walking out and back: recognising the start corrects the drift', async () => {
  const { StereoVO } = await import('../js/slam/vo.js');
  const { World } = await import('../js/slam/world.js');
  const { LoopCloser } = await import('../js/slam/closer.js');
  const { tour, CAM_HEIGHT } = await import('../js/slam/building.js');
  const W = 320, H = 180, truthRig = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
  const rig = buildRig(truthRig, { w: W, h: H }), scene = buildingScene();
  // Out 2.4 m, round, back past the start, then facing the way we started.
  const frames = tour({ fps: 10, path: [[0, 0], [0, 2.4], [0.6, 2.7], [0.7, 0.5], [0.2, -0.3], [0.05, 0.5]] });
  const run = (withLoops) => {
    // Field of view entered 5° too wide: every turn is misjudged, so the walk drifts.
    const vo = new StereoVO({ ...truthRig, hfovDeg: 75 }, W, H), world = new World({ camHeight: CAM_HEIGHT });
    const closer = new LoopCloser(vo.intr, { minGap: 12 });
    let loops = 0, last;
    for (const fr of frames) {
      const r = vo.process({ left: renderGray(rig.left, fr.pose, scene, W, H), right: renderGray(rig.right, fr.pose, scene, W, H), t: fr.t });
      if (r.keyframe) {
        world.addKeyframe(r.keyframe);
        const lc = withLoops && closer.check(world);
        if (lc) { vo.shift(lc.C); loops++; }
      }
      last = fr;
    }
    const truth = world.toMap(apply(last.pose, [-0.06, 0, 0]).map((v, d) => (d === 0 ? v + 0.06 : v)));
    const est = world.mapPose(vo.pose).t;
    return { loops, err: Math.hypot(est[0] - truth[0], est[2] - truth[2]) };
  };
  const plain = run(false), fixed = run(true);
  assert.ok(fixed.loops >= 1, 'recognised the start');
  assert.ok(fixed.err < 0.5 * plain.err, `end error ${fixed.err.toFixed(3)} m with loop closure vs ${plain.err.toFixed(3)} m without`);
});
