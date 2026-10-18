// Walls from the 3D model: flat vertical surfaces in the point cloud, found as straight lines on
// the floor plan (every wall is a tall stack of points standing over a line), each with a height.
// Things already recognised as objects are left out, so a fridge or the back of a couch doesn't
// become a wall. WallMap keeps them from one extraction to the next. Pure logic, no DOM.

/**
 * voxels: iterable of { x, y, z, n } in the map frame (y down, floor at 0).
 * exclude: objects [{ x, z, w, d, yaw }] whose footprint isn't wall.
 * Returns [{ x0, z0, x1, z1, top, n }]: segments on the floor plan, top = height (m).
 */
export function extractWalls(voxels, {
  cell = 0.1, minHits = 2, minTall = 0.6, minLength = 0.8, tol = 0.08, gap = 0.4, maxWalls = 40, exclude = [],
} = {}) {
  // Columns: each floor cell's stack of points between ankle and ceiling height.
  const cols = new Map();
  for (const v of voxels) {
    if (v.n < minHits) continue;
    const ht = -v.y;
    if (ht < 0.15 || ht > 2.8) continue;
    const i = Math.floor(v.x / cell), j = Math.floor(v.z / cell);
    const key = (i + 32768) * 65536 + (j + 32768);
    const c = cols.get(key);
    if (c) { c.lo = Math.min(c.lo, ht); c.hi = Math.max(c.hi, ht); c.n++; }
    else cols.set(key, { x: (i + 0.5) * cell, z: (j + 0.5) * cell, lo: ht, hi: ht, n: 1 });
  }
  const inObject = (p) => exclude.some((o) => {
    const dx = p.x - o.x, dz = p.z - o.z, c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    return Math.abs(dx * c - dz * s) < o.w / 2 + 0.1 && Math.abs(dx * s + dz * c) < o.d / 2 + 0.1;
  });
  let pts = [...cols.values()].filter((c) => c.hi - c.lo >= minTall && c.n >= 4 && !inObject(c));

  let seed = 987654321;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const walls = [];
  let misses = 0;
  while (walls.length < maxWalls && pts.length >= 8 && misses < 6) {
    // The line with the most wall columns near it (scored on a sample, to stay quick).
    const sample = pts.length > 1500 ? Array.from({ length: 1500 }, () => pts[(rand() * pts.length) | 0]) : pts;
    let best = null;
    for (let t = 0; t < 150; t++) {
      const a = pts[(rand() * pts.length) | 0], b = pts[(rand() * pts.length) | 0];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.3 || L > 5) continue;
      const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L, c = nx * a.x + nz * a.z;
      let score = 0;
      for (const p of sample) if (Math.abs(nx * p.x + nz * p.z - c) < tol) score++;
      if (!best || score > best.score) best = { nx, nz, c, score };
    }
    if (!best) break;
    // Refit to all of its columns (principal direction), then take them again.
    let inl = pts.filter((p) => Math.abs(best.nx * p.x + best.nz * p.z - best.c) < tol);
    const line = fitLine(inl);
    inl = pts.filter((p) => Math.abs(line.nx * (p.x - line.mx) + line.nz * (p.z - line.mz)) < tol);
    const used = new Set(inl);
    pts = pts.filter((p) => !used.has(p));
    // Split where there's a gap: a doorway, or two walls that happen to line up.
    const along = inl.map((p) => ({ t: (p.x - line.mx) * line.dx + (p.z - line.mz) * line.dz, hi: p.hi })).sort((a, b) => a.t - b.t);
    let found = false;
    for (let s = 0; s < along.length;) {
      let e = s;
      while (e + 1 < along.length && along[e + 1].t - along[e].t < gap) e++;
      const t0 = along[s].t, t1 = along[e].t, n = e - s + 1, len = t1 - t0 + cell;
      const seg = { x0: line.mx + line.dx * t0, z0: line.mz + line.dz * t0, x1: line.mx + line.dx * t1, z1: line.mz + line.dz * t1, n };
      if (len >= minLength && n >= (0.5 * len) / cell && !walls.some((w) => sameWall(w, seg))) {
        const tops = along.slice(s, e + 1).map((a) => a.hi).sort((a, b) => a - b);
        walls.push({ ...seg, top: Math.max(1, tops[Math.floor(tops.length * 0.8)]) });
        found = true;
      }
      s = e + 1;
    }
    misses = found ? 0 : misses + 1;
  }
  return walls;
}

