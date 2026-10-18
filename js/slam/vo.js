// Stereo visual odometry: where the cameras are, frame by frame.
//
// Every frame: rectify the pair, follow a few hundred corner features in the left image with
// optical flow (KLT), and solve the camera pose from where their known 3D points now appear.
// The turn comes from the visual compass (compass.js: how the whole picture shifts), and the
// tracked points only say how far you've walked; if the compass can't see enough (a blank wall),
// the points give the turn too.
// Keyframes (after enough movement): dense stereo depth, which gives new features their 3D
// position and the keyframe's point cloud for the map. Only the left camera is used for
// tracking, so the two webcams not being shutter-synced only matters for keyframe depth; those
// are postponed while the rig turns fast enough for the skew to shift the images by > 1 px.
// Pure logic, no DOM.
import { buildPyramid, goodFeatures, trackFB } from './klt.js';
import { rectification, remap } from './rectify.js';
import { disparityBM, localNormalize } from './dense.js';
import { angleOf, apply, compose, expSO3, identity, invert, logSO3, refinePose, tr3 } from './se3.js';
import { describeView } from './loop.js';
import { VisualCompass } from './compass.js';
import { poseCovariance } from './uncertainty.js';
import { GrayFrame, bandSearch } from '../stereo.js';

export const VO_DEFAULTS = {
  levels: 3, win: 7, maxFeatures: 220, minDistance: 12,
  kfDistance: 0.25, kfAngleDeg: 8, kfMinInterval: 0.15, kfMaxInterval: 1.0,
  minStart: 10, minInliers: 10, maxDisp: 64, minRange: 0.4, maxRange: 6,
  cloudStride: 3, cloudRange: 4.5, maxSyncPx: 1.0, lostTimeout: 8,
  turnFrom: 'compass', // 'compass' (whole image) or 'points' (the tracked features)
  compassWeight: 15, // the compass counts as much as this many tracked points for the turn
  edgeFilter: null, // drop cloud samples on depth edges; null = on with one camera, off with two
  edgeJump: 0.08, // …where the depth jumps by more than this (relative) to a neighbour
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
    this.stats = { syncSkips: 0, reanchors: 0, compassResyncs: 0 };
    this.compass = new VisualCompass(this.intr);
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
  process({ left, right, t = 0, gap = 0, depth = null }) {
    const o = this.o, w = this.w, h = this.h;
    const t0 = now();
    // One camera: depth comes from a model (metres, per pixel of the unwarped left image).
    const L = remap(left, w, h, this.rect.mapL), R = o.mono ? L : remap(right, w, h, this.rect.mapR);
    const D = depth && remap(depth, w, h, this.rect.mapL);
    const pyr = buildPyramid(L, w, h, o.levels);
    this.last = { L, R, pyr, t };
    this.needDepth = false;
    const dt = this.lastT == null ? 1 / 15 : Math.max(1e-3, t - this.lastT);
    let keyframe = null, inliers = 0, rmse = 0, shiftPx = 0;
    const timings = { track: 0, depth: 0 };
    // Where the camera should be if it kept moving as it was.
    const lost = this.status === 'lost';
    const step = lost ? identity() : { R: expSO3(this.vel.w.map((x) => x * dt)), t: this.vel.v.map((x) => x * dt) };
    // The compass runs on every frame, from the first one: that's heading 0°.
    let comp = this.compass.update(pyr, this.status === 'ok' ? compose(this.pose, step).t : null);
    const useCompass = o.turnFrom === 'compass' && comp.ok;
    this.heading = comp;
    timings.compass = now() - t0;

    if (this.status === 'init') {
      if (o.turnFrom === 'compass') this.pose = { R: comp.R, t: this.pose.t };
      if (o.mono && !D) {
        this.needDepth = true;
        return this.result({ keyframe: null, inliers: 0, L, timings, t0 });
      }
      const t1 = now();
      keyframe = this.makeKeyframe(L, R, pyr, this.pose, t, true, D);
      timings.depth = now() - t1;
      if (this.features.length >= o.minStart) {
        this.status = 'ok';
        this.prevPyr = pyr;
        this.lastT = t;
      } else {
        this.features = [];
        keyframe = null;
      }
      return this.result({ keyframe, inliers: this.features.length, L, timings, t0 });
    }

    // (The compass's turn isn't used for this guess: with a slightly wrong field of view it puts
    // the features further off than the steady-motion guess does.)
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
    let poseCw = null, keep = [], fit = null;
    if (useCompass && idx.length >= o.minInliers) {
      // One solve with both: the whole picture's shift (mostly the turn) and the tracked points
      // (mostly how far you've walked). A small step sideways looks much like a small turn, so
      // solving them apart lets the two drift together; solved together they keep each other right.
      const extra = (Rcw, tcw) => this.compass.poseTerms(Rcw, tcw, o.compassWeight, this.intr.f);
      const a = pack(idx);
      const r = refinePose(predCw, a.X, a.uv, this.intr, { huber: 2, extra });
      const good = idx.filter((_, j) => r.err[j] < 3);
      if (good.length >= o.minInliers) {
        const b = pack(good);
        const r2 = refinePose(r.pose, b.X, b.uv, this.intr, { huber: 1, extra });
        keep = good.filter((_, j) => r2.err[j] < 2);
        if (keep.length >= o.minInliers) {
          poseCw = r2.pose;
          rmse = r2.rmse;
          fit = r2;
          this.compass.adopt(tr3(poseCw.R));
          this.heading = comp = this.compass.reading();
        }
      }
    }
    if (!poseCw && idx.length >= o.minInliers) {
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
          fit = r2;
          // The points disagreed with the compass (or it couldn't see): it carries on from them.
          if (o.turnFrom === 'compass') {
            this.compass.resync(invert(poseCw).R);
            this.stats.compassResyncs++;
          }
        }
      }
    }
    timings.track = now() - t0;

    if (!poseCw) {
      // Lost: keep the last good image and pose, and keep trying to find the features again.
      if (!lost) this.lostAt = t;
      this.status = 'lost';
      // Still turning with you: the compass keeps the heading even with no points to follow.
      if (useCompass) this.pose = { R: comp.R, t: this.pose.t };
      this.vel = { w: [0, 0, 0], v: [0, 0, 0] };
      if (t - this.lostAt > o.lostTimeout) {
        // Start again from the last known pose; the map may get a seam here.
        if (o.mono && !D) {
          this.needDepth = true;
          return this.result({ keyframe: null, inliers: 0, L, timings, t0 });
        }
        this.stats.reanchors++;
        this.features = [];
        const t1 = now();
        keyframe = this.makeKeyframe(L, R, pyr, this.pose, t, false, D);
        timings.depth = now() - t1;
        if (this.features.length >= o.minStart) { this.status = 'ok'; this.prevPyr = pyr; this.lastT = t; }
      }
      return this.result({ keyframe, inliers: 0, L, timings, t0 });
    }

    inliers = keep.length;
    // How sure this fit is (camera position and turn, world frame), for the halo round the camera.
    // (refinePose's rmse is over the points within 3 px.)
    const uncertainty = poseCovariance(fit.info, fit.rmse, poseCw.R, { n: fit.err.filter((e) => e < 3).length });
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
      if (o.mono && !D) {
        this.needDepth = true; // ask for depth on the next frame
      } else if (synced || urgent) {
        const t1 = now();
        keyframe = this.makeKeyframe(L, R, pyr, this.pose, t, synced, D);
        timings.depth = now() - t1;
      } else {
        this.stats.syncSkips++;
      }
    }
    this.prevPyr = pyr;
    this.lastT = t;
    return this.result({ keyframe, inliers, rmse, shiftPx, L, timings, t0, uncertainty });
  }

  /** Dense depth for this pair, new features where there are none, and the keyframe's cloud. */
  makeKeyframe(L, R, pyr, pose, t, fuse, depth = null) {
    const o = this.o, w = this.w, h = this.h, { f, cx, cy } = this.intr, fB = f * this.baseline;
    let disp;
    if (depth) {
      // A depth model's scale wobbles from frame to frame: rescale this one so it agrees with the 3D
      // points already being tracked (the first keyframe's metric scale carries through the walk).
      const Tcw = invert(pose), ratios = [];
      for (const ft of this.features) {
        const zc = apply(Tcw, ft.X)[2], zm = depth[Math.round(ft.v) * w + Math.round(ft.u)];
        if (zc > 0.2 && zm > 0.2) ratios.push(zc / zm);
      }
      let k = this.depthScale ?? 1;
      if (ratios.length >= 15) {
        ratios.sort((a, b) => a - b);
        const r = ratios[ratios.length >> 1];
        const spread = (ratios[(3 * ratios.length) >> 2] - ratios[ratios.length >> 2]) / r;
        const starving = this.features.length < 0.35 * o.maxFeatures;
        if ((spread > 0.5 || r < 0.25 || r > 4) && !starving) {
          // The model got this view wrong (it disagrees with what we're tracking): keep tracking
          // with the points we have, and don't add this depth to the map.
          this.stats.badDepth = (this.stats.badDepth ?? 0) + 1;
          this.kf = { id: this.kfCount++, t, pose, points: new Float32Array(0), gray: new Uint8Array(0), fuse: false, lc: null };
          return this.kf;
        }
        if (spread <= 0.5 && r > 0.25 && r < 4) k = r; // starving on a bad view: keep the last good scale
      }
      this.depthScale = k;
      // …expressed as the disparity a stereo pair would have seen, so everything after is shared.
      disp = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) disp[i] = depth[i] > 0.1 && this.rect.validL[i] ? fB / (depth[i] * k) : -1;
    } else {
      const nL = localNormalize(L, w, h), nR = localNormalize(R, w, h);
      disp = disparityBM(nL.data, nR.data, w, h, {
        maxDisp: o.maxDisp, texture: nL.std, validL: this.rect.validL, validR: this.rect.validR,
      });
    }
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
    // A depth model smooths over the edge between something near and what's behind it, leaving a
    // streak of points in mid-air along the line of sight. So with one camera, a sample whose depth
    // differs by more than edgeJump from a neighbour one stride away is dropped. A stride away, not
    // the next pixel: a model smears an edge over several pixels, too gently per pixel to catch.
    // A flat floor or wall only changes that fast when seen more than ~80° from face-on (at 320 px
    // wide), and there the model's depth is no good anyway.
    const s = o.cloudStride, edges = o.edgeFilter ?? !!o.mono, jump = 1 + o.edgeJump;
    const steep = (i, d) => disp[i] > 0 && (disp[i] > d ? disp[i] / d : d / disp[i]) > jump;
    const pts = [], gray = [];
    for (let y = 2; y < h - 2; y += s) {
      for (let x = 2; x < w - 2; x += s) {
        const i = y * w + x, d = disp[i];
        if (d <= 0) continue;
        const Z = fB / d;
        if (Z < o.minRange || Z > o.cloudRange) continue;
        if (edges && ((x >= s && steep(i - s, d)) || (x + s < w && steep(i + s, d))
          || (y >= s && steep(i - s * w, d)) || (y + s < h && steep(i + s * w, d)))) continue;
        pts.push(((x - cx) * Z) / f, ((y - cy) * Z) / f, Z);
        gray.push(L[y * w + x]);
      }
    }
    const lc = describeView(L, w, h, disp, pyr[0], this.intr, this.baseline);
    let valid = 0;
    for (let i = 0; i < disp.length; i++) if (disp[i] > 0) valid++;
    this.depthInfo = { matched: valid / disp.length, features: this.features.length };
    this.compass.setKeyframe(pyr, disp, fB, pose);
    this.kf = { id: this.kfCount++, t, pose, points: Float32Array.from(pts), gray: Uint8Array.from(gray), fuse, lc };
    return this.kf;
  }

  /**
   * Does the pair line up? Matches ~30 corners anywhere along a ±16-row band and reports
   * { matches, disparity (median px), dy (how far the right image sits below the left), swapped }.
   */
  checkAlignment(left, right) {
    const w = this.w, h = this.h;
    const L = remap(left, w, h, this.rect.mapL), R = remap(right, w, h, this.rect.mapR);
    const corners = goodFeatures(buildPyramid(L, w, h, 1)[0], { maxCorners: 40, minDistance: 20, border: 14 });
    const gL = new GrayFrame(w, h, L), gR = new GrayFrame(w, h, R);
    const dx = [], dy = [];
    for (let k = 0; k < corners.length; k += 2) {
      // A wide band: cameras on a home-made bar can sit 20+ px apart vertically at this size.
      const m = bandSearch(gL, gR, corners[k], corners[k + 1], { r: 7, band: 30 });
      if (!m.ok || m.score < 0.78 || m.margin < 0.03) continue;
      const back = bandSearch(gR, gL, m.uB, m.vB, { r: 7, band: 30 });
      if (!back.ok || Math.abs(back.uB - m.uA) > 1.5 || Math.abs(back.vB - m.vA) > 1.5) continue;
      dx.push(m.uA - m.uB);
      dy.push(m.vB - m.vA);
    }
    const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
    return {
      matches: dx.length, disparity: dx.length ? med(dx) : null, dy: dy.length ? med(dy) : 0,
      // In the right order, nearly everything sits further left in the right image.
      swapped: dx.length >= 8 && dx.filter((d) => d < -0.5).length > 0.6 * dx.length,
    };
  }

  /** Place-recognition description of the newest frame (for relocalising when lost). */
  describeLast() {
    const { L, R, pyr } = this.last, w = this.w, h = this.h;
    const nL = localNormalize(L, w, h), nR = localNormalize(R, w, h);
    const disp = disparityBM(nL.data, nR.data, w, h, { maxDisp: this.o.maxDisp, texture: nL.std, validL: this.rect.validL, validR: this.rect.validR });
    return describeView(L, w, h, disp, pyr[0], this.intr, this.baseline);
  }

  /** Start tracking again from a known pose (found by recognising the place). */
  relocalize(pose) {
    const { L, R, pyr, t } = this.last;
    this.features = [];
    this.pose = pose;
    this.vel = { w: [0, 0, 0], v: [0, 0, 0] };
    this.compass.resync(pose.R);
    const kf = this.makeKeyframe(L, R, pyr, pose, t, true);
    this.status = 'ok';
    this.prevPyr = pyr;
    this.lastT = t;
    return kf;
  }

  /** Moves the current pose and map points by a correction (after a loop closure). */
  shift(C) {
    this.pose = compose(C, this.pose);
    this.compass.resync(this.pose.R);
    for (const f of this.features) f.X = apply(C, f.X);
    if (this.kf) this.kf.pose = compose(C, this.kf.pose);
  }

  result({ keyframe, inliers, rmse = 0, shiftPx = 0, L, timings, t0, uncertainty = null }) {
    const features = new Float32Array(this.features.length * 2);
    this.features.forEach((f, i) => { features[2 * i] = f.u; features[2 * i + 1] = f.v; });
    return {
      status: this.status, pose: this.pose, inliers, rmse, shiftPx, keyframe, features,
      image: L, timings: { ...timings, total: now() - t0 }, stats: this.stats, compass: this.heading ?? null, depthInfo: this.depthInfo ?? null, needDepth: !!this.needDepth,
      uncertainty, // { pos, rot } (m², rad², world frame) from this frame's solve; null without one
    };
  }
}

const now = () => (globalThis.performance ? performance.now() : Date.now());
