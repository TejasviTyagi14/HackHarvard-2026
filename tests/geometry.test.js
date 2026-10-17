import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bearing, buildRig, clockHour, clockLabel, dist3, fitCalibration, focalFromFov, fovFromFocal,
  norm, pixelRay, pointAlong, project, sampleRange, triangulate,
} from '../js/geometry.js';

const size = { w: 640, h: 360 };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);

test('focal length and field of view round-trip', () => {
  for (const fov of [40, 70, 95]) near(fovFromFocal(640, focalFromFov(640, fov)), fov, 1e-9);
  near(focalFromFov(640, 90), 320, 1e-9);
});

test('project() and pixelRay() are inverses for straight and angled cameras', () => {
  for (const angleDeg of [0, 6, -4]) {
    const rig = buildRig({ baselineCm: 12, angleDeg, hfovDeg: 70 }, size);
    for (const cam of [rig.left, rig.right]) {
      const X = [0.3, -0.2, 2.5];
      const p = project(cam, X);
      const ray = pixelRay(cam, p.u, p.v);
      const back = pointAlong(ray, dist3(X, cam.pos));
      assert.ok(dist3(back, X) < 1e-9);
    }
  }
});

test('triangulation recovers 3D points for parallel, toed-in and toed-out rigs', () => {
  for (const angleDeg of [0, 3, 8, -3]) {
    for (const split of ['even', 'left-straight', 'right-straight']) {
      const rig = buildRig({ baselineCm: 15, angleDeg, hfovDeg: 72, angleSplit: split }, size);
      for (const X of [[0, 0, 1], [0.4, 0.2, 2.2], [-0.8, -0.3, 4.5], [0.1, 0.5, 0.7]]) {
        const a = project(rig.left, X), b = project(rig.right, X);
        const tr = triangulate(pixelRay(rig.left, a.u, a.v), pixelRay(rig.right, b.u, b.v));
        assert.ok(tr.valid);
        assert.ok(dist3(tr.point, X) < 1e-7, `angle ${angleDeg} ${split}: ${tr.point} vs ${X}`);
        assert.ok(tr.gap < 1e-7);
      }
    }
  }
});

test('diverging rays (left/right swapped) are flagged invalid', () => {
  const rig = buildRig({ baselineCm: 12, angleDeg: 0, hfovDeg: 70 }, size);
  const X = [0.1, 0, 2];
  const a = project(rig.left, X), b = project(rig.right, X);
  const swapped = triangulate(pixelRay(rig.left, b.u, b.v), pixelRay(rig.right, a.u, a.v));
  assert.equal(swapped.valid, false);
});

test('clock directions', () => {
  assert.equal(clockHour(0), 12);
  assert.equal(clockHour(-30), 11);
  assert.equal(clockHour(30), 1);
  assert.equal(clockHour(90), 3);
  assert.equal(clockHour(-90), 9);
  assert.equal(clockHour(180), 6);
  assert.equal(clockHour(-14), 12);
  assert.equal(clockLabel(-35), "11 o'clock");
});

test('bearing levels a tilted rig', () => {
  // Rig tilted 20° down: a point straight ahead of the rig is 20° below the horizon.
  const b = bearing([0, 0, 2], 20);
  near(b.elevation, -20, 1e-9);
  near(b.azimuth, 0, 1e-9);
  near(b.ground.z, 2 * Math.cos(20 * Math.PI / 180), 1e-9);
});

function syntheticSamples(truth, points, noisePx = 0) {
  const rig = buildRig(truth, size);
  let k = 0;
  const jitter = () => (noisePx ? noisePx * Math.sin(12.9898 * ++k) : 0);
  return points.map((X) => {
    const a = project(rig.left, X), b = project(rig.right, X);
    return { uL: a.u + jitter(), vL: a.v, uR: b.u + jitter(), vR: b.v, sizeL: size, sizeR: size, trueRange: norm(X) };
  });
}

test('calibration recovers angle and FOV from samples at 1 m and 2 m', () => {
  const truth = { baselineCm: 12, angleDeg: 2.7, hfovDeg: 73.5, angleSplit: 'even' };
  const guess = { ...truth, angleDeg: 0, hfovDeg: 70 };
  const samples = syntheticSamples(truth, [[0.05, 0.1, 1.0], [-0.1, 0.05, 2.0]]);
  const before = sampleRange(samples[1], guess);
  assert.ok(Math.abs(before / samples[1].trueRange - 1) > 0.3, 'the wrong angle should read badly');
  const fit = fitCalibration(samples, guess);
  assert.equal(fit.solvedFov, true);
  near(fit.angleDeg, 2.7, 0.02, 'angle');
  near(fit.hfovDeg, 73.5, 0.2, 'fov');
  for (const r of fit.residuals) near(r.after / r.trueRange, 1, 0.002);
});

test('calibration stays close with half-pixel click noise', () => {
  const truth = { baselineCm: 12, angleDeg: -1.4, hfovDeg: 68, angleSplit: 'even' };
  const guess = { ...truth, angleDeg: 0, hfovDeg: 70 };
  const samples = syntheticSamples(truth, [[0, 0, 1.0], [0.05, 0, 1.5], [0, 0.1, 2.5]], 0.5);
  const fit = fitCalibration(samples, guess);
  near(fit.angleDeg, -1.4, 0.15, 'angle');
  near(fit.hfovDeg, 68, 3, 'fov');
  // Distances read through the fitted rig should be within a few percent.
  for (const r of fit.residuals) near(r.after / r.trueRange, 1, 0.04);
});

test('one sample fixes the angle while keeping the FOV', () => {
  const truth = { baselineCm: 10, angleDeg: 1.8, hfovDeg: 70, angleSplit: 'even' };
  const samples = syntheticSamples(truth, [[0, 0, 1.5]]);
  const fit = fitCalibration(samples, { ...truth, angleDeg: 0 });
  assert.equal(fit.solvedFov, false);
  near(fit.hfovDeg, 70, 1e-9);
  near(fit.angleDeg, 1.8, 0.01);
});
