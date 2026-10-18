// Visual compass: how far the camera has turned since it was switched on, from how the whole
// picture shifts, not from a handful of tracked points. Every frame, the motion that best warps a
// reference image onto the new one is found by direct image alignment over a thousand or so of
// the most textured pixels (small images first, then larger), with brightness allowed to drift and
// outliers (people walking past) weighted down.
//
// Walking also shifts the picture (near things more than far ones), which would look like turning.
// So the reference is normally the latest keyframe, whose depth is known, and how far you've walked
// since comes from the tracked points (vo.js): each pixel's shift from walking is then known, and
// what's left is the turn. Before the first keyframe, or when the keyframe no longer matches, the
// reference is a recent frame (renewed every few frames, so the walk between them stays small).
//
// Heading 0° is the way the camera faced when it started. Pure logic, no DOM.
import { angleOf, expSO3, identity, mul3, mulv, orthonormalize, solve, tr3 } from './se3.js';
import { buildPyramid } from './klt.js';

export const COMPASS_DEFAULTS = {
  levels: [3, 2, 1], // pyramid levels to align on, coarse first (level 3 is made here)
  maxPts: 1200, minGrad: 4, // pixels used per level: the most textured, up to this many
  huber: 10, // intensity difference (0–255) beyond which a pixel counts less
  iters: 10, minInliers: 0.55,
  refFrames: 3, refAngleDeg: 8, // a reference without depth is renewed this often
  kfAngleDeg: 25, // a keyframe reference is dropped after this much turning
  keepDistance: 0.8, // m: …or walking
};

const I3 = () => identity().R;

export class VisualCompass {
  constructor(intr, opts = {}) {
    this.intr = intr;
    this.o = { ...COMPASS_DEFAULTS, ...opts };
    this.reset();
  }

  /** Start again: R = camera → world rotation now (identity = heading 0°). */
  reset(R = I3()) {
    this.R = R.slice();
    this.ref = null; // { levels, R: reference camera → world, c: its position (or null), depth, age }
    this.M = I3(); // reference camera → current camera
    this.stepR = I3(); // last frame's turn, to predict the next
    this.prevPyr = null;
    this.last = null;
    this.ok = false;
    this.quality = 0;
  }

  /**
   * New frame (an image pyramid from klt.buildPyramid). c: where the camera is now, as far as the
   * tracked points can tell (world frame), or null. Returns the reading.
   */
  update(pyr, c = null) {
    pyr = this.withCoarse(pyr);
    if (!this.ref) {
      this.ref = this.makeRef(pyr, null, 0, this.R, null);
      this.prevPyr = pyr;
      this.ok = true;
      return this.reading();
    }
    const M0 = this.M;
    let fit = this.alignAll(this.ref, pyr, mul3(this.stepR, M0), c);
    if (!fit.ok && this.ref.age > 0) {
      // The reference doesn't match any more: fall back to the last frame.
      const prev = this.makeRef(this.prevPyr, null, 0, this.R, null);
      const f2 = this.alignAll(prev, pyr, this.stepR, null);
      if (f2.ok) {
        this.ref = prev;
        this.M = I3();
        fit = f2;
      }
    }
    this.ok = fit.ok;
    this.quality = fit.inliers;
    const M = fit.ok ? fit.M : mul3(this.stepR, this.M); // nothing to go on (a blank wall): keep turning as it was
    this.stepR = fit.ok ? mul3(M, tr3(this.M)) : I3();
    this.M = M;
    this.R = orthonormalize(mul3(this.ref.R, tr3(M)));
    this.ref.age++;
    this.last = { pyr, M0, ref: this.ref };
    const turned = angleOf(M) * 180 / Math.PI;
    if (!fit.ok || (this.ref.depth ? turned > this.o.kfAngleDeg : this.ref.age >= this.o.refFrames || turned > this.o.refAngleDeg)) {
      this.ref = this.makeRef(pyr, null, 0, this.R, null);
      this.M = I3();
    }
    this.prevPyr = pyr;
    return this.reading();
  }

