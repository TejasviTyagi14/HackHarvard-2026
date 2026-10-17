// Controller: video sources → snapshot both frames → detect → stereo-measure → track,
// then draw the views and the map every animation frame and refresh the side panels.
import { DEG, bearing, buildRig, clockLabel, fitCalibration, norm, pixelRay, sampleRange, scale, sideLabel } from './geometry.js';
import { GrayFrame, bandSearch, localSearch, sharpness } from './stereo.js';
import { REASONS, Tracker, formatDistance, measurePoint, measureScene, median, pairwiseDistances } from './scene.js';
import { castRay, demoScene, groundTruthDetections, renderView } from './demo.js';
import { Detector, MODELS } from './detector.js';
import {
  CanvasSource, cameraDetails, cameraPermission, camerasSupported, ensurePermission, listCameras,
  lockFocus, openCamera, openRecording, pickDefaultPair,
} from './sources.js';
import { classColor, drawMap, drawRigDiagram, drawView, fitCanvas } from './render.js';
import { Speaker, Voice } from './speech.js';
import { Talk } from './talk.js';
import { sayDistance } from './assistant.js';
import { fitFromPerson, personMatches, personReading, pickPerson, robustSubset, verticalOffset } from './personcal.js';
import { StereoRecorder, downloadBlob } from './recorder.js';

const $ = (id) => document.getElementById(id);
const PROC_MAX_W = 640; // matching and detection run at this width whatever the camera delivers
const STORE_KEY = 'stereo-distance:v1';
const FT = 0.3048;

const DEFAULTS = {
  baselineCm: 12, angleDeg: 0, angleSplit: 'even', hfovDeg: 70, tiltDeg: 0, vtol: 4,
  resolution: '1280x720', model: 'lite_mobilenet_v2', minScore: 0.5, units: 'm', detect: true,
  deviceIds: [null, null], debug: false, demoAngleErr: 0, demoBaselineErr: 0, vOffset: 0,
  rigConfirmed: false, calibrated: false, focusCheck: null, talkFollowUp: true, talkSpeak: true,
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULTS, ...saved };
  } catch { /* storage unavailable: use defaults */ }
  return { ...DEFAULTS };
}

const state = {
  settings: loadSettings(),
  mode: null, // 'cameras' | 'files' | 'demo'
  gen: 0, // bumps whenever sources change, so in-flight frames get dropped
  sources: [null, null],
  cameras: [],
  permission: 'unknown',
  detector: new Detector(),
  detectorStatus: 'idle', // idle | loading | ready | error
  running: false,
  paused: false,
  frames: [null, null],
  dets: [[], []],
  rig: null,
  objects: [],
  pins: [],
  pinResults: [],
  nextPinId: 1,
  selectedId: null,
  tracker: new Tracker(),
  vOffset: 0,
  swapScore: 0,
  swapDismissedAt: -Infinity,
  banner: { id: null, kind: null },
  calib: { mode: 'idle', target: null, samples: [], result: null },
  focusTest: null,
  demo: null,
  stats: { fps: 0, detectMs: 0, stereoMs: 0, last: 0 },
  panelsAt: 0,
  talkLog: [], // [{ who: 'you' | 'bot', text }]
  pcal: freshPersonCal(),
};

/** Person calibration: up to two captured positions, the capture in progress, and the result. */
function freshPersonCal() {
  return { positions: [], capturing: null, result: null, undo: null, msg: ['', ''], err: [false, false] };
}
state.vOffset = Number(state.settings.vOffset) || 0;

const procCanvases = [document.createElement('canvas'), document.createElement('canvas')];
const procCtx = procCanvases.map((c) => c.getContext('2d', { willReadFrequently: true }));
const viewCanvases = [$('viewL'), $('viewR')];
const viewCtx = viewCanvases.map((c) => c.getContext('2d'));
const mapCtx = $('map').getContext('2d');
const rigCtx = $('rigDiagram').getContext('2d');
const voice = new Voice();
const speaker = new Speaker(voice);
const talk = new Talk({
  voice,
  getScene: sceneForAssistant,
  onTurn: onTalkTurn,
  onAction: onTalkAction,
  onState: onTalkState,
});
const recorder = new StereoRecorder();

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const fmt = (m) => formatDistance(m, state.settings.units);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const bothReady = () => !!(state.sources[0]?.ready && state.sources[1]?.ready);
const rigParams = (s = state.settings) => ({ baselineCm: s.baselineCm, angleDeg: s.angleDeg, hfovDeg: s.hfovDeg, angleSplit: s.angleSplit });

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...state.settings, vOffset: round(state.vOffset, 2) }));
  } catch { /* storage unavailable: settings last for this visit only */ }
}

// ---------------------------------------------------------------------------------------
// Settings form

const NUMERIC = {
  inBaseline: ['baselineCm', 0.5, 300], inAngle: ['angleDeg', -45, 45], inFov: ['hfovDeg', 20, 160],
  inTilt: ['tiltDeg', -60, 60], inVtol: ['vtol', 0, 15], inMinScore: ['minScore', 0.1, 0.95],
  inDemoErr: ['demoAngleErr', -10, 10], inDemoBaseErr: ['demoBaselineErr', -10, 10],
};
const CHOICE = { inSplit: 'angleSplit', inModel: 'model', inRes: 'resolution', inUnits: 'units' };

function bindSettings() {
  $('inModel').innerHTML = Object.entries(MODELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  for (const [id, [key, lo, hi]] of Object.entries(NUMERIC)) {
    const el = $(id);
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (el.value === '' || !Number.isFinite(v) || v < lo || v > hi) return;
      setSetting(key, v);
    });
    el.addEventListener('change', () => { el.value = state.settings[key]; });
  }
  for (const [id, key] of Object.entries(CHOICE)) $(id).addEventListener('change', (e) => setSetting(key, e.target.value));
  $('inDetect').addEventListener('change', (e) => setSetting('detect', e.target.checked));
}

function syncInputs() {
  for (const [id, [key]] of Object.entries(NUMERIC)) $(id).value = state.settings[key];
  for (const [id, key] of Object.entries(CHOICE)) $(id).value = state.settings[key];
  $('inDetect').checked = state.settings.detect;
  $('minScoreVal').textContent = Number(state.settings.minScore).toFixed(2);
  $('trueUnit').textContent = state.settings.units;
  document.querySelectorAll('.pcUnit').forEach((el) => { el.textContent = state.settings.units; });
}

function setSetting(key, value) {
  if (state.settings[key] === value) return;
  const prev = state.settings[key];
  state.settings[key] = value;
  if (key === 'baselineCm' || key === 'angleDeg') state.settings.rigConfirmed = true;
  if (['baselineCm', 'angleDeg', 'angleSplit', 'hfovDeg', 'tiltDeg', 'vtol'].includes(key)) rigChanged();
  if (key === 'resolution' && state.mode === 'cameras') reopenCameras();
  if (key === 'model' || key === 'detect') ensureDetector();
  if (key === 'minScore') $('minScoreVal').textContent = value.toFixed(2);
  if (key === 'units') {
    $('trueUnit').textContent = value;
    for (const id of ['inTrueDist', 'inPcDist1', 'inPcDist2']) {
      const v = Number($(id).value);
      if (v > 0) $(id).value = (prev === 'm' && value === 'ft' ? v / FT : v * FT).toFixed(2);
    }
    document.querySelectorAll('.pcUnit').forEach((el) => { el.textContent = value; });
  }
  saveSettings();
  refreshPanels(true);
}

function rigChanged() {
  state.tracker = new Tracker();
  for (const p of state.pins) p.hist = [];
  drawRig();
  if (state.paused) remeasure();
}

function drawRig() {
  const dpr = fitCanvas($('rigDiagram'));
  drawRigDiagram(rigCtx, state.settings, dpr);
  const B = state.settings.baselineCm / 100;
  const pct = Math.round((100 * Math.tan(DEG) * 2) / B);
  $('angleNote').textContent = `With the cameras ${state.settings.baselineCm} cm apart, 1° of angle error shifts a 2 m reading by about ${pct}%. Calibrate with a tape measure to pin the angle down.`;
}

// ---------------------------------------------------------------------------------------
// Sources

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#sourceSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.body.classList.toggle('demo', mode === 'demo');
  $('cardDemo').hidden = mode !== 'demo';
}

