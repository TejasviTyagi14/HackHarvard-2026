// Stereo matching on grayscale frames: integral images, normalized cross-correlation (NCC),
// an epipolar search that walks a pixel's ray across the other image, and a geometry-free
// band search used while calibrating (when the rig numbers can't be trusted yet).
// Pure functions, no DOM.
import { pixelRay, pointAlong, project, triangulate } from './geometry.js';

export class GrayFrame {
  constructor(w, h, data) {
    this.w = w;
    this.h = h;
    this.data = data;
    const W = w + 1;
    const sum = new Float64Array(W * (h + 1));
    const sq = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0, rq = 0;
      for (let x = 0; x < w; x++) {
        const v = data[y * w + x];
        rs += v;
        rq += v * v;
        sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + rs;
        sq[(y + 1) * W + x + 1] = sq[y * W + x + 1] + rq;
      }
    }
    this.sum = sum;
    this.sq = sq;
  }

  static fromRGBA(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    return new GrayFrame(w, h, g);
  }

  inside(x, y, r) {
    return x - r >= 0 && y - r >= 0 && x + r < this.w && y + r < this.h;
  }

  /** Mean and standard deviation of the (2r+1)² window centred on integer (x, y). */
  stats(x, y, r) {
    const W = this.w + 1, x0 = x - r, y0 = y - r, x1 = x + r + 1, y1 = y + r + 1;
    const n = (2 * r + 1) * (2 * r + 1);
    const s = this.sum[y1 * W + x1] - this.sum[y0 * W + x1] - this.sum[y1 * W + x0] + this.sum[y0 * W + x0];
    const q = this.sq[y1 * W + x1] - this.sq[y0 * W + x1] - this.sq[y1 * W + x0] + this.sq[y0 * W + x0];
    const mean = s / n;
    return { mean, std: Math.sqrt(Math.max(0, q / n - mean * mean)) };
  }
}

/** Zero-mean template around (x, y), rounded to the nearest pixel. */
export function makePatch(frame, x, y, r) {
  x = Math.round(x);
  y = Math.round(y);
  if (!frame.inside(x, y, r)) return null;
  const { mean, std } = frame.stats(x, y, r);
  const n = (2 * r + 1) * (2 * r + 1);
  const vals = new Float32Array(n);
  let k = 0;
  for (let dy = -r; dy <= r; dy++) {
    const row = (y + dy) * frame.w;
    for (let dx = -r; dx <= r; dx++) vals[k++] = frame.data[row + x + dx] - mean;
  }
  return { vals, std, r, n, x, y };
}

/** NCC of a patch against the window at integer (x, y): 1 = identical, -2 = out of bounds. */
export function ncc(P, frame, x, y) {
  const r = P.r;
  if (!frame.inside(x, y, r)) return -2;
  const { std } = frame.stats(x, y, r);
  if (std < 1e-3 || P.std < 1e-3) return 0;
  const w = frame.w, d = frame.data, vals = P.vals;
  let acc = 0, k = 0;
  for (let dy = -r; dy <= r; dy++) {
    let i = (y + dy) * w + x - r;
    for (let dx = -r; dx <= r; dx++) acc += vals[k++] * d[i++];
  }
  return acc / (P.n * P.std * std);
}

/** Sub-pixel offset of a peak from three samples (left, centre, right). */
function parabola(a, b, c) {
  if (a < -1 || c < -1) return 0;
  const den = a - 2 * b + c;
  if (den >= 0) return 0;
  return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
}

/** Highest local maximum farther than `excl` from the winner (repeating-texture check). */
function secondPeak(scores, bi, excl) {
  let second = -1;
  for (let i = 1; i < scores.length - 1; i++) {
    if (Math.abs(i - bi) <= excl) continue;
    const s = scores[i];
    if (s > second && s >= scores[i - 1] && s >= scores[i + 1]) second = s;
  }
  return second;
}

