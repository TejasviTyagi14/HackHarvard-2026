// Canvas drawing: the two camera views with boxes and labels, the top-down map, and the
// small rig sketch next to the rig settings. All sizes are in device pixels (× dpr).
import { DEG, cameraYaws } from './geometry.js';
import { formatDistance, objectLabel } from './scene.js';

const PALETTE = ['#38bdf8', '#fb923c', '#a3e635', '#f472b6', '#c084fc', '#facc15', '#2dd4bf', '#f87171'];
const INK = '#0b0f17';
const PIN = '#f8fafc';
const CALIB = '#fbbf24';
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export function classColor(cls) {
  let h = 0;
  for (const ch of cls) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Matches the canvas backing store to its CSS size; returns the device pixel ratio. */
export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return dpr;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function pillSize(ctx, text, dpr) {
  ctx.font = `600 ${12 * dpr}px ${FONT}`;
  return { w: ctx.measureText(text).width + 12 * dpr, h: 19 * dpr };
}

function drawPill(ctx, text, r, color, dpr) {
  ctx.font = `600 ${12 * dpr}px ${FONT}`;
  ctx.fillStyle = color;
  roundRect(ctx, r.x, r.y, r.w, r.h, 4 * dpr);
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, r.x + 6 * dpr, r.y + r.h / 2 + 0.5 * dpr);
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Puts a label near (x, y) — or near a box — where it overlaps already placed labels the least:
 * above, inside the top edge, below, then stacked higher up.
 */
function placeLabel(ctx, text, anchor, placed, dpr) {
  const { w, h } = pillSize(ctx, text, dpr);
  const gap = 3 * dpr, W = ctx.canvas.width, H = ctx.canvas.height;
  const { x, y, bw = 0, bh = 0 } = anchor;
  const ys = [y - h - gap, y + gap, y + bh + gap, y - 2 * (h + gap), y - 3 * (h + gap)];
  let best = null;
  for (const cy of ys) {
    const r = { x: Math.max(0, Math.min(x, W - w)), y: Math.max(0, Math.min(cy, H - h)), w, h };
    const cost = placed.reduce((a, p) => a + overlap(r, p), 0);
    if (!best || cost < best.cost) best = { r, cost };
    if (cost === 0) break;
  }
  placed.push(best.r);
  return best.r;
}

function pill(ctx, text, x, y, color, dpr, placed = []) {
  drawPill(ctx, text, placeLabel(ctx, text, { x, y }, placed, dpr), color, dpr);
}

function crosshair(ctx, x, y, color, dpr, size = 9) {
  const s = size * dpr;
  ctx.save();
  ctx.lineWidth = 4 * dpr;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  for (const pass of [0, 1]) {
    if (pass) { ctx.lineWidth = 2 * dpr; ctx.strokeStyle = color; }
    ctx.beginPath();
    ctx.moveTo(x - s, y); ctx.lineTo(x - 3 * dpr, y);
    ctx.moveTo(x + 3 * dpr, y); ctx.lineTo(x + s, y);
    ctx.moveTo(x, y - s); ctx.lineTo(x, y - 3 * dpr);
    ctx.moveTo(x, y + 3 * dpr); ctx.lineTo(x, y + s);
    ctx.stroke();
  }
  ctx.restore();
}

function ring(ctx, x, y, color, dpr, r = 6) {
  ctx.save();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * dpr, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

/**
 * One camera view. v: { source, side (0 left / 1 right), frame {w,h} (processing size),
 * objects, pins, selectedId, debug, units, calib, dpr, paused, still (canvas to show when paused) }
 */
export function drawView(ctx, v) {
  const { side, frame, objects, pins, selectedId, debug, units, calib, dpr } = v;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, W, H);
  if (v.paused && v.still) ctx.drawImage(v.still, 0, 0, W, H);
  else if (v.source?.ready) v.source.drawTo(ctx, W, H);
  if (!frame) return;
  const kx = W / frame.w, ky = H / frame.h;
  const key = side === 0 ? 'boxL' : 'boxR';
  const anySelected = objects.some((o) => o.id === selectedId);
  const placed = [];
  const labels = [];

  for (const o of objects) {
    const b = o[key];
    if (!b) continue;
    const x = b[0] * kx, y = b[1] * ky, w = b[2] * kx, h = b[3] * ky;
    const col = classColor(o.cls), sel = o.id === selectedId;
    ctx.save();
    if (anySelected && !sel) ctx.globalAlpha = 0.45;
    ctx.lineWidth = (sel ? 3.5 : 2) * dpr;
    ctx.strokeStyle = col;
    if (o.range == null) ctx.setLineDash([7 * dpr, 5 * dpr]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    if (debug) drawSamples(ctx, o, side, kx, ky, dpr, sel);
    labels.push({ o, x, y, w, h, col, dim: anySelected && !sel, rank: sel ? -1 : o.range ?? 1e9 });
  }
  // Nearest (and selected) objects get first pick of label spots.
  labels.sort((a, b) => a.rank - b.rank);
  for (const l of labels) {
    const text = objectLabel(l.o, units);
    const r = placeLabel(ctx, text, { x: l.x, y: l.y, bw: l.w, bh: l.h }, placed, dpr);
    ctx.save();
    if (l.dim) ctx.globalAlpha = 0.6;
    drawPill(ctx, text, r, l.col, dpr);
    ctx.restore();
  }

  for (const p of pins) {
    const label = `#${p.id} ${p.range != null ? formatDistance(p.range, units) : '—'}`;
    if (side === 0) {
      crosshair(ctx, p.u * kx, p.v * ky, PIN, dpr);
      pill(ctx, label, p.u * kx + 8 * dpr, p.v * ky - 4 * dpr, PIN, dpr, placed);
    } else if (p.match?.ok) {
      ring(ctx, p.match.uB * kx, p.match.vB * ky, p.range != null ? PIN : '#f87171', dpr);
      pill(ctx, `#${p.id}`, p.match.uB * kx + 8 * dpr, p.match.vB * ky - 4 * dpr, PIN, dpr, placed);
    }
  }

  // Person calibration: the points being matched on the person right now.
  if (v.pcal) {
    ctx.fillStyle = CALIB;
    for (const m of v.pcal.matches) {
      ctx.beginPath();
      ctx.arc((side === 0 ? m.uL : m.uR) * kx, (side === 0 ? m.vL : m.vR) * ky, 3 * dpr, 0, 2 * Math.PI);
      ctx.fill();
    }
    const { w, h } = pillSize(ctx, v.pcal.label, dpr);
    drawPill(ctx, v.pcal.label, { x: 8 * dpr, y: H - h - 8 * dpr, w, h }, CALIB, dpr);
  }

  const t = calib?.target;
  if (t) {
    if (side === 0) {
      crosshair(ctx, t.uL * kx, t.vL * ky, CALIB, dpr, 12);
      pill(ctx, 'target', t.uL * kx + 10 * dpr, t.vL * ky - 6 * dpr, CALIB, dpr, placed);
    } else if (t.uR != null) {
      crosshair(ctx, t.uR * kx, t.vR * ky, CALIB, dpr, 12);
      pill(ctx, t.manual ? 'match (placed)' : `match ${t.score.toFixed(2)}`, t.uR * kx + 10 * dpr, t.vR * ky - 6 * dpr, CALIB, dpr, placed);
    }
  }
}

function drawSamples(ctx, o, side, kx, ky, dpr, selected) {
  const primary = o.primary === 'L' ? 0 : 1;
  ctx.save();
  ctx.font = `600 ${10 * dpr}px ${FONT}`;
  ctx.textBaseline = 'bottom';
  for (const s of o.samples || []) {
    const col = s.ok ? '#34d399' : '#f87171';
    if (side === primary) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(s.u * kx, s.v * ky, 3 * dpr, 0, 2 * Math.PI);
      ctx.fill();
    } else if (s.m?.ok) {
      const x = s.m.uB * kx, y = s.m.vB * ky;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(x - 4 * dpr, y - 4 * dpr); ctx.lineTo(x + 4 * dpr, y + 4 * dpr);
      ctx.moveTo(x + 4 * dpr, y - 4 * dpr); ctx.lineTo(x - 4 * dpr, y + 4 * dpr);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillText(s.m.score.toFixed(2), x + 5 * dpr, y - 3 * dpr);
    }
  }
  // Where the first sample point could appear in the other camera (its epipolar line).
  const seg = o.samples?.[0]?.m?.seg;
  if (selected && side !== primary && seg) {
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)';
    ctx.setLineDash([5 * dpr, 4 * dpr]);
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(seg.far.u * kx, seg.far.v * ky);
    ctx.lineTo(seg.near.u * kx, seg.near.v * ky);
    ctx.stroke();
  }
  ctx.restore();
}

