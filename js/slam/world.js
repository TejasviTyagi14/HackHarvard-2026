// The world model built while walking: keyframes (pose + point cloud) fused into
//   • a 3D voxel cloud (5 cm), the "3D model of the building" you can look around in, and
//   • a 2D floor grid of free / blocked / unseen cells, which is what route planning reads.
// Up is found by fitting the floor plane in the first keyframes. Keyframes are kept, so the
// whole map can be rebuilt (after loading a file, or with different body-height settings).
// Pure logic, no DOM.
//
// Map frame: x right and z forward as at the start, y straight down, floor at y = 0
// (so height above the floor is −y).
import { apply, compose, mul3, mulv, rotX } from './se3.js';

export const WORLD_DEFAULTS = {
  cell: 0.05, // floor-grid cell (m)
  size: 1200, // grid is size × size cells (60 m × 60 m), centred on the start
  voxel: 0.05, // 3D model resolution (m)
  camHeight: 1.25, // until the floor is seen: cameras' height above it (m)
  tiltDeg: 0, // …and how far they point down
  stepHeight: 0.1, // anything lower is floor you can step over
  bodyHeight: 1.9, // anything higher is overhead (doesn't block)
  rangeMax: 4, // only map within this distance (depth gets too noisy beyond)
  floorTol: 0.07, // points this close to the floor count as floor
  alignKeyframes: 4, // keyframes to collect before fitting the floor
  hit: 0.85, miss: -0.4, minLog: -2, maxLog: 3.5, // log-odds for the floor grid
};

const OCC = 0.7, FREE = -0.4;