function showPlaceholder(msg) {
  $('phStatus').hidden = !msg;
  $('phStatus').textContent = msg || '';
  $('phIntro').hidden = !!msg;
}

async function stopSources() {
  state.gen++;
  if (recorder.active) await stopRecording();
  for (const s of new Set(state.sources)) s?.stop();
  state.sources = [null, null];
  state.running = false;
  state.frames = [null, null];
  state.dets = [[], []];
  state.demo = null;
  state.swapScore = 0;
  state.stats.fps = 0;
  setPaused(false);
  resetMeasurements();
}

function resetMeasurements() {
  state.tracker = new Tracker();
  state.objects = [];
  state.pins = [];
  state.pinResults = [];
  state.selectedId = null;
  state.calib.target = null;
  state.calib.mode = 'idle';
  state.focusTest = null;
}

function start(mode) {
  if (mode === 'cameras') startCameras();
  else if (mode === 'files') chooseFiles();
  else startDemo();
}

async function startCameras() {
  await stopSources();
  setMode('cameras');
  showPlaceholder('Connecting to the cameras…');
  try {
    await ensurePermission();
  } catch (e) {
    state.permission = await cameraPermission();
    showPlaceholder(null);
    showBanner(cameraErrorText(e), 'err');
    refreshPanels(true);
    return;
  }
  state.permission = await cameraPermission();
  state.cameras = await listCameras();
  state.settings.deviceIds = pickDefaultPair(state.cameras, state.settings.deviceIds);
  saveSettings();
  fillDeviceSelects();
  if (state.cameras.length < 2) {
    showBanner(`Only ${state.cameras.length} camera found. Plug in both IC780s, then press Cameras again.`, 'err');
  }
  await openSide(0);
  await openSide(1);
  showPlaceholder(null);
  state.running = true;
  refreshCameraInfo();
  ensureDetector();
  refreshPanels(true);
}

async function reopenCameras() {
  state.gen++;
  await openSide(0);
  await openSide(1);
  refreshCameraInfo();
}

async function openSide(i) {
  state.sources[i]?.stop();
  state.sources[i] = null;
  const id = state.settings.deviceIds[i];
  if (!id) return;
  const [w, h] = state.settings.resolution.split('x').map(Number);
  const cam = state.cameras.find((c) => c.deviceId === id);
  try {
    state.sources[i] = await openCamera(id, w, h, cam?.label ?? 'Camera');
  } catch (e) {
    showBanner(cameraErrorText(e, i), 'err');
  }
  state.tracker = new Tracker();
}

function cameraErrorText(e, side) {
  const which = side == null ? 'camera' : side === 0 ? 'left camera' : 'right camera';
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Click the camera icon in the address bar to allow it. On macOS, also check System Settings → Privacy & Security → Camera and turn on your browser.';
    case 'NotReadableError':
    case 'AbortError':
      return `Couldn't start the ${which}. With two USB webcams this is usually USB bandwidth: set 640 × 480 under Detection & display, or plug the cameras into different ports. Also quit other apps using a camera (Zoom, FaceTime, Photo Booth).`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `The ${which} wasn't found. Unplug and replug it, then press Cameras again.`;
    case 'NoMediaDevices':
      return e.message;
    default:
      return `Couldn't start the ${which}: ${e?.message || e}`;
  }
}

function fillDeviceSelects() {
  ['devL', 'devR'].forEach((id, i) => {
    const el = $(id);
    if (state.mode !== 'cameras') {
      el.innerHTML = `<option>${esc(state.sources[i]?.label ?? '—')}</option>`;
      el.disabled = true;
      return;
    }
    el.disabled = false;
    el.innerHTML = state.cameras.map((c) => `<option value="${esc(c.deviceId)}">${esc(c.label)}</option>`).join('') || '<option>No cameras</option>';
    el.value = state.settings.deviceIds[i] ?? '';
  });
}

async function onDevicePicked(i, value) {
  const ids = state.settings.deviceIds;
  if (ids[1 - i] === value) {
    // Picked the other side's camera: swap them instead of opening one camera twice.
    swapSides();
    return;
  }
  ids[i] = value;
  saveSettings();
  state.gen++;
  await openSide(i);
  resetMeasurements();
  refreshCameraInfo();
  refreshPanels(true);
}

function swapSides() {
  if (state.mode === 'cameras') {
    state.settings.deviceIds.reverse();
    saveSettings();
  }
  state.sources.reverse();
  if (state.demo) {
    state.demo.dets.reverse();
    state.demo.swapped = !state.demo.swapped;
  }
  state.gen++;
  state.frames = [null, null];
  state.swapScore = 0;
  resetMeasurements();
  fillDeviceSelects();
  refreshCameraInfo();
  if (state.banner.id === 'swap') hideBanner();
  refreshPanels(true);
}

function chooseFiles() {
  $('fileInput').value = '';
  $('fileInput').click();
}

async function startReplay(files) {
  await stopSources();
  setMode('files');
  showPlaceholder('Opening the recording…');
  try {
    state.sources = await openRecording(files);
    state.running = true;
    ensureDetector();
  } catch (e) {
    showBanner(e.message, 'err');
  }
  showPlaceholder(null);
  fillDeviceSelects();
  refreshCameraInfo();
  refreshPanels(true);
}

async function startDemo() {
  await stopSources();
  setMode('demo');
  showPlaceholder('Rendering the demo room…');
  await new Promise((r) => setTimeout(r, 30)); // let the message paint before the render blocks
  const s = state.settings;
  // The "real" rig: what you entered, plus whatever mounting error you asked it to simulate.
  const truth = { ...rigParams(), baselineCm: s.baselineCm + s.demoBaselineErr, angleDeg: s.angleDeg + s.demoAngleErr };
  const canvases = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: 640, height: 360 }));
  state.demo = { truth, canvases, person: null, swapped: false, dets: [[], []] };
  renderDemo();
  state.sources = [new CanvasSource(canvases[0], 'Demo room · left camera'), new CanvasSource(canvases[1], 'Demo room · right camera')];
  state.running = true;
  showPlaceholder(null);
  fillDeviceSelects();
  refreshCameraInfo();
  refreshPanels(true);
}

/** Draws the demo room (with the stand-in person, if placed) into the demo canvases. */
function renderDemo() {
  const d = state.demo;
  const [W, H] = [d.canvases[0].width, d.canvases[0].height];
  const rig = buildRig(d.truth, { w: W, h: H });
  const scene = demoScene(undefined, d.person != null ? { person: { range: d.person } } : {});
  [rig.left, rig.right].forEach((cam, i) => {
    d.canvases[i].getContext('2d').putImageData(new ImageData(renderView(cam, scene, W, H), W, H), 0, 0);
  });
  const dets = [groundTruthDetections(rig.left, scene), groundTruthDetections(rig.right, scene)];
  Object.assign(d, { rig, scene, dets: d.swapped ? dets.reverse() : dets });
}

async function ensureDetector() {
  if (!state.settings.detect || !state.mode || state.mode === 'demo') return refreshChips();
  state.detectorStatus = 'loading';
  refreshPanels(true);
  try {
    await state.detector.load(state.settings.model);
    state.detectorStatus = 'ready';
  } catch (e) {
    state.detectorStatus = 'error';
    showBanner(`Couldn't load the object detector (${e.message}). It downloads from the internet the first time. Clicking points to measure them still works.`, 'warn');
  }
  refreshPanels(true);
}

// ---------------------------------------------------------------------------------------
// Processing

function snapshot(src, i) {
  const pw = Math.min(PROC_MAX_W, src.width), ph = Math.round((src.height * pw) / src.width);
  const c = procCanvases[i];
  if (c.width !== pw || c.height !== ph) {
    c.width = pw;
    c.height = ph;
  }
  src.drawTo(procCtx[i], pw, ph);
  return GrayFrame.fromRGBA(procCtx[i].getImageData(0, 0, pw, ph).data, pw, ph);
}

// Ground-truth boxes are perfect; real detector boxes wobble by a few pixels, so wobble these too.
const jitter = (dets) => dets.map((d) => ({ ...d, bbox: d.bbox.map((v) => v + (Math.random() - 0.5) * 3) }));

// Hidden tabs get no animation frames; keep measuring (and speaking) on a timer instead.
const tick = () => (document.hidden ? new Promise((r) => setTimeout(r, 100)) : nextFrame());

