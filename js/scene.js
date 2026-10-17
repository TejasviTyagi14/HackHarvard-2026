// From detector boxes to measured objects: pair boxes across the two cameras, stereo-match a
// few sample points inside each box, triangulate them, then track and smooth over time.
// Also the text helpers (labels, spoken summaries). Pure logic, no DOM.
import { bearing, clockHour, clockLabel, depthUncertainty, dist3, norm, pixelRay, scale, triangulate } from './geometry.js';
import { epipolarSearch } from './stereo.js';

// Where inside a box we try to match (fractions of width, height). Mostly the middle; a
// near-biased pick among them skips points that land on the background behind the object.
export const SAMPLE_POINTS = [[0.5, 0.45], [0.35, 0.35], [0.65, 0.35], [0.35, 0.62], [0.65, 0.62]];

export const MEASURE_DEFAULTS = {
  vtol: 4, // ± rows searched around the epipolar line
  vOffset: 0, // learned vertical misalignment, right image minus left (px)
  minNcc: 0.72, // match score needed when the other camera also boxed the object
  minNccSolo: 0.85, // ...and when only one camera did, so the search is unconstrained
  maxRelError: 0.35, // give up when the expected error is above this fraction of the distance
  tiltDeg: 0,
};

export const REASONS = {
  texture: 'surface too plain to match',
  edge: 'too close to the image edge',
  view: "outside the other camera's view",
  misaligned: "boxes don't line up — check the angle or left/right order",
  rays: "rays don't meet — check the angle or left/right order",
  weak: 'not found in the other camera',
  solo: 'seen by one camera only',
  far: 'too far for this camera spacing',
  geometry: 'cameras look stacked, not side by side',
  inconsistent: 'match not confirmed both ways',
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const boxCenter = ([x, y, w, h]) => [x + w / 2, y + h / 2];

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter || 1);
}

/**
 * Matches left-camera boxes to right-camera boxes of the same class. Cost favours boxes at the
 * same height and size whose centre rays actually meet in front of the rig.
 * Returns [{ i, j, tri, range }] with i or j null for boxes only one camera saw.
 */
export function pairDetections(detsL, detsR, rig, vOffset = 0) {
  const { left: L, right: R } = rig;
  const cands = [];
  detsL.forEach((a, i) => {
    const [ax, ay, aw, ah] = a.bbox;
    detsR.forEach((b, j) => {
      if (a.class !== b.class) return;
      const [bx, by, bw, bh] = b.bbox;
      const hN = (ah / L.h + bh / R.h) / 2;
      const dy = Math.abs((ay + ah / 2) / L.h - (by + bh / 2 - vOffset) / R.h) / hN;
      const dh = Math.abs(Math.log(ah / L.h / (bh / R.h)));
      const dw = Math.abs(Math.log(aw / L.w / (bw / R.w)));
      if (dy > 0.4 || dh > 0.5 || dw > 0.7) return;
      const tri = triangulate(pixelRay(L, ax + aw / 2, ay + ah / 2), pixelRay(R, bx + bw / 2, by + bh / 2));
      const range = tri && tri.valid ? norm(tri.point) : null;
      const geo = range === null ? 0.8 : range < 0.25 ? 0.5 : 0;
      cands.push({ i, j, cost: 2 * dy + dh + 0.5 * dw + geo, tri, range });
    });
  });
  cands.sort((p, q) => p.cost - q.cost);
  const usedL = new Set(), usedR = new Set(), pairs = [];
  for (const c of cands) {
    if (usedL.has(c.i) || usedR.has(c.j)) continue;
    usedL.add(c.i);
    usedR.add(c.j);
    pairs.push(c);
  }
  detsL.forEach((_, i) => usedL.has(i) || pairs.push({ i, j: null }));
  detsR.forEach((_, j) => usedR.has(j) || pairs.push({ i: null, j }));
  return pairs;
}