/**
 * Buildings are mostly square: walls meet at 90° or run in line (180°). Finds the building's main
 * direction (from the walls, longest counting most; `axis` from last time keeps it steady) and
 * turns each wall within `tolDeg` of square to be exactly square, about its middle; walls further
 * off than that are dropped (in one-camera mode they're nearly always noise). Then joins walls
 * that end up in line and touching. Returns { walls, axis }: every wall square, `square: true`.
 */
export function squareUp(walls, axis = null, { tolDeg = 20, join = 0.3 } = {}) {
  walls = walls.filter((w) => Math.hypot(w.x1 - w.x0, w.z1 - w.z0) > 1e-6); // no direction; a NaN would poison the axis
  if (!walls.length) return { walls, axis };
  const quarter = (a) => a - (Math.PI / 2) * Math.round(a / (Math.PI / 2)); // into ±45°
  let sx = 0, sy = 0, total = 0;
  for (const w of walls) {
    const a = Math.atan2(w.z1 - w.z0, w.x1 - w.x0), L = Math.hypot(w.x1 - w.x0, w.z1 - w.z0);
    sx += L * Math.cos(4 * a); sy += L * Math.sin(4 * a); total += L;
  }
  const seen = Math.atan2(sy, sx) / 4;
  // Settle slowly once there's a direction, so the walls don't swing as new ones come in.
  axis = axis == null ? seen : axis + quarter(seen - axis) * Math.min(1, total / 40);
  const tol = (tolDeg * Math.PI) / 180;
  const out = [];
  for (const w of walls) {
    const a = Math.atan2(w.z1 - w.z0, w.x1 - w.x0), d = quarter(a - axis);
    if (Math.abs(d) > tol) continue;
    const b = a - d, L = Math.hypot(w.x1 - w.x0, w.z1 - w.z0) / 2, mx = (w.x0 + w.x1) / 2, mz = (w.z0 + w.z1) / 2;
    out.push({ ...w, x0: mx - Math.cos(b) * L, z0: mz - Math.sin(b) * L, x1: mx + Math.cos(b) * L, z1: mz + Math.sin(b) * L, square: true });
  }
  // Join walls lying along the same line with less than `join` between them.
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const A = out[i], B = out[j];
        const ax = A.x1 - A.x0, az = A.z1 - A.z0, La = Math.hypot(ax, az), ux = ax / La, uz = az / La;
        if (Math.abs(ux * (B.z1 - B.z0) - uz * (B.x1 - B.x0)) > 1e-6 * La) continue; // not parallel
        const off = (p, q) => (p - A.x0) * -uz + (q - A.z0) * ux;
        if (Math.abs(off(B.x0, B.z0)) > 0.12) continue;
        const along = (p, q) => (p - A.x0) * ux + (q - A.z0) * uz;
        const t = [along(B.x0, B.z0), along(B.x1, B.z1)].sort((p, q) => p - q);
        if (t[0] > La + join || t[1] < -join) continue;
        const t0 = Math.min(0, t[0]), t1 = Math.max(La, t[1]), n = A.n + B.n, o = (off(B.x0, B.z0) * B.n) / n;
        const bx = A.x0 - uz * o, bz = A.z0 + ux * o;
        out[i] = { ...A, x0: bx + ux * t0, z0: bz + uz * t0, x1: bx + ux * t1, z1: bz + uz * t1, n, top: Math.max(A.top, B.top) };
        out.splice(j, 1);
        merged = true;
      }
    }
  }
  return { walls: out, axis };
}

const WALL_DEFAULTS = {
  near: 0.2, // walls closer than this side by side are one (the two faces of it)…
  reach: 0.3, // …when they overlap, or end less than this apart along it
  cap: 150, // most weight a kept wall has against a new sighting, so it can still settle
  confirm: 2, // extractions a wall must be in before it's shown
  forget: 3, // extractions an unshown wall may be missing from before it's dropped
  stale: 3, // extractions a shown wall may be missing from before open floor can remove it…
  openFrac: 0.6, // …which it does when this much of its length is open floor
  corner: 0.4, // a wall end this close to a perpendicular wall's line ends exactly on it
};

