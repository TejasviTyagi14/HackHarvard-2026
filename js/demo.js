// A synthetic room seen by two virtual cameras, so the whole pipeline can run (and be tested)
// without hardware. Textured boxes stand on a tiled floor; their projected outlines stand in
// for detector output, and their true distances are known.
import { norm, pixelRay, project } from './geometry.js';

// The rig sits 60 cm above the floor (y points down), like webcams on a desk, in a
// 5.2 m wide, 6 m deep room. Objects are placed so none hides another.
export const ROOM = { floorY: 0.6, ceilY: -1.9, backZ: 6, sideX: 2.6 };

export const DEMO_OBJECTS = [
  { name: 'box A', cls: 'box', x: -0.45, z: 1.8, size: [0.4, 0.5, 0.4], color: [214, 112, 64] },
  { name: 'box B', cls: 'box', x: 0.6, z: 2.6, size: [0.5, 0.6, 0.4], color: [70, 140, 214] },
  { name: 'pillar', cls: 'pillar', x: -1.5, z: 3.4, size: [0.35, 1.8, 0.35], color: [190, 190, 80] },
  { name: 'crate', cls: 'crate', x: 0.1, z: 3.9, size: [0.6, 0.45, 0.5], color: [150, 100, 200] },
  { name: 'box C', cls: 'box', x: 1.9, z: 4.8, size: [0.5, 0.7, 0.5], color: [80, 190, 120] },
];

// A person-sized block, for practising the person calibration in the demo room.
export const DEMO_PERSON = { cls: 'person', size: [0.45, 1.75, 0.25], color: [70, 95, 150] };

/**
 * person: { range, x } puts the stand-in person's front at `range` metres. Anything in line with
 * them is taken out: the ground-truth boxes ignore occlusion, so a hidden box would land on the person.
 */
export function demoScene(objects = DEMO_OBJECTS, { person = null } = {}) {
  let list = objects;
  if (person) {
    const [pw, , pd] = DEMO_PERSON.size;
    const p = { ...DEMO_PERSON, x: person.x ?? 0, z: person.range + pd / 2 };
    list = [...objects.filter((o) => Math.abs(o.x - p.x) > (o.size[0] + pw) / 2), p];
  }
  return list.map((o, k) => {
    const [w, h, d] = o.size;
    return {
      ...o, seed: 17 + k * 13,
      min: [o.x - w / 2, ROOM.floorY - h, o.z - d / 2],
      max: [o.x + w / 2, ROOM.floorY, o.z + d / 2],
    };
  });
}

/** Distance from the rig to the middle of a box's front face: the demo's "true" distance. */
export function frontFaceRange(b) {
  return norm([(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.min[2]]);
}

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Surface texture in [0, 1] from surface coordinates in metres (fine grain + blotches). */
export function texture(s, t, seed) {
  return 0.45 * valueNoise(s * 40, t * 40, seed) + 0.35 * valueNoise(s * 9, t * 9, seed + 1) + 0.2 * valueNoise(s * 2.5, t * 2.5, seed + 2);
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

/** Nearest surface hit along a ray: { t, kind, axis, box, point } or null. */
export function intersect(o, d, scene) {
  const { floorY, ceilY, backZ, sideX } = ROOM;
  let t = Infinity, kind = null, axis = -1, box = null;
  const plane = (tt, k) => { if (tt > 1e-6 && tt < t) { t = tt; kind = k; } };
  if (d[1] > 1e-9) plane((floorY - o[1]) / d[1], 'floor');
  if (d[1] < -1e-9) plane((ceilY - o[1]) / d[1], 'ceiling');
  if (d[2] > 1e-9) plane((backZ - o[2]) / d[2], 'back');
  if (d[0] > 1e-9) plane((sideX - o[0]) / d[0], 'side');
  if (d[0] < -1e-9) plane((-sideX - o[0]) / d[0], 'side');
  for (const b of scene) {
    const h = hitBox(o, d, b);
    if (h && h.t < t) { t = h.t; kind = 'box'; axis = h.axis; box = b; }
  }
  if (!kind) return null;
  return { t, kind, axis, box, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t] };
}

export const castRay = (ray, scene) => intersect(ray.o, ray.d, scene);

function surfaceColor(hit) {
  const p = hit.point;
  switch (hit.kind) {
    case 'floor': {
      const tile = (Math.floor(p[0] * 2) + Math.floor(p[2] * 2)) & 1;
      const k = (tile ? 0.95 : 0.7) * (0.55 + 0.8 * texture(p[0], p[2], 3));
      return [150 * k, 132 * k, 112 * k];
    }
    case 'ceiling': {
      const k = 0.6 + 0.6 * texture(p[0], p[2], 5);
      return [200 * k, 200 * k, 205 * k];
    }
    case 'back': {
      const k = 0.55 + 0.8 * texture(p[0], p[1], 7);
      return [168 * k, 176 * k, 186 * k];
    }
    case 'side': {
      const k = 0.5 + 0.8 * texture(p[2], p[1], 9);
      return [150 * k, 160 * k, 172 * k];
    }
    default: {
      const [s, t] = hit.axis === 0 ? [p[2], p[1]] : hit.axis === 1 ? [p[0], p[2]] : [p[0], p[1]];
      const light = hit.axis === 1 ? 1.12 : hit.axis === 0 ? 0.78 : 1;
      const k = light * (0.5 + 0.85 * texture(s, t, hit.box.seed));
      return hit.box.color.map((c) => c * k);
    }
  }
}

/** RGBA pixels of the scene as seen by `cam` (which must be built for a w × h image). */
export function renderView(cam, scene, w = cam.w, h = cam.h) {
  const img = new Uint8ClampedArray(w * h * 4);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const ray = pixelRay(cam, u, v);
      const hit = intersect(ray.o, ray.d, scene);
      const c = hit ? surfaceColor(hit) : [0, 0, 0];
      const k = (v * w + u) * 4;
      img[k] = c[0];
      img[k + 1] = c[1];
      img[k + 2] = c[2];
      img[k + 3] = 255;
    }
  }
  return img;
}

/** Each box's projected outline in `cam`, shaped like detector output, plus its true distance. */
export function groundTruthDetections(cam, scene) {
  const out = [];
  for (const b of scene) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
    for (const cx of [b.min[0], b.max[0]]) {
      for (const cy of [b.min[1], b.max[1]]) {
        for (const cz of [b.min[2], b.max[2]]) {
          const p = project(cam, [cx, cy, cz]);
          if (!p) { behind = true; continue; }
          x0 = Math.min(x0, p.u); x1 = Math.max(x1, p.u);
          y0 = Math.min(y0, p.v); y1 = Math.max(y1, p.v);
        }
      }
    }
    if (behind) continue;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(cam.w, x1); y1 = Math.min(cam.h, y1);
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    out.push({ bbox: [x0, y0, x1 - x0, y1 - y0], class: b.cls, score: 0.99, name: b.name, truth: frontFaceRange(b) });
  }
  return out;
}