async function processLoop() {
  for (;;) {
    await tick();
    const now = performance.now();
    if (!state.running || state.paused || !bothReady() || now - state.stats.last < 30) continue;
    try {
      await processFrame(now);
    } catch (e) {
      console.error(e);
    }
  }
}

async function processFrame(t0) {
  const gen = state.gen;
  const frames = state.sources.map((src, i) => snapshot(src, i));
  let dets = [[], []];
  if (state.mode === 'demo') {
    dets = state.demo.dets.map(jitter);
  } else if (state.settings.detect && state.detectorStatus === 'ready') {
    const min = state.settings.minScore;
    dets = [await state.detector.detect(procCanvases[0], min), await state.detector.detect(procCanvases[1], min)];
  }
  if (gen !== state.gen) return;
  const t1 = performance.now();
  state.frames = frames;
  state.dets = dets;
  measure(t1, true);
  const t2 = performance.now();
  const st = state.stats;
  const dt = t0 - st.last;
  st.last = t0;
  if (dt > 0 && dt < 2000) st.fps = st.fps ? 0.9 * st.fps + 0.1 * (1000 / dt) : 1000 / dt;
  st.detectMs = 0.8 * st.detectMs + 0.2 * (t1 - t0);
  st.stereoMs = 0.8 * st.stereoMs + 0.2 * (t2 - t1);
  refreshPanels();
}

/** fresh = a new frame pair; otherwise re-measure the paused frame (after a click or a settings change). */
function measure(now, fresh) {
  const [fL, fR] = state.frames;
  if (!fL || !fR) return;
  const s = state.settings;
  const rig = buildRig(rigParams(), fL, fR);
  const opts = { vtol: s.vtol, tiltDeg: s.tiltDeg, vOffset: state.vOffset };
  const scene = measureScene(state.dets[0], state.dets[1], fL, fR, rig, opts);
  if (fresh) {
    // Learn how far the right image sits above/below the left one from confident matches.
    if (scene.dyObs.length >= 2) state.vOffset = clamp(0.85 * state.vOffset + 0.15 * median(scene.dyObs), -30, 30);
    const { normal, swapped } = scene.swapVotes;
    if (normal + swapped > 0) state.swapScore = 0.92 * state.swapScore + 0.08 * (swapped / (normal + swapped));
  }
  state.rig = rig;
  state.objects = state.tracker.update(scene.objects, now, s.tiltDeg, { replace: !fresh });
  state.pinResults = state.pins.map((p) => measurePin(p, fL, fR, rig, opts, fresh));
  if (fresh) {
    tickFocusTest(fL, fR, now);
    if (state.pcal.capturing?.phase === 'capturing') collectPerson(fL, fR, now);
    speaker.tick(state.objects, s.units, now, talk.busy || !!state.pcal.capturing);
  }
}

function remeasure() {
  measure(performance.now(), false);
  refreshPanels(true);
}

function measurePin(p, fL, fR, rig, opts, fresh) {
  const m = measurePoint(p.u, p.v, fL, fR, rig, opts);
  if (!fresh) p.hist = [];
  if (m.range != null) p.lastPoint = m.point;
  p.hist = [...p.hist, m.range].slice(-7);
  const valid = p.hist.filter((r) => r != null);
  const base = { id: p.id, u: p.u, v: p.v, cls: 'point', match: m.match };
  if (!valid.length || (m.range == null && valid.length < 2)) {
    return { ...base, range: null, point: null, ground: null, azimuth: m.azimuth, reason: m.reason };
  }
  const range = median(valid);
  const point = scale(p.lastPoint, range / norm(p.lastPoint));
  const br = bearing(point, opts.tiltDeg);
  return { ...base, range, point, ground: br.ground, azimuth: br.azimuth, reason: null };
}

// ---------------------------------------------------------------------------------------
// Drawing

function personOverlay() {
  const c = state.pcal.capturing;
  if (!c) return null;
  const at = formatDistance(c.range, state.settings.units);
  return c.phase === 'capturing'
    ? { label: `Calibrating at ${at} · hold still`, matches: c.last ?? [] }
    : { label: `Calibrating at ${at} · get ready`, matches: [] };
}

function displayLoop() {
  const s = state.settings;
  for (let i = 0; i < 2; i++) {
    const src = state.sources[i];
    const canvas = viewCanvases[i];
    if (src?.ready) {
      const ar = `${src.width} / ${src.height}`;
      if (canvas.dataset.ar !== ar) {
        canvas.dataset.ar = ar;
        canvas.style.aspectRatio = ar;
      }
    }
    $(i ? 'phR' : 'phL').hidden = !!src?.ready;
    const dpr = fitCanvas(canvas);
    drawView(viewCtx[i], {
      source: src, side: i, frame: state.frames[i], objects: state.objects, pins: state.pinResults,
      selectedId: state.selectedId, debug: s.debug, units: s.units, calib: state.calib, dpr,
      paused: state.paused, still: procCanvases[i], pcal: personOverlay(),
    });
  }
  const dpr = fitCanvas($('map'));
  const rig = state.rig ?? buildRig(rigParams(), { w: 640, h: 360 });
  drawMap(mapCtx, { objects: state.objects, pins: state.pinResults, rig, settings: s, selectedId: state.selectedId, units: s.units, dpr });
  if (recorder.active) $('recTime').textContent = `Recording · ${Math.floor((performance.now() - recorder.startedAt) / 1000)} s`;
  refreshPanels();
  requestAnimationFrame(displayLoop);
}

// ---------------------------------------------------------------------------------------
// Clicks on the views

function onViewClick(side, e) {
  const fr = state.frames[side];
  if (!fr) return;
  const rect = viewCanvases[side].getBoundingClientRect();
  const u = ((e.clientX - rect.left) / rect.width) * fr.w;
  const v = ((e.clientY - rect.top) / rect.height) * fr.h;
  const cssPerPx = rect.width / fr.w;
  if (state.calib.mode !== 'idle') return onCalibClick(side, u, v);

  if (side === 0) {
    const k = state.pins.findIndex((p) => Math.hypot(p.u - u, p.v - v) * cssPerPx < 12);
    if (k >= 0) {
      state.pins.splice(k, 1);
      return afterEdit();
    }
  }
  const key = side === 0 ? 'boxL' : 'boxR';
  const inside = (b) => u >= b[0] && u <= b[0] + b[2] && v >= b[1] && v <= b[1] + b[3];
  const hits = state.objects.filter((o) => o[key] && inside(o[key])).sort((a, b) => a[key][2] * a[key][3] - b[key][2] * b[key][3]);
  if (hits.length && !e.shiftKey) {
    state.selectedId = state.selectedId === hits[0].id ? null : hits[0].id;
    return afterEdit();
  }
  if (side === 0) {
    state.pins.push({ id: state.nextPinId++, u, v, hist: [] });
    if (state.pins.length > 6) state.pins.shift();
    return afterEdit();
  }
  state.selectedId = null;
  flashHint();
  afterEdit();
}

function afterEdit() {
  state.pinResults = state.pinResults.filter((r) => state.pins.some((p) => p.id === r.id));
  if (state.paused) remeasure();
  else refreshPanels(true);
}

function flashHint() {
  const h = $('hint');
  h.classList.add('flash');
  setTimeout(() => h.classList.remove('flash'), 1200);
}

// ---------------------------------------------------------------------------------------
// Tape-measure calibration

function onCalibClick(side, u, v) {
  const [fL, fR] = state.frames;
  const c = state.calib;
  if (side === 0) {
    const m = bandSearch(fL, fR, u, v, { r: 8, band: 24 });
    let consistent = false;
    if (m.ok) {
      const back = bandSearch(fR, fL, m.uB, m.vB, { r: 8, band: 24 });
      consistent = back.ok && Math.abs(back.uB - m.uA) <= 2.5 && Math.abs(back.vB - m.vA) <= 3;
    }
    const uL = m.uA ?? Math.round(u), vL = m.vA ?? Math.round(v);
    c.target = {
      uL, vL, uR: m.ok ? m.uB : null, vR: m.ok ? m.vB : null, score: m.score ?? 0, consistent, manual: false,
      reason: m.ok ? null : m.reason, sizeL: { w: fL.w, h: fL.h }, sizeR: { w: fR.w, h: fR.h },
      demoTruth: demoTruthAt(uL, vL),
    };
    if (c.target.demoTruth) {
      const t = c.target.demoTruth;
      $('inTrueDist').value = (state.settings.units === 'ft' ? t / FT : t).toFixed(2);
    }
    c.mode = 'adjust';
  } else if (c.target) {
    const t = c.target;
    const m = localSearch(fL, fR, t.uL, t.vL, u, v, { r: 8, radius: 6 });
    Object.assign(t, m.ok ? { uR: m.uB, vR: m.vB, score: m.score } : { uR: u, vR: v, score: 0 }, { manual: true, consistent: true });
  } else {
    flashHint();
  }
  refreshPanels(true);
}