/** Where pixel (u, v) of camA can appear in camB, for depths from `near` to `far` metres. */
export function epipolarSegment(camA, camB, u, v, near = 0.15, far = 100) {
  const ray = pixelRay(camA, u, v);
  let pN = null;
  for (let s = near; !pN && s < 20; s *= 1.5) pN = project(camB, pointAlong(ray, s));
  const pF = project(camB, pointAlong(ray, far));
  if (!pN || !pF) return null;
  return { ray, near: pN, far: pF };
}

/**
 * Finds pixel (u, v) of frameA in frameB by sliding a patch along its epipolar line
 * (± vtol rows, shifted by vOffset), optionally restricted to columns [xMin, xMax].
 * Returns the match, its score, the runner-up peak, and the triangulated point.
 */
export function epipolarSearch(frameA, frameB, camA, camB, u, v, opts = {}) {
  const { r = 6, vtol = 3, vOffset = 0, xMin = -Infinity, xMax = Infinity, minTexture = 3 } = opts;
  const P = makePatch(frameA, u, v, r);
  if (!P) return { ok: false, reason: 'edge' };
  if (P.std < minTexture) return { ok: false, reason: 'texture', texture: P.std };
  const seg = epipolarSegment(camA, camB, P.x, P.y);
  if (!seg) return { ok: false, reason: 'view' };
  const { near: pN, far: pF } = seg;
  const dx = pN.u - pF.u, dy = pN.v - pF.v;
  if (Math.abs(dx) < Math.abs(dy)) return { ok: false, reason: 'geometry', seg };
  const slope = dx === 0 ? 0 : dy / dx;
  const lo = Math.max(r + 1, Math.ceil(Math.max(xMin, Math.min(pF.u, pN.u))));
  const hi = Math.min(frameB.w - r - 2, Math.floor(Math.min(xMax, Math.max(pF.u, pN.u))));
  if (hi < lo) return { ok: false, reason: 'view', seg };
  const n = hi - lo + 1;
  const scores = new Float32Array(n), ys = new Int32Array(n);
  let bi = -1, bs = -2;
  for (let i = 0; i < n; i++) {
    const x = lo + i;
    const yl = Math.round(pF.v + (x - pF.u) * slope + vOffset);
    let best = -2, by = yl;
    for (let d = -vtol; d <= vtol; d++) {
      const s = ncc(P, frameB, x, yl + d);
      if (s > best) { best = s; by = yl + d; }
    }
    scores[i] = best;
    ys[i] = by;
    if (best > bs) { bs = best; bi = i; }
  }
  if (bs <= -1) return { ok: false, reason: 'view', seg };
  // A best match pinned to the end of the search range means the real one is probably outside it.
  if (n > 2 && (bi === 0 || bi === n - 1)) return { ok: false, reason: 'weak', seg, score: bs };
  const second = secondPeak(scores, bi, Math.max(2, r));
  const x0 = lo + bi, y0 = ys[bi];
  const fx = parabola(ncc(P, frameB, x0 - 1, y0), bs, ncc(P, frameB, x0 + 1, y0));
  const fy = parabola(ncc(P, frameB, x0, y0 - 1), bs, ncc(P, frameB, x0, y0 + 1));
  const uB = x0 + fx, vB = y0 + fy;
  const tri = triangulate(seg.ray, pixelRay(camB, uB, vB));
  return {
    ok: true, uA: P.x, vA: P.y, uB, vB, score: bs, second, margin: bs - Math.max(second, 0),
    dyLine: vB - (pF.v + (uB - pF.u) * slope), tri, seg, texture: P.std,
  };
}

/**
 * Geometry-free search: best match for (u, v) of frameA inside a window of frameB
 * (columns xMin..xMax, rows yMin..yMax). Used when the rig numbers can't be trusted yet.
 */
