// Stereo rig geometry: camera models, pixel rays, triangulation, directions and the
// tape-measure calibration fit. Pure math with no DOM access, so it runs in the browser
// and under `node --test`.
//
// Rig frame: origin halfway between the two cameras, x → right, y → down, z → forward,
// in metres. The left camera sits at x = -B/2, the right one at x = +B/2.
// Pixel coordinates are processing-image pixels with the principal point at the centre.

export const DEG = Math.PI / 180;

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const dist3 = (a, b) => norm(sub(a, b));

export function focalFromFov(width, hfovDeg) {
  return width / 2 / Math.tan((hfovDeg * DEG) / 2);
}

export function fovFromFocal(width, f) {
  return (2 * Math.atan(width / 2 / f)) / DEG;
}

/**
 * Splits the angle between the two optical axes into a yaw per camera (radians,
 * positive = turned right). Positive angleDeg means toed in (turned toward each other).
 */
export function cameraYaws(angleDeg, split = 'even') {
  const a = angleDeg * DEG;
  if (split === 'left-straight') return [0, -a];
  if (split === 'right-straight') return [a, 0];
  return [a / 2, -a / 2];
}

export function makeCamera(x, yaw, w, h, hfovDeg) {
  return {
    pos: [x, 0, 0], yaw, cos: Math.cos(yaw), sin: Math.sin(yaw),
    f: focalFromFov(w, hfovDeg), cx: w / 2, cy: h / 2, w, h,
  };
}

/** params: { baselineCm, angleDeg, hfovDeg, angleSplit }; sizes in processing pixels. */
export function buildRig(params, sizeL, sizeR = sizeL) {
  const B = params.baselineCm / 100;
  const [yawL, yawR] = cameraYaws(params.angleDeg, params.angleSplit);
  return {
    baseline: B,
    left: makeCamera(-B / 2, yawL, sizeL.w, sizeL.h, params.hfovDeg),
    right: makeCamera(B / 2, yawR, sizeR.w, sizeR.h, params.hfovDeg),
  };
}

/** Unit ray in the rig frame through pixel (u, v) of a camera. */
export function pixelRay(cam, u, v) {
  const x = (u - cam.cx) / cam.f, y = (v - cam.cy) / cam.f;
  const d = [cam.cos * x + cam.sin, y, cam.cos - cam.sin * x];
  const n = norm(d);
  return { o: cam.pos, d: [d[0] / n, d[1] / n, d[2] / n] };
}

/** Projects a rig-frame point into a camera; null if it is behind the camera. */
export function project(cam, X) {
  const px = X[0] - cam.pos[0], py = X[1] - cam.pos[1], pz = X[2] - cam.pos[2];
  const xc = cam.cos * px - cam.sin * pz, zc = cam.sin * px + cam.cos * pz;
  if (zc <= 1e-6) return null;
  return { u: cam.cx + (cam.f * xc) / zc, v: cam.cy + (cam.f * py) / zc, z: zc };
}

export const pointAlong = (ray, s) => add(ray.o, scale(ray.d, s));

/**
 * Midpoint of the shortest segment between two rays. `gap` is that segment's length;
 * `valid` means the point is in front of both cameras.
 */
export function triangulate(a, b) {
  const w0 = sub(a.o, b.o);
  const B = dot(a.d, b.d), D = dot(a.d, w0), E = dot(b.d, w0);
  const den = 1 - B * B;
  if (den < 1e-12) return null;
  const s = (B * E - D) / den, t = (E - B * D) / den;
  const pa = pointAlong(a, s), pb = pointAlong(b, t);
  return { point: scale(add(pa, pb), 0.5), gap: dist3(pa, pb), s, t, valid: s > 0 && t > 0 };
}

/** Rotates a rig-frame point into a level frame when the rig is tilted down by tiltDeg. */
export function levelPoint(p, tiltDeg = 0) {
  if (!tiltDeg) return p;
  const c = Math.cos(tiltDeg * DEG), s = Math.sin(tiltDeg * DEG);
  return [p[0], c * p[1] + s * p[2], c * p[2] - s * p[1]];
}

/** Azimuth (deg, + = right), elevation (deg, + = up) and floor-plan position of a point or direction. */
export function bearing(p, tiltDeg = 0) {
  const q = levelPoint(p, tiltDeg);
  const horizontal = Math.hypot(q[0], q[2]);
  return {
    azimuth: Math.atan2(q[0], q[2]) / DEG,
    elevation: Math.atan2(-q[1], horizontal) / DEG,
    horizontal,
    ground: { x: q[0], z: q[2] },
  };
}

export function clockHour(azimuthDeg) {
  const h = ((Math.round(azimuthDeg / 30) % 12) + 12) % 12;
  return h === 0 ? 12 : h;
}

export const clockLabel = (azimuthDeg) => `${clockHour(azimuthDeg)} o'clock`;

export function sideLabel(azimuthDeg) {
  const a = Math.abs(azimuthDeg);
  if (a < 2) return 'straight ahead';
  return `${a.toFixed(0)}° ${azimuthDeg < 0 ? 'left' : 'right'}`;
}

/** Rough 1-sigma depth error (m) for a given pixel error in the match. */
export function depthUncertainty(range, rig, pxError = 0.7) {
  if (!(rig.baseline > 0)) return Infinity;
  return (range * range * pxError) / (rig.left.f * rig.baseline);
}

// ---------------------------------------------------------------------------------------
// Tape-measure calibration. Each sample is a point clicked in both images plus the distance
// measured by hand from the middle of the bar:
//   { uL, vL, uR, vR, sizeL: {w,h}, sizeR: {w,h}, trueRange }
// The baseline is trusted (it's easy to measure with a ruler); the angle between the
// cameras and the field of view are what get solved for.