/** In the demo room the true distance under a left-view pixel is known exactly. */
function demoTruthAt(u, v) {
  const d = state.demo;
  if (!d) return null;
  const cam = d.swapped ? d.rig.right : d.rig.left;
  const hit = castRay(pixelRay(cam, u, v), d.scene);
  return hit ? norm(hit.point) : null;
}

function updateVOffsetFromSamples() {
  const off = verticalOffset(state.calib.samples, rigParams());
  if (off != null) state.vOffset = clamp(off, -30, 30);
}

function addSample() {
  const t = state.calib.target;
  if (!t || t.uR == null) return;
  const val = Number($('inTrueDist').value);
  if (!(val > 0)) return;
  const trueRange = state.settings.units === 'ft' ? val * FT : val;
  const { demoTruth, ...sample } = t;
  state.calib.samples.push({ ...sample, trueRange });
  updateVOffsetFromSamples();
  state.calib.target = null;
  state.calib.mode = 'idle';
  state.calib.result = null;
  if (state.calib.samples.length === 1) $('inTrueDist').value = (state.settings.units === 'ft' ? 6.5 : 2).toFixed(2);
  saveSettings();
  refreshPanels(true);
}

async function solveCalibration() {
  $('btnSolve').disabled = true;
  $('btnSolve').textContent = 'Solving…';
  await new Promise((r) => setTimeout(r, 30));
  const params = rigParams();
  const r = fitCalibration(state.calib.samples, params);
  if (r) r.from = { angleDeg: params.angleDeg, hfovDeg: params.hfovDeg };
  state.calib.result = r;
  $('btnSolve').textContent = 'Solve';
  refreshPanels(true);
}

function applyCalibration() {
  const r = state.calib.result;
  if (!r) return;
  state.settings.angleDeg = round(r.angleDeg, 2);
  if (r.solvedFov) state.settings.hfovDeg = round(r.hfovDeg, 1);
  state.settings.calibrated = true;
  state.settings.rigConfirmed = true;
  r.applied = true;
  syncInputs();
  updateVOffsetFromSamples();
  saveSettings();
  rigChanged();
  refreshPanels(true);
}

// ---------------------------------------------------------------------------------------
// Person calibration: someone stands at a known distance; the app updates the angle between the
// cameras, and with a second distance the spacing too.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pcalSpeaks = () => talk.speakAnswers && voice.supported;

/** Adds a line to the conversation log and, if answers are spoken, says it. */
async function botSay(text) {
  state.talkLog.push({ who: 'bot', text });
  state.talkLog = state.talkLog.slice(-40);
  refreshTalkLog();
  if (pcalSpeaks()) await voice.say(text);
}

const PCAL_FAIL = {
  'no-person': "Couldn't see a person in both cameras. Make sure they're in view of both.",
  several: 'More than one person is in view. Only the person being measured should be.',
  mismatch: "The person looks a different size in the two cameras. Check that both cameras point the same way.",
  texture: "Could see the person but couldn't match enough points on them. Patterned clothing and more light help.",
};

function pcalInput(i) {
  return $(i ? 'inPcDist2' : 'inPcDist1');
}

/** index 0 = first position (about 2 m), 1 = second position (optional, a different distance). */
async function startPersonCapture(index, rangeM = null) {
  const pc = state.pcal;
  if (pc.capturing) return;
  index = Math.min(index, pc.positions.filter(Boolean).length, 1);
  const note = (msg, err = false) => { pc.msg[index] = msg; pc.err[index] = err; refreshPanels(true); };
  $('cardPersonCal').open = true;
  if (!state.running || !bothReady()) return note('Start the cameras (or the demo room) first.', true);
  if (state.mode !== 'demo' && !(state.settings.detect && state.detectorStatus === 'ready')) {
    return note('Object detection needs to be on and loaded: it finds the person.', true);
  }
  const units = state.settings.units;
  const range = rangeM ?? Number(pcalInput(index).value) * (units === 'ft' ? FT : 1);
  if (!(range >= 0.5 && range <= 15)) return note('Enter a distance between 0.5 and 15 m.', true);
  if (rangeM != null) pcalInput(index).value = (units === 'ft' ? rangeM / FT : rangeM).toFixed(2);
  if (talk.state !== 'idle') talk.end();
  if (state.paused) setPaused(false);
  // Recapturing a position replaces it and anything after it.
  pc.positions = pc.positions.slice(0, index);
  if (index === 0) { pc.msg[1] = ''; pc.err[1] = false; }
  const gen = state.gen;
  pc.capturing = { index, range, phase: 'countdown', matches: [], frames: 0, reasons: {}, last: null };
  if (state.demo) {
    state.demo.person = range; // the stand-in steps to the new spot
    renderDemo();
  }
  note('Get ready…');
  const d = sayDistance(range, units);
  const lead = index === 0
    ? `Calibrating at ${d}. Have the other person stand straight ahead, facing the cameras.`
    : `Second position, ${d}. Have them stand straight ahead again.`;
  if (pcalSpeaks()) {
    await botSay(`${lead} Hold still. 3. 2. 1.`);
  } else {
    for (let i = 3; i > 0; i--) {
      note(`Hold still… ${i}`);
      await sleep(1000);
    }
  }
  if (gen !== state.gen || pc.capturing?.index !== index) return; // cancelled or sources changed
  Object.assign(pc.capturing, { phase: 'capturing', start: performance.now() });
  refreshPanels(true);
}

/** Called once per processed frame while capturing. */
function collectPerson(fL, fR, now) {
  const c = state.pcal.capturing;
  c.frames++;
  const pick = pickPerson(state.dets[0], state.dets[1]);
  if (pick.error) {
    c.reasons[pick.error] = (c.reasons[pick.error] ?? 0) + 1;
    c.last = null;
  } else {
    const m = personMatches(fL, fR, pick.boxL, pick.boxR, { vOffset: state.vOffset });
    if (m.length < 4) c.reasons.texture = (c.reasons.texture ?? 0) + 1;
    c.matches.push(...m);
    c.last = m;
  }
  if (c.frames >= 30 || now - c.start > 3500) finishPersonCapture();
}

function finishPersonCapture() {
  const pc = state.pcal, c = pc.capturing;
  pc.capturing = null;
  const i = c.index;
  if (c.matches.length < 24) {
    const top = Object.entries(c.reasons).sort((a, b) => b[1] - a[1])[0]?.[0];
    const msg = PCAL_FAIL[top] ?? "Couldn't match enough points on the person. Try again.";
    pc.msg[i] = msg;
    pc.err[i] = true;
    refreshPanels(true);
    botSay(msg);
    return;
  }
  pc.positions[i] = { trueRange: c.range, samples: c.matches, frames: c.frames };
  pc.msg[i] = `Captured ${c.matches.length} matched points over ${c.frames} frames.`;
  pc.err[i] = false;
  applyPersonFit();
}

