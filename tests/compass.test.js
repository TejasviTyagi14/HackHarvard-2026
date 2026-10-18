import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRig } from '../js/geometry.js';
import { buildingScene, poseAt, renderGray, tour } from '../js/slam/building.js';
import { buildPyramid } from '../js/slam/klt.js';
import { rectification } from '../js/slam/rectify.js';
import { VisualCompass } from '../js/slam/compass.js';
import { StereoVO } from '../js/slam/vo.js';
import { angleOf, mul3, tr3 } from '../js/slam/se3.js';

const W = 320, H = 180, params = { baselineCm: 12, angleDeg: 0, hfovDeg: 70 };
const rig = buildRig(params, { w: W, h: H }), scene = buildingScene();

test('compass: turning on the spot, from 0° at the start, to a tenth of a degree', () => {
  const rect = rectification(params, W, H);
  const c = new VisualCompass({ f: rect.f, cx: rect.cx, cy: rect.cy });
  let worst = 0;
  for (let k = 0; k <= 30; k++) {
    const r = c.update(buildPyramid(renderGray(rig.left, poseAt(0.5, 0.5, (k * 4 * Math.PI) / 180), scene, W, H), W, H, 3));
    assert.ok(r.ok);
    worst = Math.max(worst, Math.abs(r.heading - k * 4));
  }
  assert.ok(worst < 0.1, `worst heading error ${worst.toFixed(3)}°`);
  assert.ok(Math.abs(c.reading().pitch) < 0.3, `tilt drifted ${c.reading().pitch.toFixed(2)}°`);
});

test('compass + points: the tour turns more accurately than with points alone', () => {
  const run = (turnFrom, maxFeatures) => {
    const vo = new StereoVO(params, W, H, { turnFrom, ...(maxFeatures ? { maxFeatures } : {}) });
    let worst = 0;
    for (const fr of tour({ fps: 10 })) {
      const r = vo.process({ left: renderGray(rig.left, fr.pose, scene, W, H), right: renderGray(rig.right, fr.pose, scene, W, H), t: fr.t });
      worst = Math.max(worst, (angleOf(mul3(tr3(r.pose.R), fr.pose.R)) * 180) / Math.PI);
    }
    return worst;
  };
  const compass = run('compass'), points = run('points');
  assert.ok(compass < 1.5 && compass < points, `turn error ${compass.toFixed(2)}° with the compass vs ${points.toFixed(2)}° without`);
  // Too few points to track (it keeps losing them): the compass still keeps up with the turns.
  const sparse = run('compass', 30), sparsePts = run('points', 30);
  assert.ok(sparse < 30 && sparse < 0.5 * sparsePts, `with 30 points: ${sparse.toFixed(1)}° vs ${sparsePts.toFixed(1)}°`);
});
