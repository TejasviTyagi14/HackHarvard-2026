// Object detection with COCO-SSD on TensorFlow.js (80 everyday classes: person, chair, cup…).
// The library and model weights load from public CDNs the first time, then the browser caches them.
const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO_SSD = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

export const MODELS = {
  lite_mobilenet_v2: 'Fast (SSD Lite MobileNet v2)',
  mobilenet_v2: 'Accurate (SSD MobileNet v2)',
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`couldn't download ${src.split('/npm/')[1] ?? src}`));
    document.head.appendChild(s);
  });
}

export class Detector {
  constructor() {
    this.model = null;
    this.base = null;
    this.pending = null;
  }

  get ready() {
    return !!this.model;
  }

  load(base = 'lite_mobilenet_v2') {
    if (this.model && this.base === base) return Promise.resolve(this.model);
    if (this.pending?.base === base) return this.pending.promise;
    const promise = (async () => {
      if (!window.tf) await loadScript(TFJS);
      if (!window.cocoSsd) await loadScript(COCO_SSD);
      await window.tf.ready();
      const model = await window.cocoSsd.load({ base });
      if (this.model && this.model !== model) this.model.dispose?.();
      this.model = model;
      this.base = base;
      return model;
    })();
    this.pending = { base, promise };
    promise.finally(() => { if (this.pending?.promise === promise) this.pending = null; });
    return promise;
  }

  /** [{ bbox: [x, y, w, h], class, score }] in the canvas's pixel coordinates. */
  async detect(canvas, minScore = 0.5) {
    if (!this.model) return [];
    const preds = await this.model.detect(canvas, 20, minScore);
    return preds.map((p) => ({ bbox: p.bbox, class: p.class, score: p.score }));
  }
}