function applyPersonFit() {
  const pc = state.pcal, s = state.settings;
  const params = { ...rigParams(), tiltDeg: s.tiltDeg };
  const fit = fitFromPerson(pc.positions, params);
  if (!fit) return;
  pc.undo ??= { baselineCm: s.baselineCm, angleDeg: s.angleDeg, vOffset: state.vOffset, calibrated: s.calibrated };
  s.angleDeg = round(fit.params.angleDeg, 2);
  const spacing = fit.solved.includes('baselineCm');
  if (spacing) s.baselineCm = round(fit.params.baselineCm, 1);
  const off = verticalOffset(pc.positions.flatMap((p) => robustSubset(p.samples, 32)), rigParams());
  if (off != null) state.vOffset = clamp(off, -30, 30);
  s.calibrated = s.rigConfirmed = true;
  const original = { ...params, baselineCm: pc.undo.baselineCm, angleDeg: pc.undo.angleDeg };
  const now = { ...rigParams(), tiltDeg: s.tiltDeg };
  pc.result = {
    spacing,
    tooClose: pc.positions.length === 2 && !spacing,
    from: { baselineCm: pc.undo.baselineCm, angleDeg: pc.undo.angleDeg },
    to: { baselineCm: s.baselineCm, angleDeg: s.angleDeg },
    readings: pc.positions.map((p) => ({ trueRange: p.trueRange, before: personReading(p, original), after: personReading(p, now) })),
  };
  syncInputs();
  saveSettings();
  rigChanged();
  refreshPanels(true);

  const a = s.angleDeg;
  const angleText = Math.abs(a) < 0.05 ? 'parallel' : `angled ${Math.abs(a).toFixed(1)} degrees ${a > 0 ? 'toward each other' : 'apart'}`;
  if (spacing) {
    botSay(`Calibrated. The cameras are ${s.baselineCm.toFixed(1)} centimeters apart and ${angleText}.`);
  } else {
    const next = pc.result.tooClose
      ? 'The two distances were too close together to work out the spacing; use about 2 and 4 meters.'
      : `To measure the spacing too, have them step back to about ${sayDistance(Number(pcalInput(1).value) * (s.units === 'ft' ? FT : 1), s.units)} and say calibrate again, or press the second Capture button.`;
    botSay(`Got it. The cameras are now ${angleText}. I kept the spacing at ${s.baselineCm.toFixed(1)} centimeters. ${next}`);
  }
}

function undoPersonCal() {
  const u = state.pcal.undo;
  if (!u) return false;
  Object.assign(state.settings, { baselineCm: u.baselineCm, angleDeg: u.angleDeg, calibrated: u.calibrated });
  state.vOffset = u.vOffset;
  state.pcal = freshPersonCal();
  state.pcal.msg[0] = 'Undone: back to the numbers you had before.';
  syncInputs();
  saveSettings();
  rigChanged();
  refreshPanels(true);
  return true;
}

function refreshPersonCal() {
  const pc = state.pcal, c = pc.capturing;
  [0, 1].forEach((i) => {
    const el = $(i ? 'pcStatus2' : 'pcStatus1');
    const capturing = c?.index === i && c.phase === 'capturing';
    el.textContent = capturing ? `Capturing… ${c.matches.length} points so far. Hold still.` : pc.msg[i];
    el.classList.toggle('bad', !!pc.err[i] && !c);
  });
  $('btnPc1').disabled = !!c;
  $('btnPc2').disabled = !!c || !pc.positions[0];
  $('btnPc1').textContent = c?.index === 0 ? 'Capturing…' : pc.positions[0] ? 'Capture again' : 'Capture';
  $('btnPc2').textContent = c?.index === 1 ? 'Capturing…' : pc.positions[1] ? 'Capture again' : 'Capture';
  const r = pc.result;
  $('pcResult').hidden = !r;
  if (!r) return;
  const rows = r.readings.map((x) => `<tr><td>${fmt(x.trueRange)}</td><td>${x.before ? fmt(x.before) : '—'}</td><td>${x.after ? fmt(x.after) : '—'}</td></tr>`).join('');
  const spacing = r.spacing
    ? `spacing <b>${r.from.baselineCm.toFixed(1)} → ${r.to.baselineCm.toFixed(1)} cm</b>, `
    : '';
  const note = r.spacing ? ''
    : r.tooClose ? '<br><span class="muted">The two distances are too close together to solve the spacing. Use about 2 m and 4 m.</span>'
      : `<br><span class="muted">Spacing kept at ${r.to.baselineCm.toFixed(1)} cm. Capture a second distance to solve it too.</span>`;
  $('pcResult').innerHTML = `
    <div>Updated ${spacing}angle <b>${r.from.angleDeg.toFixed(2)}° → ${r.to.angleDeg.toFixed(2)}°</b>.${note}</div>
    <table><tr><th>Person at</th><th>Read before</th><th>Reads now</th></tr>${rows}</table>
    <button type="button" class="btn small" data-undo>Undo</button>`;
}

// ---------------------------------------------------------------------------------------
// Focus check: does either camera refocus by itself while nothing moves?

function startFocusTest() {
  if (!bothReady() || !state.running) return showBanner('Start the cameras first.', 'warn');
  if (state.paused) setPaused(false);
  state.focusTest = { start: performance.now(), sharp: [[], []], pin: [] };
  $('btnFocusTest').disabled = true;
  const box = $('focusResult');
  box.hidden = false;
  box.className = 'result-box';
  box.textContent = 'Measuring… keep the rig and the scene still.';
}

function tickFocusTest(fL, fR, now) {
  const ft = state.focusTest;
  if (!ft) return;
  ft.sharp[0].push(sharpness(fL));
  ft.sharp[1].push(sharpness(fR));
  const p = state.pinResults[0];
  if (p?.range != null) ft.pin.push(p.range);
  const left = Math.max(0, 10 - (now - ft.start) / 1000);
  $('btnFocusTest').textContent = `Measuring… ${Math.ceil(left)} s`;
  if (now - ft.start >= 10000) finishFocusTest();
}

function finishFocusTest() {
  const ft = state.focusTest;
  state.focusTest = null;
  $('btnFocusTest').disabled = false;
  $('btnFocusTest').textContent = 'Run 10-second focus check';
  const swing = ft.sharp.map((a) => {
    const s = [...a].sort((x, y) => x - y);
    const lo = s[Math.floor(s.length * 0.05)], hi = s[Math.floor(s.length * 0.95)];
    return lo > 0 ? hi / lo - 1 : 0;
  });
  const unstable = swing.map((w) => w > 0.35);
  let html = swing.map((w, i) => `${i ? 'Right' : 'Left'}: sharpness varied by <b>${Math.round(w * 100)}%</b> — ${unstable[i] ? '<span class="bad">refocusing</span>' : '<span class="good">steady</span>'}`).join('<br>');
  if (ft.pin.length > 5) {
    const m = median(ft.pin);
    const sd = Math.sqrt(ft.pin.reduce((a, r) => a + (r - m) ** 2, 0) / ft.pin.length);
    html += `<br>Point #${state.pinResults[0]?.id ?? 1}: ${fmt(m)}, wobbling by ±${fmt(sd)}.`;
  }
  const bad = unstable.some(Boolean);
  html += bad
    ? '<br>At least one camera kept refocusing, so distances will jitter. More light helps; use Lock focus above if it is offered. Otherwise keep the subject at one distance, or turn autofocus off with a UVC camera-control app.'
    : "<br>Focus held still, so autofocus isn't moving the lens on this scene.";
  if (ft.sharp[0].length < 20) html += '<br><span class="muted">Few frames were captured; run it again for a firmer answer.</span>';
  const box = $('focusResult');
  box.className = bad ? 'result-box warn' : 'result-box';
  box.innerHTML = html;
  state.settings.focusCheck = bad ? 'unstable' : 'stable';
  saveSettings();
  refreshPanels(true);
}

// ---------------------------------------------------------------------------------------
// Panels

function setChip(el, text, cls = '') {
  el.textContent = text;
  el.className = `chip ${cls}`.trim();
}

function refreshChips() {
  const ready = state.sources.filter((x) => x?.ready).length;
  const cams = $('chipCams');
  if (!state.mode) setChip(cams, 'No video');
  else if (state.mode === 'demo') setChip(cams, 'Demo room', 'ok');
  else if (state.mode === 'files') setChip(cams, ready === 2 ? 'Replaying recording' : 'No recording', ready === 2 ? 'ok' : 'warn');
  else setChip(cams, ready === 2 ? `2 cameras · ${state.sources[0].width}×${state.sources[0].height}` : `${ready} of 2 cameras`, ready === 2 ? 'ok' : 'warn');

  const model = $('chipModel');
  if (state.mode === 'demo') setChip(model, 'Boxes from the scene');
  else if (!state.settings.detect) setChip(model, 'Detector off');
  else {
    const text = { idle: 'Detector idle', loading: 'Loading detector…', ready: 'Detector ready', error: 'Detector failed' }[state.detectorStatus];
    setChip(model, text, { loading: 'busy', ready: 'ok', error: 'err' }[state.detectorStatus]);
  }

  const st = state.stats;
  let fps = '— fps';
  if (state.paused) fps = 'Paused';
  else if (state.running && st.fps) {
    fps = state.settings.debug
      ? `${st.fps.toFixed(0)} fps · detect ${st.detectMs.toFixed(0)} ms · stereo ${st.stereoMs.toFixed(0)} ms`
      : `${st.fps.toFixed(0)} fps`;
  }
  setChip($('chipFps'), fps, state.paused ? 'warn' : '');
}

