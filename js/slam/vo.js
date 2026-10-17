// Stereo visual odometry: where the cameras are, frame by frame.
//
// Every frame: rectify the pair, follow a few hundred corner features in the left image with
// optical flow (KLT), and solve the camera pose from where their known 3D points now appear.
// Keyframes (after enough movement): dense stereo depth, which gives new features their 3D
// position and the keyframe's point cloud for the map. Only the left camera is used for
// tracking, so the two webcams not being shutter-synced only matters for keyframe depth; those
// are postponed while the rig turns fast enough for the skew to shift the images by > 1 px.
// Pure logic, no DOM.
import { buildPyramid, goodFeatures, trackFB } from './klt.js';
import { rectification, remap } from './rectify.js';
import { disparityBM, localNormalize } from './dense.js';
import { angleOf, apply, compose, expSO3, identity, invert, logSO3, refinePose } from './se3.js';

export const VO_DEFAULTS = {
  levels: 3, win: 7, maxFeatures: 220, minDistance: 12,
  kfDistance: 0.25, kfAngleDeg: 8, kfMinInterval: 0.15, kfMaxInterval: 1.0,
  minInliers: 18, maxDisp: 64, minRange: 0.4, maxRange: 6,
  cloudStride: 3, cloudRange: 4.5, maxSyncPx: 1.0, lostTimeout: 4,
};

export class StereoVO {
  /** params: rig numbers (+ vOffsetPx at this image size); w × h: processing size. */
  constructor(params, w, h, opts = {}) {
    this.o = { ...VO_DEFAULTS, ...opts };
    this.w = w;
    this.h = h;
    this.rect = rectification(params, w, h, params.vOffsetPx ?? 0);
    this.intr = { f: this.rect.f, cx: this.rect.cx, cy: this.rect.cy };
    this.baseline = this.rect.baseline;
    this.reset();
  }

  reset() {
    this.pose = identity(); // camera → world (the first camera's frame)
    this.vel = { w: [0, 0, 0], v: [0, 0, 0] }; // per second, in the camera frame
    this.features = []; // { u, v, X: world point }
    this.prevPyr = null;
    this.kf = null;
    this.kfCount = 0;
    this.lastT = null;
    this.status = 'init';
    this.lostAt = null;
    this.stats = { syncSkips: 0, reanchors: 0 };
  }

  project(Tcw, X) {
    const p = apply(Tcw, X);
    if (p[2] < 0.1) return null;
    return [this.intr.f * p[0] / p[2] + this.intr.cx, this.intr.f * p[1] / p[2] + this.intr.cy];
  }

