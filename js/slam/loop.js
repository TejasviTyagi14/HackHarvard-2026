// Recognising places seen before: what makes the map correct itself (loop closure) and lets
// tracking pick up again after it's lost or when a saved map is loaded (relocalisation).
//   • Each keyframe keeps ~300 corners with a binary BRIEF descriptor and a 3D position from
//     stereo, plus a tiny blurred thumbnail of the whole view.
//   • Candidates: keyframes near where you think you are, and ones whose thumbnail looks alike.
//   • Check: match descriptors, find the rigid motion that most matches agree on (3-point
//     RANSAC on the 3D positions), then confirm it by re-projecting into the current image.
// Pure functions, no DOM.
import { goodFeatures } from './klt.js';
import { expSO3, invert, logSO3, mul3, mulv, refinePose, rotY, tr3 } from './se3.js';
import { buildPyramid } from './klt.js';

const PATCH = 12; // BRIEF compares pixel pairs within ±12 px

// 256 fixed point pairs, Gaussian around the centre (the classic BRIEF layout).
const PAIRS = (() => {
  let seed = 42;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const gauss = () => {
    const v = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()) * (PATCH / 2.5);
    return Math.max(-PATCH, Math.min(PATCH, Math.round(v)));
  };
  return Int8Array.from({ length: 256 * 4 }, gauss);
})();

/** 5×5 box blur (BRIEF is sensitive to noise without it). */
export function blur(src, w, h) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w + 2; x++) {
      if (x < w) s += src[y * w + x];
      if (x >= 5) s -= src[y * w + x - 5];
      if (x >= 2 && x - 2 < w) tmp[y * w + x - 2] = s / (Math.min(x, w - 1) - Math.max(0, x - 4) + 1);
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h + 2; y++) {
      if (y < h) s += tmp[y * w + x];
      if (y >= 5) s -= tmp[(y - 5) * w + x];
      if (y >= 2 && y - 2 < h) out[(y - 2) * w + x] = s / (Math.min(y, h - 1) - Math.max(0, y - 4) + 1);
    }
  }
  return out;
}

/** 256-bit BRIEF descriptors (8 × Uint32 each) for integer points at least PATCH px inside. */
export function brief(img, w, pts) {
  const n = pts.length / 2, out = new Uint32Array(n * 8);
  for (let i = 0; i < n; i++) {
    const x = Math.round(pts[2 * i]), y = Math.round(pts[2 * i + 1]), c = y * w + x;
    for (let b = 0; b < 256; b++) {
      const k = b * 4;
      if (img[c + PAIRS[k + 1] * w + PAIRS[k]] < img[c + PAIRS[k + 3] * w + PAIRS[k + 2]]) out[i * 8 + (b >> 5)] |= 1 << (b & 31);
    }
  }
  return out;
}

const pop32 = (v) => {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
};

function hamming(a, i, b, j) {
  let d = 0;
  for (let k = 0; k < 8; k++) d += pop32(a[i * 8 + k] ^ b[j * 8 + k]);
  return d;
}

/** Mutual nearest-neighbour matches that pass a ratio test: [[i, j], …]. */
export function matchDescriptors(da, db, { maxDist = 64, ratio = 0.8 } = {}) {
  const na = da.length / 8, nb = db.length / 8;
  if (!na || !nb) return [];
  const bestB = new Int32Array(nb).fill(-1), bestBd = new Int32Array(nb).fill(999);
  const fwd = [];
  for (let i = 0; i < na; i++) {
    let b1 = 999, b2 = 999, j1 = -1;
    for (let j = 0; j < nb; j++) {
      const d = hamming(da, i, db, j);
      if (d < b1) { b2 = b1; b1 = d; j1 = j; } else if (d < b2) b2 = d;
      if (d < bestBd[j]) { bestBd[j] = d; bestB[j] = i; }
    }
    fwd.push([j1, b1, b2]);
  }
  const out = [];
  fwd.forEach(([j, d1, d2], i) => {
    if (j >= 0 && d1 <= maxDist && d1 < ratio * d2 && bestB[j] === i) out.push([i, j]);
  });
  return out;
}

