import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig, readDistance } from '../js/geometry.js';
import { GrayFrame } from '../js/stereo.js';
import { demoScene, groundTruthDetections, renderView } from '../js/demo.js';
import { measureScene } from '../js/scene.js';
import { canSolveSpacing, fitFromPerson, personMatches, personReading, pickPerson, robustSubset, verticalOffset } from '../js/personcal.js';

const W = 640, H = 360;
// The real rig: 13.5 cm apart, toed in 2°. What the user typed: 12 cm, parallel.
const truth = { baselineCm: 13.5, angleDeg: 2, hfovDeg: 70, angleSplit: 'even' };
const entered = { ...truth, baselineCm: 12, angleDeg: 0 };
const rig = buildRig(truth, { w: W, h: H });

function capture(range) {
  const scene = demoScene(undefined, { person: { range } });
  const fL = GrayFrame.fromRGBA(renderView(rig.left, scene, W, H), W, H);
  const fR = GrayFrame.fromRGBA(renderView(rig.right, scene, W, H), W, H);
  const detsL = groundTruthDetections(rig.left, scene), detsR = groundTruthDetections(rig.right, scene);
  return { scene, fL, fR, detsL, detsR };
}

const at2 = capture(2), at4 = capture(4);
const position = (c, trueRange) => {
  const p = pickPerson(c.detsL, c.detsR);
  assert.ok(!p.error, p.error);
  return { trueRange, samples: personMatches(c.fL, c.fR, p.boxL, p.boxR) };
};
const pos2 = position(at2, 2), pos4 = position(at4, 4);

test('the person is found and matched in both views', () => {
  assert.ok(pos2.samples.length >= 15, `${pos2.samples.length} matches at 2 m`);
  assert.ok(pos4.samples.length >= 12, `${pos4.samples.length} matches at 4 m`);
  // The typed-in numbers read the person badly wrong before calibrating.
  assert.ok(personReading(pos2, entered) / 2 > 1.3);
});

test('one distance fixes the angle and keeps the spacing', () => {
  assert.equal(canSolveSpacing([pos2]), false);
  const fit = fitFromPerson([pos2], entered);
  assert.deepEqual(fit.solved, ['angleDeg']);
  assert.equal(fit.params.baselineCm, 12);
  assert.ok(Math.abs(personReading(pos2, fit.params) - 2) < 0.04, `reads ${personReading(pos2, fit.params)}`);
});

test('two distances recover both the spacing and the angle', () => {
  assert.equal(canSolveSpacing([pos2, pos4]), true);
  const fit = fitFromPerson([pos2, pos4], entered);
  assert.deepEqual(fit.solved, ['baselineCm', 'angleDeg']);
  assert.ok(Math.abs(fit.params.baselineCm - 13.5) < 0.7, `spacing ${fit.params.baselineCm.toFixed(2)}`);
  assert.ok(Math.abs(fit.params.angleDeg - 2) < 0.2, `angle ${fit.params.angleDeg.toFixed(3)}`);
  for (const [p, d] of [[pos2, 2], [pos4, 4]]) assert.ok(Math.abs(personReading(p, fit.params) / d - 1) < 0.02);

  // Everything else in the room now measures right too.
  const fitted = buildRig(fit.params, { w: W, h: H });
  const { objects } = measureScene(at2.detsL, at2.detsR, at2.fL, at2.fR, fitted);
  for (const o of objects.filter((x) => x.cls === 'box')) {
    assert.ok(Math.abs(o.range / o.truth - 1) < 0.05, `${o.name}: ${o.range?.toFixed(2)} vs ${o.truth.toFixed(2)}`);
  }
  const off = verticalOffset(robustSubset(pos2.samples), fit.params);
  assert.ok(Math.abs(off) < 1, `vertical offset ${off}`);
});

test('the person is measured along the floor, not in a straight line', () => {
  const s = robustSubset(pos2.samples)[0];
  const along = readDistance({ ...s, horizontal: true }, truth);
  const straight = readDistance(s, truth);
  assert.ok(Math.abs(along - 2) < 0.04, `floor distance ${along}`);
  assert.ok(straight > along, 'the chest is above the cameras, so the straight line is longer');
});

test('nobody, or too many people, is reported instead of guessed at', () => {
  assert.deepEqual(pickPerson([], []), { error: 'no-person' });
  const p = { class: 'person', score: 0.9, bbox: [100, 50, 80, 200] };
  const q = { class: 'person', score: 0.9, bbox: [300, 60, 75, 190] };
  assert.deepEqual(pickPerson([p, q], [p, q]), { error: 'several' });
  assert.deepEqual(pickPerson([p], [{ ...p, bbox: [90, 50, 80, 100] }]), { error: 'mismatch' });
  assert.ok(pickPerson([p], [p]).boxL);
});
