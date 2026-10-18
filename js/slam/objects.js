// Objects in the 3D world: turn a detector box plus a depth map into a sized, placed 3D box
// (width, height and depth in metres, facing the way you saw it, standing on the floor), and
// merge repeat sightings so each real chair or table ends up as one object. Pure logic, no DOM.
import { apply, mulv } from './se3.js';

// Typical size (width, height, depth in m) of things worth putting in an indoor map. Depth (front
// to back) can't be seen from the front, so it comes from here, scaled with the measured width.
export const TYPICAL = {
  person: [0.5, 1.7, 0.3],
  chair: [0.5, 0.9, 0.5], couch: [2, 0.85, 0.9], bed: [1.6, 0.6, 2], 'dining table': [1.4, 0.75, 0.8],
  bench: [1.5, 0.45, 0.4], tv: [1, 0.6, 0.08], laptop: [0.35, 0.25, 0.25], 'potted plant': [0.4, 0.8, 0.4],
  refrigerator: [0.75, 1.8, 0.7], oven: [0.6, 0.9, 0.6], microwave: [0.5, 0.3, 0.4], sink: [0.6, 0.3, 0.5],
  toilet: [0.4, 0.75, 0.7], suitcase: [0.45, 0.65, 0.25], backpack: [0.3, 0.45, 0.2], 'teddy bear': [0.3, 0.4, 0.25],
  book: [0.2, 0.25, 0.15], clock: [0.3, 0.3, 0.05], vase: [0.15, 0.3, 0.15], bottle: [0.08, 0.25, 0.08],
  cup: [0.09, 0.1, 0.09], bowl: [0.15, 0.08, 0.15], keyboard: [0.45, 0.04, 0.15], mouse: [0.06, 0.04, 0.1],
  'cell phone': [0.08, 0.15, 0.01], remote: [0.05, 0.2, 0.03], umbrella: [0.9, 0.9, 0.9], 'wine glass': [0.08, 0.2, 0.08],
};

const FLOOR_SNAP = 0.35; // a box whose bottom is this close to the floor is standing on it
export const MAX_RANGE = 15; // m: further than this, the depth (and the box) can't be trusted
const PERSON_TTL = 6; // s: people move, so one not seen for this long is gone

/**
 * One detection → a 3D box in the map frame, or null if there isn't enough depth.
 * det: { class, score, bbox: [x, y, w, h] } in the rectified left image's pixels.
 * depth: Float32Array (m) for that image. intr: { f, cx, cy, w, h }. mapPose: camera → map.
 */
export function measureBox(det, depth, intr, mapPose) {
  const typical = TYPICAL[det.class];
  if (!typical) return null;
  const [bx, by, bw, bh] = det.bbox, { f, cx, cy, w, h } = intr;
  // Depth of the object itself: the nearer part of the box's middle (the rest is often background).
  const zs = [];
  for (let y = Math.floor(by + 0.25 * bh); y < by + 0.75 * bh; y += 2) {
    for (let x = Math.floor(bx + 0.25 * bw); x < bx + 0.75 * bw; x += 2) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const z = depth[y * w + x];
      if (z > 0.3 && z < MAX_RANGE + 1) zs.push(z);
    }
  }
  if (zs.length < 6) return null;
  zs.sort((a, b) => a - b);
  const Z = zs[Math.floor(zs.length * 0.3)];
  if (Z > MAX_RANGE) return null;
  const width = (bw * Z) / f, height = (bh * Z) / f;
  if (width < 0.05 || width > 4 || height < 0.03 || height > 2.6) return null;
  const depthM = typical[2] * Math.max(0.5, Math.min(2, width / typical[0]));
  // Front face centre in the camera frame, pushed back half the depth along the line of sight.
  const ux = (bx + bw / 2 - cx) / f, uy = (by + bh / 2 - cy) / f;
  const front = [ux * Z, uy * Z, Z];
  const flat = Math.hypot(ux, 1);
  const centreCam = [front[0] + (ux / flat) * (depthM / 2), front[1], front[2] + (1 / flat) * (depthM / 2)];
  const c = apply(mapPose, centreCam);
  // Facing the camera: the object's yaw is the direction you were looking at it from.
  const look = mulv(mapPose.R, [ux, 0, 1]);
  const yaw = Math.atan2(look[0], look[2]);
  // Map frame: y points down, floor at 0, so the box's bottom is at y = c.y + height/2.
  let bottom = c[1] + height / 2, hh = height, feet = null;
  if (Math.abs(bottom) < FLOOR_SNAP) bottom = 0;
  if (det.class === 'person') {
    // People stand on the floor, upright: tall from the floor to the top of the head, even
    // when their feet are out of view. Feet in view mark where the floor is (see World.addFeet).
    const top = apply(mapPose, [ux * Z, ((by - cy) / f) * Z, Z]);
    hh = Math.min(2.1, Math.max(0.9, -top[1]));
    bottom = 0;
    if (by + bh < h - 3) feet = apply(mapPose, [ux * Z, ((by + bh - cy) / f) * Z, Z]);
  }
  return { cls: det.class, score: det.score, x: c[0], z: c[2], bottom, w: width, h: hh, d: depthM, yaw, feet };
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** All the objects seen so far, with repeat sightings of the same thing merged. */
export class ObjectMap {
  constructor() {
    this.list = [];
    this.nextId = 1;
    this.now = 0;
  }

  /** Adds a sighting; returns the object it was merged into (or the new one). */
  add(b, anchor = null) {
    const { feet, ...box } = b;
    const person = b.cls === 'person', t = b.t ?? 0;
    this.now = Math.max(this.now, t);
    if (person) this.list = this.list.filter((o) => o.cls !== 'person' || this.now - o.t < PERSON_TTL);
    const near = this.list.find((o) => o.cls === b.cls
      && Math.hypot(o.x - b.x, o.z - b.z) < (person ? 1.2 : Math.max(0.5, 0.6 * Math.max(o.w, o.d, b.w))));
    if (!near) {
      const o = { id: this.nextId++, ...box, t, n: 1, anchor };
      this.list.push(o);
      return o;
    }
    // Running average; size and place settle as more views come in. People follow the newest view.
    const k = person ? 0.7 : 1 / (near.n + 1);
    near.t = t;
    for (const key of ['x', 'z', 'bottom', 'w', 'h', 'd']) near[key] += (b[key] - near[key]) * k;
    near.yaw = wrap(near.yaw + wrap(b.yaw - near.yaw) * k);
    near.n++;
    if (anchor) near.anchor = anchor;
    return near;
  }

  /** Objects seen at least twice (single sightings are often the detector being wrong), and people seen lately. */
  confirmed(min = 2) {
    return this.list.filter((o) => (o.cls === 'person' ? this.now - o.t < PERSON_TTL : o.n >= min));
  }

  /** The furniture: what stays put, so it's worth saving and navigating to. */
  lasting(min = 2) {
    return this.list.filter((o) => o.cls !== 'person' && o.n >= min);
  }
}
