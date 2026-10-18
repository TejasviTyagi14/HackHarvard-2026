// Rectification: warp both images so the pair behaves like two parallel cameras, with matching
// points on the same row. Built from the same rig numbers the rest of the app uses (spacing,
// angle, field of view, and the learned vertical offset). Pure functions, no DOM.
import { buildRig } from '../geometry.js';
import { expSO3, logSO3, mulv, tr3 } from './se3.js';

/**
 * Remap tables for a w × h pair. vOffsetPx = how far the right image sits below the left one at
 * this size. The rectified cameras keep the rig's orientation and the original focal length.
 * Returns { mapL, mapR, validL, validR, f, cx, cy, baseline, w, h }.
 */
export function rectification(params, w, h, vOffsetPx = 0) {
  const rig = buildRig(params, { w, h });
  const f = rig.left.f, cx = w / 2, cy = h / 2;
  if (params.Rrel) return rectifyMeasured(params.Rrel, rig, w, h, vOffsetPx);
  const [mapL, mapR] = [rig.left, rig.right].map((cam, side) => {
    const map = new Float32Array(w * h * 2);
    const c = cam.cos, s = cam.sin;
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        // Ray in the rig frame, turned into this camera's frame (undoing its yaw).
        const dx = (u - cx) / f, dy = (v - cy) / f;
        const qx = c * dx - s, qz = s * dx + c;
        const i = (v * w + u) * 2;
        map[i] = cam.cx + (cam.f * qx) / qz;
        map[i + 1] = cam.cy + (cam.f * dy) / qz + (side ? vOffsetPx : 0);
      }
    }
    return map;
  });
  const valid = (map) => {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const x = map[2 * i], y = map[2 * i + 1];
      m[i] = x >= 0 && y >= 0 && x <= w - 2 && y <= h - 2 ? 1 : 0;
    }
    return m;
  };
  return { mapL, mapR, validL: valid(mapL), validR: valid(mapR), f, cx, cy, baseline: rig.baseline, w, h };
}

/**
 * Rectification from a measured rotation between the cameras (Rrel: left-camera directions →
 * right-camera directions). Both are turned halfway toward each other, so the shared view sits
 * in the middle; this also takes out any tilt or roll between them.
 */
function rectifyMeasured(Rrel, rig, w, h, vOffsetPx) {
  const f = rig.left.f, cx = w / 2, cy = h / 2;
  const half = expSO3(logSO3(Rrel).map((v) => v / 2));
  const turns = [tr3(half), half]; // rectified direction → each camera's direction
  const [mapL, mapR] = turns.map((Rt, side) => {
    const map = new Float32Array(w * h * 2);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const d = mulv(Rt, [(u - cx) / f, (v - cy) / f, 1]);
        const i = (v * w + u) * 2;
        map[i] = d[2] > 0.05 ? cx + (f * d[0]) / d[2] : -1;
        map[i + 1] = d[2] > 0.05 ? cy + (f * d[1]) / d[2] + (side ? vOffsetPx : 0) : -1;
      }
    }
    return map;
  });
  const valid = (map) => Uint8Array.from({ length: w * h }, (_, i) => {
    const x = map[2 * i], y = map[2 * i + 1];
    return x >= 0 && y >= 0 && x <= w - 2 && y <= h - 2 ? 1 : 0;
  });
  return { mapL, mapR, validL: valid(mapL), validR: valid(mapR), f, cx, cy, baseline: rig.baseline, w, h };
}

/** Bilinear warp of a grayscale image through a remap table (out-of-range pixels clamp to the edge). */
export function remap(src, w, h, map, out = new Float32Array(w * h)) {
  for (let i = 0; i < w * h; i++) {
    const x = Math.min(w - 1.001, Math.max(0, map[2 * i]));
    const y = Math.min(h - 1.001, Math.max(0, map[2 * i + 1]));
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, j = y0 * w + x0;
    out[i] = (src[j] * (1 - fx) + src[j + 1] * fx) * (1 - fy) + (src[j + w] * (1 - fx) + src[j + w + 1] * fx) * fy;
  }
  return out;
}