  /**
   * frame: { left, right: grayscale (0–255) at w × h, t: seconds, gap: seconds between the two
   * cameras' capture times (0 if unknown) }.
   */
  process({ left, right, t = 0, gap = 0 }) {
    const o = this.o, w = this.w, h = this.h;
    const t0 = now();
    const L = remap(left, w, h, this.rect.mapL), R = remap(right, w, h, this.rect.mapR);
    const pyr = buildPyramid(L, w, h, o.levels);
    const dt = this.lastT == null ? 1 / 15 : Math.max(1e-3, t - this.lastT);
    let keyframe = null, inliers = 0, rmse = 0, shiftPx = 0;
    const timings = { track: 0, depth: 0 };

    if (this.status === 'init') {
      const t1 = now();
      keyframe = this.makeKeyframe(L, R, pyr, this.pose, t, true);
      timings.depth = now() - t1;
      if (this.features.length >= 40) {
        this.status = 'ok';
        this.prevPyr = pyr;
        this.lastT = t;
      } else {
        this.features = [];
        keyframe = null;
      }
      return this.result({ keyframe, inliers: this.features.length, L, timings, t0 });
    }

    // Where the camera should be if it kept moving as it was.
    const lost = this.status === 'lost';
    const step = lost ? identity() : { R: expSO3(this.vel.w.map((x) => x * dt)), t: this.vel.v.map((x) => x * dt) };
    const predWc = compose(this.pose, step);
    const predCw = invert(predWc);

    const n = this.features.length;
    const pts = new Float32Array(2 * n), guess = new Float32Array(2 * n);
    this.features.forEach((f, i) => {
      pts[2 * i] = f.u; pts[2 * i + 1] = f.v;
      const g = this.project(predCw, f.X) ?? [f.u, f.v];
      guess[2 * i] = g[0]; guess[2 * i + 1] = g[1];
    });
    const tr = trackFB(this.prevPyr, pyr, pts, guess, { win: o.win }, 1.0);
    const idx = [];
    for (let i = 0; i < n; i++) if (tr.ok[i]) idx.push(i);
    const pack = (ids) => {
      const X = new Float64Array(ids.length * 3), uv = new Float64Array(ids.length * 2);
      ids.forEach((k, j) => {
        X.set(this.features[k].X, j * 3);
        uv[j * 2] = tr.pts[2 * k]; uv[j * 2 + 1] = tr.pts[2 * k + 1];
      });
      return { X, uv };
    };
    let poseCw = null, keep = [];
    if (idx.length >= o.minInliers) {
      // Robust pass on everything, then a tighter one on the points that agree.
      const a = pack(idx);
      let r = refinePose(predCw, a.X, a.uv, this.intr, { huber: 2 });
      if (r.rmse > 2.5 && !lost) r = refinePose(invert(this.pose), a.X, a.uv, this.intr, { huber: 2 });
      const good = idx.filter((_, j) => r.err[j] < 3);
      if (good.length >= o.minInliers) {
        const b = pack(good);
        const r2 = refinePose(r.pose, b.X, b.uv, this.intr, { huber: 1 });
        keep = good.filter((_, j) => r2.err[j] < 2);
        if (keep.length >= o.minInliers) {
          poseCw = r2.pose;
          rmse = r2.rmse;
        }
      }
    }
    timings.track = now() - t0;

    if (!poseCw) {
      // Lost: keep the last good image and pose, and keep trying to find the features again.
      if (!lost) this.lostAt = t;
      this.status = 'lost';
      this.vel = { w: [0, 0, 0], v: [0, 0, 0] };
      if (t - this.lostAt > o.lostTimeout) {
        // Start again from the last known pose; the map may get a seam here.
        this.stats.reanchors++;
        this.features = [];
        const t1 = now();
        keyframe = this.makeKeyframe(L, R, pyr, this.pose, t, false);
        timings.depth = now() - t1;
        if (this.features.length >= 40) { this.status = 'ok'; this.prevPyr = pyr; this.lastT = t; }
      }
      return this.result({ keyframe, inliers: 0, L, timings, t0 });
    }

    inliers = keep.length;
    this.features = keep.map((k) => ({ ...this.features[k], u: tr.pts[2 * k], v: tr.pts[2 * k + 1] }));
    const newPose = invert(poseCw);
    if (!lost) {
      const d = compose(invert(this.pose), newPose);
      const wv = logSO3(d.R);
      // Smooth the velocity a little; it's only a guess for the next frame.
      this.vel = {
        w: wv.map((x, i) => 0.5 * this.vel.w[i] + 0.5 * (x / dt)),
        v: d.t.map((x, i) => 0.5 * this.vel.v[i] + 0.5 * (x / dt)),
      };
    }
    this.pose = newPose;
    this.status = 'ok';
    shiftPx = Math.hypot(...this.vel.w) * gap * this.intr.f;

    // New keyframe after enough movement, or when features run low.
    const since = compose(invert(this.kf.pose), this.pose);
    const moved = Math.hypot(...since.t), turned = angleOf(since.R) * 180 / Math.PI;
    const age = t - this.kf.t;
    const want = (moved > o.kfDistance || turned > o.kfAngleDeg || this.features.length < 0.5 * o.maxFeatures
      || (age > o.kfMaxInterval && (moved > 0.03 || turned > 1))) && age >= o.kfMinInterval;
    if (want) {
      const urgent = this.features.length < 0.35 * o.maxFeatures;
      const synced = shiftPx <= o.maxSyncPx;
      if (synced || urgent) {
        const t1 = now();
        keyframe = this.makeKeyframe(L, R, pyr, this.pose, t, synced);
        timings.depth = now() - t1;
      } else {
        this.stats.syncSkips++;
      }
    }
    this.prevPyr = pyr;
    this.lastT = t;
    return this.result({ keyframe, inliers, rmse, shiftPx, L, timings, t0 });
  }