function emptyObjectsText() {
  if (!state.running) return 'Start the cameras, a recording, or the demo room.';
  if (state.mode !== 'demo' && !state.settings.detect) return 'Object detection is off. Click the left view to measure points.';
  if (state.mode !== 'demo' && state.detectorStatus === 'loading') return 'Loading the detector…';
  return 'Nothing detected yet. The detector knows 80 everyday things: people, chairs, bottles, cups, laptops, phones…';
}

function refreshObjects() {
  const objs = [...state.objects].sort((a, b) => (a.range ?? 1e9) - (b.range ?? 1e9));
  $('objCount').textContent = objs.length ? `${objs.length} in view` : '';
  if (!objs.length) {
    $('objRows').innerHTML = `<tr class="empty"><td colspan="7">${esc(emptyObjectsText())}</td></tr>`;
    return;
  }
  $('objRows').innerHTML = objs.map((o) => {
    const dist = o.range != null
      ? `<b>${fmt(o.range)}</b>${o.quality === 'rough' ? ' <span class="tag">rough</span>' : ''}`
      : `<span class="muted">unavailable</span><div class="why">${esc(o.reason || '')}</div>`;
    const seen = o.boxL && o.boxR ? 'both' : o.boxL ? 'left only' : 'right only';
    const truth = o.truth != null ? `${fmt(o.truth)}${o.range != null ? ` <span class="why">${o.range >= o.truth ? '+' : '−'}${Math.abs(Math.round((o.range / o.truth - 1) * 100))}%</span>` : ''}` : '—';
    return `<tr data-id="${o.id}" class="${o.id === state.selectedId ? 'sel' : ''}">
      <td><span class="dot" style="background:${classColor(o.cls)}"></span>${esc(o.name ?? o.cls)} <span class="muted">#${o.id}</span></td>
      <td>${dist}</td>
      <td>${clockLabel(o.azimuth)}<div class="why">${sideLabel(o.azimuth)}</div></td>
      <td>${seen}</td>
      <td class="dbg">${o.matchScore != null ? o.matchScore.toFixed(2) : '—'}</td>
      <td class="dbg">${o.sigma != null && o.range != null ? `±${fmt(o.sigma)}` : '—'}</td>
      <td class="truth">${truth}</td>
    </tr>`;
  }).join('');
}

function refreshPairs() {
  const items = [
    ...state.objects.filter((o) => o.point).map((o) => ({ id: o.id, label: `${o.name ?? o.cls} #${o.id}`, color: classColor(o.cls), point: o.point })),
    ...state.pinResults.filter((p) => p.point).map((p) => ({ id: `p${p.id}`, label: `point #${p.id}`, color: '#f8fafc', point: p.point })),
  ];
  let pairs = pairwiseDistances(items);
  const sel = items.find((i) => i.id === state.selectedId);
  if (sel) pairs = pairs.filter((p) => p.a === sel || p.b === sel);
  $('pairNote').textContent = sel ? `from ${sel.label}` : pairs.length ? 'closest first' : '';
  $('pairList').innerHTML = pairs.length
    ? pairs.slice(0, 10).map((p) => `<li><span class="between"><span class="dot" style="background:${p.a.color}"></span>${esc(p.a.label)} ↔ <span class="dot" style="background:${p.b.color}"></span>${esc(p.b.label)}</span><b>${fmt(p.d)}</b></li>`).join('')
    : '<li class="empty">Needs two objects or measured points with a distance.</li>';
}

function refreshPins() {
  $('pinList').innerHTML = state.pinResults.length
    ? state.pinResults.map((p) => `<li><span class="grow">#${p.id} ${p.range != null
      ? `<b>${fmt(p.range)}</b> · ${clockLabel(p.azimuth)} <span class="muted">(${sideLabel(p.azimuth)})</span>`
      : `<span class="muted">no distance — ${esc(p.reason || 'measuring…')}</span>`}</span><button type="button" class="x" data-pin="${p.id}" aria-label="Remove point ${p.id}">×</button></li>`).join('')
    : '<li class="empty">Click the left view to measure any spot.</li>';
}

function refreshChecklist() {
  const s = state.settings;
  const rows = [];
  const add = (status, title, detail) => rows.push({ status, title, detail });
  if (state.mode === 'demo') {
    add('ok', 'Demo room running', 'Switch to Cameras for the real rig.');
  } else {
    const perm = state.permission;
    add(perm === 'granted' ? 'ok' : perm === 'denied' ? 'err' : 'todo', 'Camera access',
      perm === 'granted' ? 'Allowed in this browser.'
        : perm === 'denied' ? 'Blocked. Allow it from the address bar, and in macOS Privacy & Security → Camera.'
          : 'Press Start cameras; the browser will ask.');
    const ic780 = state.cameras.filter((c) => /ic780/i.test(c.label)).length;
    add(ic780 >= 2 ? 'ok' : state.cameras.length ? 'warn' : 'todo', 'Two IC780 cameras',
      state.cameras.length ? `${ic780} IC780 found (${state.cameras.length} cameras total).` : 'Not checked yet.');
  }
  const ready = state.sources.filter((x) => x?.ready);
  add(ready.length === 2 ? 'ok' : ready.length ? 'warn' : 'todo', 'Both streams running',
    ready.length ? ready.map((x) => `${x.width}×${x.height}`).join(' + ') : 'No video yet.');
  add(s.rigConfirmed ? 'ok' : 'todo', 'Rig measured',
    s.rigConfirmed ? `${s.baselineCm} cm apart, ${s.angleDeg}° between them.` : 'Fix both cameras to one rigid bar 10–15 cm apart, then enter the spacing under Rig.');
  add(s.calibrated ? 'ok' : state.calib.samples.length || state.pcal.positions.length ? 'warn' : 'todo', 'Calibration',
    s.calibrated ? 'Applied. Redo it if the cameras move on the bar.'
      : 'Have someone stand 2 m away and press Capture under Calibrate with a person, or say "calibrate".');
  add(s.focusCheck === 'stable' ? 'ok' : s.focusCheck === 'unstable' ? 'warn' : 'todo', 'Focus check',
    s.focusCheck === 'stable' ? 'Focus held steady.' : s.focusCheck === 'unstable' ? 'A camera refocused during the test; expect jitter.' : 'Checks whether autofocus moves (Camera check).');
  if (state.mode !== 'demo') {
    const det = { ready: 'Loaded.', loading: 'Downloading…', error: 'Failed to load; point measuring still works.', idle: s.detect ? 'Loads when video starts.' : 'Turned off.' };
    add(state.detectorStatus === 'ready' ? 'ok' : state.detectorStatus === 'error' ? 'err' : 'todo', 'Object detector', det[state.detectorStatus]);
  }
  const icon = { ok: '✓', warn: '!', err: '✕', todo: '' };
  $('checklist').innerHTML = rows.map((r) => `<li><span class="ic ${r.status}">${icon[r.status]}</span><span>${esc(r.title)}<span class="detail">${esc(r.detail)}</span></span></li>`).join('');
}

