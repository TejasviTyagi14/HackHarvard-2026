// Live two-camera pipeline for the landing page's radar section. Same plumbing as the Measure
// page (js/app.js): sources.js opens the cameras, detector.js runs COCO-SSD, scene.js pairs the
// boxes across the two views and measures them, using the rig and camera choice the Measure page
// saved in localStorage. The section's sliders override baseline and angle while it runs.
import { camerasSupported, ensurePermission, listCameras, openCamera, pickDefaultPair } from '../sources.js';
import { Detector } from '../detector.js';
import { Tracker, measureScene, median } from '../scene.js';
import { buildRig } from '../geometry.js';
import { GrayFrame } from '../stereo.js';

const STORE_KEY = 'stereo-distance:v1'; // the Measure page's settings (js/app.js)
const PROC_MAX_W = 640; // detection and matching run at this width, like app.js
const STEP_MS = 200; // one stereo measurement every ~200 ms; runs never overlap
const DEFAULTS = {
  baselineCm: 12, angleDeg: 0, angleSplit: 'even', hfovDeg: 70, tiltDeg: 0, vtol: 4,
  resolution: '1280x720', model: 'lite_mobilenet_v2', minScore: 0.5, deviceIds: [null, null], vOffset: 0,
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The rig the Measure page saved (read-only here), with defaults for anything missing. */
export function savedRig() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* storage unavailable */ }
  if (!s || typeof s !== 'object') s = {};
  const ids = Array.isArray(s.deviceIds) && s.deviceIds.length === 2 ? s.deviceIds : [null, null];
  return {
    baselineCm: clamp(num(s.baselineCm, DEFAULTS.baselineCm), 0.5, 300),
    angleDeg: clamp(num(s.angleDeg, DEFAULTS.angleDeg), -45, 45),
    angleSplit: typeof s.angleSplit === 'string' ? s.angleSplit : DEFAULTS.angleSplit,
    hfovDeg: clamp(num(s.hfovDeg, DEFAULTS.hfovDeg), 20, 160),
    tiltDeg: clamp(num(s.tiltDeg, DEFAULTS.tiltDeg), -60, 60),
    vtol: clamp(num(s.vtol, DEFAULTS.vtol), 0, 15),
    resolution: /^\d+x\d+$/.test(s.resolution ?? '') ? s.resolution : DEFAULTS.resolution,
    model: typeof s.model === 'string' ? s.model : DEFAULTS.model,
    minScore: clamp(num(s.minScore, DEFAULTS.minScore), 0.1, 0.95),
    deviceIds: ids,
    vOffset: clamp(num(s.vOffset, 0), -30, 30),
    calibrated: !!s.calibrated,
  };
}

/** Inline, human message for anything start() throws. */
export function liveErrorText(e) {
  const which = e?.side == null ? 'cameras' : e.side === 0 ? 'left camera' : 'right camera';
  switch (e?.name) {
    case 'TooFewCameras':
      return `Two cameras needed for stereo — found ${e.count}. Plug in both, then press Start cameras again. The demo keeps running.`;
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow it from the camera icon in the address bar (on macOS also System Settings → Privacy & Security → Camera). The demo keeps running.';
    case 'NotReadableError':
    case 'AbortError':
      return `Couldn't start the ${which}. Quit other apps using a camera (Zoom, FaceTime, Photo Booth); with two USB webcams, set 640 × 480 on the Measure page or use different ports.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return e?.side == null
        ? 'Two cameras needed for stereo — found 0. The demo keeps running.'
        : `The ${which} wasn't found. Replug it, then press Start cameras again.`;
    case 'NoMediaDevices':
      return `${e.message} The demo keeps running.`;
    default:
      return `Couldn't start the cameras: ${e?.message || e}. The demo keeps running.`;
  }
}

export class LiveStereo {
  /**
   * getRig() → { baselineCm, angleDeg } (the sliders), read on every measurement.
   * onResult({ rig, objects, canvases, w, h, hz }) after each measured frame pair.
   * onStatus(kind, value): ('detector', 'loading' | 'ready' | 'error'), ('ended', side).
   */
  constructor({ getRig, onResult, onStatus = () => {} }) {
    Object.assign(this, { getRig, onResult, onStatus });
    this.settings = savedRig();
    this.detector = new Detector();
    this.detectorStatus = 'idle';
    this.sources = [null, null];
    this.labels = ['', ''];
    this.gen = 0;
    this.running = false;
    this.paused = false;
    this.tracker = new Tracker();
    this.vOffset = 0;
    this.rigKey = '';
    this.hz = 0;
    this.lastStep = 0;
    // Reused every frame: the snapshot the detector reads, and the copy shown with its results.
    this.proc = [0, 1].map(() => document.createElement('canvas'));
    this.procCtx = this.proc.map((c) => c.getContext('2d', { willReadFrequently: true }));
    this.shown = [0, 1].map(() => document.createElement('canvas'));
    this.shownCtx = this.shown.map((c) => c.getContext('2d'));
  }

  get streams() { return this.sources.map((s) => s?.stream ?? null); }
  get size() { const s = this.sources[0]; return s?.ready ? { w: s.width, h: s.height } : null; }

