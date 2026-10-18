// How sure we are of where the camera is, for the halo drawn round it.
//
// Two parts. The frame's own fit (poseCovariance, from vo.js): how tightly the tracked points pin
// the camera to the map around it, from the information of the final pose solve and its pixel
// error. And drift (DriftTracker): the map being tracked against was itself built by odometry, so
// its errors add up as you walk, faster still while tracking is lost, and a loop closure takes most
// of them away again. combine() adds the two into a floor-plane covariance and a heading spread,
// and says whether that's good enough to trust. Map frame: x right, y down, z forward.
// Pure logic, no DOM.
import { mul3, tr3 } from './se3.js';

const DEG = Math.PI / 180;
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const UNC_DEFAULTS = {
  minSigma: 0.5, // px: the pixel noise (per image axis) is never taken as less than this (a near-perfect fit is luck)
  minPivot: 1e-8, // how little of a pose direction may be pinned beyond what the others explain
  weakRadius: 0.75, // m: a 2-sigma radius beyond this is 'weak' (about 19 m walked without a loop closure)…
  weakYaw: 6 * DEG, // …and so is a heading spread beyond this
  guessSd: 0.4, // m: tracking, but this frame's fit gave no spread (degenerate): assume this much
  guessYaw: [5 * DEG, 1 * DEG], // …and this heading spread, without / with the compass
  maxSd: 50, // m: outputs are clamped to this
};

/**
 * Inverse of a symmetric positive definite n×n matrix (row-major), or null when it's singular or
 * nearly so. It's scaled to a unit diagonal first: the turn and the position come in different
 * units, and this way the test asks how much of each is pinned beyond what the others explain.
 */
export function inverseSPD(A, n, minPivot = UNC_DEFAULTS.minPivot) {
  const d = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = A[i * n + i];
    if (!(v > 0) || !Number.isFinite(v)) return null;
    d[i] = 1 / Math.sqrt(v);
  }
  const L = new Float64Array(n * n), M = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = j; i < n; i++) {
      let s = A[i * n + j] * d[i] * d[j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(s > minPivot)) return null;
        L[j * n + j] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  for (let j = 0; j < n; j++) { // M = L⁻¹
    M[j * n + j] = 1 / L[j * n + j];
    for (let i = j + 1; i < n; i++) {
      let s = 0;
      for (let k = j; k < i; k++) s -= L[i * n + k] * M[k * n + j];
      M[i * n + j] = s / L[i * n + i];
    }
  }
  const out = new Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = i; k < n; k++) s += M[k * n + i] * M[k * n + j];
      out[i * n + j] = out[j * n + i] = s * d[i] * d[j];
    }
  }
  return out;
}

const conj = (R, S) => mul3(mul3(R, S), tr3(R)); // R·S·Rᵀ

/**
 * Spread of a pose fit (se3.refinePose's info and rmse; Rcw its world → camera rotation) as
 * { pos: camera position covariance (m², world frame), rot: rotation covariance (rad², world
 * frame) }, each 9 numbers row-major; null if the fit doesn't pin the pose down. n: the points
 * the rmse was taken over (0 if unknown).
 *
 * refinePose's rmse is of each point's whole (u, v) miss, so the noise on each image axis is
 * rmse/√2; and the fit itself soaked up 6 of the 2n numbers, so the misses left are smaller than
 * the noise by n − 3 to n (which matters at the 10 or so points tracking can get by on).
 *
 * refinePose moves T_cw by X_c ← exp(ω)·X_c + v. The camera centre C = −R_cwᵀ·t_cw then moves to
 * C − R_cwᵀ·exp(−ω)·v: to first order only v moves it (the turn is about the camera's own centre),
 * so ∂C/∂(ω, v) = [0 | −R_cwᵀ] and Σ_C = R_wc·Σ_vv·R_wcᵀ. Σ_vv is the v block of the whole inverse,
 * so the turn's own uncertainty (a sideways step looks like a turn) is in it. The camera → world
 * rotation becomes R_wc·exp(−ω) = exp(−R_wc·ω)·R_wc, so the world-frame turn is −R_wc·ω.
 */
export function poseCovariance(info, rmse, Rcw, { n = 0, minSigma = UNC_DEFAULTS.minSigma, minPivot = UNC_DEFAULTS.minPivot } = {}) {
  if (!info || !Number.isFinite(rmse)) return null;
  const inv = inverseSPD(info, 6, minPivot);
  if (!inv) return null;
  const s2 = Math.max((rmse * rmse) / 2 * (n > 3 ? n / (n - 3) : 1), minSigma * minSigma);
  const block = (o) => [0, 1, 2].flatMap((a) => [0, 1, 2].map((b) => s2 * inv[(o + a) * 6 + o + b]));
  const Rwc = tr3(Rcw);
  const pos = conj(Rwc, block(3)), rot = conj(Rwc, block(0));
  if (![...pos, ...rot].every(Number.isFinite)) return null;
  return { pos, rot };
}