  /**
   * The compass's evidence about the whole pose of the last frame, for solving it together with
   * the tracked points (se3.refinePose's `extra`): R, t = world → camera. Pixels with known depth
   * say something about where the camera is too; the rest only about which way it faces. Scaled
   * so that, for the turn, it counts as much as `points` tracked points would.
   */
  poseTerms(R, t, points, f0) {
    if (!this.last || this.last.ref !== this.ref || !this.ok) return null;
    const L = this.o.levels[this.o.levels.length - 1];
    const ref = this.ref.levels[L], P = this.last.pyr[L];
    if (!ref || !P) return null;
    const { pts, f, cx, cy } = ref, { w, h, data, gx, gy } = P, n = pts.length / 4, hub = this.o.huber;
    // Reference pixel k is at world point (Rwr·ray + ρ·c_ref)/ρ; here, scaled by ρ: p = R·q + ρ·t.
    const Rwr = this.ref.R, c = this.ref.c ?? [0, 0, 0];
    const M = mul3(R, Rwr), Rc = mulv(R, c);
    const at = [];
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    for (let k = 0; k < n; k++) {
      const dx = pts[4 * k], dy = pts[4 * k + 1], I0 = pts[4 * k + 2], rho = this.ref.depth ? pts[4 * k + 3] : 0;
      const x = M[0] * dx + M[1] * dy + M[2] + rho * (Rc[0] + t[0]);
      const y = M[3] * dx + M[4] * dy + M[5] + rho * (Rc[1] + t[1]);
      const z = M[6] * dx + M[7] * dy + M[8] + rho * (Rc[2] + t[2]);
      if (z < 0.2) continue;
      const u = (f * x) / z + cx, v = (f * y) / z + cy;
      if (u < 1 || v < 1 || u > w - 2 || v > h - 2) continue;
      const I = sample(data, w, u, v);
      at.push(x, y, z, rho, I0, I, sample(gx, w, u, v), sample(gy, w, u, v));
      s0++; s1 += I0; s2 += I; s3 += I0 * I0; s4 += I0 * I;
    }
    if (s0 < 80) return null;
    // Brightness drift between the images: I ≈ gain·I0 + offset (least squares).
    const den = s0 * s3 - s1 * s1;
    const gain = den > 1e-6 ? (s0 * s4 - s1 * s2) / den : 1, off = (s2 - gain * s1) / s0;
    const H = new Float64Array(36), g = new Float64Array(6), J = new Float64Array(6);
    for (let k = 0; k < at.length; k += 8) {
      const x = at[k], y = at[k + 1], z = at[k + 2], rho = at[k + 3], I0 = at[k + 4], I = at[k + 5], Ix = at[k + 6], Iy = at[k + 7];
      const r = I - gain * I0 - off, e = Math.abs(r), wt = e <= hub ? 1 : hub / e;
      const iz = 1 / z, iz2 = iz * iz;
      J[0] = Ix * (-f * x * y * iz2) + Iy * -(f + f * y * y * iz2);
      J[1] = Ix * (f + f * x * x * iz2) + Iy * (f * x * y * iz2);
      J[2] = Ix * (-f * y * iz) + Iy * (f * x * iz);
      J[3] = rho * Ix * f * iz;
      J[4] = rho * Iy * f * iz;
      J[5] = -rho * (Ix * x + Iy * y) * f * iz2;
      for (let a = 0; a < 6; a++) {
        g[a] += wt * J[a] * r;
        for (let b = a; b < 6; b++) H[a * 6 + b] += wt * J[a] * J[b];
      }
    }
    const trace = H[0] + H[7] + H[14];
    if (!(trace > 0)) return null;
    const k = (points * 2 * f0 * f0) / trace;
    return { H: Array.from(H, (v) => v * k), g: Array.from(g, (v) => v * k) };
  }

  /** The pose was settled (with the points): the compass carries on from its rotation (camera → world). */
  adopt(Rwc) {
    this.R = orthonormalize(Rwc);
    if (this.ref) {
      const M = mul3(tr3(this.R), this.ref.R);
      if (this.last?.ref === this.ref) this.stepR = mul3(M, tr3(this.last.M0));
      this.M = M;
    }
  }