  /** Dense depth for this pair, new features where there are none, and the keyframe's cloud. */
  makeKeyframe(L, R, pyr, pose, t, fuse) {
    const o = this.o, w = this.w, h = this.h, { f, cx, cy } = this.intr, fB = f * this.baseline;
    const nL = localNormalize(L, w, h), nR = localNormalize(R, w, h);
    const disp = disparityBM(nL.data, nR.data, w, h, {
      maxDisp: o.maxDisp, texture: nL.std, validL: this.rect.validL, validR: this.rect.validR,
    });
    const at = (x, y) => {
      const v = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const d = disp[(y + dy) * w + x + dx];
          if (d > 0) v.push(d);
        }
      }
      if (v.length < 5) return -1;
      v.sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    // New features away from the ones still being tracked.
    const need = o.maxFeatures - this.features.length;
    if (need > 10) {
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) mask[i] = this.rect.validL[i] ? 0 : 1;
      const r = o.minDistance;
      for (const ft of this.features) {
        const fx = Math.round(ft.u), fy = Math.round(ft.v);
        for (let y = Math.max(0, fy - r); y <= Math.min(h - 1, fy + r); y++) {
          for (let x = Math.max(0, fx - r); x <= Math.min(w - 1, fx + r); x++) mask[y * w + x] = 1;
        }
      }
      const corners = goodFeatures(pyr[0], { maxCorners: need * 2, minDistance: o.minDistance, mask });
      let added = 0;
      for (let k = 0; k < corners.length && added < need; k += 2) {
        const x = corners[k], y = corners[k + 1];
        const d = at(x, y);
        if (d <= 0) continue;
        const Z = fB / d;
        if (Z < o.minRange || Z > o.maxRange) continue;
        this.features.push({ u: x, v: y, X: apply(pose, [((x - cx) * Z) / f, ((y - cy) * Z) / f, Z]) });
        added++;
      }
    }
    // The keyframe's point cloud (camera frame) for the map.
    const pts = [], gray = [];
    for (let y = 2; y < h - 2; y += o.cloudStride) {
      for (let x = 2; x < w - 2; x += o.cloudStride) {
        const d = disp[y * w + x];
        if (d <= 0) continue;
        const Z = fB / d;
        if (Z < o.minRange || Z > o.cloudRange) continue;
        pts.push(((x - cx) * Z) / f, ((y - cy) * Z) / f, Z);
        gray.push(L[y * w + x]);
      }
    }
    this.kf = { id: this.kfCount++, t, pose, points: Float32Array.from(pts), gray: Uint8Array.from(gray), fuse };
    return this.kf;
  }

  result({ keyframe, inliers, rmse = 0, shiftPx = 0, L, timings, t0 }) {
    const features = new Float32Array(this.features.length * 2);
    this.features.forEach((f, i) => { features[2 * i] = f.u; features[2 * i + 1] = f.v; });
    return {
      status: this.status, pose: this.pose, inliers, rmse, shiftPx, keyframe, features,
      image: L, timings: { ...timings, total: now() - t0 }, stats: this.stats,
    };
  }
}

const now = () => (globalThis.performance ? performance.now() : Date.now());