/**
 * The walls kept from one extraction to the next, so they don't flicker. Each is kept square to
 * the building's axis a, as u = x cos a + z sin a, v = −x sin a + z cos a: o = 0 runs along the
 * axis at v = c, o = 1 across it at u = c, and it spans [t0, t1] along itself. A wall is shown
 * once two extractions have found it; after that it stays, unless open floor shows it wasn't one.
 * Right after clear() every wall is shown at once, but still goes if it isn't found again.
 */
export class WallMap {
  constructor(opts = {}) {
    this.o = { ...WALL_DEFAULTS, ...opts };
    this.nextId = 1;
    this.clear();
  }

  /** After the map moved under the walls (loop closure, re-levelling, reset, load): the next extraction is shown at once. */
  clear() {
    this.walls = [];
    this.axis = null;
    this.k = 0;
    this.seed = true;
  }

  get size() {
    return this.walls.length;
  }

  /** Merges one extraction (squareUp's output). isFree(x, z): the floor grid has seen open floor there. */
  update(squared, axis, { isFree = null } = {}) {
    const o = this.o, k = ++this.k, seed = this.seed;
    this.seed = false;
    axis = Number.isFinite(axis) ? axis : this.axis ?? 0;
    // The axis settled a little: each wall turns about its middle, so it stays on its points.
    if (this.axis != null && axis !== this.axis) for (const w of this.walls) Object.assign(w, inAxis(ends(w, this.axis), axis));
    this.axis = axis;
    for (const seg of squared) {
      const w = { ...inAxis(seg, axis), top: seg.top, n: seg.n || 1 };
      if (!(w.t1 - w.t0 > 1e-6)) continue; // no length, or not a number
      const near = this.walls.filter((s) => alike(s, w, o)).sort((p, q) => q.n - p.n)[0];
      if (!near) { this.walls.push({ id: this.nextId++, ...w, seen: 1, last: k, shown: seed }); continue; }
      merge(near, w, o.cap);
      if (near.last !== k) { near.seen++; near.last = k; }
    }
    // Walls that grew into each other, or that one new piece bridged, become one.
    for (let merged = true; merged;) {
      merged = false;
      for (let i = 0; i < this.walls.length && !merged; i++) {
        for (let j = i + 1; j < this.walls.length && !merged; j++) {
          const A = this.walls[i], B = this.walls[j];
          if (!alike(A, B, o)) continue;
          const [keep, gone] = A.n >= B.n ? [A, B] : [B, A];
          merge(keep, gone, o.cap);
          Object.assign(keep, { id: Math.min(A.id, B.id), seen: Math.max(A.seen, B.seen), last: Math.max(A.last, B.last), shown: A.shown || B.shown });
          this.walls.splice(this.walls.indexOf(gone), 1);
          merged = true;
        }
      }
    }
    for (const w of this.walls) if (w.seen >= o.confirm) w.shown = true;
    // Walls found only once that weren't found again go, even ones shown at once after clear(), so
    // a stray piece in that extraction isn't kept for good. A confirmed wall goes once it's been
    // missing for a while and the grid sees open floor where it stood: it was a person or clutter.
    this.walls = this.walls.filter((w) => (w.seen >= o.confirm
      ? !(isFree && k - w.last >= o.stale && openFloor(w, axis, isFree) > o.openFrac)
      : k - w.last < o.forget));
  }

  /** Shown walls as floor-plan segments [{ id, x0, z0, x1, z1, top, n, square }], exactly square to the axis, corners joined. */
  list() {
    const { corner } = this.o, a = this.axis ?? 0, shown = this.walls.filter((w) => w.shown);
    // End e of wall w moves onto the nearest perpendicular wall's line, if that wall reaches the meeting point.
    const snap = (w, e) => {
      let best = e, d = corner;
      for (const p of shown) {
        if (p.o === w.o || w.c < p.t0 - corner || w.c > p.t1 + corner || Math.abs(p.c - e) >= d) continue;
        best = p.c;
        d = Math.abs(p.c - e);
      }
      return best;
    };
    return shown.map((w) => {
      let t0 = snap(w, w.t0), t1 = snap(w, w.t1);
      if (t1 - t0 < corner) [t0, t1] = [w.t0, w.t1]; // both ends on one wall, or nearly nothing left
      const [x0, z0] = point(w.o, w.c, t0, a), [x1, z1] = point(w.o, w.c, t1, a);
      return { id: w.id, x0, z0, x1, z1, top: w.top, n: w.n, square: true };
    });
  }
}

