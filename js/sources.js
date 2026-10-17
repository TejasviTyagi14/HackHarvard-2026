// Video sources: live cameras (getUserMedia), recorded files (one side-by-side file or two
// separate files) and plain canvases (the demo room). Every source can draw its current
// frame into a 2D context at any size.

function videoBin() {
  let bin = document.getElementById('videoBin');
  if (!bin) {
    bin = document.createElement('div');
    bin.id = 'videoBin';
    bin.setAttribute('aria-hidden', 'true');
    bin.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    document.body.appendChild(bin);
  }
  return bin;
}

function makeVideo() {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  videoBin().appendChild(v);
  return v;
}

export class VideoSource {
  /** half: 0 = left half of the frame, 1 = right half, null = whole frame. */
  constructor(video, { label, kind, stream = null, half = null, url = null }) {
    Object.assign(this, { video, label, kind, stream, half, url });
    this.frameCount = 0;
    this.frameTime = null; // capture time of the newest frame (performance.now() clock)
    this.startClock();
  }

  /** Counts frames and keeps each one's capture time, so two cameras' frames can be paired. */
  startClock() {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    const tick = (now, meta) => {
      if (this.stopped) return;
      this.frameCount = meta.presentedFrames ?? this.frameCount + 1;
      this.frameTime = meta.captureTime ?? meta.expectedDisplayTime ?? now;
      v.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
  }

  get ready() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  get width() {
    const w = this.video.videoWidth;
    return this.half == null ? w : Math.floor(w / 2);
  }

  get height() {
    return this.video.videoHeight;
  }

  get track() {
    return this.stream?.getVideoTracks()[0] ?? null;
  }

  drawTo(ctx, w, h) {
    if (this.half == null) ctx.drawImage(this.video, 0, 0, w, h);
    else ctx.drawImage(this.video, this.half * this.width, 0, this.width, this.height, 0, 0, w, h);
  }

  pause(on) {
    if (this.kind !== 'file') return;
    if (on) this.video.pause();
    else this.video.play().catch(() => {});
  }

  stop() {
    this.stopped = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.remove();
    if (this.url) URL.revokeObjectURL(this.url);
  }
}

export class CanvasSource {
  constructor(canvas, label) {
    Object.assign(this, { canvas, label, kind: 'demo' });
  }
  get ready() { return true; }
  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }
  get track() { return null; }
  drawTo(ctx, w, h) { ctx.drawImage(this.canvas, 0, 0, w, h); }
  pause() {}
  stop() {}
}

export function camerasSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

/** 'granted' | 'prompt' | 'denied' | 'unknown' */
export async function cameraPermission() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state;
  } catch {
    return 'unknown';
  }
}

/** Device labels are hidden until the page has camera access once, so ask for it first. */
export async function ensurePermission() {
  if (!camerasSupported()) {
    throw Object.assign(new Error('This page has no camera access. Open it at http://localhost (not as a file).'), { name: 'NoMediaDevices' });
  }
  const devs = await navigator.mediaDevices.enumerateDevices();
  if (devs.some((d) => d.kind === 'videoinput' && d.label)) return;
  const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  s.getTracks().forEach((t) => t.stop());
}

/** Video inputs; identical names (two IC780s) get #1 / #2 suffixes. */
export async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const seen = {};
  const named = devs.map((d, i) => {
    const base = d.label || `Camera ${i + 1}`;
    seen[base] = (seen[base] || 0) + 1;
    return { deviceId: d.deviceId, base, n: seen[base] };
  });
  return named.map((d) => ({ ...d, label: seen[d.base] > 1 ? `${d.base} #${d.n}` : d.base }));
}

/** Picks two cameras: saved choices if still present, else IC780s, else anything external. */
export function pickDefaultPair(cameras, saved = [null, null]) {
  const ids = cameras.map((c) => c.deviceId);
  if (saved[0] && saved[1] && saved[0] !== saved[1] && ids.includes(saved[0]) && ids.includes(saved[1])) return saved;
  const rank = (c) => (/ic780/i.test(c.label) ? 0 : /facetime|macbook|built-in|iphone|continuity|desk view/i.test(c.label) ? 2 : 1);
  const sorted = [...cameras].sort((a, b) => rank(a) - rank(b));
  return [sorted[0]?.deviceId ?? null, sorted[1]?.deviceId ?? null];
}

export async function openCamera(deviceId, width, height, label, fps = 30) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps } },
  });
  const video = makeVideo();
  video.srcObject = stream;
  await video.play();
  return new VideoSource(video, { label, kind: 'camera', stream });
}

async function loadVideoFile(file) {
  const video = makeVideo();
  video.loop = true;
  const url = URL.createObjectURL(file);
  video.src = url;
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error(`Couldn't play ${file.name}. Chrome plays .webm and .mp4.`));
  });
  return { video, url };
}

/** One file = side-by-side recording (left | right). Two files = left, right (sorted by name). */
export async function openRecording(files) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) throw new Error('No file chosen.');
  if (list.length === 1) {
    const { video, url } = await loadVideoFile(list[0]);
    await video.play();
    return [
      new VideoSource(video, { label: `${list[0].name} · left half`, kind: 'file', half: 0, url }),
      new VideoSource(video, { label: `${list[0].name} · right half`, kind: 'file', half: 1 }),
    ];
  }
  const [a, b] = await Promise.all(list.slice(0, 2).map(loadVideoFile));
  a.video.currentTime = 0;
  b.video.currentTime = 0;
  await Promise.all([a.video.play(), b.video.play()]);
  return [
    new VideoSource(a.video, { label: list[0].name, kind: 'file', url: a.url }),
    new VideoSource(b.video, { label: list[1].name, kind: 'file', url: b.url }),
  ];
}

/** What the browser reports about a live camera: delivered size/fps and focus controls. */
export function cameraDetails(src) {
  const t = src?.track;
  if (!t) return null;
  const caps = t.getCapabilities ? t.getCapabilities() : {};
  const set = t.getSettings();
  return {
    width: set.width, height: set.height, fps: set.frameRate,
    focusModes: caps.focusMode || [], focusMode: set.focusMode || null,
    focusDistance: caps.focusDistance || null,
  };
}

export async function lockFocus(src) {
  const t = src?.track;
  if (!t) throw new Error('No live camera.');
  const caps = t.getCapabilities ? t.getCapabilities() : {};
  const modes = caps.focusMode || [];
  if (modes.includes('manual')) {
    const fd = t.getSettings().focusDistance ?? caps.focusDistance?.min;
    await t.applyConstraints({ advanced: [{ focusMode: 'manual', ...(fd != null ? { focusDistance: fd } : {}) }] });
    return 'Focus locked (manual).';
  }
  if (modes.includes('single-shot')) {
    await t.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] });
    return 'Focused once, then locked (single-shot).';
  }
  throw new Error("This browser doesn't expose focus control for this camera.");
}
