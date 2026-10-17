// Dense stereo for keyframes: block matching on rectified images. Each image is first normalised
// by its local mean and contrast, so the two webcams' different exposure doesn't matter; then a
// sum of absolute differences over a small window picks the disparity, with uniqueness, texture
// and left-right checks to drop guesses. Pure functions, no DOM.

/** (I − local mean) / (local std + 8), plus the local std (for the texture check). */
export function localNormalize(src, w, h, r = 4) {
  const W = w + 1;
  const s1 = new Float64Array(W * (h + 1)), s2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      a += v;
      b += v * v;
      s1[(y + 1) * W + x + 1] = s1[y * W + x + 1] + a;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + b;
    }
  }
  const data = new Float32Array(w * h), std = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = (s1[y1 * W + x1] - s1[y0 * W + x1] - s1[y1 * W + x0] + s1[y0 * W + x0]) / n;
      const q = (s2[y1 * W + x1] - s2[y0 * W + x1] - s2[y1 * W + x0] + s2[y0 * W + x0]) / n;
      const sd = Math.sqrt(Math.max(0, q - m * m));
      std[y * w + x] = sd;
      data[y * w + x] = (src[y * w + x] - m) / (sd + 8);
    }
  }
  return { data, std };
}

/**
 * Disparity of every left pixel (Float32Array, −1 = no reliable match).
 * L, R: normalised rectified images. opts.texture: local std of the left image;
 * opts.validL / validR: which rectified pixels came from inside the original images.
 *
 * Streams over disparities instead of storing the whole cost volume: each pixel keeps its best
 * cost, the runner-up away from the best, the costs either side of the best (for sub-pixel
 * refinement), and each right pixel keeps its own best (for the left-right check).
 */
export function disparityBM(L, R, w, h, { maxDisp = 64, r = 3, uniqueness = 0.12, texture = null, minTexture = 3, validL = null, validR = null } = {}) {
  const D = maxDisp, n = w * h, k = 2 * r + 1;
  const cost = new Float32Array(n), hs = new Float32Array(n), agg = new Float32Array(n);
  const best = new Float32Array(n).fill(Infinity), second = new Float32Array(n).fill(Infinity);
  const cPrev = new Float32Array(n).fill(Infinity), cNext = new Float32Array(n).fill(Infinity);
  const last = new Float32Array(n).fill(Infinity), rBest = new Float32Array(n).fill(Infinity);
  const bestD = new Int16Array(n).fill(-1), rBestD = new Int16Array(n).fill(-1);
  for (let d = 0; d < D; d++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) cost[row + x] = x >= d ? Math.abs(L[row + x] - R[row + x - d]) : 4;
    }
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = 0; x < w; x++) {
        acc += cost[row + x];
        if (x >= k) acc -= cost[row + x - k];
        if (x >= k - 1) hs[row + x - r] = acc;
      }
    }
    for (let x = r; x < w - r; x++) {
      let acc = 0;
      for (let y = 0; y < h; y++) {
        acc += hs[y * w + x];
        if (y >= k) acc -= hs[(y - k) * w + x];
        if (y >= k - 1) agg[(y - r) * w + x] = acc;
      }
    }
    // Only pixels whose whole window (shifted by d) lies inside the image.
    const x0 = r + 1 + d;
    if (x0 >= w - r) continue;
    for (let y = r; y < h - r; y++) {
      for (let x = x0, i = y * w + x0; x < w - r; x++, i++) {
        const c = agg[i];
        const bd = bestD[i];
        if (c < best[i]) {
          if (bd >= 0 && d - bd > 1 && best[i] < second[i]) second[i] = best[i];
          cPrev[i] = last[i];
          cNext[i] = Infinity;
          best[i] = c;
          bestD[i] = d;
        } else if (d - bd === 1) {
          cNext[i] = c;
        } else if (c < second[i]) {
          second[i] = c;
        }
        last[i] = c;
        const j = i - d; // the right-image pixel this pairs with
        if (c < rBest[j]) { rBest[j] = c; rBestD[j] = d; }
      }
    }
  }
  const disp = new Float32Array(n).fill(-1);
  for (let y = r; y < h - r; y++) {
    for (let x = r + 1; x < w - r; x++) {
      const i = y * w + x, bd = bestD[i];
      if (bd < 1) continue;
      if (texture && texture[i] < minTexture) continue;
      if (validL && !validL[i]) continue;
      if (validR && !validR[i - bd]) continue;
      if (second[i] < best[i] * (1 + uniqueness)) continue;
      if (Math.abs(rBestD[i - bd] - bd) > 1) continue;
      let sub = bd;
      const c0 = cPrev[i], c2 = cNext[i], den = c0 - 2 * best[i] + c2;
      if (Number.isFinite(den) && den > 0) sub = bd + Math.max(-0.5, Math.min(0.5, (c0 - c2) / (2 * den)));
      disp[i] = sub;
    }
  }
  return disp;
}
