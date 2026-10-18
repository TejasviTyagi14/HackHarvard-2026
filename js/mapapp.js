import { mountPhone } from './phone.js';
// Map page: walk around with the two cameras and a 3D model of the building builds up; mark
// places by voice or click, then get spoken turn-by-turn directions back to them.
//   cameras → (grayscale pairs) → worker: tracking + keyframe depth + fusion + planning
//   worker → this page: pose every frame, map updates on keyframes, the route
//   this page: 3D view, floor plan, guidance (10×/s), voice.
import { buildRig, clockHour } from './geometry.js';
import { measureScene } from './scene.js';
import { GrayFrame } from './stereo.js';
import { Detector } from './detector.js';
import { cameraPermission, camerasSupported, ensurePermission, listCameras, openCamera, openRecording, pickDefaultPair } from './sources.js';
import { Voice, tone } from './speech.js';
import { Talk } from './talk.js';
import { answerBest, sayDistance, spokenName } from './assistant.js';
import { Guide } from './slam/guide.js';
import { parseNav, placesSentence, resolveDestination } from './slam/navtalk.js';
import { downloadBlob } from './recorder.js';

const $ = (id) => document.getElementById(id);
const MEASURE_KEY = 'stereo-distance:v1';
const MAP_KEY = 'stereo-map:v1';
const MAP_DEFAULTS = { camHeight: 1.3, bodyHeight: 1.9, stepHeight: 0.1, rangeMax: 4, quality: 'fast', landmarks: true, fps60: true };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function load(key, defaults) {
  try { return { ...defaults, ...(JSON.parse(localStorage.getItem(key) || 'null') ?? {}) }; } catch { return { ...defaults }; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// The measuring page owns the rig numbers and camera choice; this page reads them.
const rigSettings = load(MEASURE_KEY, { baselineCm: 12, angleDeg: 0, hfovDeg: 70, angleSplit: 'even', vOffset: 0, resolution: '1280x720', deviceIds: [null, null], units: 'm', tiltDeg: 0, talkFollowUp: true, talkSpeak: true, minScore: 0.5, model: 'lite_mobilenet_v2' });
const settings = load(MAP_KEY, MAP_DEFAULTS);

const state = {
  mode: null, // 'cameras' | 'files' | 'demo'
  sources: [null, null],
  worker: null, ready: false, busy: false, frameId: 0, lastPair: [-1, -1],
  size: null, // processing size sent to the worker
  pose: null, status: 'idle', route: null, floor: 'pending', truth: null,
  places: [], landmarks: [], start: { x: 0, z: 0 }, grid: null, trajectory: new Float32Array(0), stats: null,
  mapping: true, nav: null, sceneObjects: [], sceneAt: 0,
  fps: 0, lastResultAt: 0, pendingDetect: null, lastDetect: 0, keys: { forward: 0, turn: 0 },
  talkLog: [],
};

const voice = new Voice();
const guide = new Guide({ units: rigSettings.units });
const detector = new Detector();
let view3d = null;

const talk = new Talk({
  voice,
  getScene: () => ({ objects: state.sceneObjects, pins: [], units: rigSettings.units, status: state.mode ? 'ok' : 'no-video', paused: false, hfovDeg: rigSettings.hfovDeg }),
  onTurn: (r) => { logTalk('you', r.question); if (r.text) logTalk('bot', r.text); },
  onAction: onTalkAction,
  onState: onTalkState,
  answer: mapAnswer,
});

// ---------------------------------------------------------------------------------------
// Worker

function startWorker() {
  state.worker?.terminate();
  const w = new Worker(new URL('./slam/worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => onWorker(e.data);
  w.onerror = (e) => banner(`The mapper stopped: ${e.message}`, 'err');
  state.worker = w;
  state.ready = false;
  state.busy = false;
}

function initWorker(size) {
  state.size = size;
  const vOffsetPx = (rigSettings.vOffset || 0) * (size.w / 640);
  state.worker.postMessage({
    type: 'init', size,
    rig: { baselineCm: rigSettings.baselineCm, angleDeg: rigSettings.angleDeg, hfovDeg: rigSettings.hfovDeg, angleSplit: rigSettings.angleSplit, vOffsetPx },
    world: { camHeight: settings.camHeight, tiltDeg: rigSettings.tiltDeg || 0, bodyHeight: settings.bodyHeight, stepHeight: settings.stepHeight, rangeMax: settings.rangeMax },
  });
  resetMapView();
}

function onWorker(m) {
  switch (m.type) {
    case 'ready': state.ready = true; break;
    case 'result': onResult(m); break;
    case 'map': onMap(m); break;
    case 'truth': state.truth = m; break;
    case 'route': state.route = m.route; if (state.nav && m.route?.ok) view3d?.setRoute(m.route.path); drawPlan(); break;
    case 'demoDone': banner('Tour finished. Walk on with the arrow keys (or W A S D), pick a destination on the floor plan, or say "take me back to the start".', 'info'); setDemoButtons('walk'); break;
    case 'saved': downloadBlob(new Blob([m.data], { type: 'application/json' }), `building-map-${stamp()}.json`); break;
    case 'ply': downloadBlob(new Blob([m.data], { type: 'application/octet-stream' }), `building-model-${stamp()}.ply`); break;
    case 'error': console.error(m.stack); banner(`Mapper error: ${m.message}`, 'err'); break;
    default:
  }
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function onResult(m) {
  state.busy = false;
  const now = performance.now();
  if (state.lastResultAt) state.fps = 0.9 * state.fps + 0.1 * (1000 / Math.max(1, now - state.lastResultAt));
  state.lastResultAt = now;
  state.status = m.status;
  state.floor = m.floor;
  state.route = m.route;
  state.timings = m.timings;
  state.vo = m.vo;
  state.shiftPx = m.shiftPx;
  state.inliers = m.inliers;
  if (m.status !== 'init') state.pose = { x: m.x, y: m.y, z: m.z, heading: m.heading, R: m.pose.R };
  if (m.seen) {
    state.sceneObjects = m.seen.map((o, i) => ({ ...o, id: i + 1, ground: { x: o.point[0], z: o.point[2] }, quality: 'stereo', reason: null }));
    state.sceneAt = now;
  }
  drawCamera(m);
  if (view3d && state.pose) {
    view3d.setPose(state.pose);
    view3d.setRoute(state.nav && m.route?.ok ? m.route.path : null);
  }
  if (state.pendingDetect && state.pendingDetect.id === m.id) finishDetect(state.pendingDetect, m);
  refreshChips();
}

function onMap(m) {
  if (view3d) {
    if (m.reset) view3d.resetPoints();
    view3d.addPoints(m.xyz, m.gray);
    view3d.setTrajectory(m.trajectory);
  }
  state.grid = m.grid;
  state.trajectory = m.trajectory;
  state.landmarks = m.landmarks;
  state.places = m.places;
  state.stats = m.stats;
  state.start = { x: m.start[0], z: m.start[2] };
  renderGrid();
  refreshDestinations();
  view3d?.setMarkers([
    { label: 'start', x: state.start.x, z: state.start.z, kind: 'start' },
    ...state.places.map((p) => ({ label: p.name, x: p.x, z: p.z, kind: 'place' })),
    ...state.landmarks.map((l) => ({ label: spokenName(l.cls), x: l.x, z: l.z, kind: 'landmark' })),
  ]);
}

function resetMapView() {
  view3d?.resetPoints();
  view3d?.setTrajectory(new Float32Array(0));
  view3d?.setRoute(null);
  view3d?.setGoal(null);
  Object.assign(state, { pose: null, route: null, grid: null, places: [], landmarks: [], trajectory: new Float32Array(0), stats: null, truth: null, status: 'init' });
  stopNav(false);
  renderGrid();
  refreshDestinations();
}

// ---------------------------------------------------------------------------------------
// Sources

function procSize(src) {
  const w = settings.quality === 'detailed' ? 480 : 320;
  return { w, h: Math.round((src.height * w) / src.width) };
}

async function stopSources() {
  state.worker?.postMessage({ type: 'demo', kind: null });
  for (const s of new Set(state.sources)) s?.stop();
  state.sources = [null, null];
  state.mode = null;
  state.busy = false;
  setDemoButtons(null);
}

async function startCameras() {
  await stopSources();
  state.mode = 'cameras';
  setModeButtons();
  try {
    await ensurePermission();
  } catch (e) {
    banner('Camera access is blocked. Allow it from the address bar (and in macOS Privacy & Security → Camera).', 'err');
    return;
  }
  const cams = await listCameras();
  const ids = pickDefaultPair(cams, rigSettings.deviceIds);
  if (!ids[0] || !ids[1]) return banner(`Found ${cams.length} camera(s). Plug in both IC780s, then try again.`, 'err');
  const [w, h] = (rigSettings.resolution || '1280x720').split('x').map(Number);
  try {
    // 60 fps halves the worst-case gap between the two cameras' frames, if they can do it.
    const fps = settings.fps60 ? 60 : 30;
    state.sources = [await openCamera(ids[0], w, h, 'Left', fps), await openCamera(ids[1], w, h, 'Right', fps)];
  } catch (e) {
    banner(`Couldn't start the cameras (${e.message}). Two USB cameras on one hub can run out of bandwidth: try a lower resolution on the measuring page, or separate ports.`, 'err');
    return;
  }
  await waitReady();
  startWorker();
  initWorker(procSize(state.sources[0]));
  ensureDetector();
  hidePlaceholder();
}

async function startRecording(files) {
  await stopSources();
  state.mode = 'files';
  setModeButtons();
  try {
    state.sources = await openRecording(files);
  } catch (e) {
    return banner(e.message, 'err');
  }
  await waitReady();
  startWorker();
  initWorker(procSize(state.sources[0]));
  ensureDetector();
  hidePlaceholder();
}

async function startDemo(kind) {
  await stopSources();
  state.mode = 'demo';
  setModeButtons();
  startWorker();
  // The demo renders 16:9 at the processing size, with the rig numbers as the truth.
  initWorker({ w: settings.quality === 'detailed' ? 480 : 320, h: settings.quality === 'detailed' ? 270 : 180 });
  state.worker.postMessage({ type: 'demo', kind });
  setDemoButtons(kind);
  hidePlaceholder();
  if (kind === 'walk') banner('Walk with the arrow keys (or W A S D). Mark a spot, walk somewhere else, then ask to be taken back.', 'info');
}

function waitReady() {
  return new Promise((resolve) => {
    const check = () => (state.sources.every((s) => s?.ready) ? resolve() : setTimeout(check, 50));
    check();
  });
}

const grab = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
const grabCtx = grab.map((c) => c.getContext('2d', { willReadFrequently: true }));
const proc = [0, 1].map(() => Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
const procCtx = proc.map((c) => c.getContext('2d', { willReadFrequently: true }));

function grayOf(i, src) {
  const { w, h } = state.size;
  const c = grab[i];
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  src.drawTo(grabCtx[i], w, h);
  const rgba = grabCtx[i].getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let k = 0, j = 0; k < g.length; k++, j += 4) g[k] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

/** Sends the newest camera pair to the worker whenever it's free (never queues up a backlog). */
function pump() {
  requestAnimationFrame(pump);
  if (!state.worker || state.mode === 'demo' || !state.mode || state.busy || !state.size) return;
  const [a, b] = state.sources;
  if (!a?.ready || !b?.ready) return;
  if (a.frameCount === state.lastPair[0] && b.frameCount === state.lastPair[1] && a.frameCount > 0) return;
  state.lastPair = [a.frameCount, b.frameCount];
  const left = grayOf(0, a), right = grayOf(1, b);
  // How far apart in time the two frames were captured (0 if the browser doesn't say).
  const gap = a.frameTime != null && b.frameTime != null && a !== b ? Math.abs(a.frameTime - b.frameTime) / 1000 : 0;
  state.gap = gap;
  const id = ++state.frameId;
  state.busy = true;
  state.worker.postMessage({ type: 'frame', id, t: performance.now() / 1000, gap, left: left.buffer, right: right.buffer }, [left.buffer, right.buffer]);
  maybeDetect(id);
}

// ---------------------------------------------------------------------------------------
// Landmarks: every 1.5 s, find objects and remember where they are in the map.

async function ensureDetector() {
  if (!settings.landmarks || state.mode === 'demo') return;
  try {
    await detector.load(rigSettings.model || 'lite_mobilenet_v2');
  } catch {
    banner("Couldn't load the object detector; mapping still works, but it won't remember objects.", 'warn');
  }
}

function maybeDetect(id) {
  if (!settings.landmarks || !detector.ready || state.pendingDetect || performance.now() - state.lastDetect < 1500) return;
  state.lastDetect = performance.now();
  const frames = state.sources.map((src, i) => {
    const w = Math.min(640, src.width), h = Math.round((src.height * w) / src.width);
    if (proc[i].width !== w || proc[i].height !== h) { proc[i].width = w; proc[i].height = h; }
    src.drawTo(procCtx[i], w, h);
    return GrayFrame.fromRGBA(procCtx[i].getImageData(0, 0, w, h).data, w, h);
  });
  const job = { id, done: false };
  job.promise = (async () => {
    const dets = [await detector.detect(proc[0], rigSettings.minScore ?? 0.5), await detector.detect(proc[1], rigSettings.minScore ?? 0.5)];
    const rig = buildRig(rigSettings, { w: frames[0].w, h: frames[0].h }, { w: frames[1].w, h: frames[1].h });
    return measureScene(dets[0], dets[1], frames[0], frames[1], rig, { vOffset: rigSettings.vOffset || 0 }).objects;
  })();
  state.pendingDetect = job;
}

async function finishDetect(job, result) {
  state.pendingDetect = null;
  const objects = await job.promise.catch(() => []);
  state.sceneObjects = objects.map((o, i) => ({ ...o, id: i + 1 }));
  state.sceneAt = performance.now();
  if (result.status !== 'ok') return;
  const B = rigSettings.baselineCm / 100;
  for (const o of objects) {
    if (!o.point || o.range > settings.rangeMax) continue;
    // Rig centre → the (rectified) left camera the map tracks, then into the map.
    const c = [o.point[0] + B / 2, o.point[1], o.point[2]];
    const p = applyPose(result.pose, c);
    state.worker.postMessage({ type: 'landmark', cls: o.cls, p });
  }
}

const applyPose = (P, v) => [
  P.R[0] * v[0] + P.R[1] * v[1] + P.R[2] * v[2] + P.t[0],
  P.R[3] * v[0] + P.R[4] * v[1] + P.R[5] * v[2] + P.t[1],
  P.R[6] * v[0] + P.R[7] * v[1] + P.R[8] * v[2] + P.t[2],
];

// ---------------------------------------------------------------------------------------
// Navigation

function goTo(dest) {
  if (!state.pose) return banner('Start mapping first, so I know where you are.', 'warn');
  state.nav = dest;
  state.worker.postMessage({ type: 'goal', x: dest.x, z: dest.z, label: dest.label });
  guide.o.units = rigSettings.units;
  guide.start(dest, performance.now() / 1000);
  view3d?.setGoal(dest);
  refreshNav();
}

function stopNav(say = true) {
  if (!state.nav) return;
  state.nav = null;
  guide.stop();
  state.worker?.postMessage({ type: 'goal', clear: true });
  view3d?.setGoal(null);
  view3d?.setRoute(null);
  if (say) speak('Stopped navigating.', 'info');
  refreshNav();
}

function speak(text, priority) {
  logTalk('bot', text);
  if (!talk.speakAnswers || !voice.supported) return;
  voice.say(text, { interrupt: priority !== 'info' || !voice.speaking });
}

// 10 times a second: turn the route into what to say next.
setInterval(() => {
  if (!state.nav || !state.pose || talk.state === 'listening') return;
  const out = guide.update({
    pose: { x: state.pose.x, z: state.pose.z, heading: state.pose.heading },
    route: state.route, tracking: state.status === 'lost' ? 'lost' : 'ok', now: performance.now() / 1000,
  });
  for (const s of out.say) speak(s.text, s.priority);
  if (out.tone && talk.speakAnswers) tone('tick');
  if (out.status) $('navNow').textContent = out.status.text + (out.status.remaining ? ` · ${sayDistance(out.status.remaining, rigSettings.units)} left` : '');
  if (!guide.active && state.nav) {
    state.nav = null;
    state.worker.postMessage({ type: 'goal', clear: true });
    view3d?.setGoal(null);
    view3d?.setRoute(null);
    refreshNav();
  }
}, 100);

function markHere(name) {
  if (!state.pose || !name.trim()) return false;
  state.worker.postMessage({ type: 'place', name: name.trim(), x: state.pose.x, z: state.pose.z });
  return true;
}

// ---------------------------------------------------------------------------------------
// Voice: navigation commands first, then the scene assistant ("what's in front of me?").

function mapInfo() {
  return { places: state.places, landmarks: state.landmarks, start: state.start };
}

function here() {
  return { x: state.pose?.x ?? 0, z: state.pose?.z ?? 0 };
}

function bearingFromMe(p) {
  const h = here();
  const az = (Math.atan2(p.x - h.x, p.z - h.z) - (state.pose?.heading ?? 0)) * 180 / Math.PI;
  return ((az + 540) % 360) - 180;
}

function mapAnswer(alternatives, scene, ctx) {
  for (const alt of alternatives) {
    const nav = parseNav(alt, { navigating: !!state.nav });
    if (nav) {
      const r = navReply(nav, alt, scene, ctx);
      if (r) return r;
    }
  }
  return answerBest(alternatives, scene, ctx);
}

function navReply(nav, question, scene, ctx) {
  const u = rigSettings.units;
  const reply = (text, action = null) => ({ question, intent: 'nav', text, action, focus: null, ctx });
  if (!state.pose && !['places'].includes(nav.intent)) return reply('Start mapping first: the cameras need to be running so I know where you are.');
  switch (nav.intent) {
    case 'mark':
      return reply(`Saved this spot as the ${nav.name}.`, { mark: nav.name });
    case 'back':
      return reply('', { go: { ...state.start, label: 'the start' }, end: true });
    case 'go': {
      const d = resolveDestination(nav.name, mapInfo(), here());
      if (d.missing) return reply(d.cls ? `I haven't seen ${/^[aeiou]/.test(d.label) ? 'an' : 'a'} ${d.label} yet.` : `I don't know a place called ${d.label}. ${placesSentence(mapInfo(), u)}`);
      return reply('', { go: d, end: true });
    }
    case 'stopNav':
      return reply(state.nav ? 'Stopped navigating.' : "I'm not navigating right now.", { stopNav: true });
    case 'remaining':
      return reply(state.route?.ok ? `About ${sayDistance(state.route.length, u)} to go.` : "I don't have a route right now.");
    case 'places':
      return reply(placesSentence(mapInfo(), u, state.pose ? here() : null));
    case 'whereAmI': {
      const h = here();
      const toStart = Math.hypot(h.x - state.start.x, h.z - state.start.z);
      const nearest = state.places.map((p) => ({ p, d: Math.hypot(p.x - h.x, p.z - h.z) })).sort((a, b) => a.d - b.d)[0];
      const near = nearest ? ` The nearest saved place is the ${nearest.p.name}, ${sayDistance(nearest.d, u)} away at ${clockHour(bearingFromMe(nearest.p))} o'clock.` : '';
      return reply(`You're ${sayDistance(toStart, u)} from where you started, which is at ${clockHour(bearingFromMe(state.start))} o'clock.${near}`);
    }
    case 'locate': {
      const d = resolveDestination(nav.name, mapInfo(), here());
      if (d.missing) return null; // let the scene assistant try ("where is the chair")
      const dist = Math.hypot(d.x - here().x, d.z - here().z);
      return reply(`${cap(d.label)} is ${sayDistance(dist, u)} away in a straight line, at ${clockHour(bearingFromMe(d))} o'clock. Say "take me to ${d.label.replace(/^the /, 'the ')}" for directions.`);
    }
    case 'pauseMap':
      return reply("Mapping paused. I'll keep track of where you are without adding to the map.", { mapping: false });
    case 'resumeMap':
      return reply('Mapping again.', { mapping: true });
    default:
      return null;
  }
}

function onTalkAction(a) {
  if (a.mark) markHere(a.mark);
  if (a.go) goTo(a.go);
  if (a.stopNav) stopNav(false);
  if (a.mapping != null) setMapping(a.mapping);
  if (a.units) { rigSettings.units = a.units; guide.o.units = a.units; }
}

function logTalk(who, text) {
  state.talkLog.push({ who, text });
  state.talkLog = state.talkLog.slice(-40);
  const log = $('talkLog');
  log.innerHTML = state.talkLog.map((m) => `<li class="${m.who}"><span class="who">${m.who === 'you' ? 'You' : 'Map'}</span>${esc(m.text)}</li>`).join('');
  log.scrollTop = log.scrollHeight;
}

function onTalkState(st, detail = '') {
  const mic = $('btnMic');
  if (talk.phoneActive) {
    mic.disabled = true;
    mic.dataset.state = 'idle';
    const note = $('talkNote');
    if (note) note.textContent = 'Phone mode uses your phone microphone and speaker. Laptop microphone recognition is off.';
    $('talkStatus').textContent = st === 'speaking' ? 'Answering on your phone…' : st === 'thinking' ? 'Working out your answer…' : 'Phone mode is on. Use your phone to talk.';
    return;
  }
  mic.disabled = !talk.supported;
  mic.dataset.state = st;
  const s = $('talkStatus');
  if (st === 'listening') s.textContent = detail ? `“${detail}”` : 'Listening…';
  else if (st === 'thinking') s.textContent = 'Thinking…';
  else if (st === 'speaking') s.textContent = 'Answering…';
  else if (detail === 'not-allowed') s.textContent = 'Microphone access is blocked. Allow it from the address bar.';
  else if (detail === 'network') s.textContent = "Chrome's speech recognition needs the internet. Type instead.";
  else s.innerHTML = 'Press the mic or <kbd>M</kbd>: “mark this spot as the kitchen”, “take me back to the start”.';
  if (!talk.supported) { mic.disabled = true; s.textContent = "This browser can't recognize speech; type instead."; }
}

// ---------------------------------------------------------------------------------------
// Drawing: the camera view with tracked features, and the floor plan.

function drawCamera(m) {
  const c = $('camView'), ctx = c.getContext('2d');
  const { w, h } = m.size;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const img = ctx.createImageData(w, h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) { const g = m.image[i]; img.data[j] = img.data[j + 1] = img.data[j + 2] = g; img.data[j + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = m.status === 'ok' ? '#34d399' : '#f87171';
  for (let i = 0; i < m.features.length; i += 2) ctx.fillRect(m.features[i] - 1, m.features[i + 1] - 1, 3, 3);
  if (m.keyframe) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 3; ctx.strokeRect(1.5, 1.5, w - 3, h - 3); }
}

const planCanvas = document.createElement('canvas');
let planView = null; // { x0, z0, s } world → screen transform

function renderGrid() {
  const g = state.grid;
  if (g) {
    planCanvas.width = g.w;
    planCanvas.height = g.h;
    const ctx = planCanvas.getContext('2d');
    const img = ctx.createImageData(g.w, g.h);
    for (let j = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++) {
        const v = g.data[j * g.w + i], k = ((g.h - 1 - j) * g.w + i) * 4; // z up on screen
        const [r, gg, b, a] = v === 1 ? [226, 232, 240, 255] : v === 0 ? [36, 46, 64, 255] : [0, 0, 0, 0];
        img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  drawPlan();
}

function drawPlan() {
  const c = $('plan'), dpr = window.devicePixelRatio || 1;
  const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0b0e14';
  ctx.fillRect(0, 0, W, H);
  const g = state.grid;
  if (!g) {
    ctx.fillStyle = '#5c6679';
    ctx.font = `${13 * dpr}px system-ui`;
    ctx.textAlign = 'center';
    ctx.fillText('The floor plan appears as you walk.', W / 2, H / 2);
    planView = null;
    return;
  }
  const gw = g.w * g.cell, gh = g.h * g.cell;
  const s = Math.min(W / gw, H / gh) * 0.94;
  const ox = (W - gw * s) / 2, oy = (H - gh * s) / 2;
  planView = { s, ox, oy, g };
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(planCanvas, ox, oy, gw * s, gh * s);
  const P = (x, z) => [ox + (x - g.x0) * s, oy + (g.z0 + gh - z) * s];
  // Path walked
  const t = state.trajectory;
  if (t.length >= 6) {
    ctx.strokeStyle = 'rgba(56,189,248,0.8)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    for (let i = 0; i + 2 < t.length; i += 3) { const [x, y] = P(t[i], t[i + 2]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  // Route
  if (state.nav && state.route?.ok) {
    ctx.strokeStyle = '#fbbf24';
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    state.route.path.forEach(([x, z], i) => { const [a, b] = P(x, z); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font = `600 ${11 * dpr}px system-ui`;
  ctx.textBaseline = 'middle';
  const pin = (x, z, color, label) => {
    const [a, b] = P(x, z);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(a, b, 4.5 * dpr, 0, 2 * Math.PI); ctx.fill();
    if (label) { ctx.fillStyle = '#e2e8f0'; ctx.fillText(label, a + 7 * dpr, b); }
  };
  pin(state.start.x, state.start.z, '#a3e635', 'start');
  for (const l of state.landmarks) pin(l.x, l.z, '#c084fc', spokenName(l.cls));
  for (const p of state.places) pin(p.x, p.z, '#fb923c', p.name);
  if (state.nav) {
    const [a, b] = P(state.nav.x, state.nav.z);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath(); ctx.arc(a, b, 9 * dpr, 0, 2 * Math.PI); ctx.stroke();
  }
  if (state.truth && state.mode === 'demo') pin(state.truth.x, state.truth.z, 'rgba(255,255,255,0.35)', '');
  if (state.pose) {
    const [a, b] = P(state.pose.x, state.pose.z), hd = state.pose.heading, L = 11 * dpr;
    ctx.fillStyle = state.status === 'lost' ? '#f87171' : '#38bdf8';
    ctx.beginPath();
    ctx.moveTo(a + Math.sin(hd) * L, b - Math.cos(hd) * L);
    ctx.lineTo(a + Math.sin(hd + 2.5) * L * 0.7, b - Math.cos(hd + 2.5) * L * 0.7);
    ctx.lineTo(a + Math.sin(hd - 2.5) * L * 0.7, b - Math.cos(hd - 2.5) * L * 0.7);
    ctx.closePath();
    ctx.fill();
  }
}

function planClick(e) {
  if (!planView) return;
  const c = $('plan'), r = c.getBoundingClientRect(), dpr = c.width / r.width;
  const { s, ox, oy, g } = planView;
  const x = g.x0 + ((e.clientX - r.left) * dpr - ox) / s;
  const z = g.z0 + g.h * g.cell - ((e.clientY - r.top) * dpr - oy) / s;
  goTo({ x, z, label: 'the spot you picked' });
}

// ---------------------------------------------------------------------------------------
// Panels

function banner(text, kind = 'warn') {
  const b = $('banner');
  b.className = kind === 'warn' ? 'banner' : `banner ${kind}`;
  $('bannerText').textContent = text;
  b.hidden = false;
}

function hidePlaceholder() {
  $('placeholder').hidden = true;
}

function setChip(id, text, cls = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `chip ${cls}`.trim();
}

function refreshChips() {
  const st = state.status;
  setChip('chipTrack', st === 'ok' ? 'Tracking' : st === 'lost' ? 'Lost: stop and turn slowly' : st === 'init' ? 'Looking for features…' : 'Idle', st === 'ok' ? 'ok' : st === 'lost' ? 'err' : 'busy');
  const s = state.stats;
  setChip('chipMap', s ? `${s.keyframes} keyframes · ${s.freeArea.toFixed(0)} m² mapped` : 'No map yet');
  setChip('chipFps', state.fps ? `${state.fps.toFixed(0)} fps` : '— fps');
  setChip('chipFloor', { fitted: 'Floor found', assumed: 'Floor assumed', pending: 'Finding the floor…' }[state.floor] ?? '', state.floor === 'fitted' ? 'ok' : '');
  const t = state.timings;
  $('camStats').textContent = state.status === 'idle' ? '' : [
    `${state.inliers ?? 0} points tracked`,
    t ? `track ${t.track.toFixed(0)} ms${t.depth ? ` · depth ${t.depth.toFixed(0)} ms` : ''}` : '',
    state.gap ? `camera gap ${(state.gap * 1000).toFixed(0)} ms` : '',
    state.vo?.syncSkips ? `${state.vo.syncSkips} keyframes waited for slower turning` : '',
    state.truth && state.mode === 'demo' ? `drift vs truth ${(state.truth.drift * 100).toFixed(0)} cm` : '',
  ].filter(Boolean).join(' · ');
}

function refreshDestinations() {
  const sel = $('destSel');
  const cur = sel.value;
  const opts = [
    ['start', 'The start'],
    ...state.places.map((p, i) => [`p${i}`, p.name]),
    ...state.landmarks.map((l, i) => [`l${i}`, `${spokenName(l.cls)} (seen)`]),
  ];
  sel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  if (opts.some(([v]) => v === cur)) sel.value = cur;
  $('placeList').innerHTML = state.places.length
    ? state.places.map((p, i) => `<li><span class="grow">${esc(p.name)}</span><button type="button" class="link" data-go="p${i}">Go</button><button type="button" class="x" data-rm="${esc(p.name)}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join('')
    : '<li class="empty">No places yet. Stand somewhere and save it, or say “mark this spot as the kitchen”.</li>';
}

function destinationOf(v) {
  if (v === 'start') return { ...state.start, label: 'the start' };
  if (v.startsWith('p')) { const p = state.places[Number(v.slice(1))]; return p && { x: p.x, z: p.z, label: `the ${p.name}` }; }
  const l = state.landmarks[Number(v.slice(1))];
  return l && { x: l.x, z: l.z, label: `the ${spokenName(l.cls)}` };
}

function refreshNav() {
  $('btnGo').hidden = !!state.nav;
  $('btnStopNav').hidden = !state.nav;
  if (!state.nav) $('navNow').textContent = 'Pick a destination, click the floor plan, or say “take me to …”.';
}

function setModeButtons() {
  document.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('active', b.dataset.src === state.mode || (b.dataset.src === 'demo' && state.mode === 'demo')));
  $('cardDemo').hidden = state.mode !== 'demo';
}

function setDemoButtons(kind) {
  $('btnTour').classList.toggle('primary', kind === 'tour');
  $('btnWalk').classList.toggle('primary', kind === 'walk');
}

function setMapping(on) {
  state.mapping = on;
  state.worker?.postMessage({ type: 'mapping', on });
  $('btnMapping').textContent = on ? 'Pause mapping' : 'Resume mapping';
  $('btnMapping').setAttribute('aria-pressed', String(!on));
}

// ---------------------------------------------------------------------------------------
// Wiring

function bindSettings() {
  const fields = { inCamHeight: 'camHeight', inBodyHeight: 'bodyHeight', inStepHeight: 'stepHeight', inRange: 'rangeMax' };
  for (const [id, key] of Object.entries(fields)) {
    const el = $(id);
    el.value = settings[key];
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (!Number.isFinite(v) || v <= 0) { el.value = settings[key]; return; }
      settings[key] = v;
      save(MAP_KEY, settings);
      state.worker?.postMessage({ type: 'settings', world: { camHeight: settings.camHeight, bodyHeight: settings.bodyHeight, stepHeight: settings.stepHeight, rangeMax: settings.rangeMax } });
    });
  }
  $('inQuality').value = settings.quality;
  $('inQuality').addEventListener('change', (e) => { settings.quality = e.target.value; save(MAP_KEY, settings); banner('Quality applies the next time you start the cameras or the demo.', 'info'); });
  $('inLandmarks').checked = settings.landmarks;
  $('inLandmarks').addEventListener('change', (e) => { settings.landmarks = e.target.checked; save(MAP_KEY, settings); if (settings.landmarks) ensureDetector(); });
  $('inFps60').checked = settings.fps60;
  $('inFps60').addEventListener('change', (e) => { settings.fps60 = e.target.checked; save(MAP_KEY, settings); });
  $('inSpeak').checked = rigSettings.talkSpeak !== false;
  talk.speakAnswers = $('inSpeak').checked;
  $('inSpeak').addEventListener('change', (e) => { talk.speakAnswers = e.target.checked; if (!e.target.checked) voice.cancel(); });
  talk.followUp = rigSettings.talkFollowUp !== false;
  $('rigSummary').textContent = `${rigSettings.baselineCm} cm apart, ${rigSettings.angleDeg}° between them, ${rigSettings.hfovDeg}° field of view (from the measuring page).`;
}

function wire() {
  document.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.src === 'cameras') startCameras();
    else if (b.dataset.src === 'files') { $('fileInput').value = ''; $('fileInput').click(); }
    else startDemo('tour');
  }));
  $('fileInput').addEventListener('change', (e) => { if (e.target.files.length) startRecording(e.target.files); });
  $('btnTour').addEventListener('click', () => startDemo('tour'));
  $('btnWalk').addEventListener('click', () => startDemo('walk'));
  $('btnMapping').addEventListener('click', () => setMapping(!state.mapping));
  $('btnNew').addEventListener('click', () => {
    if (!state.worker) return;
    state.worker.postMessage({ type: 'reset' });
    if (state.mode === 'demo') state.worker.postMessage({ type: 'demo', kind: 'walk' });
    resetMapView();
  });
  $('btnSave').addEventListener('click', () => state.worker?.postMessage({ type: 'save' }));
  $('btnPly').addEventListener('click', () => state.worker?.postMessage({ type: 'ply' }));
  $('btnLoad').addEventListener('click', () => { $('mapFile').value = ''; $('mapFile').click(); });
  $('mapFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f || !state.worker) return banner('Start the cameras (or the demo) first, then load the map.', 'warn');
    state.worker.postMessage({ type: 'load', data: await f.text() });
    banner('Map loaded. Positions continue from where that mapping session started, so begin there, facing the same way.', 'info');
  });
  $('btnGo').addEventListener('click', () => { const d = destinationOf($('destSel').value); if (d) goTo(d); });
  $('btnStopNav').addEventListener('click', () => stopNav());
  $('markForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('markName').value;
    if (markHere(name)) { $('markName').value = ''; speak(`Saved this spot as the ${name.trim()}.`, 'info'); } else banner('Start mapping first, and give the spot a name.', 'warn');
  });
  $('placeList').addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { const d = destinationOf(go.dataset.go); if (d) goTo(d); }
    const rm = e.target.closest('[data-rm]');
    if (rm) state.worker?.postMessage({ type: 'removePlace', name: rm.dataset.rm });
  });
  $('plan').addEventListener('click', planClick);
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('active', x === b));
    view3d?.setMode(b.dataset.view);
  }));
  $('inClip').addEventListener('input', (e) => { view3d?.setClipHeight(Number(e.target.value)); $('clipVal').textContent = `${Number(e.target.value).toFixed(1)} m`; });
  $('btnMic').addEventListener('click', () => talk.toggle());
  $('askForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('askInput').value.trim(); if (q) { $('askInput').value = ''; talk.ask(q); } });
  document.querySelectorAll('[data-ask]').forEach((b) => b.addEventListener('click', () => talk.ask(b.dataset.ask)));
  $('bannerClose').addEventListener('click', () => { $('banner').hidden = true; });

  const keyMap = { ArrowUp: ['forward', 1], KeyW: ['forward', 1], ArrowDown: ['forward', -1], KeyS: ['forward', -1], ArrowLeft: ['turn', -1], KeyA: ['turn', -1], ArrowRight: ['turn', 1], KeyD: ['turn', 1] };
  const onKey = (e, down) => {
    if (e.target.closest('input, select, textarea')) return;
    if (down && e.code === 'KeyM' && !e.repeat) { talk.toggle(); return; }
    if (down && e.key === 'Escape') { if (talk.phoneActive) talk.phone.hangup(); else talk.end(); return; }
    const k = keyMap[e.code];
    if (!k || state.mode !== 'demo') return;
    e.preventDefault();
    state.keys[k[0]] = down ? k[1] : (state.keys[k[0]] === k[1] ? 0 : state.keys[k[0]]);
    state.worker?.postMessage({ type: 'keys', ...state.keys });
  };
  document.addEventListener('keydown', (e) => onKey(e, true));
  document.addEventListener('keyup', (e) => onKey(e, false));
  new ResizeObserver(drawPlan).observe($('plan'));
}

async function init() {
  bindSettings();
  wire();
  onTalkState('idle');
  mountPhone({ talk, voice });
  refreshNav();
  refreshDestinations();
  renderGrid();
  requestAnimationFrame(pump);
  try {
    const { MapView3D } = await import('./view3d.js');
    view3d = new MapView3D($('view3d'), { onPick: (p) => goTo({ ...p, label: 'the spot you picked' }) });
  } catch (e) {
    $('view3d').innerHTML = '<p class="muted pad">The 3D view needs three.js from the internet. The floor plan and directions still work.</p>';
  }
  if (camerasSupported() && (await cameraPermission()) === 'granted' && rigSettings.deviceIds?.[0]) {
    $('placeholderNote').textContent = 'Cameras are allowed: press Start mapping with cameras when you are ready to walk.';
  }
}

window.stereoMap = { state, talk, guide };
init();