  /** Adds a coarser level (for big turns between frames) to a 3-level pyramid. */
  withCoarse(pyr) {
    if (pyr[3] || !pyr[2] || pyr[2].w < 40) return pyr;
    return [...pyr, buildPyramid(pyr[2].data, pyr[2].w, pyr[2].h, 2)[1]];
  }

  /**
   * A keyframe (this frame, just after update): its depth lets the next frames separate walking
   * from turning. disp: disparity per level-0 pixel (≤ 0 = unknown), fB: focal × baseline, so
   * inverse depth = disp / fB. R: the keyframe camera's rotation (camera → world).
   */
  setKeyframe(pyr, disp, fB, pose) {
    // Keep the reference we have while it still matches well: each new reference adds a little
    // error, so fewer of them means less drift.
    const r = this.ref;
    if (r?.depth && r.c && this.ok && this.quality > 0.9 && angleOf(this.M) < (0.6 * this.o.kfAngleDeg * Math.PI) / 180
      && Math.hypot(pose.t[0] - r.c[0], pose.t[1] - r.c[1], pose.t[2] - r.c[2]) < this.o.keepDistance) return;
    pyr = this.withCoarse(pyr);
    this.R = orthonormalize(pose.R);
    this.ref = this.makeRef(pyr, disp, fB, this.R, pose.t.slice());
    this.M = I3();
    this.prevPyr = pyr;
  }

  /** The rotation was found some other way (tracked points, a loop closure): carry on from it. */
  resync(R) {
    this.R = orthonormalize(R);
    if (this.ref) this.ref.R = orthonormalize(mul3(this.R, this.M));
  }

  /** { R, heading (°, turning right is +), pitch (°, up is +), roll (°), ok, quality } */
  reading() {
    const R = this.R;
    const fwd = [R[2], R[5], R[8]], right = [R[0], R[3], R[6]];
    return {
      R: R.slice(), ok: this.ok, quality: this.quality,
      heading: (Math.atan2(fwd[0], fwd[2]) * 180) / Math.PI,
      pitch: (Math.asin(Math.max(-1, Math.min(1, -fwd[1]))) * 180) / Math.PI,
      roll: (Math.asin(Math.max(-1, Math.min(1, right[1]))) * 180) / Math.PI,
    };
  }

  makeRef(pyr, disp, fB, R, c) {
    const levels = [];
    for (const L of this.o.levels) if (pyr[L]) levels[L] = this.samples(pyr[L], L, disp, fB, pyr[0].w);
    return { levels, R: R.slice(), c, depth: !!disp, age: 0 };
  }

  /** The most textured pixels of a level: ray (x, y), brightness, inverse depth (0 = unknown). */
  samples(P, L, disp, fB, w0) {
    const { w, h, data, gx, gy } = P, s = 2 ** L;
    const f = this.intr.f / s, cx = (this.intr.cx + 0.5) / s - 0.5, cy = (this.intr.cy + 0.5) / s - 0.5;
    const rhoAt = (x, y) => {
      if (!disp) return 0;
      const d = disp[Math.round(y * s + (s - 1) / 2) * w0 + Math.round(x * s + (s - 1) / 2)];
      return d > 0 ? d / fB : 0;
    };
    // With depth, only pixels whose depth is known: the others would be taken as far away, and
    // walking past them would look like turning.
    let cand = [];
    for (let pass = disp ? 0 : 1; pass < 2 && cand.length < 200; pass++) {
      cand = [];
      for (let y = 3; y < h - 3; y++) {
        for (let x = 3; x < w - 3; x++) {
          const i = y * w + x, g = Math.abs(gx[i]) + Math.abs(gy[i]);
          if (g >= this.o.minGrad && (pass || rhoAt(x, y) > 0)) cand.push([g, i]);
        }
      }
    }
    cand.sort((a, b) => b[0] - a[0]);
    // The strongest, thinned out evenly if there are too many.
    const take = cand.slice(0, this.o.maxPts * 2), k = take.length > this.o.maxPts ? 2 : 1;
    const out = [];
    for (let j = 0; j < take.length; j += k) {
      const i = take[j][1], x = i % w, y = (i - x) / w;
      out.push((x - cx) / f, (y - cy) / f, data[i], rhoAt(x, y));
    }
    return { pts: Float32Array.from(out), f, cx, cy };
  }

