// ======================================================================================
// ADAPTER for the landing page's "Measuring distance" section (Section 2).
//
// DEMO DATA (mocked):
//   - SITE_ROOM_OBJECTS: a hand-placed living room (couch, chair, potted plant, tv, person,
//     dining table) for the synthetic demo renderer. Classes are COCO names so the
//     assistant's questions ("how far is the sofa?") resolve.
//   - detect(): the "object detector". On the synthetic room we use the renderer's own
//     projected boxes (groundTruthDetections) in place of COCO-SSD, with a little jitter
//     and a fixed confidence per class so the table looks like detector output.
//
// REAL PIPELINE (not mocked):
//   - renderView (CPU raycaster) produces the left/right camera images.
//   - buildRig builds the two cameras from baseline / toe-in / field of view.
//   - measureScene pairs the boxes across views and finds each object's distance by
//     epipolar patch matching + triangulation on the rendered pixels.
//   - answer() from js/assistant.js is the real scene assistant.
// ======================================================================================
import { demoScene, renderView, groundTruthDetections } from '../demo.js';
import { buildRig } from '../geometry.js';
import { measureScene } from '../scene.js';
import { GrayFrame } from '../stereo.js';

export const VIEW_W = 320, VIEW_H = 180, HFOV = 70;

export const SITE_ROOM_OBJECTS = [
  { cls: 'couch', x: -1.35, z: 2.8, size: [1.3, 0.8, 0.8], color: [92, 112, 150] },
  { cls: 'chair', x: -0.35, z: 2.0, size: [0.45, 0.85, 0.45], color: [176, 120, 72] },
  { cls: 'potted plant', x: 0.08, z: 0.85, size: [0.18, 0.5, 0.18], color: [70, 150, 90] },
  { cls: 'tv', x: 0.0, z: 5.7, size: [1.0, 1.3, 0.2], color: [120, 128, 150] },
  { cls: 'person', x: 0.9, z: 4.6, size: [0.45, 1.75, 0.25], color: [70, 95, 150] },
  { cls: 'dining table', x: 1.6, z: 3.6, size: [0.9, 0.75, 0.7], color: [168, 128, 88] },
];

// Mock detector confidences (COCO-SSD-like) per class.
const CONF = { couch: 0.91, chair: 0.84, 'potted plant': 0.77, tv: 0.88, person: 0.96, 'dining table': 0.72 };

const scene3d = demoScene(SITE_ROOM_OBJECTS);

/** MOCK detector: ground-truth projected boxes standing in for COCO-SSD. */
function detect(cam) {
  return groundTruthDetections(cam, scene3d).map((d) => ({
    ...d, name: undefined, score: CONF[d.class] ?? 0.8,
    bbox: d.bbox.map((v) => v + (Math.random() - 0.5) * 1.5),
  }));
}

/**
 * Runs the real stereo pipeline for one rig setting.
 * Returns { rig, images: [ImageData, ImageData], dets: [L, R], objects (measured, with id) }.
 */
export function runPipeline({ baselineCm = 12, angleDeg = 0, hfovDeg = HFOV } = {}) {
  const rig = buildRig({ baselineCm, angleDeg, hfovDeg, angleSplit: 'even' }, { w: VIEW_W, h: VIEW_H });
  const rgba = [rig.left, rig.right].map((cam) => renderView(cam, scene3d, VIEW_W, VIEW_H));
  const frames = rgba.map((px) => GrayFrame.fromRGBA(px, VIEW_W, VIEW_H));
  const dets = [detect(rig.left), detect(rig.right)];
  const res = measureScene(dets[0], dets[1], frames[0], frames[1], rig, { vtol: 4, tiltDeg: 0, vOffset: 0 });
  const objects = res.objects.map((o, k) => ({ ...o, id: k + 1, name: null }));
  const images = typeof ImageData !== 'undefined' ? rgba.map((px) => new ImageData(px, VIEW_W, VIEW_H)) : rgba;
  return { rig, images, dets, objects };
}

/** The scene object js/assistant.js answer() expects. */
export const assistantScene = (objects) => ({ objects, pins: [], units: 'm', status: 'ok', paused: false, hfovDeg: HFOV });
