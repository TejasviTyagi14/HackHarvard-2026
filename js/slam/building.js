// A small synthetic building for trying the mapper without walking around: two rooms joined by
// a doorway, some furniture, textured walls. It can be rendered from any pose of the stereo rig,
// walked on a scripted tour, or driven with the arrow keys. Pure functions, no DOM.
//
// Frame: the rig starts at the origin facing +z; x right, y down. The floor is camHeight below
// the cameras.
import { pixelRay } from '../geometry.js';
import { texture } from '../demo.js';
import { mulv, rotY } from './se3.js';

export const CAM_HEIGHT = 1.25;
const CEILING = 2.6;
const T = 0.15; // wall thickness

function wall(x0, z0, x1, z1, seed) {
  const floorY = CAM_HEIGHT, ceilY = CAM_HEIGHT - CEILING;
  const xs = x0 === x1 ? [x0 - T / 2, x0 + T / 2] : [Math.min(x0, x1), Math.max(x0, x1)];
  const zs = z0 === z1 ? [z0 - T / 2, z0 + T / 2] : [Math.min(z0, z1), Math.max(z0, z1)];
  return { kind: 'wall', min: [xs[0], ceilY, zs[0]], max: [xs[1], floorY, zs[1]], seed, color: 175 };
}

// Furniture carries the object-detector class it stands in for, so the demo can "see" landmarks.
function block(cls, x, z, w, d, h, color, seed) {
  return { kind: 'furniture', cls, min: [x - w / 2, CAM_HEIGHT - h, z - d / 2], max: [x + w / 2, CAM_HEIGHT, z + d / 2], seed, color };
}

/** Room A (x −2.5…2.5, z −1.5…5) and room B (x 2.5…8, z 1…6), with a 1 m door at z 3…4. */
export function buildingScene() {
  return {
    floorY: CAM_HEIGHT,
    ceilY: CAM_HEIGHT - CEILING,
    boxes: [
      wall(-2.5, -1.5, 2.5, -1.5, 101), // south wall of A
      wall(-2.5, -1.5, -2.5, 5, 102), // west wall of A
      wall(-2.5, 5, 2.5, 5, 103), // north wall of A
      wall(2.5, -1.5, 2.5, 3, 104), // shared wall, below the door
      wall(2.5, 4, 2.5, 6, 105), // shared wall, above the door
      wall(2.5, 1, 8, 1, 106), // south wall of B
      wall(2.5, 6, 8, 6, 107), // north wall of B
      wall(8, 1, 8, 6, 108), // east wall of B
      block('dining table', -1.2, 1.6, 1.2, 0.8, 0.75, 140, 201),
      block('refrigerator', -2.1, 3.6, 0.6, 0.45, 1.8, 120, 202),
      block('couch', 6.4, 5.2, 1.8, 0.8, 0.8, 110, 203),
      block('chair', 4.6, 1.8, 0.6, 0.6, 0.6, 150, 204),
    ],
  };
}

function hitBox(o, d, b) {
  let tmin = -Infinity, tmax = Infinity, axis = -1;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < b.min[a] || o[a] > b.max[a]) return null;
      continue;
    }
    let t1 = (b.min[a] - o[a]) / d[a], t2 = (b.max[a] - o[a]) / d[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) { tmin = t1; axis = a; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin > 1e-6 ? { t: tmin, axis } : null;
}

/** The first box a ray o + s·d hits, and how far along: { box, t } or null. */
export function firstHit(o, d, scene) {
  let best = null;
  for (const b of scene.boxes) {
    const h = hitBox(o, d, b);
    if (h && (!best || h.t < best.t)) best = { box: b, t: h.t };
  }
  return best;
}