function refreshCalib() {
  const c = state.calib;
  const params = rigParams();
  document.body.classList.toggle('picking', c.mode !== 'idle');
  $('btnPickTarget').textContent = c.mode === 'idle' ? 'Pick target' : 'Cancel';
  const t = c.target;
  let html;
  if (c.mode === 'pick') html = '<span class="muted">Click the target in the left view…</span>';
  else if (!t) html = '<span class="muted">No target picked.</span>';
  else if (t.uR == null) {
    html = `<span class="bad">No match on the right (${esc(REASONS[t.reason] || 'not found')}).</span> Click the same spot in the right view, or pick something with more texture.`;
  } else {
    const reads = sampleRange(t, params);
    const q = t.manual ? 'placed by you'
      : t.consistent ? `match ${t.score.toFixed(2)}, confirmed both ways`
        : `<span class="bad">match ${t.score.toFixed(2)}, not confirmed: check the right view</span>`;
    html = `Found on the right (${q}).<br>Reads <b>${reads ? fmt(reads) : 'no distance'}</b> with the current rig numbers${t.demoTruth ? ` · demo truth <b>${fmt(t.demoTruth)}</b>` : ''}.`;
  }
  $('calibTarget').innerHTML = html;
  $('btnAddSample').disabled = !(t && t.uR != null);
  $('btnSolve').disabled = c.samples.length === 0;
  $('sampleList').innerHTML = c.samples.map((s, i) => {
    const r = sampleRange(s, params);
    return `<li><span class="grow">${fmt(s.trueRange)} measured</span><span class="muted">reads ${r ? fmt(r) : '—'}</span><button type="button" class="x" data-rm="${i}" aria-label="Remove sample">×</button></li>`;
  }).join('');

  const r = c.result;
  $('calibResult').hidden = !r;
  if (!r) return;
  const rows = r.residuals.map((x) => `<tr><td>${fmt(x.trueRange)}</td><td>${x.before ? fmt(x.before) : '—'}</td><td>${x.after ? fmt(x.after) : '—'}</td></tr>`).join('');
  $('calibResult').innerHTML = `
    <div>Angle <b>${r.from.angleDeg.toFixed(2)}° → ${r.angleDeg.toFixed(2)}°</b>${r.solvedFov
      ? ` · field of view <b>${r.from.hfovDeg.toFixed(1)}° → ${r.hfovDeg.toFixed(1)}°</b>`
      : '<br><span class="muted">Field of view kept: add a sample at a clearly different distance to solve it too.</span>'}</div>
    <table><tr><th>Measured</th><th>Read before</th><th>Read after</th></tr>${rows}</table>
    ${r.applied ? '<span class="good">Applied.</span>' : '<button type="button" class="btn small primary" data-apply>Apply</button>'}`;
}

function refreshCameraInfo() {
  $('camInfo').innerHTML = state.sources.map((src, i) => {
    const side = i ? 'Right' : 'Left';
    if (!src) return `<div class="cam"><div class="name">${side}: —</div></div>`;
    const d = cameraDetails(src);
    if (!d) {
      return `<div class="cam"><div class="name">${side}: ${esc(src.label)}</div><div class="meta">${src.kind === 'demo' ? 'Rendered' : 'From file'}${src.ready ? ` · ${src.width}×${src.height}` : ''}</div></div>`;
    }
    const focus = d.focusModes.length
      ? `focus: ${d.focusModes.join(', ')}${d.focusMode ? ` (now ${d.focusMode})` : ''}`
      : "focus control isn't exposed by the browser";
    const canLock = d.focusModes.includes('manual') || d.focusModes.includes('single-shot');
    return `<div class="cam"><div class="name">${side}: ${esc(src.label)}</div><div class="meta">${d.width}×${d.height} @ ${Math.round(d.fps || 0)} fps · ${esc(focus)}</div>${canLock ? `<button type="button" class="btn small" data-lock="${i}">Lock focus</button>` : ''}</div>`;
  }).join('');
}

function refreshSwapHint() {
  if (state.swapScore > 0.6 && performance.now() - state.swapDismissedAt > 30000 && state.banner.kind !== 'err') {
    showBanner('Left and right look swapped (or the angle setting is far off): the matched objects only make sense with the cameras the other way round.', 'warn', { label: 'Swap', fn: swapSides }, 'swap');
  } else if (state.banner.id === 'swap' && state.swapScore < 0.4) {
    hideBanner();
  }
}

function refreshPanels(force = false) {
  const now = performance.now();
  if (!force && now - state.panelsAt < 250) return;
  state.panelsAt = now;
  refreshChips();
  refreshObjects();
  refreshPairs();
  refreshPins();
  refreshChecklist();
  refreshCalib();
  refreshPersonCal();
  refreshSwapHint();
  $('vOffset').textContent = `${(Math.abs(state.vOffset) < 0.05 ? 0 : state.vOffset).toFixed(1)} px`;
  ['resL', 'resR'].forEach((id, i) => {
    const s = state.sources[i];
    $(id).textContent = s?.ready ? `${s.width}×${s.height}` : '';
  });
}

function showBanner(text, kind = 'warn', action = null, id = null) {
  state.banner = { id, kind };
  $('banner').className = kind === 'warn' ? 'banner' : `banner ${kind}`;
  $('bannerText').textContent = text;
  const btn = $('bannerAction');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideBanner(); action.fn(); };
  }
  $('banner').hidden = false;
}

function hideBanner() {
  if (state.banner.id === 'swap') state.swapDismissedAt = performance.now();
  state.banner = { id: null, kind: null };
  $('banner').hidden = true;
}

// ---------------------------------------------------------------------------------------
// Recording, pause, toggles

async function toggleRecording() {
  if (recorder.active) return stopRecording();
  if (!bothReady()) return showBanner('Start both cameras before recording.', 'warn');
  try {
    recorder.start(state.sources);
  } catch (e) {
    return showBanner(`Recording failed: ${e.message}`, 'err');
  }
  $('btnRecord').textContent = '■ Stop & save';
  $('btnRecord').classList.add('rec');
}

async function stopRecording() {
  const blob = await recorder.stop();
  $('btnRecord').textContent = '● Record';
  $('btnRecord').classList.remove('rec');
  $('recTime').textContent = '';
  if (blob?.size) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const name = `stereo-${stamp}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`;
    downloadBlob(blob, name);
    showBanner(`Saved ${name} to your downloads. Open it under Recording to replay it.`, 'info');
  }
}

function setPaused(on) {
  state.paused = on;
  $('btnPause').textContent = on ? 'Resume' : 'Pause';
  $('btnPause').setAttribute('aria-pressed', String(on));
  for (const s of new Set(state.sources)) s?.pause(on);
  refreshChips();
}

function exportSettings() {
  const data = { ...state.settings, vOffset: round(state.vOffset, 2), samples: state.calib.samples };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'stereo-settings.json');
}

async function importSettings(file) {
  try {
    const { samples, vOffset, ...rest } = JSON.parse(await file.text());
    for (const k of Object.keys(DEFAULTS)) if (k in rest) state.settings[k] = rest[k];
    if (Array.isArray(samples)) state.calib.samples = samples;
    if (Number.isFinite(vOffset)) state.vOffset = vOffset;
    syncInputs();
    saveSettings();
    rigChanged();
    showBanner('Settings imported.', 'info');
  } catch (e) {
    showBanner(`Couldn't read that file: ${e.message}`, 'err');
  }
  refreshPanels(true);
}

// ---------------------------------------------------------------------------------------
// Conversation: ask what's in front of you, by voice or by typing

function sceneForAssistant() {
  let status = 'ok';
  if (!state.running || !bothReady()) status = 'no-video';
  else if (state.mode !== 'demo' && !state.settings.detect) status = 'detector-off';
  else if (state.mode !== 'demo' && state.detectorStatus === 'loading') status = 'loading';
  else if (state.mode !== 'demo' && state.detectorStatus === 'error') status = 'detector-error';
  return {
    objects: state.objects, pins: state.pinResults, units: state.settings.units,
    status, paused: state.paused, hfovDeg: state.settings.hfovDeg,
  };
}

function onTalkTurn(result) {
  state.talkLog.push({ who: 'you', text: result.question });
  if (result.text) state.talkLog.push({ who: 'bot', text: result.text });
  state.talkLog = state.talkLog.slice(-40);
  if (result.focus != null) state.selectedId = result.focus;
  refreshTalkLog();
  refreshPanels(true);
}

function onTalkAction(action) {
  if (action.units) {
    setSetting('units', action.units);
    syncInputs();
  }
  if (action.updates != null) setUpdates(action.updates);
  if (action.calibrate === 'capture') {
    const pc = state.pcal;
    // "Calibrate" again after the first position moves on to the second; after both, start over.
    startPersonCapture(pc.positions[0] && !pc.positions[1] ? 1 : 0, action.range ?? null);
  } else if (action.calibrate === 'undo') {
    botSay(undoPersonCal() ? 'Calibration undone.' : 'There is no calibration to undo.');
  }
}