export function windowSearch(frameA, frameB, u, v, { r = 8, xMin = 0, xMax = Infinity, yMin = -Infinity, yMax = Infinity, minTexture = 3 } = {}) {
  const P = makePatch(frameA, u, v, r);
  if (!P) return { ok: false, reason: 'edge' };
  if (P.std < minTexture) return { ok: false, reason: 'texture' };
  const y0 = Math.max(r + 1, Math.ceil(yMin)), y1 = Math.min(frameB.h - r - 2, Math.floor(yMax));
  const x0 = Math.max(r + 1, Math.ceil(xMin)), x1 = Math.min(frameB.w - r - 2, Math.floor(xMax));
  if (y1 < y0 || x1 < x0) return { ok: false, reason: 'edge' };
  const n = x1 - x0 + 1;
  const cols = new Float32Array(n), colY = new Int32Array(n);
  let bi = -1, bs = -2;
  for (let i = 0; i < n; i++) {
    let best = -2, by = y0;
    for (let y = y0; y <= y1; y++) {
      const s = ncc(P, frameB, x0 + i, y);
      if (s > best) { best = s; by = y; }
    }
    cols[i] = best;
    colY[i] = by;
    if (best > bs) { bs = best; bi = i; }
  }
  // Best at a window edge that isn't the image edge: the real match is probably outside.
  if (n > 2 && ((bi === 0 && x0 > r + 1) || (bi === n - 1 && x1 < frameB.w - r - 2))) return { ok: false, reason: 'weak', score: bs };
  const second = secondPeak(cols, bi, r);
  const bx = x0 + bi, by = colY[bi];
  const fx = parabola(ncc(P, frameB, bx - 1, by), bs, ncc(P, frameB, bx + 1, by));
  const fy = parabola(ncc(P, frameB, bx, by - 1), bs, ncc(P, frameB, bx, by + 1));
  return { ok: true, uA: P.x, vA: P.y, uB: bx + fx, vB: by + fy, score: bs, second, margin: bs - Math.max(second, 0) };
}

/** Best match for (u, v) anywhere in a horizontal band of frameB (calibration clicks). */
export function bandSearch(frameA, frameB, u, v, { r = 8, band = 24, minTexture = 3 } = {}) {
  const y = Math.round(v);
  return windowSearch(frameA, frameB, u, v, { r, minTexture, yMin: y - band, yMax: y + band });
}

/** Snaps a hand-placed match (uB, vB) to the best NCC position within ± radius pixels. */
export function localSearch(frameA, frameB, uA, vA, uB, vB, { r = 8, radius = 8 } = {}) {
  const P = makePatch(frameA, uA, vA, r);
  if (!P) return { ok: false, reason: 'edge' };
  if (P.std < 1e-3) return { ok: false, reason: 'texture' };
  const cx = Math.round(uB), cy = Math.round(vB);
  let bs = -2, bx = cx, by = cy;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const s = ncc(P, frameB, x, y);
      if (s > bs) { bs = s; bx = x; by = y; }
    }
  }
  if (bs <= -1) return { ok: false, reason: 'edge' };
  const fx = parabola(ncc(P, frameB, bx - 1, by), bs, ncc(P, frameB, bx + 1, by));
  const fy = parabola(ncc(P, frameB, bx, by - 1), bs, ncc(P, frameB, bx, by + 1));
  return { ok: true, uA: P.x, vA: P.y, uB: bx + fx, vB: by + fy, score: bs };
}

/** Variance of the Laplacian over the central part of the frame: higher = sharper. */
export function sharpness(frame, frac = 0.5) {
  const { w, h, data } = frame;
  const x0 = Math.max(1, Math.floor((w * (1 - frac)) / 2)), x1 = Math.min(w - 2, Math.floor((w * (1 + frac)) / 2));
  const y0 = Math.max(1, Math.floor((h * (1 - frac)) / 2)), y1 = Math.min(h - 2, Math.floor((h * (1 + frac)) / 2));
  let s = 0, q = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
      s += lap;
      q += lap * lap;
      n++;
    }
  }
  return n ? q / n - (s / n) ** 2 : 0;
}
