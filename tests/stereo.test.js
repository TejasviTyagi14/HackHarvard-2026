import test from 'node:test';
import assert from 'node:assert/strict';
import { GrayFrame, bandSearch, epipolarSearch, localSearch, makePatch, ncc, sharpness } from '../js/stereo.js';
import { buildRig, norm, pixelRay } from '../js/geometry.js';
import { castRay, demoScene, groundTruthDetections, renderView } from '../js/demo.js';

// Smooth random texture sampled with a horizontal shift, so the true disparity is known exactly.
function texturedPair(w, h, shift) {
  const f = (x, y) => 128 + 50 * Math.sin(x * 0.37 + y * 0.11) * Math.cos(y * 0.29 - x * 0.07) + 40 * Math.sin(x * 0.13 + Math.cos(y * 0.21) * 3);
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { a[y * w + x] = f(x, y); b[y * w + x] = f(x + shift, y); }
  return [new GrayFrame(w, h, a), new GrayFrame(w, h, b)];
}

const gray = (rgba, w, h) => GrayFrame.fromRGBA(rgba, w, h);

test('integral-image stats match a direct computation', () => {
  const [fa] = texturedPair(40, 30, 0);
  const { mean, std } = fa.stats(20, 15, 3);
  let s = 0, q = 0;
  for (let y = 12; y <= 18; y++) for (let x = 17; x <= 23; x++) { const v = fa.data[y * 40 + x]; s += v; q += v * v; }
  assert.ok(Math.abs(mean - s / 49) < 1e-6);
  assert.ok(Math.abs(std - Math.sqrt(q / 49 - (s / 49) ** 2)) < 1e-4);
});

test('a patch correlates perfectly with itself', () => {
  const [fa] = texturedPair(80, 60, 0);
  const P = makePatch(fa, 40, 30, 6);
  assert.ok(Math.abs(ncc(P, fa, 40, 30) - 1) < 1e-5);
  assert.ok(ncc(P, fa, 46, 30) < 0.99);
});

test('band search finds a known shift to sub-pixel accuracy', () => {
  const [fa, fb] = texturedPair(200, 80, 7.3);
  const m = bandSearch(fa, fb, 100, 40, { r: 7, band: 6 });
  assert.ok(m.ok);
  assert.ok(Math.abs(m.uB - (100 - 7.3)) < 0.25, `uB ${m.uB}`);
  assert.ok(Math.abs(m.vB - 40) < 0.25);
  const snapped = localSearch(fa, fb, 100, 40, 95, 42, { r: 7, radius: 5 });
  assert.ok(Math.abs(snapped.uB - (100 - 7.3)) < 0.25);
});

test('a flat patch is rejected for lack of texture', () => {
  const w = 60, h = 40;
  const flat = new GrayFrame(w, h, new Float32Array(w * h).fill(90));
  const rig = buildRig({ baselineCm: 12, angleDeg: 0, hfovDeg: 70 }, { w, h });
  const m = epipolarSearch(flat, flat, rig.left, rig.right, 30, 20, { r: 5 });
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'texture');
});

test('sharpness drops when the image is blurred', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 255;
  const fa = new GrayFrame(120, 80, Float32Array.from({ length: 120 * 80 }, rand));
  const blurred = new Float32Array(fa.data.length);
  for (let y = 1; y < 79; y++) for (let x = 1; x < 119; x++) {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += fa.data[(y + dy) * 120 + x + dx];
    blurred[y * 120 + x] = s / 9;
  }
  assert.ok(sharpness(new GrayFrame(120, 80, blurred)) < 0.5 * sharpness(fa));
});

for (const angleDeg of [0, 3]) {
  test(`epipolar search on the demo room measures box surfaces (angle ${angleDeg}°)`, () => {
    const W = 640, H = 360;
    const rig = buildRig({ baselineCm: 12, angleDeg, hfovDeg: 70 }, { w: W, h: H });
    const scene = demoScene();
    const fL = gray(renderView(rig.left, scene, W, H), W, H);
    const fR = gray(renderView(rig.right, scene, W, H), W, H);
    const dets = groundTruthDetections(rig.left, scene);
    assert.equal(dets.length, 5);
    for (const det of dets) {
      const [x, y, w, h] = det.bbox;
      const u = Math.round(x + w / 2), v = Math.round(y + h * 0.55);
      const truth = norm(castRay(pixelRay(rig.left, u, v), scene).point);
      const m = epipolarSearch(fL, fR, rig.left, rig.right, u, v, { r: 6, vtol: 2 });
      assert.ok(m.ok, `${det.name}: ${m.reason}`);
      assert.ok(m.score > 0.9, `${det.name}: score ${m.score}`);
      const err = Math.abs(norm(m.tri.point) / truth - 1);
      assert.ok(err < 0.04, `${det.name}: measured ${norm(m.tri.point).toFixed(3)} vs ${truth.toFixed(3)}`);
    }
  });
}
