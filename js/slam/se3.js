// Rigid-body math for tracking: 3×3 rotations as row-major arrays, the exponential map, poses
// { R, t } meaning X_dst = R·X_src + t, and a robust Gauss-Newton refinement of a camera pose
// from 3D map points and where they appear in the image (PnP). Pure functions, no DOM.

export const identity = () => ({ R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });

export function mul3(A, B) {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  }
  return C;
}

export const mulv = (A, v) => [
  A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
  A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
  A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
];

export const tr3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];

/** Rotation for axis-angle vector w (radians). */
export function expSO3(w) {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const s = Math.sin(th), c = 1 - Math.cos(th);
  return [
    1 + c * (-y * y - z * z), -s * z + c * x * y, s * y + c * x * z,
    s * z + c * x * y, 1 + c * (-x * x - z * z), -s * x + c * y * z,
    -s * y + c * x * z, s * x + c * y * z, 1 + c * (-x * x - y * y),
  ];
}

/** Axis-angle vector of rotation R (inverse of expSO3). */
export function logSO3(R) {
  const th = angleOf(R);
  const v = [R[7] - R[5], R[2] - R[6], R[3] - R[1]];
  const k = th < 1e-6 ? 0.5 : th / (2 * Math.sin(th));
  return [k * v[0], k * v[1], k * v[2]];
}

/** Rotation angle of R in radians. */
export function angleOf(R) {
  return Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)));
}

export function rotY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function rotX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Re-orthonormalises a rotation that has picked up rounding error. */
export function orthonormalize(R) {
  const n = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  const r0 = n([R[0], R[1], R[2]]);
  let r1 = [R[3], R[4], R[5]];
  const d = r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2];
  r1 = n([r1[0] - d * r0[0], r1[1] - d * r0[1], r1[2] - d * r0[2]]);
  const r2 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]];
  return [...r0, ...r1, ...r2];
}

/** a∘b: first b, then a. */
export function compose(a, b) {
  const t = mulv(a.R, b.t);
  return { R: mul3(a.R, b.R), t: [t[0] + a.t[0], t[1] + a.t[1], t[2] + a.t[2]] };
}

export function invert(p) {
  const Rt = tr3(p.R);
  const t = mulv(Rt, p.t);
  return { R: Rt, t: [-t[0], -t[1], -t[2]] };
}

export function apply(p, X) {
  const v = mulv(p.R, X);
  return [v[0] + p.t[0], v[1] + p.t[1], v[2] + p.t[2]];
}

/** Solves the n×n system A·x = b in place (Gaussian elimination with partial pivoting). */
export function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[p * n + c])) p = r;
    if (Math.abs(A[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [A[c * n + k], A[p * n + k]] = [A[p * n + k], A[c * n + k]];
      [b[c], b[p]] = [b[p], b[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    x[r] = s / A[r * n + r];
  }
  return x;
}

/**
 * Refines T_cw (world → camera) so the world points X (flat xyz array) project onto their image
 * positions uv (flat array), with Huber weighting so a few bad tracks can't drag it away.
 * intr: { f, cx, cy }. Returns { pose, err (per-point reprojection error, px), rmse }.
 */
export function refinePose(pose, X, uv, intr, { iters = 12, huber = 1.5 } = {}) {
  const n = uv.length / 2;
  const { f, cx, cy } = intr;
  let R = pose.R.slice(), t = pose.t.slice();
  const err = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    const H = new Array(36).fill(0), g = new Array(6).fill(0);
    let used = 0;
    for (let i = 0; i < n; i++) {
      const Xw = X[i * 3], Yw = X[i * 3 + 1], Zw = X[i * 3 + 2];
      const x = R[0] * Xw + R[1] * Yw + R[2] * Zw + t[0];
      const y = R[3] * Xw + R[4] * Yw + R[5] * Zw + t[1];
      const z = R[6] * Xw + R[7] * Yw + R[8] * Zw + t[2];
      if (z < 0.05) { err[i] = Infinity; continue; }
      const iz = 1 / z;
      const ru = f * x * iz + cx - uv[i * 2], rv = f * y * iz + cy - uv[i * 2 + 1];
      const e = Math.hypot(ru, rv);
      err[i] = e;
      const w = e <= huber ? 1 : huber / e;
      // d(u, v)/d(ω, v) for the left-multiplied update X_c ← exp(ω)·X_c + v,
      // i.e. (∂π/∂X_c)·[−[X_c]× | I].
      const iz2 = iz * iz;
      const Ju = [-f * x * y * iz2, f + f * x * x * iz2, -f * y * iz, f * iz, 0, -f * x * iz2];
      const Jv = [-(f + f * y * y * iz2), f * x * y * iz2, f * x * iz, 0, f * iz, -f * y * iz2];
      for (let a = 0; a < 6; a++) {
        g[a] += w * (Ju[a] * ru + Jv[a] * rv);
        for (let b = a; b < 6; b++) H[a * 6 + b] += w * (Ju[a] * Ju[b] + Jv[a] * Jv[b]);
      }
      used++;
    }
    if (used < 6) break;
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H[a * 6 + b] = H[b * 6 + a];
    const d = solve(H, g.map((v) => -v), 6);
    if (!d) break;
    const dR = expSO3([d[0], d[1], d[2]]);
    R = mul3(dR, R);
    const nt = mulv(dR, t);
    t = [nt[0] + d[3], nt[1] + d[4], nt[2] + d[5]];
    if (Math.hypot(d[0], d[1], d[2]) < 1e-7 && Math.hypot(d[3], d[4], d[5]) < 1e-6) break;
  }
  // Final residuals at the refined pose.
  let s = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const Xw = X[i * 3], Yw = X[i * 3 + 1], Zw = X[i * 3 + 2];
    const x = R[0] * Xw + R[1] * Yw + R[2] * Zw + t[0];
    const y = R[3] * Xw + R[4] * Yw + R[5] * Zw + t[1];
    const z = R[6] * Xw + R[7] * Yw + R[8] * Zw + t[2];
    err[i] = z < 0.05 ? Infinity : Math.hypot(f * x / z + cx - uv[i * 2], f * y / z + cy - uv[i * 2 + 1]);
    if (err[i] < 3) { s += err[i] * err[i]; m++; }
  }
  return { pose: { R: orthonormalize(R), t }, err, rmse: m ? Math.sqrt(s / m) : Infinity };
}
