// Spreading a loop-closure correction over the whole walk: a pose graph over keyframes, with the
// odometry between consecutive keyframes and the loop constraints as edges. Because the floor
// fixes which way is up, only heading and position need correcting (4 degrees of freedom, as
// visual-inertial systems do), which turns into two linear least-squares problems: headings
// first, then positions. Solved with conjugate gradients. Pure logic, no DOM.
import { mul3, mulv, rotY } from './se3.js';

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const yawOf = (R) => Math.atan2(R[2], R[8]);

/**
 * Least squares over a graph: minimise Σ w·(x_j − x_i − c)² for edges { i, j, w, c }, with x_0
 * held at x0[0]. Returns the solved Float64Array.
 */
function solveGraph(n, edges, x0) {
  const x = Float64Array.from(x0);
  if (n < 2) return x;
  // Normal equations L·x = b on nodes 1…n−1 (node 0 is the anchor).
  const b = new Float64Array(n);
  for (const e of edges) { b[e.j] += e.w * e.c; b[e.i] -= e.w * e.c; }
  const mat = (v, out) => {
    out.fill(0);
    for (const e of edges) {
      const d = e.w * (v[e.i] - v[e.j]);
      out[e.i] += d;
      out[e.j] -= d;
    }
    out[0] = v[0]; // keeps the anchor fixed
  };
  b[0] = x0[0];
  // Conjugate gradients from the current values.
  const r = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
  mat(x, Ap);
  for (let k = 0; k < n; k++) r[k] = b[k] - Ap[k];
  r[0] = 0;
  p.set(r);
  let rr = r.reduce((s, v) => s + v * v, 0);
  for (let it = 0; it < 4 * n && rr > 1e-14; it++) {
    mat(p, Ap);
    Ap[0] = 0;
    const pAp = p.reduce((s, v, k) => s + v * Ap[k], 0);
    if (pAp <= 0) break;
    const a = rr / pAp;
    for (let k = 1; k < n; k++) { x[k] += a * p[k]; r[k] -= a * Ap[k]; }
    const rr2 = r.reduce((s, v) => s + v * v, 0);
    const beta = rr2 / rr;
    for (let k = 1; k < n; k++) p[k] = r[k] + beta * p[k];
    p[0] = 0;
    rr = rr2;
  }
  return x;
}

/**
 * poses: keyframe poses in the map frame, in walking order ({ R, t }).
 * loops: [{ i, j, rel }] where rel is keyframe j's pose expressed in keyframe i's frame,
 * as measured by recognising the place. Returns the corrected poses (keyframe 0 stays put).
 */
export function optimizePoses(poses, loops, { loopWeight = 2 } = {}) {
  const n = poses.length;
  const yaw = poses.map((p) => yawOf(p.R));
  // Headings, unwrapped along the walk.
  const theta = new Float64Array(n);
  for (let k = 1; k < n; k++) theta[k] = theta[k - 1] + wrap(yaw[k] - yaw[k - 1]);
  const offset = yaw[0];
  const odo = [];
  for (let k = 0; k + 1 < n; k++) {
    const dp = mulv(rotY(-yaw[k]), poses[k + 1].t.map((v, d) => v - poses[k].t[d]));
    odo.push({ i: k, j: k + 1, w: 1, dth: wrap(yaw[k + 1] - yaw[k]), dp });
  }
  const lp = loops.map(({ i, j, rel }) => {
    // Where the loop says j is, given i, in the map frame.
    const R = mul3(poses[i].R, rel.R);
    const t = mulv(poses[i].R, rel.t).map((v, d) => v + poses[i].t[d]);
    // Headings are unwrapped along the walk (a full loop is +360°, not 0°), so take the
    // measured turn as the nearest equivalent of the walk's current estimate.
    const cur = theta[j] - theta[i];
    return { i, j, w: loopWeight, dth: cur + wrap(yawOf(R) - yaw[i] - cur), dp: mulv(rotY(-yaw[i]), t.map((v, d) => v - poses[i].t[d])) };
  });
  const edges = [...odo, ...lp];
  // 1) headings
  const th = solveGraph(n, edges.map((e) => ({ i: e.i, j: e.j, w: e.w, c: e.dth })), theta);
  // 2) positions, with the corrected headings
  const pos = [0, 1, 2].map((d) => {
    const es = edges.map((e) => ({ i: e.i, j: e.j, w: e.w, c: mulv(rotY(th[e.i] + offset), e.dp)[d] }));
    return solveGraph(n, es, Float64Array.from(poses.map((p) => p.t[d])));
  });
  return poses.map((p, k) => ({
    R: mul3(rotY(th[k] - theta[k]), p.R),
    t: [pos[0][k], pos[1][k], pos[2][k]],
  }));
}