/**
 * Distance one sample reads under the given rig numbers, or null if the rays diverge.
 * sample.horizontal = measure along the floor (level distance) instead of in a straight line.
 */
export function readDistance(sample, params) {
  const rig = buildRig(params, sample.sizeL, sample.sizeR);
  const tr = triangulate(pixelRay(rig.left, sample.uL, sample.vL), pixelRay(rig.right, sample.uR, sample.vR));
  if (!tr || !tr.valid) return null;
  return sample.horizontal ? bearing(tr.point, params.tiltDeg ?? 0).horizontal : norm(tr.point);
}

/** Range (m) one sample reads under the given FOV and angle, or null if the rays diverge. */
export function sampleRange(sample, params, hfovDeg = params.hfovDeg, angleDeg = params.angleDeg) {
  return readDistance(sample, { ...params, hfovDeg, angleDeg });
}

function calibrationCost(samples, params) {
  let e = 0, w = 0;
  for (const s of samples) {
    const r = readDistance(s, params);
    const wt = s.weight ?? 1;
    e += wt * (r ? Math.log(r / s.trueRange) ** 2 : 4);
    w += wt;
  }
  return e / w;
}

/** Two samples at clearly different distances pin down both FOV and angle; otherwise only the angle. */
export function canSolveFov(samples) {
  if (samples.length < 2) return false;
  const d = samples.map((s) => s.trueRange);
  return Math.max(...d) / Math.min(...d) >= 1.4;
}

function nelderMead(f, x0, steps, iters = 400) {
  const n = x0.length;
  let pts = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += steps[i];
    pts.push(x);
  }
  let vals = pts.map(f);
  const mix = (a, b, t) => a.map((ai, i) => ai + (b[i] - ai) * t);
  for (let k = 0; k < iters; k++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    pts = order.map((i) => pts[i]);
    vals = order.map((i) => vals[i]);
    if (Math.abs(vals[n] - vals[0]) < 1e-14) break;
    const c = pts.slice(0, n).reduce((acc, p) => acc.map((a, i) => a + p[i] / n), new Array(n).fill(0));
    const worst = pts[n];
    const xr = mix(c, worst, -1), fr = f(xr);
    if (fr < vals[0]) {
      const xe = mix(c, worst, -2), fe = f(xe);
      [pts[n], vals[n]] = fe < fr ? [xe, fe] : [xr, fr];
    } else if (fr < vals[n - 1]) {
      [pts[n], vals[n]] = [xr, fr];
    } else {
      const xc = mix(c, worst, 0.5), fc = f(xc);
      if (fc < vals[n]) [pts[n], vals[n]] = [xc, fc];
      else for (let i = 1; i <= n; i++) { pts[i] = mix(pts[0], pts[i], 0.5); vals[i] = f(pts[i]); }
    }
  }
  const best = vals.indexOf(Math.min(...vals));
  return { x: pts[best], value: vals[best] };
}

// Search ranges and grid steps for each rig number the fit can solve for.
const FIT_GRID = { angleDeg: [-30, 30, 0.1], baselineCm: [2, 60, 0.5], hfovDeg: [30, 130, 1] };

/**
 * Finds the rig numbers listed in `solve` (any of 'angleDeg', 'baselineCm', 'hfovDeg') that make
 * the samples read their true distances; everything else stays as in `params`.
 * Returns { values, solved, params (the full fitted set), rmsPct }.
 */
export function fitRig(samples, params, solve) {
  if (!samples.length || !solve.length) return null;
  const withValues = (x) => {
    const p = { ...params };
    solve.forEach((k, i) => { p[k] = x[i]; });
    return p;
  };
  const cost = (x) => {
    const p = withValues(x);
    return p.baselineCm < 0.5 || p.hfovDeg < 10 || p.hfovDeg > 170 ? 1e9 : calibrationCost(samples, p);
  };
  // A coarse grid first (coarser for two unknowns) so the polish starts in the right valley.
  const coarse = solve.length > 1 ? 4 : 1;
  const axes = solve.map((k) => {
    const [lo, hi, step] = FIT_GRID[k];
    const vals = [];
    for (let v = lo; v <= hi + 1e-9; v += step * coarse) vals.push(v);
    return vals;
  });
  const start = solve.map((k) => params[k]);
  let best = { x: start, c: cost(start) };
  const walk = (i, acc) => {
    if (i === axes.length) {
      const c = cost(acc);
      if (c < best.c) best = { x: [...acc], c };
      return;
    }
    for (const v of axes[i]) {
      acc[i] = v;
      walk(i + 1, acc);
    }
  };
  walk(0, []);
  const polished = nelderMead(cost, best.x, solve.map((k) => FIT_GRID[k][2] * coarse * 0.8));
  if (polished.value <= best.c) best = { x: polished.x, c: polished.value };
  return {
    values: Object.fromEntries(solve.map((k, i) => [k, best.x[i]])),
    solved: solve,
    params: withValues(best.x),
    rmsPct: (Math.exp(Math.sqrt(best.c)) - 1) * 100,
  };
}

/**
 * Solves for the angle between the cameras (and the FOV when the samples allow it) so that
 * the measured samples read their tape-measured distances.
 */
export function fitCalibration(samples, params, { solveFov = canSolveFov(samples) } = {}) {
  const fit = fitRig(samples, params, solveFov ? ['hfovDeg', 'angleDeg'] : ['angleDeg']);
  if (!fit) return null;
  return {
    hfovDeg: fit.params.hfovDeg,
    angleDeg: fit.params.angleDeg,
    solvedFov: solveFov,
    rmsPct: fit.rmsPct,
    residuals: samples.map((s) => ({ trueRange: s.trueRange, before: readDistance(s, params), after: readDistance(s, fit.params) })),
  };
}