/** Brightness (0–255) of whatever the ray o + s·d hits first. */
function shade(o, d, scene) {
  let t = Infinity, kind = null, axis = -1, box = null;
  if (d[1] > 1e-9) { const s = (scene.floorY - o[1]) / d[1]; if (s > 0 && s < t) { t = s; kind = 'floor'; } }
  if (d[1] < -1e-9) { const s = (scene.ceilY - o[1]) / d[1]; if (s > 0 && s < t) { t = s; kind = 'ceiling'; } }
  for (const b of scene.boxes) {
    const h = hitBox(o, d, b);
    if (h && h.t < t) { t = h.t; kind = 'box'; axis = h.axis; box = b; }
  }
  if (!kind) return 40;
  const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  if (kind === 'floor') {
    const tile = (Math.floor(p[0] * 2) + Math.floor(p[2] * 2)) & 1;
    return (tile ? 150 : 115) * (0.6 + 0.7 * texture(p[0], p[2], 3));
  }
  if (kind === 'ceiling') return 185 * (0.7 + 0.5 * texture(p[0], p[2], 5));
  const [s, q] = axis === 0 ? [p[2], p[1]] : axis === 1 ? [p[0], p[2]] : [p[0], p[1]];
  const light = axis === 1 ? 1.1 : axis === 0 ? 0.85 : 1;
  return box.color * light * (0.5 + 0.85 * texture(s, q, box.seed));
}

/** Grayscale view (Float32, 0–255) from camera `cam` of a rig at pose { R, t } (rig → world). */
export function renderGray(cam, pose, scene, w, h, out = new Float32Array(w * h)) {
  const o = mulv(pose.R, cam.pos);
  o[0] += pose.t[0]; o[1] += pose.t[1]; o[2] += pose.t[2];
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const d = mulv(pose.R, pixelRay(cam, u, v).d);
      out[v * w + u] = Math.min(255, shade(o, d, scene));
    }
  }
  return out;
}

/** Rig pose looking along heading (radians, + = right) from (x, z), level. */
export const poseAt = (x, z, heading) => ({ R: rotY(heading), t: [x, 0, z] });

// The scripted tour: through room A, the doorway, around room B, then a turn back.
const TOUR = [[0, 0], [0, 2.2], [0.9, 3.4], [2.5, 3.5], [4.5, 3.5], [5.6, 2.6], [6.7, 3.0], [6.6, 4.0], [5.2, 4.3], [3.6, 3.6]];

/** [{ t, x, z, heading, pose }] at `fps`, walking at `speed` m/s and turning at most `turnRate`°/s. */
export function tour({ fps = 15, speed = 0.7, turnRate = 45, path = TOUR } = {}) {
  const out = [];
  const dt = 1 / fps, maxTurn = (turnRate * Math.PI / 180) * dt;
  let [x, z] = path[0], heading = 0, seg = 1, t = 0;
  out.push({ t, x, z, heading, pose: poseAt(x, z, heading) });
  t += dt;
  while (seg < path.length) {
    const [tx, tz] = path[seg];
    const want = Math.atan2(tx - x, tz - z);
    let dh = want - heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    heading += Math.max(-maxTurn, Math.min(maxTurn, dh));
    // Slow down in sharp turns, like people do.
    const step = speed * dt * Math.max(0.25, Math.cos(Math.min(Math.PI / 2, Math.abs(dh))));
    const left = Math.hypot(tx - x, tz - z);
    if (left <= step) { x = tx; z = tz; seg++; } else { x += ((tx - x) / left) * step; z += ((tz - z) / left) * step; }
    out.push({ t, x, z, heading, pose: poseAt(x, z, heading) });
    t += dt;
  }
  return out;
}

/** Moves a walker by (forward m, turn rad), stopping short of walls and furniture (0.3 m clearance). */
export function walk(state, forward, turn, scene) {
  const heading = state.heading + turn;
  const nx = state.x + Math.sin(heading) * forward, nz = state.z + Math.cos(heading) * forward;
  const clear = (x, z) => !scene.boxes.some((b) => x > b.min[0] - 0.3 && x < b.max[0] + 0.3 && z > b.min[2] - 0.3 && z < b.max[2] + 0.3);
  if (clear(nx, nz)) return { x: nx, z: nz, heading };
  if (clear(nx, state.z)) return { x: nx, z: state.z, heading };
  if (clear(state.x, nz)) return { x: state.x, z: nz, heading };
  return { x: state.x, z: state.z, heading };
}
