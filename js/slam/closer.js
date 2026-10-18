// Drift correction and relocalisation on top of the world model.
//   check(): after each keyframe, look for an older keyframe of the same place (nearby or
//   similar-looking, at least 30 keyframes back); if one verifies, add the loop to the pose
//   graph, correct every keyframe and rebuild the map.
//   relocalize(): when tracking is lost (or a saved map was just loaded), find which stored
//   keyframe the current view matches and where the cameras must be.
// Pure logic, no DOM.
import { thumbScore, verifyPlace } from './loop.js';
import { optimizePoses } from './posegraph.js';
import { compose, invert } from './se3.js';

export class LoopCloser {
  constructor(intr, { minGap = 30, radius = 3, cooldown = 5, maxCandidates = 4 } = {}) {
    Object.assign(this, { intr, minGap, radius, cooldown, maxCandidates });
    this.loops = [];
    this.lastLoop = -Infinity;
  }

  candidates(world, desc, upTo, near) {
    const kfs = world.keyframes, out = new Map();
    const scored = [];
    for (let i = 0; i < upTo; i++) {
      const kf = kfs[i];
      if (!kf.lc) continue;
      const p = world.mapPose(kf.pose).t;
      const d = near ? Math.hypot(p[0] - near[0], p[2] - near[2]) : Infinity;
      scored.push({ i, d, s: thumbScore(desc.thumb, kf.lc.thumb) });
    }
    scored.filter((c) => c.d < this.radius).sort((a, b) => a.d - b.d).slice(0, 2).forEach((c) => out.set(c.i, c));
    scored.filter((c) => c.s > 0.5).sort((a, b) => b.s - a.s).slice(0, this.maxCandidates).forEach((c) => out.set(c.i, c));
    return [...out.values()].slice(0, this.maxCandidates);
  }

  /** Call after world.addKeyframe(). Returns null, or { i, j, correction, inliers, C } where C moves odometry-frame poses. */
  check(world) {
    const kfs = world.keyframes, k = kfs.length - 1, cur = kfs[k];
    if (!cur?.lc || !world.align || k < this.minGap || k - this.lastLoop < this.cooldown) return null;
    const P = kfs.map((kf) => world.mapPose(kf.pose));
    for (const c of this.candidates(world, cur.lc, k - this.minGap, P[k].t)) {
      const v = verifyPlace(cur.lc, kfs[c.i].lc, this.intr);
      if (!v) continue;
      // How far off the current estimate is, against how far we've walked since: big jumps
      // after a short walk are more likely a wrong match than drift.
      const pred = compose(P[c.i], v.pose);
      const correction = Math.hypot(pred.t[0] - P[k].t[0], pred.t[2] - P[k].t[2]);
      let walked = 0;
      for (let q = c.i + 1; q <= k; q++) walked += Math.hypot(P[q].t[0] - P[q - 1].t[0], P[q].t[2] - P[q - 1].t[2]);
      if (correction > 0.5 + 0.1 * walked) continue;
      this.loops.push({ i: c.i, j: k, rel: v.pose });
      const before = kfs[k].pose;
      world.correct(optimizePoses(P, this.loops));
      this.lastLoop = k;
      return { i: c.i, j: k, correction, inliers: v.inliers, C: compose(kfs[k].pose, invert(before)) };
    }
    return null;
  }

  /** Odometry-frame camera pose for a view, by recognising a stored keyframe; null if none match. */
  relocalize(world, desc, near = null) {
    for (const c of this.candidates(world, desc, world.keyframes.length, near)) {
      const v = verifyPlace(desc, world.keyframes[c.i].lc, this.intr);
      if (v) return compose(world.keyframes[c.i].pose, v.pose);
    }
    return null;
  }
}