  /** c: the current camera position (world), to take out the walk since a keyframe reference. */
  alignAll(ref, pyr, M, c, fineOnly = false) {
    // The walk since the reference, in the reference camera's frame: each point there is at
    // ray/ρ, so from here it's in the direction ray + ρ·b (before turning).
    const b = ref.depth && ref.c && c ? mulv(tr3(ref.R), [ref.c[0] - c[0], ref.c[1] - c[1], ref.c[2] - c[2]]) : null;
    let fit = { M, ok: false, inliers: 0, used: 0 };
    for (const L of fineOnly ? this.o.levels.slice(-1) : this.o.levels) {
      if (!pyr[L] || !ref.levels[L]) continue;
      fit = this.align(ref.levels[L], pyr[L], fit.M, b);
    }
    fit.ok = fit.used > 80 && fit.inliers >= this.o.minInliers;
    return fit;
  }

  /** Gauss-Newton on (turn ω, brightness gain, offset): reference pixels → this image. */
  align(ref, P, M0, b) {
    const { pts, f, cx, cy } = ref, { w, h, data, gx, gy } = P, n = pts.length / 4, hub = this.o.huber;
    const N = 5;
    let M = M0, a = 0, off = 0, used = 0, inl = 0;
    const bx = b ? b[0] : 0, by = b ? b[1] : 0, bz = b ? b[2] : 0;
    for (let it = 0; it < this.o.iters; it++) {
      const H = new Float64Array(N * N), g = new Float64Array(N), J = new Float64Array(N);
      used = 0; inl = 0;
      for (let k = 0; k < n; k++) {
        const rho = pts[4 * k + 3], I0 = pts[4 * k + 2];
        const dx = pts[4 * k] + rho * bx, dy = pts[4 * k + 1] + rho * by, dz = 1 + rho * bz;
        if (dz < 0.2) continue;
        // Where the pixel is now: the point's direction from here, turned by M.
        const x = M[0] * dx + M[1] * dy + M[2] * dz;
        const y = M[3] * dx + M[4] * dy + M[5] * dz;
        const z = M[6] * dx + M[7] * dy + M[8] * dz;
        if (z < 0.2) continue;
        const iz = 1 / z, u = f * x * iz + cx, v = f * y * iz + cy;
        if (u < 1 || v < 1 || u > w - 2 || v > h - 2) continue;
        const I = sample(data, w, u, v), Ix = sample(gx, w, u, v), Iy = sample(gy, w, u, v);
        const r = I - (1 + a) * I0 - off;
        const e = Math.abs(r), wt = e <= hub ? 1 : hub / e;
        used++;
        if (e < 2.5 * hub) inl++;
        const iz2 = iz * iz;
        // ∂(u, v)/∂ω for p ← exp(ω)·p (as in se3.refinePose), times the image gradient.
        J[0] = Ix * (-f * x * y * iz2) + Iy * -(f + f * y * y * iz2);
        J[1] = Ix * (f + f * x * x * iz2) + Iy * (f * x * y * iz2);
        J[2] = Ix * (-f * y * iz) + Iy * (f * x * iz);
        J[3] = -I0;
        J[4] = -1;
        for (let i = 0; i < N; i++) {
          g[i] += wt * J[i] * r;
          for (let j = i; j < N; j++) H[i * N + j] += wt * J[i] * J[j];
        }
      }
      if (used < 30) break;
      for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) H[i * N + j] = H[j * N + i];
      for (let i = 0; i < N; i++) H[i * N + i] *= 1.001;
      const d = solve(Array.from(H), Array.from(g, (x) => -x), N);
      if (!d) break;
      M = mul3(expSO3([d[0], d[1], d[2]]), M);
      a += d[3];
      off += d[4];
      if (Math.hypot(d[0], d[1], d[2]) < 2e-5) break;
    }
    return { M: orthonormalize(M), used, inliers: used ? inl / used : 0 };
  }
}


function sample(img, w, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}
