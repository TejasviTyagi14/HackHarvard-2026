// Section 2 of the landing page, "Measuring distance": a radar HUD for the two-camera rig.
// Until the visitor starts their cameras it runs the real stereo pipeline on a synthetic room
// (see ./adapter.js for what is mocked); after that, on the live pair (./live.js).
import { runPipeline, assistantScene, VIEW_W, VIEW_H, HFOV } from './adapter.js';
import { LiveStereo, liveErrorText, savedRig } from './live.js';
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
const fmtN = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const CAM_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" d="M3 7.5h3.2L8 5h8l1.8 2.5H21V19H3z"/><circle cx="12" cy="12.8" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const camBox = (i, name) => `
          <div class="rs-cam" data-k="cam${i}">
            <video muted playsinline autoplay data-k="vid${i}"></video>
            <div class="rs-cam-ph">${CAM_ICON}<span class="rs-cam-name">${name} · OFF</span><button class="rs-start" type="button" data-start>Start cameras</button></div>
            <div class="rs-cam-lbl"><i class="rs-live-dot"></i>${name} · LIVE</div>
          </div>`;
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
        <div class="rs-hud rs-hud-tl"><span class="rs-dot"></span><span data-k="mode">DEMO · SYNTHETIC ROOM</span></div>
        <div class="rs-hud rs-hud-tr" data-k="rig"></div>
        <canvas class="rs-radar-cv" aria-label="Radar view of measured objects"></canvas>
        <div class="rs-hud rs-hud-bl"><i class="rs-key rs-key-ov"></i>STEREO OVERLAP <i class="rs-key rs-key-warm"></i>&lt; 1 m</div>
      </div>
      <aside class="rs-side">
        <div class="rs-panel rs-views" data-k="views" data-mode="demo">
          <div class="rs-ph"><span>LEFT · MATCHED</span><span class="rs-mut" data-k="vsrc">synthetic room</span><span>RIGHT · MATCHED</span></div>
          <div class="rs-quad">
            <canvas class="rs-views-cv" aria-label="Left and right camera views with detections and matched points"></canvas>${camBox(0, 'LEFT')}${camBox(1, 'RIGHT')}
          </div>
          <div class="rs-livebar">
            <span class="rs-livemsg" data-k="livemsg" aria-live="polite"></span>
            <button class="rs-demo-btn" type="button" data-k="demoBtn" hidden>Use demo</button>
          </div>
        </div>
        <div class="rs-panel rs-controls">
          <label class="rs-slider"><span>BASELINE</span><input type="range" min="4" max="40" step="1" value="12" data-k="base"><output data-k="baseOut">12 cm</output></label>
          <label class="rs-slider"><span>TOE-IN</span><input type="range" min="-15" max="30" step="1" value="0" data-k="toe"><output data-k="toeOut">0°</output></label>
        </div>
        <div class="rs-panel rs-formula">
          <div class="rs-ph"><span>DEPTH</span><span class="rs-mut" data-k="fsel"></span></div>
          <div class="rs-eq" data-k="eq">Z = <b>f</b> · <b>B</b> / <b>d</b><span class="rs-eqv" data-k="eqv"><br>Z = <b data-k="ef"></b> · <b data-k="eB"></b> / <b data-k="ed"></b> = <em data-k="eZ"></em></span></div>
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
    base: 12, toe: 0, hfov: HFOV, data: null, hover: null, sel: null, pulse: null, lit: new Map(),
    sweep: -60, dir: 1, active: false, raf: 0, last: 0, pending: true, ctx: {}, listening: false,
    detail: normalizeDetail(DETAIL_PRESETS.normal), lastQ: null, lastCtx: {},
    mode: 'demo', // 'demo' | 'starting' | 'live'
    demoRig: null, // the demo's slider values while live
    blips: new Map(), // id → { r, az, tr, taz, a, gone, o }: eased radar positions
    eq: null, eqT: null, // formula numbers shown / target
    entered: false,
  };
  const offs = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: VIEW_W, height: VIEW_H }));
  const animating = () => st.active && !reduced;

  // ----------------------------------------------------------------------------- pipeline
  function recompute() {
    st.pending = false;
    // Live: the next measurement reads the sliders; only the rig drawing changes now.
    if (st.mode === 'live') {
      updateRigHud();
      if (!st.raf) drawRadar();
      return;
    }
    const d = runPipeline({ baselineCm: st.base, angleDeg: st.toe, hfovDeg: HFOV });
    d.images.forEach((img, i) => offs[i].getContext('2d').putImageData(img, 0, 0));
    setData({ rig: d.rig, objects: d.objects, srcs: offs, srcW: VIEW_W, srcH: VIEW_H });
  }
  /** One measured frame pair, demo or live: { rig, objects, srcs: [canvas, canvas], srcW, srcH }. */
  function setData(d) {
    st.data = d;
    if (st.sel != null && !d.objects.some((o) => o.id === st.sel && o.range != null)) st.sel = null;
    if (st.hover != null && !d.objects.some((o) => o.id === st.hover)) st.hover = null;
    updateRigHud();
    syncBlips(!animating());
    renderTable();
    renderFormula();
    drawViews();
    if (!st.raf) drawRadar();
  }
  function updateRigHud() {
    const f = st.data?.rig?.left.f;
    $('rig').textContent = `B ${fmtN(st.base)} cm · TOE-IN ${fmtN(st.toe)}° · HFOV ${fmtN(st.hfov)}°${f ? ` · f ${f.toFixed(0)} px` : ''}`;
  }
  let qRaf = 0;
  const schedule = () => {
    st.pending = true;
    if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; recompute(); });
  };

  const objects = () => st.data?.objects ?? [];
  const closest = () => objects().filter((o) => o.range != null).sort((a, b) => a.range - b.range)[0] ?? null;
  const selected = () => objects().find((o) => o.id === st.sel) ?? closest();

  // ----------------------------------------------------------------------------- blips (eased)
  function syncBlips(snap) {
    const seen = new Set();
    for (const o of objects()) {
      seen.add(o.id);
      const r = Math.min(o.range ?? MAX_R, MAX_R + 0.2), az = o.azimuth;
      let b = st.blips.get(o.id);
      if (!b) st.blips.set(o.id, (b = { r, az, a: 0 }));
      Object.assign(b, { o, tr: r, taz: az, gone: false });
      if (snap) Object.assign(b, { r, az, a: 1 });
    }
    for (const [id, b] of st.blips) {
      if (seen.has(id)) continue;
      b.gone = true;
      if (snap) st.blips.delete(id);
    }
  }
  function easeBlips(dt) {
    const k = 1 - Math.exp(-dt * 8);
    for (const [id, b] of st.blips) {
      b.r += (b.tr - b.r) * k;
      b.az += (b.taz - b.az) * k;
      b.a = b.gone ? b.a - dt * 3 : Math.min(1, b.a + dt * 4);
      if (b.gone && b.a <= 0) st.blips.delete(id);
    }
  }

  // ----------------------------------------------------------------------------- table
  const rows = new Map(); // id → <tr>, kept across frames so rows can animate in and out
  function renderTable() {
    const tb = $('tbody');
    const list = [...objects()].sort((a, b) => (a.range ?? 99) - (b.range ?? 99));
    const keep = new Set(list.map((o) => o.id));
    for (const [id, tr] of rows) {
      if (keep.has(id)) continue;
      rows.delete(id);
      if (!animating()) { tr.remove(); continue; }
      tr.classList.add('is-out');
      setTimeout(() => tr.remove(), 260);
    }
    list.forEach((o, i) => {
      let tr = rows.get(o.id);
      if (!tr) {
        tr = el('tr', animating() ? 'is-new' : '', '<td></td><td></td><td></td><td></td>');
        tr.dataset.id = o.id;
        tr.addEventListener('animationend', () => tr.classList.remove('is-new'));
        tr.addEventListener('mouseenter', () => setHover(o.id));
        tr.addEventListener('mouseleave', () => setHover(null));
        tr.addEventListener('click', () => select(o.id));
        rows.set(o.id, tr);
      }
      tr.classList.toggle('is-warm', isClose(o));
      const q = o.quality === 'rough' ? ' <span class="rs-tag">ROUGH</span>' : '';
      const cells = [label(o.cls), `${o.range != null ? o.range.toFixed(2) + ' m' : '—'}${q}`, sideTxt(o.azimuth), `${(o.score * 100).toFixed(0)}%`];
      cells.forEach((h, c) => { if (tr.cells[c].innerHTML !== h) tr.cells[c].innerHTML = h; });
      // Move only when out of place, so a row's entry animation isn't restarted.
      if (tb.children[i] !== tr) tb.insertBefore(tr, tb.children[i] ?? null);
    });
    syncRows();
  }
  function clearTable() {
    rows.clear();
    $('tbody').innerHTML = '';
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
    if (!o || !rig || o.range == null) {
      st.eqT = null;
      $('eqv').hidden = true;
      $('eqnote').textContent = st.mode === 'live' ? 'No object measured yet. Point the rig at a person, chair, cup…' : 'No object measured.';
      $('fsel').textContent = '';
      return;
    }
    const f = rig.left.f, B = rig.baseline;
    const Z = o.point ? o.point[2] : o.range;
    // Disparity of the matched sample the pipeline used (or, with an angle, its rectified equivalent).
    const s = o.samples?.find((x) => x.ok && x.m.tri?.point === o.point);
    let d = s ? Math.abs(s.m.uA - s.m.uB) : null;
    const rect = st.toe !== 0 || !s;
    if (rect) d = (f * B) / Z;
    st.eqT = { f, B, d, warm: isClose(o) };
    if (!st.eq || !animating()) st.eq = { ...st.eqT };
    $('eqv').hidden = false;
    writeEq();
    $('fsel').textContent = `${label(o.cls)}${st.sel == null ? ' · closest' : ''}`;
    const why = st.mode === 'live' ? 'Tracked over the last second. ' : rect ? 'Toe-in: disparity after rectification. ' : '';
    $('eqnote').textContent = `${why}Depth along the axis; slant range ${o.range.toFixed(2)} m (${o.quality}). Click a blip to switch.`;
  }
  // The numbers tick toward their new values; Z is always f · B / d of what's on screen.
  const eqTxt = { ef: '', eB: '', ed: '', eZ: '' };
  function writeEq() {
    const e = st.eq;
    if (!e) return;
    const t = { ef: `${e.f.toFixed(0)} px`, eB: `${e.B.toFixed(2)} m`, ed: `${e.d.toFixed(1)} px`, eZ: `${((e.f * e.B) / e.d).toFixed(2)} m` };
    for (const k in t) if (t[k] !== eqTxt[k]) $(k).textContent = eqTxt[k] = t[k];
    $('eZ').classList.toggle('warm', !!st.eqT?.warm);
  }
  function easeEq(dt) {
    if (!st.eq || !st.eqT) return;
    const k = 1 - Math.exp(-dt * 10);
    for (const key of ['f', 'B', 'd']) st.eq[key] += (st.eqT[key] - st.eq[key]) * k;
    writeEq();
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
    const d = st.data;
    if (!d) return;
    const w = viewsCv.clientWidth || 640;
    const gap = 10, vw = (w - gap) / 2, k = vw / d.srcW, vh = d.srcH * k;
    const { g } = fit(viewsCv, vh);
    g.clearRect(0, 0, w, vh);
    g.imageSmoothingEnabled = true;
    const ox = [0, vw + gap];
    d.srcs.forEach((c, i) => {
      g.drawImage(c, ox[i], 0, vw, vh);
      g.strokeStyle = rgba(ACCENT, 0.2);
      g.lineWidth = 1;
      g.strokeRect(ox[i] + 0.5, 0.5, vw - 1, vh - 1);
    });
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
    for (let a = yaw - st.hfov / 2; a <= yaw + st.hfov / 2 + 1e-6; a += 2) pts.push([apexX + Math.sin(a * DEG) * R, geo.cy - Math.cos(a * DEG) * R]);
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

  const blipXY = (b) => toXY(b.r, b.az);

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
    for (const b of st.blips.values()) {
      const o = b.o;
      const [x, y] = blipXY(b);
      const col = isClose(o) ? WARM : OBJ;
      g.globalAlpha = Math.max(0, Math.min(1, b.a));
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
    g.globalAlpha = 1;
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
    g.fillText(`B = ${fmtN(st.base)} cm (not to scale)`, cx, cy + 23);
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
    easeBlips(dt);
    easeEq(dt);
    drawRadar(t);
    drawWave();
  }

  // ----------------------------------------------------------------------------- radar hover / click
  function hit(ev) {
    if (!geo) return null;
    const r = radarCv.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let best = null, bd = 16;
    for (const b of st.blips.values()) {
      if (b.gone) continue;
      const [bx, by] = blipXY(b);
      const d = Math.hypot(bx - x, by - y);
      if (d < bd) { bd = d; best = b.o; }
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
  function syncSliders() {
    $('base').value = String(st.base);
    $('toe').value = String(st.toe);
    $('baseOut').textContent = `${fmtN(st.base)} cm`;
    $('toeOut').textContent = `${fmtN(st.toe)}°`;
  }

  // ----------------------------------------------------------------------------- live cameras
  const viewsPanel = $('views');
  const vids = [$('vid0'), $('vid1')];
  const camEls = [$('cam0'), $('cam1')];
  const startBtns = [...section.querySelectorAll('[data-start]')];
  const live = new LiveStereo({
    getRig: () => ({ baselineCm: st.base, angleDeg: st.toe }),
    onResult: (res) => {
      if (st.mode !== 'live') return;
      setData({ rig: res.rig, objects: res.objects, srcs: res.canvases, srcW: res.w, srcH: res.h });
      if (live.detectorStatus === 'ready') liveMsg(`${live.labels.join(' ↔ ')} · ${res.hz ? res.hz.toFixed(1) + ' Hz' : ''}`);
    },
    onStatus: (kind, v) => {
      if (st.mode !== 'live') return;
      if (kind === 'ended') useDemo(`The ${v === 0 ? 'left' : 'right'} camera disconnected — back to the demo room.`);
      else if (kind === 'detector' && v === 'loading') liveMsg('Loading the object detector (first time only, a few MB)…');
      else if (kind === 'detector' && v === 'error') liveMsg("Couldn't download the object detector (it needs the internet the first time). The cameras still run.", 'err');
    },
  });
  const liveMsg = (t, kind = 'info') => {
    const m = $('livemsg');
    if (m.textContent !== t) m.textContent = t || '';
    m.dataset.kind = kind;
  };
  const CHIPS = {
    demo: ["What's closest to me?", 'How far is the sofa?', "What's on my left?"],
    live: ["What's closest to me?", 'How far is the person?', "What's on my left?"],
  };
  function renderChips() {
    $('chips').innerHTML = '';
    for (const c of CHIPS[st.mode === 'live' ? 'live' : 'demo']) {
      const b = el('button', 'rs-chip', c);
      b.type = 'button';
      b.addEventListener('click', () => { $('q').value = c; ask(c); });
      $('chips').append(b);
    }
  }
  function setMode(m) {
    const was = st.mode;
    st.mode = m;
    viewsPanel.dataset.mode = m;
    $('mode').textContent = m === 'live' ? 'LIVE · 2 CAM' : m === 'starting' ? 'STARTING CAMERAS…' : 'DEMO · SYNTHETIC ROOM';
    $('vsrc').textContent = m === 'live' ? 'live · detected' : 'synthetic room';
    for (const b of startBtns) {
      b.disabled = m !== 'demo';
      b.textContent = m === 'starting' ? 'Starting…' : 'Start cameras';
    }
    $('demoBtn').hidden = m === 'demo';
    if ((was === 'live') !== (m === 'live')) renderChips();
  }
  function scanFlash() {
    if (reduced) return;
    for (const c of camEls) {
      c.classList.remove('is-scan');
      void c.offsetWidth; // restart the animation
      c.classList.add('is-scan');
    }
  }
  for (const c of camEls) c.addEventListener('animationend', (e) => { if (e.animationName === 'rs-scan') c.classList.remove('is-scan'); });

  async function startLive() {
    if (st.mode !== 'demo') return;
    setMode('starting');
    liveMsg('Asking for camera access…');
    let info;
    try {
      info = await live.start();
    } catch (e) {
      if (e?.name === 'Cancelled' || st.mode !== 'starting') return;
      setMode('demo');
      liveMsg(liveErrorText(e), 'err');
      return;
    }
    if (st.mode !== 'starting') { live.stop(); return; }
    // The rig the Measure page saved; the sliders override it from here on.
    const rig = savedRig();
    st.demoRig = { base: st.base, toe: st.toe };
    st.base = rig.baselineCm;
    st.toe = rig.angleDeg;
    st.hfov = rig.hfovDeg;
    syncSliders();
    live.streams.forEach((s, i) => {
      vids[i].srcObject = s;
      vids[i].play().catch(() => {});
    });
    const size = live.size;
    if (size) viewsPanel.style.setProperty('--cam-ar', `${size.w} / ${size.h}`);
    // Clear the demo's objects so they fade out while the first live pair is measured.
    st.sel = st.hover = null;
    clearTable();
    setMode('live');
    setData({ ...st.data, objects: [] });
    scanFlash();
    liveMsg(`${info.labels.join(' ↔ ')}${info.calibrated ? ' · calibrated rig' : ' · rig from the Measure page'}`);
    live.pause(!st.active);
    if (!st.active) vids.forEach((v) => v.pause());
  }
  function useDemo(note = '') {
    live.stop();
    vids.forEach((v) => { v.pause(); v.srcObject = null; });
    viewsPanel.style.removeProperty('--cam-ar');
    if (st.demoRig) {
      st.base = st.demoRig.base;
      st.toe = st.demoRig.toe;
      st.demoRig = null;
    }
    st.hfov = HFOV;
    syncSliders();
    st.sel = st.hover = null;
    st.blips.clear();
    clearTable();
    setMode('demo');
    liveMsg(note);
    recompute();
  }
  for (const b of startBtns) b.addEventListener('click', startLive);
  $('demoBtn').addEventListener('click', () => useDemo());

  // ----------------------------------------------------------------------------- voice agent
  const voice = new Voice();
  const listener = new Listener();
  let audio = null; // { ctx, stream, analyser, buf }
  const msg = (t) => { $('msg').textContent = t || ''; };

  // The scene the assistant sees, with the level of detail picked in the Droid pop-up.
  const scene = () => {
    const s = { ...assistantScene(objects()), detail: st.detail, hfovDeg: st.hfov };
    if (st.mode === 'live') s.status = { loading: 'loading', error: 'detector-error' }[live.detectorStatus] ?? 'ok';
    return s;
  };
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
  renderChips();

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
      // Panels fade and slide in the first time the section comes into view.
      if (on && !st.entered) { st.entered = true; section.classList.add('is-in'); }
      // Off-screen: no measuring and no drawing; the cameras stay open so coming back is instant.
      live.pause(!on);
      if (st.mode === 'live') vids.forEach((v) => (on ? v.play().catch(() => {}) : v.pause()));
      if (on && !reduced) {
        st.last = 0;
        st.raf = requestAnimationFrame(frame);
      } else {
        cancelAnimationFrame(st.raf);
        st.raf = 0;
        if (!on) { listener.abort(); voice.cancel(); }
        syncBlips(true);
        if (st.eqT) { st.eq = { ...st.eqT }; writeEq(); }
        drawRadar();
      }
    },
    dispose() {
      cancelAnimationFrame(st.raf);
      cancelAnimationFrame(qRaf);
      live.dispose();
      vids.forEach((v) => { v.pause(); v.srcObject = null; });
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