function explain(samples, paired) {
  const tally = {};
  for (const s of samples) tally[s.fail] = (tally[s.fail] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'weak';
  if (!paired && (top === 'weak' || top === 'view')) return REASONS.solo;
  if (paired && top === 'view') return REASONS.misaligned;
  return REASONS[top] || REASONS.weak;
}

/** Measures one paired (or one-sided) detection. ctx: { detsL, detsR, frameL, frameR, rig, o }. */
export function measureObject(pair, ctx) {
  const { detsL, detsR, frameL, frameR, rig, o } = ctx;
  const a = pair.i != null ? detsL[pair.i] : null;
  const b = pair.j != null ? detsR[pair.j] : null;
  const fromLeft = !!a;
  const det = a || b, other = fromLeft ? b : a;
  const [camA, camB, fA, fB] = fromLeft ? [rig.left, rig.right, frameL, frameR] : [rig.right, rig.left, frameR, frameL];
  const vOffset = fromLeft ? o.vOffset : -o.vOffset;
  const [x, y, w, h] = det.bbox;
  const r = clamp(Math.round(Math.min(w, h) / 8), 4, 9);
  const minNcc = other ? o.minNcc : o.minNccSolo;
  const minMargin = other ? 0.02 : 0.05;
  const samples = [];
  for (const [fx, fy] of SAMPLE_POINTS) {
    const u = x + fx * w, v = y + fy * h;
    let xMin = -Infinity, xMax = Infinity;
    if (other) {
      const [ox, , ow] = other.bbox;
      const pad = Math.max(6, 0.3 * ow);
      xMin = ox + fx * ow - pad;
      xMax = ox + fx * ow + pad;
    }
    const m = epipolarSearch(fA, fB, camA, camB, u, v, { r, vtol: o.vtol, vOffset, xMin, xMax });
    let fail = null;
    if (!m.ok) fail = m.reason;
    else if (m.score < minNcc || m.margin < minMargin) fail = 'weak';
    else if (!m.tri || !m.tri.valid) fail = 'rays';
    else if (m.tri.gap > Math.max(0.03, 0.08 * norm(m.tri.point))) fail = 'rays';
    samples.push({ u, v, m, ok: !fail, fail, range: fail ? null : norm(m.tri.point) });
  }
  const good = samples.filter((s) => s.ok).sort((p, q) => p.range - q.range);
  let range = null, point = null, quality = 'none', reason = null, sigma = null, matchScore = null;
  if (good.length) {
    const pick = good[Math.floor(0.3 * (good.length - 1))];
    range = pick.range;
    point = pick.m.tri.point;
    quality = 'stereo';
    matchScore = pick.m.score;
    sigma = depthUncertainty(range, rig, 0.7);
  } else if (other && pair.range != null && pair.range > 0.25) {
    // Fall back to the two box centres: much noisier, so it's labelled rough.
    range = pair.range;
    point = pair.tri.point;
    quality = 'rough';
    sigma = depthUncertainty(range, rig, 4);
  } else {
    reason = explain(samples, !!other);
  }
  if (range != null && sigma / range > o.maxRelError) {
    range = point = sigma = null;
    quality = 'none';
    reason = REASONS.far;
  }
  const dir = point ?? pixelRay(camA, x + w / 2, y + h / 2).d;
  const br = bearing(dir, o.tiltDeg);
  return {
    cls: det.class, score: det.score, name: det.name ?? null, truth: det.truth ?? other?.truth ?? null,
    boxL: a?.bbox ?? null, boxR: b?.bbox ?? null, primary: fromLeft ? 'L' : 'R',
    range, point, sigma, quality, reason, matchScore,
    azimuth: br.azimuth, elevation: br.elevation, ground: point ? br.ground : null,
    samples,
  };
}

/**
 * Measures every detection in one stereo frame. Also returns evidence used by the app:
 * dyObs (vertical misalignment seen in confident matches) and swapVotes (do the box pairs
 * only make geometric sense with left and right swapped?).
 */
export function measureScene(detsL, detsR, frameL, frameR, rig, opts = {}) {
  const o = { ...MEASURE_DEFAULTS, ...opts };
  const pairs = pairDetections(detsL, detsR, rig, o.vOffset);
  const ctx = { detsL, detsR, frameL, frameR, rig, o };
  const objects = pairs.map((p) => measureObject(p, ctx));
  const dyObs = [];
  for (const ob of objects) {
    for (const s of ob.samples) {
      if (s.ok && s.m.score > 0.9 && s.m.margin > 0.05) dyObs.push(ob.primary === 'L' ? s.m.dyLine : -s.m.dyLine);
    }
  }
  let normal = 0, swapped = 0;
  for (const p of pairs) {
    if (p.i == null || p.j == null) continue;
    const cl = boxCenter(detsL[p.i].bbox), cr = boxCenter(detsR[p.j].bbox);
    const asIs = triangulate(pixelRay(rig.left, ...cl), pixelRay(rig.right, ...cr));
    const flipped = triangulate(pixelRay(rig.left, ...cr), pixelRay(rig.right, ...cl));
    if (asIs?.valid) normal++;
    else if (flipped?.valid) swapped++;
  }
  return { objects, pairs, dyObs, swapVotes: { normal, swapped } };
}

/** Distance to any clicked point in the left image, confirmed by matching back right → left. */
export function measurePoint(u, v, frameL, frameR, rig, opts = {}) {
  const o = { ...MEASURE_DEFAULTS, ...opts };
  const dir = pixelRay(rig.left, u, v).d;
  const fail = (key, match = null) => ({ range: null, point: null, reason: REASONS[key] || REASONS.weak, match, ...bearingOf(dir, o, false) });
  const m = epipolarSearch(frameL, frameR, rig.left, rig.right, u, v, { r: 7, vtol: o.vtol, vOffset: o.vOffset });
  if (!m.ok) return fail(m.reason === 'view' ? 'view' : m.reason, m);
  if (m.score < 0.75) return fail('weak', m);
  if (!m.tri?.valid) return fail('rays', m);
  const back = epipolarSearch(frameR, frameL, rig.right, rig.left, m.uB, m.vB, { r: 7, vtol: o.vtol, vOffset: -o.vOffset });
  if (!back.ok || Math.abs(back.uB - m.uA) > 2 || Math.abs(back.vB - m.vA) > 3) return fail('inconsistent', m);
  const range = norm(m.tri.point);
  const sigma = depthUncertainty(range, rig, 0.6);
  if (sigma / range > o.maxRelError) return fail('far', m);
  return { range, point: m.tri.point, sigma, reason: null, match: m, ...bearingOf(m.tri.point, o, true) };
}

function bearingOf(p, o, withGround) {
  const br = bearing(p, o.tiltDeg);
  return { azimuth: br.azimuth, elevation: br.elevation, ground: withGround ? br.ground : null };
}

/**
 * Keeps object identities stable across frames (same class + overlapping boxes) and reports a
 * median distance over the last second so the labels don't flicker.
 */
export class Tracker {
  constructor({ maxAgeMs = 1200, windowMs = 1000, minHits = 2, showMs = 450 } = {}) {
    Object.assign(this, { maxAgeMs, windowMs, minHits, showMs });
    this.tracks = [];
    this.nextId = 1;
  }

  /** replace: forget history and show immediately (used when re-measuring a paused frame). */
  update(objects, now, tiltDeg = 0, { replace = false } = {}) {
    const cands = [];
    objects.forEach((o, i) => this.tracks.forEach((t, k) => {
      if (t.cls !== o.cls) return;
      const s = Math.max(o.boxL && t.boxL ? iou(o.boxL, t.boxL) : 0, o.boxR && t.boxR ? iou(o.boxR, t.boxR) : 0);
      if (s >= 0.2) cands.push({ i, k, s });
    }));
    cands.sort((p, q) => q.s - p.s);
    const usedO = new Set(), usedT = new Set();
    for (const c of cands) {
      if (usedO.has(c.i) || usedT.has(c.k)) continue;
      usedO.add(c.i);
      usedT.add(c.k);
      if (replace) this.tracks[c.k].hist = [];
      this.absorb(this.tracks[c.k], objects[c.i], now);
    }
    objects.forEach((o, i) => {
      if (usedO.has(i)) return;
      const t = { id: this.nextId++, cls: o.cls, hits: replace ? this.minHits - 1 : 0, hist: [] };
      this.tracks.push(t);
      this.absorb(t, o, now);
    });
    this.tracks = this.tracks.filter((t) => now - t.lastSeen <= this.maxAgeMs);
    return this.tracks
      .filter((t) => t.hits >= this.minHits && now - t.lastSeen <= this.showMs)
      .map((t) => this.view(t, tiltDeg));
  }

  absorb(t, o, now) {
    t.last = o;
    t.lastSeen = now;
    t.hits++;
    if (o.boxL) t.boxL = o.boxL;
    if (o.boxR) t.boxR = o.boxR;
    t.hist.push({ t: now, range: o.range, point: o.point, quality: o.quality, sigma: o.sigma, matchScore: o.matchScore });
    t.hist = t.hist.filter((h) => now - h.t <= this.windowMs).slice(-12);
  }

  view(t, tiltDeg) {
    const o = t.last;
    const valid = t.hist.filter((h) => h.range != null);
    if (!valid.length) return { ...o, id: t.id, range: null, point: null, ground: null, sigma: null };
    const range = median(valid.map((h) => h.range));
    const latest = valid[valid.length - 1];
    const point = scale(latest.point, range / latest.range);
    const br = bearing(point, tiltDeg);
    return {
      ...o, id: t.id, range, point, ground: br.ground, azimuth: br.azimuth, elevation: br.elevation,
      quality: latest.quality, sigma: latest.sigma, matchScore: latest.matchScore, reason: null,
    };
  }
}

/** All pairwise 3D distances between items that have a point, closest first. */
export function pairwiseDistances(items) {
  const pts = items.filter((o) => o.point);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) out.push({ a: pts[i], b: pts[j], d: dist3(pts[i].point, pts[j].point) });
  }
  return out.sort((p, q) => p.d - q.d);
}