const MAP = { bg: '#0d1118', ring: '#1f2735', spoke: '#18202c', text: '#6b7588', fovL: 'rgba(56,189,248,0.07)', fovR: 'rgba(251,146,60,0.07)' };

/** Top-down map, forward = up. m: { objects, pins, rig, settings, selectedId, units, dpr } */
export function drawMap(ctx, m) {
  const { objects, pins, rig, settings, selectedId, units, dpr } = m;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.fillStyle = MAP.bg;
  ctx.fillRect(0, 0, W, H);

  const placed = [...objects, ...pins].filter((o) => o.ground);
  const farthest = Math.max(0, ...placed.map((o) => Math.hypot(o.ground.x, o.ground.z)));
  const unitM = units === 'ft' ? 0.3048 : 1;
  const maxM = Math.max(3, farthest * 1.2);
  const ox = W / 2, oy = H - 24 * dpr;
  const s = Math.min((oy - 18 * dpr) / maxM, (W / 2 - 14 * dpr) / maxM);
  const P = (x, z) => [ox + x * s, oy - z * s];
  const dir = (azDeg, r) => [ox + Math.sin(azDeg * DEG) * r, oy - Math.cos(azDeg * DEG) * r];
  const R = maxM * s;

  ctx.save();
  ctx.font = `${11 * dpr}px ${FONT}`;
  ctx.lineWidth = 1 * dpr;

  // Clock spokes from 9 to 3 o'clock.
  ctx.strokeStyle = MAP.spoke;
  ctx.fillStyle = MAP.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const hr of [9, 10, 11, 12, 1, 2, 3]) {
    const az = (hr >= 9 ? hr - 12 : hr) * 30;
    const [ex, ey] = dir(az, R);
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
    const [lx, ly] = dir(az, R - 12 * dpr);
    if (ly > 8 * dpr) ctx.fillText(String(hr), lx, ly);
  }

  // Range rings.
  const maxU = maxM / unitM;
  const step = [0.5, 1, 2, 5, 10, 20, 50].find((st) => maxU / st <= 6) ?? 100;
  ctx.strokeStyle = MAP.ring;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (let r = step; r <= maxU + 1e-9; r += step) {
    const rp = r * unitM * s;
    ctx.beginPath(); ctx.arc(ox, oy, rp, Math.PI, 2 * Math.PI); ctx.stroke();
    ctx.fillText(`${r} ${units}`, ox + rp + 3 * dpr, oy - 2 * dpr);
  }

  // Each camera's field of view (baseline drawn at least 10 px wide so both are visible).
  if (rig) {
    const [yawL, yawR] = cameraYaws(settings.angleDeg, settings.angleSplit);
    const halfB = Math.max((rig.baseline / 2) * s, 5 * dpr);
    for (const [cx, yaw, fill] of [[ox - halfB, yawL, MAP.fovL], [ox + halfB, yawR, MAP.fovR]]) {
      const half = (settings.hfovDeg / 2) * DEG;
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(cx, oy);
      ctx.lineTo(cx + Math.sin(yaw - half) * R * 1.1, oy - Math.cos(yaw - half) * R * 1.1);
      ctx.lineTo(cx + Math.sin(yaw + half) * R * 1.1, oy - Math.cos(yaw + half) * R * 1.1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(ox - halfB - 3 * dpr, oy - 3 * dpr, 2 * halfB + 6 * dpr, 6 * dpr);
    ctx.fillStyle = '#38bdf8'; ctx.fillRect(ox - halfB - 3 * dpr, oy - 3 * dpr, 6 * dpr, 6 * dpr);
    ctx.fillStyle = '#fb923c'; ctx.fillRect(ox + halfB - 3 * dpr, oy - 3 * dpr, 6 * dpr, 6 * dpr);
  }

  const sel = objects.find((o) => o.id === selectedId && o.ground);

  // Lines from the selected object to everything else, with distances.
  if (sel) {
    const [sx, sy] = P(sel.ground.x, sel.ground.z);
    ctx.font = `600 ${11 * dpr}px ${FONT}`;
    for (const o of placed) {
      if (o === sel || !o.point) continue;
      const [x, y] = P(o.ground.x, o.ground.z);
      ctx.strokeStyle = 'rgba(226,232,240,0.55)';
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(x, y); ctx.stroke();
      ctx.setLineDash([]);
      const d = Math.hypot(o.point[0] - sel.point[0], o.point[1] - sel.point[1], o.point[2] - sel.point[2]);
      const text = formatDistance(d, units);
      const tw = ctx.measureText(text).width;
      const mx = (sx + x) / 2, my = (sy + y) / 2;
      ctx.fillStyle = 'rgba(13,17,24,0.85)';
      ctx.fillRect(mx - tw / 2 - 4 * dpr, my - 8 * dpr, tw + 8 * dpr, 16 * dpr);
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, mx, my);
    }
  }

  // Objects with a distance as dots; direction-only ones as dashed bearings.
  ctx.font = `600 ${11 * dpr}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const o of objects) {
    const col = classColor(o.cls);
    ctx.globalAlpha = sel && o !== sel ? 0.6 : 1;
    if (o.ground) {
      const [x, y] = P(o.ground.x, o.ground.z);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, (o === sel ? 8 : 6) * dpr, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${o.cls} ${formatDistance(o.range, units)}`, x + 10 * dpr, y);
    } else {
      const [ex, ey] = dir(o.azimuth, R * 0.97);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([3 * dpr, 5 * dpr]);
      ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillText(`${o.cls} (no distance)`, Math.min(ex + 6 * dpr, W - 110 * dpr), Math.max(ey, 10 * dpr));
    }
  }
  ctx.globalAlpha = 1;

  for (const p of pins) {
    if (!p.ground) continue;
    const [x, y] = P(p.ground.x, p.ground.z);
    ctx.fillStyle = PIN;
    ctx.beginPath();
    ctx.moveTo(x, y - 6 * dpr); ctx.lineTo(x + 6 * dpr, y); ctx.lineTo(x, y + 6 * dpr); ctx.lineTo(x - 6 * dpr, y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`#${p.id} ${formatDistance(p.range, units)}`, x + 9 * dpr, y);
  }
  ctx.restore();
  return { maxM };
}