/** Tiny blurred thumbnail (16 × 9), zero mean and unit spread, for "does this view look familiar". */
export function thumbnail(img, w, h, tw = 16, th = 9) {
  const out = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * w) / tw), x1 = Math.floor(((x + 1) * w) / tw);
      const y0 = Math.floor((y * h) / th), y1 = Math.floor(((y + 1) * h) / th);
      let s = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += img[yy * w + xx];
      out[y * tw + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  let m = 0;
  for (const v of out) m += v;
  m /= out.length;
  let q = 0;
  for (let i = 0; i < out.length; i++) { out[i] -= m; q += out[i] * out[i]; }
  const sd = Math.sqrt(q / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

export function thumbScore(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

/**
 * Everything place recognition needs from one stereo view (rectified left image + its
 * disparity): { uv, pts3 (camera frame), desc, thumb }.
 */
export function describeView(L, w, h, disp, level0, intr, baseline, { maxCorners = 300, minRange = 0.4, maxRange = 6 } = {}) {
  const corners = goodFeatures(level0, { maxCorners: maxCorners * 2, minDistance: 8, border: PATCH + 2 });
  const fB = intr.f * baseline;
  const uv = [], pts3 = [];
  for (let k = 0; k < corners.length && uv.length / 2 < maxCorners; k += 2) {
    const x = corners[k], y = corners[k + 1];
    const v = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const d = disp[(y + dy) * w + x + dx]; if (d > 0) v.push(d); }
    if (v.length < 5) continue;
    v.sort((a, b) => a - b);
    const Z = fB / v[v.length >> 1];
    if (Z < minRange || Z > maxRange) continue;
    uv.push(x, y);
    pts3.push(((x - intr.cx) * Z) / intr.f, ((y - intr.cy) * Z) / intr.f, Z);
  }
  const uvA = Float32Array.from(uv);
  return { uv: uvA, pts3: Float32Array.from(pts3), desc: brief(blur(L, w, h), w, uvA), thumb: thumbnail(L, w, h) };
}

// ---------------------------------------------------------------------------------------
// Rigid alignment of matched 3D points (Horn's quaternion method).

function jacobiMaxEigenvector(A) {
  // Cyclic Jacobi on a symmetric 4×4 matrix; returns the eigenvector of the largest eigenvalue.
  const a = A.map((r) => r.slice());
  const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [V[0][best], V[1][best], V[2][best], V[3][best]];
}

/** { R, t } minimising Σ |R·a_i + t − b_i|² over index lists ia (into A) and ib (into B). */
export function rigidAlign(A, B, ia, ib) {
  const n = ia.length;
  const ca = [0, 0, 0], cb = [0, 0, 0];
  for (let k = 0; k < n; k++) for (let d = 0; d < 3; d++) { ca[d] += A[ia[k] * 3 + d] / n; cb[d] += B[ib[k] * 3 + d] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < n; k++) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += (A[ia[k] * 3 + r] - ca[r]) * (B[ib[k] * 3 + c] - cb[c]);
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w, x, y, z] = jacobiMaxEigenvector(N);
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
  const rc = mulv(R, ca);
  return { R, t: [cb[0] - rc[0], cb[1] - rc[1], cb[2] - rc[2]] };
}

/**
 * Is `cand` (a stored view) the same place as `cur`? Returns { pose: cur camera in cand's camera
 * frame, inliers, matches } or null. intr: { f, cx, cy } of the rectified camera.
 */
export function verifyPlace(cur, cand, intr, { minInliers = 25, iters = 300 } = {}) {
  const pairs = matchDescriptors(cur.desc, cand.desc);
  if (pairs.length < minInliers) return null;
  const A = cur.pts3, B = cand.pts3;
  // Stereo depth error grows with distance squared, so allow more slack far away.
  const tol = (k) => 0.05 + 0.025 * B[pairs[k][1] * 3 + 2] ** 2;
  const errOf = (T, k) => {
    const [i, j] = pairs[k];
    const p = mulv(T.R, [A[i * 3], A[i * 3 + 1], A[i * 3 + 2]]);
    return Math.hypot(p[0] + T.t[0] - B[j * 3], p[1] + T.t[1] - B[j * 3 + 1], p[2] + T.t[2] - B[j * 3 + 2]);
  };
  let seed = 7, best = null;
  const rand = (n) => ((seed = (seed * 16807) % 2147483647) % n);
  for (let it = 0; it < iters; it++) {
    const s = [rand(pairs.length), rand(pairs.length), rand(pairs.length)];
    if (s[0] === s[1] || s[1] === s[2] || s[0] === s[2]) continue;
    const T = rigidAlign(A, B, s.map((k) => pairs[k][0]), s.map((k) => pairs[k][1]));
    let count = 0;
    for (let k = 0; k < pairs.length; k++) if (errOf(T, k) < tol(k)) count++;
    if (!best || count > best.count) best = { T, count };
  }
  if (!best || best.count < minInliers * 0.6) return null;
  const inl = pairs.filter((_, k) => errOf(best.T, k) < tol(k));
  const T = rigidAlign(A, B, inl.map((p) => p[0]), inl.map((p) => p[1]));
  // Confirm by projecting the stored 3D points into the current image.
  const X = new Float64Array(inl.length * 3), uv = new Float64Array(inl.length * 2);
  inl.forEach(([i, j], k) => {
    X[k * 3] = B[j * 3]; X[k * 3 + 1] = B[j * 3 + 1]; X[k * 3 + 2] = B[j * 3 + 2];
    uv[k * 2] = cur.uv[i * 2]; uv[k * 2 + 1] = cur.uv[i * 2 + 1];
  });
  const r = refinePose(invert(T), X, uv, intr, { huber: 1.5 });
  const good = [...r.err].filter((e) => e < 2.5).length;
  if (good < minInliers) return null;
  return { pose: invert(r.pose), inliers: good, matches: pairs.length };
}

/** Rotation R minimising Σ |R·a − b|² for unit vectors (no translation): Horn's method, uncentred. */
function rotationOnly(A, B, ia, ib) {
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < ia.length; k++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += A[ia[k] * 3 + r] * B[ib[k] * 3 + c];
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const [w, x, y, z] = jacobiMaxEigenvector([
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * How the right camera is turned relative to the left, from matched features in the raw images
 * (most of a room is far enough away that a pure rotation explains the shift).
 * Returns { R (left-camera directions → right-camera directions), inliers, yaw, pitch, roll } or null.
 */
export function estimateRotation(L, R, w, h, intr, baseline = 0.12, farthest = 8) {
  const feats = (img) => {
    const pts = goodFeatures(buildPyramid(img, w, h, 1)[0], { maxCorners: 400, minDistance: 7, border: PATCH + 2 });
    return { pts, desc: brief(blur(img, w, h), w, pts) };
  };
  const a = feats(L), b = feats(R);
  const pairs = matchDescriptors(a.desc, b.desc, { maxDist: 70, ratio: 0.85 });
  if (pairs.length < 20) return null;
  const ray = (pts, i) => {
    const x = (pts[2 * i] - intr.cx) / intr.f, y = (pts[2 * i + 1] - intr.cy) / intr.f, n = Math.hypot(x, y, 1);
    return [x / n, y / n, 1 / n];
  };
  const A = [], B = [];
  for (const [i, j] of pairs) { A.push(...ray(a.pts, i)); B.push(...ray(b.pts, j)); }
  const tol = 1.5 / intr.f; // ~1.5 px
  const err = (Rm, k) => {
    const p = mulv(Rm, [A[k * 3], A[k * 3 + 1], A[k * 3 + 2]]);
    return Math.hypot(p[0] - B[k * 3], p[1] - B[k * 3 + 1], p[2] - B[k * 3 + 2]);
  };
  let seed = 11, best = null;
  const n = pairs.length;
  for (let it = 0; it < 400; it++) {
    const i = (seed = (seed * 16807) % 2147483647) % n, j = (seed = (seed * 16807) % 2147483647) % n;
    if (i === j) continue;
    const Rm = rotationOnly(A, B, [i, j], [i, j]);
    let c = 0;
    for (let k = 0; k < n; k++) if (err(Rm, k) < tol) c++;
    if (!best || c > best.c) best = { Rm, c };
  }
  if (!best || best.c < 20) return null;
  const inl = [...Array(n).keys()].filter((k) => err(best.Rm, k) < tol);
  let Rm = rotationOnly(A, B, inl, inl);
  // Tilt and roll come out exactly, but left–right angle can't be told apart from the sideways
  // shift the camera spacing causes (that needs a known distance). Set it so the farthest matches
  // sit at a plausible indoor distance; calibrating with a known distance pins it down properly.
  const dispAt = (Rx) => {
    const half = expSO3(logSO3(Rx).map((v) => v / 2)), back = tr3(half);
    const d = inl.map((k) => {
      const a = mulv(half, [A[k * 3], A[k * 3 + 1], A[k * 3 + 2]]), b = mulv(back, [B[k * 3], B[k * 3 + 1], B[k * 3 + 2]]);
      return intr.f * (a[0] / a[2] - b[0] / b[2]);
    }).sort((p, q) => p - q);
    return d[Math.floor(d.length * 0.05)];
  };
  const target = (intr.f * baseline) / farthest;
  const yawed = (e) => mul3(rotY(e), Rm);
  let lo = -0.2, hi = 0.2;
  if ((dispAt(yawed(lo)) - target) * (dispAt(yawed(hi)) - target) < 0) {
    const up = dispAt(yawed(hi)) > dispAt(yawed(lo));
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if ((dispAt(yawed(mid)) > target) === up) hi = mid; else lo = mid;
    }
    Rm = yawed((lo + hi) / 2);
  }
  // Where the right camera points, seen from the left camera (+ yaw = right, + pitch = down).
  const fwd = [Rm[6], Rm[7], Rm[8]]; // third row = R^T·(0,0,1)
  const deg = 180 / Math.PI;
  return {
    R: Rm, inliers: inl.length, matches: n,
    yaw: Math.atan2(fwd[0], fwd[2]) * deg, pitch: Math.asin(Math.max(-1, Math.min(1, fwd[1]))) * deg,
    roll: Math.atan2(Rm[3], Rm[4]) * deg, angle: Math.hypot(...logSO3(Rm)) * deg,
  };
}
