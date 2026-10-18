// Plain math for the 3D view, kept free of three.js so node can test it. Positions are in
// three's frame (x right, y up, z = −map z) unless they say map; walls are packed as
// [ax, az, bx, bz, top, …] per wall, in three's frame.

/** Camera → map rotation (row-major) for a level camera facing `heading` (+ = right). */
export function headingR(h = 0) {
  const c = Math.cos(h), s = Math.sin(h);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/**
 * The 1-sigma ellipse of a map floor-plane covariance: semi-axes a ≥ b (m) and th, the long
 * axis's angle from map +x toward map +z. (A floor mesh turned by rotation.y = th puts its local
 * x there in three's frame, since three's z is minus the map's.)
 */
export function ellipse(cxx, cxz, czz) {
  const m = (cxx + czz) / 2, r = Math.hypot((cxx - czz) / 2, cxz);
  return { a: Math.sqrt(Math.max(0, m + r)), b: Math.sqrt(Math.max(0, m - r)), th: 0.5 * Math.atan2(2 * cxz, cxx - czz) };
}

/**
 * First thing a ray from o along unit d meets within max: the floor (y = 0) or one of n walls,
 * below its top and below clipH. Walls are drawn `half` thick either side, so a wall hit stops at
 * its face. Writes { len, hit: 0 none / 1 floor / 2 wall, nx, nz (the face's normal, toward o) }
 * into out. (Plain arguments, so calling it every frame allocates nothing.)
 */
export function rayHit(o, d, walls, n, clipH = Infinity, out = {}, max = 6, half = 0.05) {
  let best = max, hit = 0, nx = 0, nz = 0;
  if (d.y < -0.01 && o.y > 0) { const s = -o.y / d.y; if (s < best) { best = s; hit = 1; } }
  for (let i = 0; i < n; i++) {
    const ax = walls[i * 5], az = walls[i * 5 + 1], ex = walls[i * 5 + 2] - ax, ez = walls[i * 5 + 3] - az;
    const den = d.x * ez - d.z * ex;
    if (Math.abs(den) < 1e-9) continue;
    const wx = ax - o.x, wz = az - o.z;
    const s = (wx * ez - wz * ex) / den, u = (wx * d.z - wz * d.x) / den;
    if (s <= 0.02 || s >= best || u < 0 || u > 1) continue;
    const y = o.y + s * d.y;
    if (y < 0 || y > Math.min(walls[i * 5 + 4], clipH)) continue;
    const L = Math.hypot(ex, ez);
    best = s; hit = 2; nx = -ez / L; nz = ex / L;
  }
  let len = best;
  if (hit === 2) {
    if (nx * d.x + nz * d.z > 0) { nx = -nx; nz = -nz; }
    len = Math.max(0.02, best - half / Math.max(0.15, -(nx * d.x + nz * d.z)));
  }
  out.len = len; out.hit = hit; out.nx = nx; out.nz = nz;
  return out;
}

/**
 * Does wall i stand between a view at c and your spot on the floor at (ux, uz)? The sight line
 * must cross the wall (padded by its thickness t) below the wall's top and below clipH.
 */
export function blocksView(c, ux, uz, walls, i, clipH = Infinity, t = 0.1) {
  const ax = walls[i * 5], az = walls[i * 5 + 1], ex = walls[i * 5 + 2] - ax, ez = walls[i * 5 + 3] - az;
  const dx = ux - c.x, dz = uz - c.z, den = dx * ez - dz * ex;
  if (Math.abs(den) <= 1e-9) return false;
  const wx = ax - c.x, wz = az - c.z;
  const s = (wx * ez - wz * ex) / den, w = (wx * dz - wz * dx) / den;
  const pad = t / Math.max(0.1, Math.hypot(ex, ez));
  return s > 0 && s < 1 && w > -pad && w < 1 + pad && c.y * (1 - s) < Math.min(walls[i * 5 + 4], clipH) + 0.05;
}

/** In-place separable box blur of radius r (a → tmp → a), edges clamped. */
export function boxBlur(a, tmp, w, h, r) {
  const n = 2 * r + 1;
  for (let j = 0; j < h; j++) {
    const row = j * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += a[row + Math.min(w - 1, Math.max(0, i))];
    for (let i = 0; i < w; i++) {
      tmp[row + i] = s / n;
      s += a[row + Math.min(w - 1, i + r + 1)] - a[row + Math.max(0, i - r)];
    }
  }
  for (let i = 0; i < w; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += tmp[Math.min(h - 1, Math.max(0, j)) * w + i];
    for (let j = 0; j < h; j++) {
      a[j * w + i] = s / n;
      s += tmp[Math.min(h - 1, j + r + 1) * w + i] - tmp[Math.max(0, j - r) * w + i];
    }
  }
}
