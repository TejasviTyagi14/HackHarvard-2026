// Feature tracking for visual odometry: image pyramids, Shi-Tomasi corners, and pyramidal
// Lucas-Kanade optical flow (KLT) with a forward-backward check. Works on Float32 grayscale
// images (0–255). Pure functions, no DOM.

/** Blurs with [1 4 6 4 1]/16 and keeps every other pixel. */
export function pyrDown(src, w, h) {
  const W = w >> 1, H = h >> 1;
  const tmp = new Float32Array(W * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let X = 0; X < W; X++) {
      const x = 2 * X;
      tmp[y * W + X] = (src[row + Math.max(0, x - 2)] + 4 * src[row + Math.max(0, x - 1)] + 6 * src[row + x]
        + 4 * src[row + Math.min(w - 1, x + 1)] + src[row + Math.min(w - 1, x + 2)]) / 16;
    }
  }
  const out = new Float32Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const y = 2 * Y;
    const r = [-2, -1, 0, 1, 2].map((k) => Math.min(h - 1, Math.max(0, y + k)) * W);
    for (let X = 0; X < W; X++) {
      out[Y * W + X] = (tmp[r[0] + X] + 4 * tmp[r[1] + X] + 6 * tmp[r[2] + X] + 4 * tmp[r[3] + X] + tmp[r[4] + X]) / 16;
    }
  }
  return { data: out, w: W, h: H };
}

/** Scharr gradients, scaled to intensity change per pixel. */
function gradients(img, w, h) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = img[i - w - 1], b = img[i - w], c = img[i - w + 1];
      const d = img[i - 1], e = img[i + 1];
      const f = img[i + w - 1], g = img[i + w], k = img[i + w + 1];
      gx[i] = (3 * (c - a) + 10 * (e - d) + 3 * (k - f)) / 32;
      gy[i] = (3 * (f - a) + 10 * (g - b) + 3 * (k - c)) / 32;
    }
  }
  return { gx, gy };
}

/** [{ data, w, h, gx, gy }], level 0 = full size. */
export function buildPyramid(img, w, h, levels = 3) {
  const pyr = [];
  let cur = { data: img, w, h };
  for (let L = 0; L < levels; L++) {
    pyr.push({ ...cur, ...gradients(cur.data, cur.w, cur.h) });
    if (L < levels - 1) cur = pyrDown(cur.data, cur.w, cur.h);
  }
  return pyr;
}

// Bilinear sample; callers keep (x, y) at least one pixel inside the image.
function bilinear(img, w, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

function boxSum(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      s += src[y * w + x];
      if (x > 2 * r) s -= src[y * w + x - 2 * r - 1];
      if (x >= 2 * r) tmp[y * w + x - r] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) {
      s += tmp[y * w + x];
      if (y > 2 * r) s -= tmp[(y - 2 * r - 1) * w + x];
      if (y >= 2 * r) out[(y - r) * w + x] = s;
    }
  }
  return out;
}

/**
 * Shi-Tomasi corners on a pyramid level: strongest first, at least minDistance apart, outside
 * `mask` (Uint8Array, 1 = taken). Returns a flat Float32Array [x0, y0, x1, y1, …].
 */
export function goodFeatures(level, { maxCorners = 200, minDistance = 10, quality = 0.02, minResponse = 2, border = 10, mask = null } = {}) {
  const { w, h, gx, gy } = level;
  const n = w * h;
  const xx = new Float32Array(n), xy = new Float32Array(n), yy = new Float32Array(n);
  for (let i = 0; i < n; i++) { xx[i] = gx[i] * gx[i]; xy[i] = gx[i] * gy[i]; yy[i] = gy[i] * gy[i]; }
  const A = boxSum(xx, w, h, 2), B = boxSum(xy, w, h, 2), C = boxSum(yy, w, h, 2);
  const resp = new Float32Array(n);
  let max = 0;
  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      const i = y * w + x, a = A[i] / 25, b = B[i] / 25, c = C[i] / 25;
      const l = 0.5 * (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b));
      resp[i] = l;
      if (l > max) max = l;
    }
  }
  const thr = Math.max(quality * max, minResponse);
  const cands = [];
  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      const i = y * w + x, v = resp[i];
      if (v < thr || (mask && mask[i])) continue;
      if (v < resp[i - 1] || v < resp[i + 1] || v < resp[i - w] || v < resp[i + w]
        || v < resp[i - w - 1] || v < resp[i - w + 1] || v < resp[i + w - 1] || v < resp[i + w + 1]) continue;
      cands.push(i);
    }
  }
  cands.sort((p, q) => resp[q] - resp[p]);
  const cell = Math.max(1, minDistance);
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = Array.from({ length: gw * gh }, () => []);
  const out = [];
  const d2 = minDistance * minDistance;
  for (const i of cands) {
    if (out.length / 2 >= maxCorners) break;
    const x = i % w, y = (i / w) | 0;
    const cx = (x / cell) | 0, cy = (y / cell) | 0;
    let ok = true;
    for (let gyy = Math.max(0, cy - 1); ok && gyy <= Math.min(gh - 1, cy + 1); gyy++) {
      for (let gxx = Math.max(0, cx - 1); ok && gxx <= Math.min(gw - 1, cx + 1); gxx++) {
        for (const [px, py] of grid[gyy * gw + gxx]) if ((px - x) ** 2 + (py - y) ** 2 < d2) { ok = false; break; }
      }
    }
    if (!ok) continue;
    grid[cy * gw + cx].push([x, y]);
    out.push(x, y);
  }
  return Float32Array.from(out);
}

