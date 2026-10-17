import test from 'node:test';
import assert from 'node:assert/strict';
import { GrayFrame } from '../js/stereo.js';
import { buildRig, project } from '../js/geometry.js';
import { demoScene, groundTruthDetections, renderView } from '../js/demo.js';
import {
  Tracker, formatDistance, measurePoint, measureScene, objectLabel, pairDetections,
  pairwiseDistances, speechChanged, speechSummary,
} from '../js/scene.js';

const W = 640, H = 360;
const params = { baselineCm: 12, angleDeg: 2, hfovDeg: 70 };
const rig = buildRig(params, { w: W, h: H });
const scene = demoScene();
const fL = GrayFrame.fromRGBA(renderView(rig.left, scene, W, H), W, H);
const fR = GrayFrame.fromRGBA(renderView(rig.right, scene, W, H), W, H);
const detsL = groundTruthDetections(rig.left, scene);
const detsR = groundTruthDetections(rig.right, scene);

test('boxes are paired with their own counterpart, never a look-alike', () => {
  const pairs = pairDetections(detsL, detsR, rig);
  const both = pairs.filter((p) => p.i != null && p.j != null);
  assert.equal(both.length, 5);
  for (const p of both) assert.equal(detsL[p.i].name, detsR[p.j].name);
});

test('different classes are never paired', () => {
  const a = [{ bbox: [100, 100, 50, 80], class: 'chair', score: 0.9 }];
  const b = [{ bbox: [90, 100, 50, 80], class: 'person', score: 0.9 }];
  const pairs = pairDetections(a, b, rig);
  assert.deepEqual(pairs.map((p) => [p.i, p.j]), [[0, null], [null, 0]]);
});

test('every demo object gets a distance within 6% of the truth', () => {
  const { objects, swapVotes } = measureScene(detsL, detsR, fL, fR, rig);
  assert.equal(objects.length, 5);
  assert.equal(swapVotes.swapped, 0);
  for (const o of objects) {
    assert.equal(o.quality, 'stereo', `${o.name}: ${o.reason}`);
    assert.ok(Math.abs(o.range / o.truth - 1) < 0.06, `${o.name}: ${o.range.toFixed(2)} vs ${o.truth.toFixed(2)}`);
  }
});

test('a wrong angle setting shows up as wrong distances, not silent success', () => {
  const wrong = buildRig({ ...params, angleDeg: params.angleDeg + 1.5 }, { w: W, h: H });
  const { objects } = measureScene(detsL, detsR, fL, fR, wrong);
  const boxB = objects.find((o) => o.name === 'box B');
  assert.ok(boxB.range == null || Math.abs(boxB.range / boxB.truth - 1) > 0.15);
});

test('swapped cameras are detected on a parallel rig', () => {
  // With toe-in, swapped images can still triangulate past B / (2·angle), so only near
  // objects give clear evidence; parallel cameras make every object a witness.
  const flat = buildRig({ ...params, angleDeg: 0 }, { w: W, h: H });
  const gL = GrayFrame.fromRGBA(renderView(flat.left, scene, W, H), W, H);
  const gR = GrayFrame.fromRGBA(renderView(flat.right, scene, W, H), W, H);
  const dL = groundTruthDetections(flat.left, scene), dR = groundTruthDetections(flat.right, scene);
  assert.equal(measureScene(dL, dR, gL, gR, flat).swapVotes.swapped, 0);
  const { swapVotes } = measureScene(dR, dL, gR, gL, flat);
  assert.ok(swapVotes.swapped >= 4 && swapVotes.normal === 0, JSON.stringify(swapVotes));
});

test('an object seen by one camera still gets a direction', () => {
  const { objects } = measureScene(detsL.slice(0, 1), [], fL, fR, rig);
  assert.equal(objects.length, 1);
  assert.ok(Number.isFinite(objects[0].azimuth));
  assert.ok(objects[0].azimuth < 0, 'box A is to the left');
});

test('clicked points are measured and cross-checked', () => {
  const X = [0.6, 0.2, 2.4]; // on box B's front face
  const p = project(rig.left, X);
  const m = measurePoint(p.u, p.v, fL, fR, rig);
  assert.ok(m.range != null, m.reason);
  assert.ok(Math.abs(m.range - Math.hypot(...X)) < 0.06);
  assert.ok(m.ground);
});

test('tracker keeps ids and reports a median distance', () => {
  const t = new Tracker({ minHits: 2 });
  const mk = (range, x = 100) => ({ cls: 'chair', boxL: [x, 100, 60, 80], boxR: [x - 10, 100, 60, 80], range, point: [0, 0, range], azimuth: 0, quality: 'stereo' });
  assert.equal(t.update([mk(2.0)], 0).length, 0, 'needs two hits before showing');
  let out = t.update([mk(2.2, 102)], 100);
  assert.equal(out.length, 1);
  const id = out[0].id;
  t.update([mk(9.0, 103)], 200); // one wild reading
  out = t.update([mk(2.1, 101)], 300);
  assert.equal(out[0].id, id);
  assert.ok(Math.abs(out[0].range - 2.15) < 1e-9, `median ${out[0].range}`);
  assert.equal(t.update([], 2000).length, 0, 'tracks expire');
});

test('pairwise distances between objects', () => {
  const items = [{ point: [0, 0, 1] }, { point: [3, 0, 5] }, { point: null }, { point: [0, 0, 2] }];
  const d = pairwiseDistances(items);
  assert.equal(d.length, 3);
  assert.equal(d[0].d, 1);
  assert.equal(d[2].d, 5);
});

test('labels read like the spec', () => {
  assert.equal(objectLabel({ cls: 'chair', range: 2.13, azimuth: -28, quality: 'stereo' }), "chair · ~2.1 m · 11 o'clock");
  assert.equal(objectLabel({ cls: 'chair', range: null, azimuth: 2 }), "chair · distance unavailable · 12 o'clock");
  assert.equal(formatDistance(2.13, 'ft'), '7.0 ft');
});

test('speech only fires on meaningful change', () => {
  const a = speechSummary([{ cls: 'chair', range: 2.1, azimuth: -30 }, { cls: 'person', range: 1.2, azimuth: 0 }]);
  assert.equal(a.text, "person, 1 meter, 12 o'clock. chair, 2 meters, 11 o'clock.");
  const b = speechSummary([{ cls: 'chair', range: 2.3, azimuth: -31 }, { cls: 'person', range: 1.3, azimuth: 2 }]);
  assert.equal(speechChanged(a.items, b.items), false, 'small drift is not news');
  const c = speechSummary([{ cls: 'chair', range: 2.8, azimuth: -31 }, { cls: 'person', range: 1.3, azimuth: 2 }]);
  assert.equal(speechChanged(a.items, c.items), true, '0.5 m change is');
  const d = speechSummary([{ cls: 'person', range: 1.2, azimuth: 0 }]);
  assert.equal(speechChanged(a.items, d.items), true, 'something left');
  assert.equal(speechSummary([]).text, 'Nothing in view.');
});