export function formatDistance(m, units = 'm') {
  if (m == null || !Number.isFinite(m)) return '—';
  if (units === 'ft') {
    const ft = m * 3.28084;
    return ft < 10 ? `${ft.toFixed(1)} ft` : `${Math.round(ft)} ft`;
  }
  return m < 10 ? `${m.toFixed(1)} m` : `${Math.round(m)} m`;
}

/** "chair · ~2.1 m · 11 o'clock" */
export function objectLabel(o, units = 'm') {
  const dist = o.range == null
    ? 'distance unavailable'
    : `~${formatDistance(o.range, units)}${o.quality === 'rough' ? ' (rough)' : ''}`;
  return `${o.cls} · ${dist} · ${clockLabel(o.azimuth)}`;
}

export function spokenDistance(m, units = 'm') {
  if (units === 'ft') {
    const ft = Math.max(1, Math.round(m * 3.28084));
    return `${ft} ${ft === 1 ? 'foot' : 'feet'}`;
  }
  const v = m < 3 ? Math.max(0.5, Math.round(m * 2) / 2) : Math.round(m);
  return `${v} meter${v === 1 ? '' : 's'}`;
}

/** Nearest three objects with a distance, then up to two without. */
export function speechSummary(objects, units = 'm') {
  const near = objects.filter((o) => o.range != null).sort((a, b) => a.range - b.range).slice(0, 3);
  const rest = objects.filter((o) => o.range == null).slice(0, 2);
  const items = [...near, ...rest].map((o) => ({ cls: o.cls, range: o.range, clock: clockHour(o.azimuth) }));
  if (!items.length) return { text: 'Nothing in view.', items };
  const text = items
    .map((i) => `${i.cls}, ${i.range != null ? `${spokenDistance(i.range, units)}, ` : ''}${i.clock} o'clock.`)
    .join(' ');
  return { text, items };
}

/** True when the new summary differs enough from the last one spoken to be worth saying. */
export function speechChanged(prev, next, minChangeM = 0.5) {
  if (!prev) return true;
  if (prev.length !== next.length) return true;
  const key = (i) => `${i.cls}@${i.clock}`;
  const pool = [...prev];
  for (const n of next) {
    const k = pool.findIndex((p) => key(p) === key(n));
    if (k < 0) return true;
    const p = pool.splice(k, 1)[0];
    if ((p.range == null) !== (n.range == null)) return true;
    if (n.range != null && Math.abs(n.range - p.range) >= minChangeM) return true;
  }
  return false;
}
