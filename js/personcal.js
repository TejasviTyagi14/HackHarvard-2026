// Calibrating from a person who stands at a known distance: find them in both views, match
// points on their torso, then solve the angle between the cameras (one distance) or the angle
// and the spacing between them (two distances). Pure logic, no DOM.
//
// Why two distances for the spacing: at one distance, a wider spacing and a bigger toe-in angle
// can produce exactly the same picture, so only one of the two can be pinned down. A second
// distance separates them, because spacing matters less with distance and angle doesn't.
import { buildRig, fitRig, readDistance } from './geometry.js';
import { epipolarSegment, windowSearch } from './stereo.js';
import { median } from './scene.js';

// Where on the person's box to match: chest to thighs, away from the arms and the background.
const GRID_X = [0.32, 0.44, 0.56, 0.68];
const GRID_Y = [0.22, 0.32, 0.42, 0.52, 0.62];
const area = (b) => b[2] * b[3];

/** The one person to measure in each view: { boxL, boxR } or { error }. */
export function pickPerson(detsL, detsR) {
  const people = (dets) => dets.filter((d) => d.class === 'person').sort((a, b) => area(b.bbox) - area(a.bbox));
  const L = people(detsL), R = people(detsR);
  if (!L.length || !R.length) return { error: 'no-person' };
  // A second person nearly as big as the first makes it unclear who is being measured.
  if ((L[1] && area(L[1].bbox) > 0.5 * area(L[0].bbox)) || (R[1] && area(R[1].bbox) > 0.5 * area(R[0].bbox))) return { error: 'several' };
  const a = L[0].bbox, b = R[0].bbox;
  if (Math.abs(Math.log(a[3] / b[3])) > 0.4) return { error: 'mismatch' };
  return { boxL: a, boxR: b };
}

/**
 * Points on the person's torso matched between the views, each confirmed by matching back:
 * [{ uL, vL, uR, vR, score, sizeL, sizeR }] in processing pixels.
 */
export function personMatches(frameL, frameR, boxL, boxR, { vOffset = 0, band = 12, r = 7, minScore = 0.8 } = {}) {
  const sizeL = { w: frameL.w, h: frameL.h }, sizeR = { w: frameR.w, h: frameR.h };
  const out = [];
  for (const fy of GRID_Y) {
    for (const fx of GRID_X) {
      const u = boxL[0] + fx * boxL[2], v = boxL[1] + fy * boxL[3];
      const ou = boxR[0] + fx * boxR[2], pad = Math.max(10, 0.35 * boxR[2]);
      const m = windowSearch(frameL, frameR, u, v, { r, xMin: ou - pad, xMax: ou + pad, yMin: v + vOffset - band, yMax: v + vOffset + band });
      if (!m.ok || m.score < minScore || m.margin < 0.03) continue;
      const back = windowSearch(frameR, frameL, m.uB, m.vB, {
        r, xMin: boxL[0], xMax: boxL[0] + boxL[2], yMin: m.vB - vOffset - band, yMax: m.vB - vOffset + band,
      });
      if (!back.ok || Math.abs(back.uB - m.uA) > 2 || Math.abs(back.vB - m.vA) > 2) continue;
      out.push({ uL: m.uA, vL: m.vA, uR: m.uB, vR: m.vB, score: m.score, sizeL, sizeR });
    }
  }
  return out;
}

/**
 * Drops matches whose raw disparity is far from the rest (background, wrong matches), then
 * keeps up to n of them spread evenly across what's left.
 */
export function robustSubset(samples, n = 16) {
  if (!samples.length) return [];
  const disp = (s) => s.uL - s.uR;
  const med = median(samples.map(disp));
  const tol = Math.max(2, 0.15 * Math.abs(med));
  const kept = samples.filter((s) => Math.abs(disp(s) - med) <= tol).sort((a, b) => disp(a) - disp(b));
  if (kept.length <= n) return kept;
  return Array.from({ length: n }, (_, i) => kept[Math.round((i * (kept.length - 1)) / (n - 1))]);
}

/** What the rig numbers say the person's floor distance is (median over their matched points). */
export function personReading(position, params) {
  const reads = robustSubset(position.samples, 64)
    .map((s) => readDistance({ ...s, horizontal: true }, params))
    .filter((r) => r != null);
  return median(reads);
}

/** The spacing needs two positions at clearly different distances (e.g. 2 m and 4 m). */
export function canSolveSpacing(positions) {
  const d = positions.filter(Boolean).map((p) => p.trueRange);
  return d.length >= 2 && Math.max(...d) / Math.min(...d) >= 1.4;
}

/**
 * positions: [{ trueRange (m, along the floor), samples: personMatches(...) }, ...]
 * params: current rig numbers (+ tiltDeg). With one position solves the angle and keeps the
 * spacing; with two at different distances solves both. Each position counts equally.
 */
export function fitFromPerson(positions, params) {
  const pos = positions.filter((p) => p?.samples?.length);
  if (!pos.length) return null;
  const solve = canSolveSpacing(pos) ? ['baselineCm', 'angleDeg'] : ['angleDeg'];
  const samples = pos.flatMap((p) => {
    const sub = robustSubset(p.samples);
    return sub.map((s) => ({ ...s, trueRange: p.trueRange, horizontal: true, weight: 1 / sub.length }));
  });
  return fitRig(samples, params, solve);
}

/** How far the right image sits above (−) or below (+) where the rig numbers expect it. */
export function verticalOffset(samples, params) {
  const dys = samples.map((s) => {
    const rig = buildRig(params, s.sizeL, s.sizeR);
    const seg = epipolarSegment(rig.left, rig.right, s.uL, s.vL);
    if (!seg) return null;
    const slope = (seg.near.v - seg.far.v) / (seg.near.u - seg.far.u || 1);
    return s.vR - (seg.far.v + (s.uR - seg.far.u) * slope);
  }).filter((d) => d != null);
  return dys.length ? median(dys) : null;
}
