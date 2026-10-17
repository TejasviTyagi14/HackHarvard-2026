// Records both views into one side-by-side video (left | right) so a replay stays in sync.
export class StereoRecorder {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.recorder = null;
    this.live = false;
    this.startedAt = 0;
  }

  get active() {
    return !!this.recorder;
  }

  start([L, R]) {
    const w = Math.min(1280, L.width), h = Math.round((L.height * w) / L.width);
    this.canvas.width = 2 * w;
    this.canvas.height = h;
    this.live = true;
    const draw = () => {
      if (!this.live) return;
      L.drawTo(this.ctx, w, h);
      this.ctx.save();
      this.ctx.translate(w, 0);
      R.drawTo(this.ctx, w, h);
      this.ctx.restore();
      // Hidden tabs get no animation frames; keep recording on a timer.
      if (document.hidden) this.timeout = setTimeout(draw, 33);
      else this.raf = requestAnimationFrame(draw);
    };
    draw();
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.chunks = [];
    this.recorder = new MediaRecorder(this.canvas.captureStream(30), { mimeType, videoBitsPerSecond: 10_000_000 });
    this.recorder.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.recorder.start(1000);
    this.startedAt = performance.now();
  }

  /** Resolves to the recorded Blob (or null if nothing was recording). */
  stop() {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec) return resolve(null);
      rec.onstop = () => {
        this.live = false;
        cancelAnimationFrame(this.raf);
        clearTimeout(this.timeout);
        this.recorder = null;
        resolve(new Blob(this.chunks, { type: rec.mimeType || 'video/webm' }));
      };
      rec.stop();
    });
  }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
