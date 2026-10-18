// Walls from the 3D model: flat vertical surfaces in the point cloud, found as straight lines on
// the floor plan (every wall is a tall stack of points standing over a line), each with a height.
// Things already recognised as objects are left out, so a fridge or the back of a couch doesn't
// become a wall. Pure logic, no DOM.

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