export class World {
  constructor(opts = {}) {
    this.o = { ...WORLD_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    const n = this.o.size * this.o.size;
    this.logodds = new Float32Array(n);
    this.freeStamp = new Int32Array(n);
    this.hitStamp = new Int32Array(n);
    this.stamp = 0;
    this.bbox = null; // [i0, j0, i1, j1] cells touched so far
    this.voxels = new Map();
    this.pendingPoints = [];
    this.pendingReset = true;
    this.keyframes = [];
    this.waiting = []; // keyframes collected before the floor is fitted
    this.align = null; // { R, t }: odometry frame → map frame
    this.floor = 'pending'; // 'pending' | 'fitted' | 'assumed'
    this.landmarks = [];
    this.places = [];
    this.version = 0;
  }

  /** Map frame assumed from the camera-height and tilt settings. */
  assumedAlign() {
    const R = rotX(-(this.o.tiltDeg * Math.PI) / 180);
    return { R, t: [0, -this.o.camHeight, 0] };
  }

  toMap(p) {
    return apply(this.align ?? this.assumedAlign(), p);
  }

  /** Camera pose in the map frame. */
  mapPose(pose) {
    return compose(this.align ?? this.assumedAlign(), pose);
  }

  addKeyframe(kf) {
    const keep = { id: kf.id, t: kf.t, pose: { R: kf.pose.R.slice(), t: kf.pose.t.slice() }, points: kf.points, gray: kf.gray, fuse: kf.fuse };
    this.keyframes.push(keep);
    if (!this.align) {
      this.waiting.push(keep);
      if (this.waiting.length >= this.o.alignKeyframes) this.fitFloor();
      return;
    }
    if (keep.fuse) this.fuse(keep);
  }

  /** Fits the floor plane in the first keyframes and fuses them. */
  fitFloor() {
    const A0 = this.assumedAlign();
    const cand = [];
    for (const kf of this.waiting) {
      const P = compose(A0, kf.pose);
      for (let i = 0; i < kf.points.length; i += 3) {
        const p = apply(P, [kf.points[i], kf.points[i + 1], kf.points[i + 2]]);
        if (Math.abs(p[1]) < 0.4) cand.push(p);
      }
    }
    const plane = ransacPlane(cand, 0.03, 300);
    this.align = A0;
    this.floor = 'assumed';
    if (plane && plane.inliers >= Math.max(200, 0.15 * cand.length)) {
      let n = plane.n;
      if (n[1] > 0) n = n.map((x) => -x); // make it point up (−y)
      if (-n[1] > Math.cos((25 * Math.PI) / 180)) {
        const Rc = rotationBetween(n, [0, -1, 0]);
        const R = mul3(Rc, A0.R);
        const t = mulv(Rc, A0.t);
        // After rotating, the floor sits at y = −d / |n|·…; measure it from the inliers.
        const ys = plane.points.map((p) => mulv(Rc, p)[1]).sort((a, b) => a - b);
        const y0 = ys[ys.length >> 1];
        this.align = { R, t: [t[0], t[1] - y0, t[2]] };
        this.floor = 'fitted';
      }
    }
    for (const kf of this.waiting) if (kf.fuse) this.fuse(kf);
    this.waiting = [];
  }

  cellIndex(x, z) {
    const s = this.o.size;
    const i = Math.floor(x / this.o.cell) + s / 2, j = Math.floor(z / this.o.cell) + s / 2;
    return i < 0 || j < 0 || i >= s || j >= s ? -1 : j * s + i;
  }

  fuse(kf) {
    const o = this.o, s = o.size;
    const P = compose(this.align, kf.pose);
    const cam = P.t;
    const ci = Math.floor(cam[0] / o.cell) + s / 2, cj = Math.floor(cam[2] / o.cell) + s / 2;
    const stamp = ++this.stamp;
    const freeList = [], hitList = [];
    const touch = (i, j) => {
      if (!this.bbox) this.bbox = [i, j, i, j];
      else {
        if (i < this.bbox[0]) this.bbox[0] = i;
        if (j < this.bbox[1]) this.bbox[1] = j;
        if (i > this.bbox[2]) this.bbox[2] = i;
        if (j > this.bbox[3]) this.bbox[3] = j;
      }
    };
    const ray = (i1, j1, inclusive) => {
      // Bresenham from the camera's cell to (i1, j1): cells passed through are seen to be free.
      let i = ci, j = cj;
      const di = Math.abs(i1 - i), dj = Math.abs(j1 - j), si = i < i1 ? 1 : -1, sj = j < j1 ? 1 : -1;
      let err = di - dj;
      for (;;) {
        if (i === i1 && j === j1) {
          if (!inclusive) return;
        }
        if (i < 0 || j < 0 || i >= s || j >= s) return;
        const k = j * s + i;
        if (this.freeStamp[k] !== stamp) { this.freeStamp[k] = stamp; freeList.push(k); touch(i, j); }
        if (i === i1 && j === j1) return;
        const e2 = 2 * err;
        if (e2 > -dj) { err -= dj; i += si; }
        if (e2 < di) { err += di; j += sj; }
      }
    };
    const pts = kf.points;
    for (let a = 0, g = 0; a < pts.length; a += 3, g++) {
      const p = apply(P, [pts[a], pts[a + 1], pts[a + 2]]);
      this.addVoxel(p, kf.gray[g]);
      const dx = p[0] - cam[0], dz = p[2] - cam[2];
      if (dx * dx + dz * dz > o.rangeMax * o.rangeMax) continue;
      const height = -p[1];
      const i1 = Math.floor(p[0] / o.cell) + s / 2, j1 = Math.floor(p[2] / o.cell) + s / 2;
      if (i1 < 0 || j1 < 0 || i1 >= s || j1 >= s) continue;
      if (height > o.stepHeight && height < o.bodyHeight) {
        ray(i1, j1, false);
        const k = j1 * s + i1;
        if (this.hitStamp[k] !== stamp) { this.hitStamp[k] = stamp; hitList.push(k); touch(i1, j1); }
      } else if (Math.abs(height) < o.floorTol) {
        ray(i1, j1, true);
      }
    }
    for (const k of freeList) if (this.hitStamp[k] !== stamp) this.logodds[k] = Math.max(o.minLog, this.logodds[k] + o.miss);
    for (const k of hitList) this.logodds[k] = Math.min(o.maxLog, this.logodds[k] + o.hit);
    this.version++;
  }

  addVoxel(p, g) {
    const v = this.o.voxel;
    const ix = Math.floor(p[0] / v), iy = Math.floor(p[1] / v), iz = Math.floor(p[2] / v);
    const key = (ix + 4096) * 67108864 + (iy + 4096) * 8192 + (iz + 4096);
    const cur = this.voxels.get(key);
    if (!cur) {
      this.voxels.set(key, { n: 1, g, x: (ix + 0.5) * v, y: (iy + 0.5) * v, z: (iz + 0.5) * v });
      return;
    }
    cur.n++;
    cur.g += (g - cur.g) / cur.n;
    // Show a voxel once two observations agree, which drops most stray depth noise.
    if (cur.n === 2) this.pendingPoints.push(cur);
  }

  /** New 3D-model points since the last call: { reset, xyz: Float32Array, gray: Uint8Array }. */
  takePoints() {
    const list = this.pendingPoints;
    this.pendingPoints = [];
    const reset = this.pendingReset;
    this.pendingReset = false;
    const xyz = new Float32Array(list.length * 3), gray = new Uint8Array(list.length);
    list.forEach((p, i) => { xyz[i * 3] = p.x; xyz[i * 3 + 1] = p.y; xyz[i * 3 + 2] = p.z; gray[i] = p.g; });
    return { reset, xyz, gray };
  }

  /** 1 = blocked, 0 = free, −1 = not seen yet. */
  cellState(k) {
    const v = this.logodds[k];
    return v > OCC ? 1 : v < FREE ? 0 : -1;
  }

  /** The explored part of the floor grid: { x0, z0, cell, w, h, data: Int8Array (1 / 0 / −1) }. */
  gridSnapshot(margin = 10) {
    const o = this.o, s = o.size;
    if (!this.bbox) return null;
    const i0 = Math.max(0, this.bbox[0] - margin), j0 = Math.max(0, this.bbox[1] - margin);
    const i1 = Math.min(s - 1, this.bbox[2] + margin), j1 = Math.min(s - 1, this.bbox[3] + margin);
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    const data = new Int8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = this.cellState((j0 + j) * s + i0 + i);
    return { x0: (i0 - s / 2) * o.cell, z0: (j0 - s / 2) * o.cell, cell: o.cell, w, h, data, version: this.version };
  }

  /** Throws everything away except the keyframes, then fuses them all again. */
  rebuild(opts = {}) {
    Object.assign(this.o, opts);
    const { keyframes, landmarks, places, align, floor } = this;
    this.reset();
    Object.assign(this, { landmarks, places, align, floor });
    for (const kf of keyframes) {
      this.keyframes.push(kf);
      if (kf.fuse) this.fuse(kf);
    }
  }

  /** Remembers a detected object (map frame); repeated sightings within 0.8 m are merged. */
  addLandmark(cls, p) {
    const near = this.landmarks.find((l) => l.cls === cls && Math.hypot(l.x - p[0], l.z - p[2]) < 0.8);
    if (near) {
      near.n++;
      near.x += (p[0] - near.x) / near.n;
      near.y += (p[1] - near.y) / near.n;
      near.z += (p[2] - near.z) / near.n;
      return near;
    }
    const l = { id: this.landmarks.length + 1, cls, x: p[0], y: p[1], z: p[2], n: 1 };
    this.landmarks.push(l);
    return l;
  }

  /** Landmarks seen at least twice (one-off detections are often wrong). */
  confirmedLandmarks() {
    return this.landmarks.filter((l) => l.n >= 2);
  }

  setPlace(name, x, z) {
    const key = name.trim().toLowerCase();
    this.places = this.places.filter((p) => p.name.toLowerCase() !== key);
    const place = { name: name.trim(), x, z };
    this.places.push(place);
    return place;
  }

  stats() {
    let free = 0, blocked = 0;
    if (this.bbox) {
      const s = this.o.size;
      for (let j = this.bbox[1]; j <= this.bbox[3]; j++) {
        for (let i = this.bbox[0]; i <= this.bbox[2]; i++) {
          const c = this.cellState(j * s + i);
          if (c === 0) free++;
          else if (c === 1) blocked++;
        }
      }
    }
    const a = this.o.cell * this.o.cell;
    return { keyframes: this.keyframes.length, voxels: this.voxels.size, freeArea: free * a, blockedArea: blocked * a, floor: this.floor };
  }

  /** Everything needed to rebuild this map later, as plain JSON. */
  serialize(extra = {}) {
    return {
      kind: 'stereo-map', version: 1, saved: new Date().toISOString(), opts: this.o, align: this.align, floor: this.floor,
      landmarks: this.landmarks, places: this.places, ...extra,
      keyframes: this.keyframes.map((k) => ({
        id: k.id, t: k.t, R: k.pose.R, tt: k.pose.t, fuse: k.fuse, points: toB64(k.points.buffer), gray: toB64(k.gray.buffer),
      })),
    };
  }

  static deserialize(data) {
    if (data?.kind !== 'stereo-map') throw new Error("That file isn't a saved map.");
    const w = new World(data.opts);
    w.align = data.align;
    w.floor = data.floor;
    w.landmarks = data.landmarks ?? [];
    w.places = data.places ?? [];
    for (const k of data.keyframes) {
      const kf = { id: k.id, t: k.t, pose: { R: k.R, t: k.tt }, fuse: k.fuse, points: new Float32Array(fromB64(k.points)), gray: new Uint8Array(fromB64(k.gray)) };
      w.keyframes.push(kf);
      if (kf.fuse && w.align) w.fuse(kf);
    }
    return w;
  }

  /** The 3D model as a binary PLY point cloud (opens in MeshLab, Blender, CloudCompare). */
  toPLY() {
    const pts = [...this.voxels.values()].filter((v) => v.n >= 2);
    const header = `ply\nformat binary_little_endian 1.0\ncomment stereo-distance map, metres, y up\nelement vertex ${pts.length}\n`
      + 'property float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
    const head = new TextEncoder().encode(header);
    const buf = new ArrayBuffer(head.length + pts.length * 15);
    new Uint8Array(buf).set(head);
    const dv = new DataView(buf);
    let o = head.length;
    for (const p of pts) {
      // Written y-up (height above the floor), z flipped to keep it right-handed.
      dv.setFloat32(o, p.x, true); dv.setFloat32(o + 4, -p.y, true); dv.setFloat32(o + 8, -p.z, true);
      const g = Math.max(0, Math.min(255, Math.round(p.g)));
      dv.setUint8(o + 12, g); dv.setUint8(o + 13, g); dv.setUint8(o + 14, g);
      o += 15;
    }
    return buf;
  }
}

/** Rotation taking unit vector a onto unit vector b. */
export function rotationBetween(a, b) {
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const s2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (s2 < 1e-12) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const K = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
  const K2 = mul3(K, K), f = (1 - c) / s2;
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (i % 4 === 0 ? 1 : 0) + K[i] + K2[i] * f);
}

/** Plane through most of the points (within tol m): { n, d, inliers, points }. */
export function ransacPlane(points, tol = 0.03, iters = 300) {
  if (points.length < 50) return null;
  let best = null;
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let it = 0; it < iters; it++) {
    const a = points[(rand() * points.length) | 0], b = points[(rand() * points.length) | 0], c = points[(rand() * points.length) | 0];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(...n);
    if (len < 1e-6) continue;
    n = n.map((x) => x / len);
    const d = -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
    let count = 0;
    for (const p of points) if (Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + d) < tol) count++;
    if (!best || count > best.inliers) best = { n, d, inliers: count };
  }
  if (!best) return null;
  best.points = points.filter((p) => Math.abs(best.n[0] * p[0] + best.n[1] * p[1] + best.n[2] * p[2] + best.d) < tol);
  return best;
}

function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}