  /** Opens the saved (or best-guess) camera pair and starts measuring. Throws for liveErrorText(). */
  async start() {
    this.stop();
    const gen = this.gen;
    const cancelled = () => Object.assign(new Error('cancelled'), { name: 'Cancelled' });
    this.settings = savedRig();
    this.vOffset = this.settings.vOffset;
    if (!camerasSupported()) {
      throw Object.assign(new Error('This page has no camera access. Open it at http://localhost (not as a file).'), { name: 'NoMediaDevices' });
    }
    await ensurePermission();
    const cams = await listCameras();
    if (gen !== this.gen) throw cancelled();
    if (cams.length < 2) throw Object.assign(new Error('too few cameras'), { name: 'TooFewCameras', count: cams.length });
    const ids = pickDefaultPair(cams, this.settings.deviceIds);
    const [w, h] = this.settings.resolution.split('x').map(Number);
    for (let i = 0; i < 2; i++) {
      const cam = cams.find((c) => c.deviceId === ids[i]);
      let src;
      try {
        src = await openCamera(ids[i], w, h, cam?.label ?? 'Camera');
      } catch (e) {
        if (gen === this.gen) this.stop();
        throw Object.assign(e, { side: i });
      }
      if (gen !== this.gen) { src.stop(); throw cancelled(); }
      this.sources[i] = src;
      this.labels[i] = cam?.label ?? `Camera ${i + 1}`;
      src.track?.addEventListener('ended', () => { if (gen === this.gen) this.onStatus('ended', i); });
    }
    this.running = true;
    this.tracker = new Tracker();
    this.rigKey = '';
    this.hz = 0;
    this.loadDetector(gen);
    this.loop(gen);
    return { labels: [...this.labels], calibrated: this.settings.calibrated };
  }

  async loadDetector(gen) {
    if (this.detector.ready) { this.detectorStatus = 'ready'; this.onStatus('detector', 'ready'); return; }
    this.detectorStatus = 'loading';
    this.onStatus('detector', 'loading');
    try {
      await this.detector.load(this.settings.model);
      this.detectorStatus = 'ready';
    } catch (e) {
      console.warn('Detector failed to load:', e);
      this.detectorStatus = 'error';
    }
    if (gen === this.gen) this.onStatus('detector', this.detectorStatus);
  }

  pause(on) { this.paused = !!on; }

  /** Releases both cameras and drops any measurement in flight. */
  stop() {
    this.gen++;
    this.running = false;
    for (const s of this.sources) s?.stop();
    this.sources = [null, null];
    this.labels = ['', ''];
  }

  dispose() {
    this.stop();
    this.detector.model?.dispose?.();
  }

  // ------------------------------------------------------------------------------- loop
  async loop(gen) {
    let wait = 0;
    while (gen === this.gen) {
      await sleep(wait); // also lets start()'s caller finish its setup before the first frame
      if (gen !== this.gen) break;
      const t0 = performance.now();
      if (!this.paused && !document.hidden && this.sources[0]?.ready && this.sources[1]?.ready) {
        try {
          await this.step(gen, t0);
        } catch (e) {
          console.error(e);
        }
      }
      wait = this.paused ? 150 : Math.max(16, STEP_MS - (performance.now() - t0));
    }
  }

  snapshot(i) {
    const src = this.sources[i];
    const pw = Math.min(PROC_MAX_W, src.width), ph = Math.round((src.height * pw) / src.width);
    const c = this.proc[i];
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    src.drawTo(this.procCtx[i], pw, ph);
    return GrayFrame.fromRGBA(this.procCtx[i].getImageData(0, 0, pw, ph).data, pw, ph);
  }

  async step(gen, t0) {
    const fL = this.snapshot(0), fR = this.snapshot(1);
    let dets = [[], []];
    if (this.detector.ready) {
      const min = this.settings.minScore;
      dets = [await this.detector.detect(this.proc[0], min), await this.detector.detect(this.proc[1], min)];
    }
    if (gen !== this.gen) return;
    const s = this.settings;
    const { baselineCm, angleDeg } = this.getRig();
    const rig = buildRig({ baselineCm, angleDeg, hfovDeg: s.hfovDeg, angleSplit: s.angleSplit }, fL, fR);
    const scene = measureScene(dets[0], dets[1], fL, fR, rig, { vtol: s.vtol, tiltDeg: s.tiltDeg, vOffset: this.vOffset });
    // Learn how far the right image sits above/below the left one from confident matches (as app.js).
    if (scene.dyObs.length >= 2) this.vOffset = clamp(0.85 * this.vOffset + 0.15 * median(scene.dyObs), -30, 30);
    // A slider move changes every range: forget the old history instead of mixing the two rigs.
    const key = `${baselineCm}|${angleDeg}`;
    const replace = key !== this.rigKey;
    this.rigKey = key;
    const objects = this.tracker.update(scene.objects, performance.now(), s.tiltDeg, { replace });
    // Show the exact frames the boxes came from (the detector's snapshot is reused next step).
    for (let i = 0; i < 2; i++) {
      const p = this.proc[i], c = this.shown[i];
      if (c.width !== p.width || c.height !== p.height) {
        c.width = p.width;
        c.height = p.height;
      }
      this.shownCtx[i].drawImage(p, 0, 0);
    }
    const dt = t0 - this.lastStep;
    this.lastStep = t0;
    if (dt > 0 && dt < 2000) this.hz = this.hz ? 0.85 * this.hz + 0.15 * (1000 / dt) : 1000 / dt;
    this.onResult({ rig, objects, canvases: this.shown, w: fL.w, h: fL.h, hz: this.hz });
  }
}