/**
 * Pyramidal Lucas-Kanade: where each point of `prev` moved to in `next`. `guess` (same layout as
 * pts, or null) is a predicted position, e.g. from the expected camera motion.
 * Returns { pts, ok } with ok[i] = 1 for points that converged inside the image.
 */
export function trackLK(prev, next, pts, guess = null, { win = 7, iters = 12, eps = 0.02, minEig = 0.5 } = {}) {
  const n = pts.length / 2;
  const out = new Float32Array(n * 2), ok = new Uint8Array(n);
  const top = prev.length - 1;
  const N = (2 * win + 1) ** 2;
  const Iw = new Float32Array(N), Ix = new Float32Array(N), Iy = new Float32Array(N);
  for (let i = 0; i < n; i++) {
    const px0 = pts[2 * i], py0 = pts[2 * i + 1];
    let dx = guess ? (guess[2 * i] - px0) / (1 << top) : 0;
    let dy = guess ? (guess[2 * i + 1] - py0) / (1 << top) : 0;
    let good = true;
    for (let L = top; L >= 0 && good; L--) {
      const P = prev[L], Q = next[L];
      const s = 1 / (1 << L);
      const px = px0 * s, py = py0 * s;
      if (px - win < 1 || py - win < 1 || px + win > P.w - 3 || py + win > P.h - 3) { good = false; break; }
      let a = 0, b = 0, c = 0, k = 0;
      for (let yy = -win; yy <= win; yy++) {
        for (let xx = -win; xx <= win; xx++, k++) {
          Iw[k] = bilinear(P.data, P.w, px + xx, py + yy);
          Ix[k] = bilinear(P.gx, P.w, px + xx, py + yy);
          Iy[k] = bilinear(P.gy, P.w, px + xx, py + yy);
          a += Ix[k] * Ix[k]; b += Ix[k] * Iy[k]; c += Iy[k] * Iy[k];
        }
      }
      const det = a * c - b * b;
      const eig = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / (2 * N);
      if (eig < minEig || det < 1e-6) { good = false; break; }
      let vx = 0, vy = 0;
      for (let it = 0; it < iters; it++) {
        const qx = px + dx + vx, qy = py + dy + vy;
        if (qx - win < 1 || qy - win < 1 || qx + win > Q.w - 3 || qy + win > Q.h - 3) { good = false; break; }
        let bx = 0, by = 0;
        k = 0;
        for (let yy = -win; yy <= win; yy++) {
          for (let xx = -win; xx <= win; xx++, k++) {
            const diff = Iw[k] - bilinear(Q.data, Q.w, qx + xx, qy + yy);
            bx += diff * Ix[k];
            by += diff * Iy[k];
          }
        }
        const ex = (c * bx - b * by) / det, ey = (a * by - b * bx) / det;
        vx += ex;
        vy += ey;
        if (ex * ex + ey * ey < eps * eps) break;
      }
      if (!good) break;
      if (L > 0) { dx = 2 * (dx + vx); dy = 2 * (dy + vy); } else { dx += vx; dy += vy; }
    }
    if (good) {
      out[2 * i] = px0 + dx;
      out[2 * i + 1] = py0 + dy;
      ok[i] = 1;
    }
  }
  return { pts: out, ok };
}

/** KLT forwards, then back again: a track is kept only if it returns within maxErr pixels. */
export function trackFB(prev, next, pts, guess = null, opts = {}, maxErr = 1) {
  const fwd = trackLK(prev, next, pts, guess, opts);
  const back = trackLK(next, prev, fwd.pts, pts, opts);
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    if (!fwd.ok[i] || !back.ok[i]) { fwd.ok[i] = 0; continue; }
    if (Math.hypot(back.pts[2 * i] - pts[2 * i], back.pts[2 * i + 1] - pts[2 * i + 1]) > maxErr) fwd.ok[i] = 0;
  }
  return fwd;
}
