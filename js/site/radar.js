// Section 2 of the landing page, "Measuring distance": a radar HUD for the two-camera rig,
// driven by the real stereo pipeline on a synthetic room (see ./adapter.js for what is mocked).
import { runPipeline, assistantScene, VIEW_W, VIEW_H, HFOV } from './adapter.js';
import { answer, answerBest, classFromPhrase } from '../assistant.js';
import { Voice, Listener } from '../speech.js';
import { DETAIL_PRESETS, normalizeDetail } from '../detail.js';
import { mountDroid } from './droid.js';

const DEG = Math.PI / 180;
const MAX_R = 6;
// Light blue for the rig and HUD, green for detected objects, amber only for the < 1 m alert.
const ACCENT = [125, 211, 252], OBJ = [74, 222, 128], WARM = [245, 158, 11];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const NAMES = { 'dining table': 'TABLE', 'potted plant': 'PLANT', tv: 'TV' };
const label = (cls) => NAMES[cls] ?? cls.toUpperCase();
const sideTxt = (az) => (Math.abs(az) < 1 ? '0°' : `${Math.abs(az).toFixed(0)}° ${az < 0 ? 'L' : 'R'}`);
const isClose = (o) => o.range != null && o.range < 1;
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

export function mountRadar(section) {
  section.classList.add('radar-sec');
  section.innerHTML = `
  <div class="rs-wrap">
    <header class="rs-head">
      <div class="rs-eyebrow">02 · STEREO RIG</div>
      <h2 class="rs-title">Measuring distance</h2>
      <p class="rs-copy">Two cameras see the same object from slightly different places. The shift between the two views — the disparity — gives the distance.</p>
    </header>
    <div class="rs-grid">
      <div class="rs-panel rs-radar">
        <div class="rs-hud rs-hud-tl"><span class="rs-dot"></span>LIVE · SYNTHETIC ROOM</div>
        <div class="rs-hud rs-hud-tr" data-k="rig"></div>
        <canvas class="rs-radar-cv" aria-label="Radar view of measured objects"></canvas>
        <div class="rs-hud rs-hud-bl"><i class="rs-key rs-key-ov"></i>STEREO OVERLAP <i class="rs-key rs-key-warm"></i>&lt; 1 m</div>
      </div>
      <aside class="rs-side">
        <div class="rs-panel rs-views">
          <div class="rs-ph"><span>LEFT CAM</span><span class="rs-mut">matched features</span><span>RIGHT CAM</span></div>
          <canvas class="rs-views-cv" aria-label="Left and right camera views with matched points"></canvas>
        </div>
        <div class="rs-panel rs-controls">
          <label class="rs-slider"><span>BASELINE</span><input type="range" min="4" max="40" step="1" value="12" data-k="base"><output data-k="baseOut">12 cm</output></label>
          <label class="rs-slider"><span>TOE-IN</span><input type="range" min="0" max="30" step="1" value="0" data-k="toe"><output data-k="toeOut">0°</output></label>
        </div>
        <div class="rs-panel rs-formula">
          <div class="rs-ph"><span>DEPTH</span><span class="rs-mut" data-k="fsel"></span></div>
          <div class="rs-eq" data-k="eq"></div>
          <div class="rs-eqnote" data-k="eqnote"></div>
        </div>
      </aside>
    </div>
    <div class="rs-lower">
      <div class="rs-panel rs-table">
        <table><thead><tr><th>CLASS</th><th>DIST</th><th>BEARING</th><th>CONF</th></tr></thead><tbody data-k="tbody"></tbody></table>
      </div>
      <div class="rs-panel rs-voice">
        <div class="rs-voice-top">
          <button class="rs-mic" type="button" aria-label="Ask by voice" data-k="mic">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>
          </button>
          <button class="rs-detail" type="button" data-k="detail" title="Change how detailed answers are — Droid edits the assistant" aria-label="Change how detailed answers are">
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
            <span>Detail</span>
          </button>
          <canvas class="rs-wave" data-k="wave"></canvas>
        </div>
        <div class="rs-caption" data-k="caption" aria-live="polite"><span class="rs-mut">Ask the rig about the room.</span></div>
        <form class="rs-ask" data-k="form"><input type="text" placeholder="Ask: how far is the sofa?" data-k="q" aria-label="Ask a question"><button type="submit">ASK</button></form>
        <div class="rs-chips" data-k="chips"></div>
        <div class="rs-msg" data-k="msg"></div>
      </div>
    </div>
  </div>`;
  const $ = (k) => section.querySelector(`[data-k="${k}"]`);
  const radarCv = section.querySelector('.rs-radar-cv'), viewsCv = section.querySelector('.rs-views-cv');
  const waveCv = $('wave');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const st = {
    base: 12, toe: 0, data: null, hover: null, sel: null, pulse: null, lit: new Map(),
    sweep: -60, dir: 1, active: false, raf: 0, last: 0, pending: true, ctx: {}, listening: false,
    detail: normalizeDetail(DETAIL_PRESETS.normal), lastQ: null, lastCtx: {},
  };
  const offs = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: VIEW_W, height: VIEW_H }));

  // ----------------------------------------------------------------------------- pipeline
  function recompute() {
    st.pending = false;
    st.data = runPipeline({ baselineCm: st.base, angleDeg: st.toe, hfovDeg: HFOV });
    st.data.images.forEach((img, i) => offs[i].getContext('2d').putImageData(img, 0, 0));
    if (st.sel != null && !st.data.objects.some((o) => o.id === st.sel && o.range != null)) st.sel = null;
    $('rig').textContent = `B ${st.base} cm · TOE-IN ${st.toe}° · HFOV ${HFOV}° · f ${st.data.rig.left.f.toFixed(0)} px`;
    renderTable();
    renderFormula();
    drawViews();
    drawRadar();
  }
  let qRaf = 0;
  const schedule = () => {
    st.pending = true;
    if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; recompute(); });
  };

  const objects = () => st.data?.objects ?? [];
  const closest = () => objects().filter((o) => o.range != null).sort((a, b) => a.range - b.range)[0] ?? null;
  const selected = () => objects().find((o) => o.id === st.sel) ?? closest();

  // ----------------------------------------------------------------------------- table
  function renderTable() {
    const tb = $('tbody');
    tb.innerHTML = '';
    for (const o of [...objects()].sort((a, b) => (a.range ?? 99) - (b.range ?? 99))) {
      const tr = el('tr', isClose(o) ? 'is-warm' : '');
      tr.dataset.id = o.id;
      const q = o.quality === 'rough' ? ' <span class="rs-tag">ROUGH</span>' : '';
      tr.innerHTML = `<td>${label(o.cls)}</td><td>${o.range != null ? o.range.toFixed(2) + ' m' : '—'}${q}</td><td>${sideTxt(o.azimuth)}</td><td>${(o.score * 100).toFixed(0)}%</td>`;
      tr.addEventListener('mouseenter', () => setHover(o.id));
      tr.addEventListener('mouseleave', () => setHover(null));
      tr.addEventListener('click', () => select(o.id));
      tb.append(tr);
    }
    syncRows();
  }
  function syncRows() {
    const sel = selected()?.id;
    for (const tr of $('tbody').children) {
      const id = Number(tr.dataset.id);
      tr.classList.toggle('is-hover', id === st.hover);
      tr.classList.toggle('is-sel', id === sel);
    }
  }
  function setHover(id) {
    if (st.hover === id) return;
    st.hover = id;
    syncRows();
    drawViews();
    if (!st.active || reduced) drawRadar();
  }
  function select(id) {
    st.sel = id;
    syncRows();
    renderFormula();
    drawViews();
    if (!st.active || reduced) drawRadar();
  }

  // ----------------------------------------------------------------------------- formula
  function renderFormula() {
    const o = selected();
    const rig = st.data?.rig;
    if (!o || !rig) {
      $('eq').innerHTML = 'Z = f · B / d';
      $('eqnote').textContent = 'No object measured.';
      $('fsel').textContent = '';
      return;
    }
    const f = rig.left.f, B = rig.baseline;
    const Z = o.point ? o.point[2] : o.range;
    // Disparity of the matched sample the pipeline used (or, after toe-in, its rectified equivalent).
    const s = o.samples.find((x) => x.ok && x.m.tri?.point === o.point);
    let d = s ? Math.abs(s.m.uA - s.m.uB) : null, rect = st.toe > 0 || !s;
    if (rect) d = (f * B) / Z;
    const z2 = (f * B) / d;
    $('fsel').textContent = `${label(o.cls)}${st.sel == null ? ' · closest' : ''}`;
    $('eq').innerHTML = `Z = <b>f</b> · <b>B</b> / <b>d</b><br><span class="rs-eqv">Z = <b>${f.toFixed(0)} px</b> · <b>${B.toFixed(2)} m</b> / <b>${d.toFixed(1)} px</b> = <em class="${isClose(o) ? 'warm' : ''}">${z2.toFixed(2)} m</em></span>`;
    $('eqnote').textContent = `${rect ? 'Toe-in: disparity after rectification. ' : ''}Depth along the axis; slant range ${o.range?.toFixed(2) ?? '—'} m (${o.quality}). Click a blip to switch.`;
  }

  // ----------------------------------------------------------------------------- canvases
  function fit(cv, cssH) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 600, h = cssH ?? cv.clientHeight ?? 300;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function drawViews() {
    if (!st.data) return;
    const w = viewsCv.clientWidth || 640;
    const gap = 10, vw = (w - gap) / 2, k = vw / VIEW_W, vh = VIEW_H * k;
    const { g } = fit(viewsCv, vh);
    g.clearRect(0, 0, w, vh);
    g.imageSmoothingEnabled = true;
    offs.forEach((c, i) => g.drawImage(c, i * (vw + gap), 0, vw, vh));
    const ox = [0, vw + gap];
    const sel = selected()?.id;
    for (const o of objects()) {
      const hot = o.id === st.hover || o.id === sel;
      const col = isClose(o) ? WARM : OBJ;
      [o.boxL, o.boxR].forEach((b, i) => {
        if (!b) return;
        g.strokeStyle = rgba(col, hot ? 1 : 0.7);
        g.lineWidth = hot ? 1.5 : 1;
        g.strokeRect(ox[i] + b[0] * k + 0.5, b[1] * k + 0.5, b[2] * k, b[3] * k);
        g.fillStyle = rgba(col, 0.85);
        g.font = '600 9px "JetBrains Mono", ui-monospace, monospace';
        const t = label(o.cls);
        const tw = g.measureText(t).width + 6;
        g.fillRect(ox[i] + b[0] * k, Math.max(0, b[1] * k - 12), tw, 12);
        g.fillStyle = '#05070a';
        g.fillText(t, ox[i] + b[0] * k + 3, Math.max(9, b[1] * k - 3));
      });
      // Matched features, joined across the two views.
      for (const s of o.samples) {
        if (!s.ok) continue;
        const [pl, pr] = o.primary === 'L' ? [[s.m.uA, s.m.vA], [s.m.uB, s.m.vB]] : [[s.m.uB, s.m.vB], [s.m.uA, s.m.vA]];
        const a = [pl[0] * k, pl[1] * k], b = [ox[1] + pr[0] * k, pr[1] * k];
        g.strokeStyle = rgba(col, hot ? 0.75 : 0.28);
        g.lineWidth = hot ? 1 : 0.75;
        g.beginPath();
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
        g.stroke();
        g.fillStyle = rgba(col, 1);
        for (const p of [a, b]) {
          g.beginPath();
          g.arc(p[0], p[1], hot ? 2.2 : 1.6, 0, 2 * Math.PI);
          g.fill();
        }
      }
    }
  }

  // Radar geometry (CSS pixels).
  let geo = null;
  function radarGeo(w, h) {
    const cx = w / 2, cy = h - 30;
    const s = Math.min((cy - 26) / (MAX_R + 0.4), (w / 2 - 26) / ((MAX_R + 0.6) * Math.sin(62 * DEG)));
    const half = 6 + st.base * 1.1; // exaggerated half-baseline in px
    return { cx, cy, s, half };
  }
  const toXY = (r, az) => [geo.cx + Math.sin(az * DEG) * r * geo.s, geo.cy - Math.cos(az * DEG) * r * geo.s];

  function cone(apexX, yaw) {
    const pts = [[apexX, geo.cy]];
    const R = (MAX_R + 0.3) * geo.s;
    for (let a = yaw - HFOV / 2; a <= yaw + HFOV / 2 + 1e-6; a += 2) pts.push([apexX + Math.sin(a * DEG) * R, geo.cy - Math.cos(a * DEG) * R]);
    return pts;
  }
  // Sutherland–Hodgman: clip polygon `p` by convex polygon `c` (both clockwise on screen).
  function clip(p, c) {
    let out = p;
    for (let i = 0; i < c.length && out.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length], inp = out;
      out = [];
      const side = (q) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
      for (let j = 0; j < inp.length; j++) {
        const P = inp[j], Q = inp[(j + 1) % inp.length], sp = side(P), sq = side(Q);
        if (sp >= 0) out.push(P);
        if (sp >= 0 !== sq >= 0) {
          const t = sp / (sp - sq);
          out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
        }
      }
    }
    return out;
  }
  const poly = (g, pts) => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.closePath();
  };

  function blipXY(o) {
    return toXY(Math.min(o.range ?? MAX_R, MAX_R + 0.2), o.azimuth);
  }

  function drawRadar(now = performance.now()) {
    const { g, w, h } = fit(radarCv);
    geo = radarGeo(w, h);
    const { cx, cy, s, half } = geo;
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, cy + 1);
    g.clip();

    // Range rings and labels.
    g.font = '10px "JetBrains Mono", ui-monospace, monospace';
    for (let r = 1; r <= MAX_R; r++) {
      g.strokeStyle = r === 1 ? rgba(WARM, 0.35) : rgba(ACCENT, r % 2 ? 0.1 : 0.16);
      g.setLineDash(r === 1 ? [3, 4] : []);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, r * s, Math.PI, 2 * Math.PI);
      g.stroke();
    }
    g.setLineDash([]);
    // Bearing spokes and ticks.
    for (let a = -90; a <= 90; a += 10) {
      const [x0, y0] = toXY(MAX_R, a), [x1, y1] = toXY(MAX_R + (a % 30 ? 0.12 : 0.25), a);
      g.strokeStyle = rgba(ACCENT, a % 30 ? 0.25 : 0.5);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      if (a % 30 === 0 && Math.abs(a) < 90) {
        g.strokeStyle = rgba(ACCENT, 0.06);
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(x0, y0);
        g.stroke();
      }
    }

    // Field-of-view cones and their overlap.
    const yaw = st.toe / 2;
    const cL = cone(cx - half, yaw), cR = cone(cx + half, -yaw);
    for (const c of [cL, cR]) {
      poly(g, c);
      g.fillStyle = rgba(ACCENT, 0.025);
      g.fill();
      g.strokeStyle = rgba(ACCENT, 0.28);
      g.stroke();
    }
    const ov = clip(cL, cR);
    if (ov.length > 2) {
      poly(g, ov);
      g.fillStyle = rgba(ACCENT, 0.075);
      g.fill();
      g.setLineDash([4, 3]);
      g.strokeStyle = rgba(ACCENT, 0.6);
      g.stroke();
      g.setLineDash([]);
    }

    // Sweep with fading trail.
    if (!reduced) {
      const trail = 34;
      for (let i = 0; i < trail; i++) {
        const a0 = st.sweep - st.dir * i, a1 = st.sweep - st.dir * (i + 1);
        g.beginPath();
        g.moveTo(cx, cy);
        g.arc(cx, cy, (MAX_R + 0.3) * s, (Math.min(a0, a1) - 90) * DEG, (Math.max(a0, a1) - 90) * DEG);
        g.closePath();
        g.fillStyle = rgba(ACCENT, 0.11 * (1 - i / trail) ** 2);
        g.fill();
      }
      const [sx, sy] = toXY(MAX_R + 0.3, st.sweep);
      g.strokeStyle = rgba(ACCENT, 0.9);
      g.lineWidth = 1.25;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(sx, sy);
      g.stroke();
      g.lineWidth = 1;
    }

    // Blips.
    const sel = selected()?.id;
    const placed = [];
    for (const o of objects()) {
      const [x, y] = blipXY(o);
      const col = isClose(o) ? WARM : OBJ;
      const lit = reduced ? 1 : st.lit.get(o.id) ?? 0;
      const hot = o.id === st.hover || o.id === sel;
      const a = o.range == null ? 0.35 : 0.5 + 0.5 * lit;
      g.fillStyle = rgba(col, 0.12 * a + (hot ? 0.12 : 0));
      g.beginPath();
      g.arc(x, y, 9 + 5 * lit, 0, 2 * Math.PI);
      g.fill();
      g.fillStyle = rgba(col, a);
      g.beginPath();
      g.arc(x, y, hot ? 4.5 : 3.5, 0, 2 * Math.PI);
      g.fill();
      if (hot) {
        g.strokeStyle = rgba(col, 0.9);
        g.strokeRect(x - 8.5, y - 8.5, 17, 17);
      }
      if (st.pulse && st.pulse.id === o.id) {
        const t = (now - st.pulse.t) / 1000;
        if (t > 3) st.pulse = null;
        else for (let k = 0; k < 3; k++) {
          const p = ((t + k * 0.33) % 1);
          g.strokeStyle = rgba(col, (1 - p) * 0.9);
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(x, y, 6 + p * 34, 0, 2 * Math.PI);
          g.stroke();
          g.lineWidth = 1;
        }
      }
      // Label (flip side near the right edge; nudge down if it collides).
      const txt = `${label(o.cls)} · ${o.range != null ? o.range.toFixed(1) + ' m' : '? m'} · ${sideTxt(o.azimuth)}`;
      g.font = `${hot ? 600 : 500} 10.5px "JetBrains Mono", ui-monospace, monospace`;
      const tw = g.measureText(txt).width;
      let lx = x + 12, ly = y - 8;
      if (lx + tw > w - 6) lx = x - 12 - tw;
      while (placed.some((p) => Math.abs(p[1] - ly) < 13 && lx < p[0] + p[2] && lx + tw > p[0])) ly += 13;
      placed.push([lx, ly, tw]);
      g.fillStyle = 'rgba(5,7,10,0.72)';
      g.fillRect(lx - 3, ly - 10, tw + 6, 14);
      g.fillStyle = rgba(col, hot ? 1 : 0.55 + 0.45 * lit);
      g.fillText(txt, lx, ly);
    }
    g.restore();

    // Range labels along the centre line, cameras and baseline.
    g.font = '10px "JetBrains Mono", ui-monospace, monospace';
    g.fillStyle = rgba(ACCENT, 0.55);
    g.textAlign = 'left';
    for (let r = 1; r <= MAX_R; r++) {
      const [x] = toXY(r, 90);
      g.fillStyle = r === 1 ? rgba(WARM, 0.75) : rgba(ACCENT, 0.55);
      g.fillText(`${r} m`, x - 8, cy + 13);
    }
    g.textAlign = 'center';
    g.fillStyle = rgba(ACCENT, 0.55);
    for (const a of [-60, -30, 0, 30, 60]) {
      const [x, y] = toXY(MAX_R + 0.5, a);
      g.fillText(a === 0 ? '0°' : `${Math.abs(a)}° ${a < 0 ? 'L' : 'R'}`, x, y + 3);
    }
    for (const [x, rot] of [[cx - half, yaw], [cx + half, -yaw]]) {
      g.save();
      g.translate(x, cy);
      g.rotate(rot * DEG);
      g.fillStyle = '#05070a';
      g.strokeStyle = rgba(ACCENT, 1);
      g.fillRect(-6, -4, 12, 8);
      g.strokeRect(-6, -4, 12, 8);
      g.fillStyle = rgba(ACCENT, 1);
      g.fillRect(-2, -6, 4, 2);
      g.restore();
    }
    g.strokeStyle = rgba(ACCENT, 0.5);
    g.beginPath();
    g.moveTo(cx - half, cy + 9);
    g.lineTo(cx + half, cy + 9);
    g.moveTo(cx - half, cy + 6);
    g.lineTo(cx - half, cy + 12);
    g.moveTo(cx + half, cy + 6);
    g.lineTo(cx + half, cy + 12);
    g.stroke();
    g.fillStyle = rgba(ACCENT, 0.9);
    g.fillText(`B = ${st.base} cm (not to scale)`, cx, cy + 23);
    g.textAlign = 'left';
  }

  function frame(t) {
    st.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - (st.last || t)) / 1000);
    st.last = t;
    const prev = st.sweep;
    st.sweep += st.dir * 34 * dt;
    if (st.sweep > 64) { st.sweep = 64; st.dir = -1; }
    if (st.sweep < -64) { st.sweep = -64; st.dir = 1; }
    for (const o of objects()) {
      const lo = Math.min(prev, st.sweep) - 0.5, hi = Math.max(prev, st.sweep) + 0.5;
      const v = o.azimuth >= lo && o.azimuth <= hi ? 1 : Math.max(0, (st.lit.get(o.id) ?? 0) - dt * 0.55);
      st.lit.set(o.id, v);
    }
    drawRadar(t);
    drawWave();
  }

  // ----------------------------------------------------------------------------- radar hover / click
  function hit(ev) {
    if (!geo) return null;
    const r = radarCv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = null, bd = 16;
    for (const o of objects()) {
      const [bx, by] = blipXY(o);
      const d = Math.hypot(bx - x, by - y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  radarCv.addEventListener('mousemove', (e) => {
    const o = hit(e);
    radarCv.style.cursor = o ? 'pointer' : 'default';
    setHover(o?.id ?? null);
  });
  radarCv.addEventListener('mouseleave', () => setHover(null));
  radarCv.addEventListener('click', (e) => { const o = hit(e); if (o) select(o.id); });

  // ----------------------------------------------------------------------------- controls
  $('base').addEventListener('input', (e) => { st.base = Number(e.target.value); $('baseOut').textContent = `${st.base} cm`; schedule(); });
  $('toe').addEventListener('input', (e) => { st.toe = Number(e.target.value); $('toeOut').textContent = `${st.toe}°`; schedule(); });

  // ----------------------------------------------------------------------------- voice agent
  const voice = new Voice();
  const listener = new Listener();
  let audio = null; // { ctx, stream, analyser, buf }
  const msg = (t) => { $('msg').textContent = t || ''; };

  // The scene the assistant sees, with the level of detail picked in the Droid pop-up.
  const scene = () => ({ ...assistantScene(objects()), detail: st.detail });
  function respond(r, heard) {
    if (r.intent !== 'detail') { st.lastQ = heard; st.lastCtx = st.ctx; }
    st.ctx = r.ctx;
    $('caption').innerHTML = '';
    $('caption').append(el('div', 'rs-q', `&gt; ${escapeHtml(heard)}`), el('div', 'rs-a', escapeHtml(r.text)));
    let id = r.focus;
    if (id == null) {
      const cls = classFromPhrase(heard) ?? classFromPhrase(r.text);
      id = objects().find((o) => o.cls === cls)?.id ?? null;
    }
    if (id != null) {
      st.pulse = { id, t: performance.now() };
      st.sel = objects().some((o) => o.id === id && o.range != null) ? id : st.sel;
      syncRows();
      renderFormula();
      drawViews();
      if (!st.active || reduced) pulseStatic();
    }
    if (r.intent === 'detail') { droid.open(); return; }
    voice.say(r.text).catch(() => {});
  }
  function ask(q) {
    q = q.trim();
    if (!q || !st.data) return;
    respond(answer(q, scene(), st.ctx), q);
  }
  // Without the sweep loop running, animate the pulse on its own for 3 s.
  function pulseStatic() {
    const t0 = performance.now();
    const step = (t) => { drawRadar(t); if (t - t0 < 3000 && !st.active) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  $('form').addEventListener('submit', (e) => { e.preventDefault(); ask($('q').value); });
  for (const c of ["What's closest to me?", 'How far is the sofa?', "What's on my left?"]) {
    const b = el('button', 'rs-chip', c);
    b.type = 'button';
    b.addEventListener('click', () => { $('q').value = c; ask(c); });
    $('chips').append(b);
  }

  // Droid detail pop-up: applies the preset the way the Measure page does (scene.detail), then
  // re-asks the last question so the caption visibly changes.
  const droid = mountDroid({
    button: $('detail'), anchor: section.querySelector('.rs-voice'), reduced,
    onApply(level, detail) {
      st.detail = normalizeDetail(detail);
      if (!st.data) return;
      const q = st.lastQ ?? "What's closest to me?";
      st.ctx = st.lastCtx ?? {};
      respond(answer(q, scene(), st.ctx), q);
    },
  });

  async function startAudio() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    audio = { ctx, stream, analyser, buf: new Uint8Array(analyser.fftSize) };
  }
  function stopAudio() {
    if (!audio) return;
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ctx.close().catch(() => {});
    audio = null;
  }
  function setListening(on) {
    st.listening = on;
    $('mic').classList.toggle('is-on', on);
    $('mic').setAttribute('aria-pressed', String(on));
    if (!st.active) drawWave();
  }

  $('mic').addEventListener('click', async () => {
    if (st.listening) return listener.stop();
    if (!listener.supported) return msg("Speech recognition isn't available in this browser. Type a question or use a chip below.");
    msg('');
    voice.cancel();
    try {
      await startAudio();
    } catch (e) {
      stopAudio();
      return msg(e?.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the address bar, or type a question below.' : `Couldn't open the microphone (${e?.message ?? e}). Type a question below.`);
    }
    setListening(true);
    if (!st.raf) waveLoop();
    $('caption').innerHTML = '<span class="rs-mut">Listening…</span>';
    const res = await listener.listen({ onInterim: (t) => { $('caption').innerHTML = `<span class="rs-mut">${escapeHtml(t)}</span>`; } });
    setListening(false);
    stopAudio();
    if (res.alternatives) return respond(answerBest(res.alternatives, scene(), st.ctx), res.alternatives[0]);
    $('caption').innerHTML = '<span class="rs-mut">Ask the rig about the room.</span>';
    if (res.error === 'not-allowed' || res.error === 'service-not-allowed') msg('Speech recognition was blocked. Type a question below.');
    else if (res.error === 'no-speech') msg("Didn't hear anything. Try again, or type below.");
    else if (res.error !== 'aborted') msg(`Speech recognition stopped (${res.error}). Type a question below.`);
  });
  function waveLoop() {
    if (!st.listening || st.raf) return;
    drawWave();
    requestAnimationFrame(waveLoop);
  }

  function drawWave() {
    const { g, w, h } = fit(waveCv);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = rgba(ACCENT, st.listening ? 0.95 : 0.35);
    g.lineWidth = 1.25;
    g.beginPath();
    if (audio && st.listening) {
      audio.analyser.getByteTimeDomainData(audio.buf);
      const n = audio.buf.length;
      for (let i = 0; i < n; i += 4) {
        const x = (i / (n - 1)) * w, y = h / 2 + ((audio.buf[i] - 128) / 128) * h * 0.9;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    } else {
      const t = reduced ? 0 : performance.now() / 900;
      for (let x = 0; x <= w; x += 3) {
        const y = h / 2 + Math.sin(x / 9 + t * 3) * Math.sin(x / w * Math.PI) * 1.6;
        x ? g.lineTo(x, y) : g.moveTo(x, y);
      }
    }
    g.stroke();
  }

  // ----------------------------------------------------------------------------- lifecycle
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { drawViews(); drawRadar(); drawWave(); }) : null;
  ro?.observe(radarCv);
  ro?.observe(viewsCv);
  recompute();
  drawWave();

  return {
    setActive(on) {
      on = !!on;
      if (on === st.active) return;
      st.active = on;
      if (on && !reduced) {
        st.last = 0;
        st.raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
        if (!on) { listener.abort(); voice.cancel(); }
        drawRadar();
      }
    },
    dispose() {
      cancelAnimationFrame(st.raf);
      cancelAnimationFrame(qRaf);
      ro?.disconnect();
      droid.dispose();
      listener.abort();
      voice.cancel();
      stopAudio();
      st.active = false;
      section.innerHTML = '';
      section.classList.remove('radar-sec');
    },
  };
}