/** Bird's-eye sketch of the rig as entered: spacing, angle, and both fields of view. */
export function drawRigDiagram(ctx, settings, dpr) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  const [yawL, yawR] = cameraYaws(settings.angleDeg, settings.angleSplit);
  const cx = W / 2, by = H - 26 * dpr, half = Math.min(70 * dpr, W * 0.22), len = H - 46 * dpr;
  const hf = (settings.hfovDeg / 2) * DEG;
  ctx.save();
  ctx.font = `${11 * dpr}px ${FONT}`;
  for (const [x, yaw, fill, stroke] of [[cx - half, yawL, 'rgba(56,189,248,0.12)', '#38bdf8'], [cx + half, yawR, 'rgba(251,146,60,0.12)', '#fb923c']]) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x, by);
    ctx.lineTo(x + Math.sin(yaw - hf) * len, by - Math.cos(yaw - hf) * len);
    ctx.lineTo(x + Math.sin(yaw + hf) * len, by - Math.cos(yaw + hf) * len);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, by);
    ctx.lineTo(x + Math.sin(yaw) * len, by - Math.cos(yaw) * len);
    ctx.stroke();
    ctx.save();
    ctx.translate(x, by);
    ctx.rotate(yaw);
    ctx.fillStyle = stroke;
    ctx.fillRect(-9 * dpr, -5 * dpr, 18 * dpr, 10 * dpr);
    ctx.restore();
  }
  // Bar and spacing dimension.
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(cx - half, by + 12 * dpr); ctx.lineTo(cx + half, by + 12 * dpr);
  ctx.moveTo(cx - half, by + 8 * dpr); ctx.lineTo(cx - half, by + 16 * dpr);
  ctx.moveTo(cx + half, by + 8 * dpr); ctx.lineTo(cx + half, by + 16 * dpr);
  ctx.stroke();
  ctx.fillStyle = '#cbd5e1';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Number(settings.baselineCm).toFixed(1)} cm (not to scale)`, cx, by + 15 * dpr);
  ctx.textBaseline = 'top';
  const a = Number(settings.angleDeg);
  const kind = Math.abs(a) < 0.05 ? 'parallel' : a > 0 ? 'toed in' : 'toed out';
  ctx.fillText(`${a.toFixed(1)}° between cameras · ${kind}`, cx, 4 * dpr);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText('L', 6 * dpr, by - 6 * dpr);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fb923c';
  ctx.fillText('R', W - 6 * dpr, by - 6 * dpr);
  ctx.restore();
}