function setUpdates(on) {
  if (on && !speaker.supported) return showBanner('This browser has no speech output.', 'warn');
  speaker.setEnabled(on);
  $('btnSpeak').setAttribute('aria-pressed', String(on));
}

const MIC_ERRORS = {
  'not-allowed': 'Microphone access is blocked. Allow it from the address bar; on macOS also check System Settings → Privacy & Security → Microphone.',
  'service-not-allowed': 'Speech recognition is blocked in this browser. Type your question instead.',
  'audio-capture': 'No microphone found. Type your question instead.',
  network: "Chrome's speech recognition needs an internet connection. Type your question instead.",
  'language-not-supported': "Speech recognition isn't available in English here. Type your question instead.",
  'start-failed': "Couldn't start listening. Press the mic to try again.",
  unsupported: "This browser can't recognize speech. Type your question, or open the page in Chrome.",
};

function onTalkState(st, detail = '') {
  const mic = $('btnMic'), status = $('talkStatus');
  mic.dataset.state = st;
  mic.setAttribute('aria-label', st === 'listening' ? 'Stop listening' : 'Ask a question');
  status.classList.toggle('err', !!MIC_ERRORS[detail]);
  if (st === 'listening') status.textContent = detail ? `“${detail}”` : 'Listening…';
  else if (st === 'thinking') status.textContent = 'Thinking…';
  else if (st === 'speaking') status.textContent = 'Answering. Press the mic to cut in with another question.';
  else if (MIC_ERRORS[detail]) status.textContent = MIC_ERRORS[detail];
  else if (detail === 'no-speech') status.textContent = "Didn't hear anything. Press the mic to ask again.";
  else status.innerHTML = 'Press the mic or <kbd>A</kbd> and ask “What’s in front of me?”';
  if (!talk.supported) {
    mic.disabled = true;
    mic.title = MIC_ERRORS.unsupported;
  }
  $('talkNote').textContent = !talk.supported
    ? MIC_ERRORS.unsupported
    : talk.listener.local
      ? 'Speech is recognized on this Mac.'
      : 'Chrome sends your voice to its online speech service to turn it into text. Answers are worked out here, from the cameras.';
}

function refreshTalkLog() {
  const log = $('talkLog');
  log.innerHTML = state.talkLog.length
    ? state.talkLog.map((m) => `<li class="${m.who}"><span class="who">${m.who === 'you' ? 'You' : 'Stereo'}</span>${esc(m.text)}</li>`).join('')
    : '<li class="empty">Your conversation shows up here. Try “What’s in front of me?”, then “How far is it?” or “What else?”.</li>';
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------------------------
// Wiring

function wire() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => start(b.dataset.mode)));
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => start(b.dataset.start)));
  $('fileInput').addEventListener('change', (e) => { if (e.target.files.length) startReplay(e.target.files); });
  $('devL').addEventListener('change', (e) => onDevicePicked(0, e.target.value));
  $('devR').addEventListener('change', (e) => onDevicePicked(1, e.target.value));
  $('btnSwap').addEventListener('click', swapSides);
  viewCanvases.forEach((c, side) => c.addEventListener('pointerdown', (e) => onViewClick(side, e)));

  $('btnPause').addEventListener('click', () => state.running && setPaused(!state.paused));
  $('btnSpeak').addEventListener('click', () => setUpdates(!speaker.enabled));

  $('btnMic').addEventListener('click', () => talk.toggle());
  $('askForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('askInput').value.trim();
    if (!q) return;
    $('askInput').value = '';
    talk.ask(q);
  });
  $('suggestions').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ask]');
    if (b) talk.ask(b.dataset.ask);
  });
  $('inFollowUp').addEventListener('change', (e) => {
    state.settings.talkFollowUp = talk.followUp = e.target.checked;
    saveSettings();
  });
  $('inSpeakAnswers').addEventListener('change', (e) => {
    state.settings.talkSpeak = talk.speakAnswers = e.target.checked;
    if (!e.target.checked) voice.cancel();
    saveSettings();
  });
  $('btnDebug').addEventListener('click', () => {
    state.settings.debug = !state.settings.debug;
    document.body.classList.toggle('debug', state.settings.debug);
    $('btnDebug').setAttribute('aria-pressed', String(state.settings.debug));
    saveSettings();
    refreshPanels(true);
  });
  $('bannerClose').addEventListener('click', hideBanner);

  $('objRows').addEventListener('pointerdown', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = Number(tr.dataset.id);
    state.selectedId = state.selectedId === id ? null : id;
    refreshPanels(true);
  });
  $('pinList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pin]');
    if (!b) return;
    state.pins = state.pins.filter((p) => p.id !== Number(b.dataset.pin));
    afterEdit();
  });
  $('btnClearPins').addEventListener('click', () => { state.pins = []; afterEdit(); });

  $('btnPickTarget').addEventListener('click', () => {
    const c = state.calib;
    if (c.mode === 'idle') {
      if (!state.frames[0]) return showBanner('Start the cameras (or the demo room) first.', 'warn');
      c.mode = 'pick';
      c.target = null;
    } else {
      c.mode = 'idle';
      c.target = null;
    }
    refreshPanels(true);
  });
  $('btnPc1').addEventListener('click', () => startPersonCapture(0));
  $('btnPc2').addEventListener('click', () => startPersonCapture(1));
  $('pcResult').addEventListener('click', (e) => { if (e.target.closest('[data-undo]')) undoPersonCal(); });
  $('btnAddSample').addEventListener('click', addSample);
  $('btnSolve').addEventListener('click', solveCalibration);
  $('calibResult').addEventListener('click', (e) => { if (e.target.closest('[data-apply]')) applyCalibration(); });
  $('sampleList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    state.calib.samples.splice(Number(b.dataset.rm), 1);
    state.calib.result = null;
    refreshPanels(true);
  });

  $('camInfo').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-lock]');
    if (!b) return;
    try {
      showBanner(await lockFocus(state.sources[Number(b.dataset.lock)]), 'info');
    } catch (err) {
      showBanner(err.message, 'warn');
    }
    refreshCameraInfo();
  });
  $('btnFocusTest').addEventListener('click', startFocusTest);
  $('btnResetVOff').addEventListener('click', () => { state.vOffset = 0; saveSettings(); refreshPanels(true); });

  $('btnRecord').addEventListener('click', toggleRecording);
  $('btnOpenRec').addEventListener('click', chooseFiles);
  $('btnExport').addEventListener('click', exportSettings);
  $('btnImport').addEventListener('click', () => { $('importInput').value = ''; $('importInput').click(); });
  $('importInput').addEventListener('change', (e) => { if (e.target.files[0]) importSettings(e.target.files[0]); });
  $('btnRebuildDemo').addEventListener('click', startDemo);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && talk.state !== 'idle') return talk.end();
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space' && !e.target.closest('button') && state.running) {
      e.preventDefault();
      setPaused(!state.paused);
    } else if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
      e.preventDefault();
      talk.toggle();
    } else if (e.key === 'Escape' && state.calib.mode !== 'idle') {
      state.calib.mode = 'idle';
      state.calib.target = null;
      refreshPanels(true);
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    if (state.mode !== 'cameras') return;
    state.cameras = await listCameras();
    fillDeviceSelects();
    refreshPanels(true);
  });
  window.addEventListener('resize', drawRig);
  window.addEventListener('pagehide', saveSettings);
}

async function init() {
  bindSettings();
  syncInputs();
  wire();
  document.body.classList.toggle('debug', state.settings.debug);
  $('btnDebug').setAttribute('aria-pressed', String(state.settings.debug));
  drawRig();
  fillDeviceSelects();
  talk.followUp = $('inFollowUp').checked = state.settings.talkFollowUp;
  talk.speakAnswers = $('inSpeakAnswers').checked = state.settings.talkSpeak;
  onTalkState('idle');
  refreshTalkLog();
  requestAnimationFrame(displayLoop);
  processLoop();
  state.permission = camerasSupported() ? await cameraPermission() : 'unsupported';
  refreshPanels(true);
  // Access was granted on an earlier visit: go straight to the cameras.
  if (state.permission === 'granted') startCameras();
}

// Handy for poking at the pipeline from the browser console.
window.stereo = { state, start, swapSides, talk };

init();