/** Segment → square to axis a, about its middle: { o, c, t0, t1 } (see WallMap). */
function inAxis(s, a) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const u0 = s.x0 * ca + s.z0 * sa, v0 = -s.x0 * sa + s.z0 * ca, u1 = s.x1 * ca + s.z1 * sa, v1 = -s.x1 * sa + s.z1 * ca;
  const o = Math.abs(v1 - v0) > Math.abs(u1 - u0) ? 1 : 0, half = Math.hypot(u1 - u0, v1 - v0) / 2;
  const m = o ? (v0 + v1) / 2 : (u0 + u1) / 2;
  return { o, c: o ? (u0 + u1) / 2 : (v0 + v1) / 2, t0: m - half, t1: m + half };
}

/** The floor-plan point at offset c and position t along a wall of orientation o, for axis a: [x, z]. */
function point(o, c, t, a) {
  const [u, v] = o ? [c, t] : [t, c], ca = Math.cos(a), sa = Math.sin(a);
  return [u * ca - v * sa, u * sa + v * ca];
}

/** A kept wall's segment for axis a. */
function ends(w, a) {
  const [x0, z0] = point(w.o, w.c, w.t0, a), [x1, z1] = point(w.o, w.c, w.t1, a);
  return { x0, z0, x1, z1 };
}

/** Whether kept walls a and b are one wall: same way, side by side, overlapping or nearly. */
function alike(a, b, { near, reach }) {
  return a.o === b.o && Math.abs(a.c - b.c) < near && b.t0 < a.t1 + reach && b.t1 > a.t0 - reach;
}

/** Folds w into kept wall s: offset and top as a weighted average, extent the union of both. */
function merge(s, w, cap) {
  const g = w.n / (s.n + w.n);
  s.c += (w.c - s.c) * g;
  s.top += (w.top - s.top) * g;
  s.t0 = Math.min(s.t0, w.t0);
  s.t1 = Math.max(s.t1, w.t1);
  s.n = Math.min(cap, s.n + w.n);
}

/** Share of a wall's length (every 10 cm) where the grid sees open floor on it and 10 cm to either side. */
function openFloor(w, a, isFree, step = 0.1) {
  const m = Math.max(1, Math.round((w.t1 - w.t0) / step));
  let open = 0;
  for (let i = 0; i <= m; i++) {
    const t = w.t0 + ((w.t1 - w.t0) * i) / m;
    if ([-step, 0, step].every((dc) => isFree(...point(w.o, w.c + dc, t, a)))) open++;
  }
  return open / (m + 1);
}

/** Whether segment b is just the far side of wall a (parallel, alongside it, and overlapping). */
function sameWall(a, b) {
  const ax = a.x1 - a.x0, az = a.z1 - a.z0, La = Math.hypot(ax, az);
  const bx = b.x1 - b.x0, bz = b.z1 - b.z0, Lb = Math.hypot(bx, bz);
  if (Math.abs(ax * bz - az * bx) / (La * Lb) > Math.sin((12 * Math.PI) / 180)) return false;
  const mx = (b.x0 + b.x1) / 2 - a.x0, mz = (b.z0 + b.z1) / 2 - a.z0;
  const off = Math.abs(mx * az - mz * ax) / La, t = (mx * ax + mz * az) / La;
  return off < 0.25 && t > -0.2 && t < La + 0.2;
}

/** Total-least-squares line through points: centre (mx, mz), direction (dx, dz), normal (nx, nz). */
function fitLine(ps) {
  let mx = 0, mz = 0;
  for (const p of ps) { mx += p.x; mz += p.z; }
  mx /= ps.length; mz /= ps.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of ps) { const a = p.x - mx, b = p.z - mz; sxx += a * a; sxz += a * b; szz += b * b; }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const dx = Math.cos(th), dz = Math.sin(th);
  return { mx, mz, dx, dz, nx: -dz, nz: dx };
}