/**
 * The floor-plane part of a frame's uncertainty (vo result's `uncertainty`), in the map frame:
 * alignR = odometry world → map rotation (world.align.R). Returns { cxx, cxz, czz } (m², x/z block
 * of the position covariance) and yawVar (rad², turn about the map's vertical), or null.
 */
export function floorCovariance(uncertainty, alignR = null) {
  if (!uncertainty) return null;
  const A = alignR ?? I3;
  const P = conj(A, uncertainty.pos), Q = conj(A, uncertainty.rot);
  return { cxx: P[0], cxz: P[2], czz: P[8], yawVar: Q[4] };
}

export const DRIFT_DEFAULTS = {
  // Odometry's errors are mostly systematic (the depth scale, a slightly wrong field of view), so
  // they add up along the walk rather than averaging out: the spread grows in proportion to how
  // far you've walked since the last anchor (the start or a loop closure).
  posPerM: 0.02, // position sd: 2% of the distance walked
  yawPerM: [1.5 * DEG, 0.3 * DEG], // heading sd per metre walked, without / with the compass
  yawPerTurn: [0.02, 0.005], // …and per radian turned (a wrong field of view scales every turn)
  // Lost: the pose stands still while you don't, so the spread grows with time instead.
  lostPosPerS: 0.3, // m/s
  lostYawPerS: [8 * DEG, 1 * DEG], // without / with the compass (which keeps turning with you)
  loopKeep: 0.3, // a loop closure leaves this much of the drift
  maxStep: 2, // m per frame: more is a jump (a correction), not walking
  maxDt: 2, // s per frame
};

/** How far the odometry may have drifted, as a position sd (m) and a heading sd (rad). */
export class DriftTracker {
  constructor(opts = {}) {
    this.o = { ...DRIFT_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.posSd = 0;
    this.yawSd = 0;
  }

  /** One frame: dt s since the last, moved m and turned rad since it (map frame). */
  step({ dt = 0, moved = 0, turned = 0, status = 'ok', compassOk = false } = {}) {
    const o = this.o, c = compassOk ? 1 : 0;
    const clamp = (v, hi) => (Number.isFinite(v) ? Math.min(hi, Math.abs(v)) : 0);
    dt = clamp(dt, o.maxDt);
    if (status === 'lost' || status === 'reloc') {
      this.posSd += o.lostPosPerS * dt;
      this.yawSd += o.lostYawPerS[c] * dt;
    } else if (status === 'ok') {
      const m = clamp(moved, o.maxStep), a = clamp(turned, Math.PI);
      this.posSd += o.posPerM * m;
      this.yawSd += o.yawPerM[c] * m + o.yawPerTurn[c] * a;
    }
    this.posSd = Math.min(this.posSd, UNC_DEFAULTS.maxSd);
    this.yawSd = Math.min(this.yawSd, Math.PI);
  }

  /** A loop closure just corrected the map: most of the drift is gone. */
  loopClosed() {
    this.posSd *= this.o.loopKeep;
    this.yawSd *= this.o.loopKeep;
  }
}

/**
 * This frame's spread (floorCovariance, or null) plus the drift, in the map frame:
 * { cxx, cxz, czz (m²), yawSd (rad), level: 'good' | 'weak' | 'lost' }.
 */
export function combine(floorCov, drift, { status = 'ok', compassOk = false } = {}, opts = {}) {
  const o = { ...UNC_DEFAULTS, ...opts };
  let f = floorCov;
  // Tracking, yet no spread from this frame (its fit was degenerate): don't call that sure.
  if (!f && status === 'ok') f = { cxx: o.guessSd ** 2, cxz: 0, czz: o.guessSd ** 2, yawVar: o.guessYaw[compassOk ? 1 : 0] ** 2 };
  const p2 = (drift?.posSd ?? 0) ** 2, y2 = (drift?.yawSd ?? 0) ** 2, max2 = o.maxSd ** 2;
  const sane = (v) => (Number.isFinite(v) ? Math.min(max2, Math.max(0, v)) : max2);
  const cxx = sane((f?.cxx ?? 0) + p2), czz = sane((f?.czz ?? 0) + p2);
  const lim = Math.sqrt(cxx * czz), cxz = Number.isFinite(f?.cxz) ? Math.max(-lim, Math.min(lim, f.cxz)) : 0;
  const yv = (f?.yawVar ?? 0) + y2;
  const yawSd = Number.isFinite(yv) ? Math.min(Math.PI, Math.sqrt(Math.max(0, yv))) : Math.PI;
  // The ellipse's long axis.
  const big = (cxx + czz) / 2 + Math.hypot((cxx - czz) / 2, cxz);
  const level = status === 'lost' || status === 'reloc' ? 'lost'
    : 2 * Math.sqrt(big) > o.weakRadius || yawSd > o.weakYaw ? 'weak' : 'good';
  return { cxx, cxz, czz, yawSd, level };
}
