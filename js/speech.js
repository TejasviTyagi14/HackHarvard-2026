// Speech in and out: one shared voice (text-to-speech), the periodic "what changed" announcer,
// a one-utterance listener (speech recognition), and short tones that mark listening.
import { speechChanged, speechSummary } from './scene.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Voice {
  get supported() {
    return this.output ? this.output.supported : 'speechSynthesis' in window;
  }

  get speaking() {
    return this.output ? this.output.speaking : this.supported && (speechSynthesis.speaking || speechSynthesis.pending);
  }

  cancel() {
    if (this.output) this.output.cancel();
    else if (this.supported) speechSynthesis.cancel();
  }

  /**
   * Speaks text one sentence at a time (Chrome cuts long single utterances off) and resolves
   * when it's done or was interrupted.
   */
  say(text, { interrupt = true, rate = 1.05 } = {}) {
    if (this.output) return this.output.say(text, { interrupt });
    if (!this.supported || !text) return Promise.resolve();
    if (interrupt) speechSynthesis.cancel();
    const parts = text.split(/(?<=[.!?:;])\s+/).filter(Boolean);
    return new Promise((resolve) => {
      let left = parts.length, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      // onend occasionally never fires in Chrome; don't wait forever.
      const timer = setTimeout(finish, 2000 + text.length * 90);
      // With no usable voice, nothing ever starts; don't hold up the conversation for it.
      setTimeout(() => { if (!speechSynthesis.speaking && !speechSynthesis.pending) finish(); }, 1200);
      for (const p of parts) {
        const u = new SpeechSynthesisUtterance(p);
        u.rate = rate;
        u.lang = 'en-US';
        u.onend = () => { if (--left <= 0) finish(); };
        u.onerror = (e) => { if (e.error === 'interrupted' || e.error === 'canceled' || --left <= 0) finish(); };
        speechSynthesis.speak(u);
      }
    });
  }

  /** Waits until nothing is being spoken (up to maxMs). */
  async idle(maxMs = 4000) {
    for (const end = performance.now() + maxMs; this.speaking && performance.now() < end;) await sleep(80);
  }
}

/** Every 2 s, says the nearest objects, but only when the scene has changed. */
export class Speaker {
  constructor(voice, intervalMs = 2000) {
    this.voice = voice;
    this.intervalMs = intervalMs;
    this.enabled = false;
    this.last = null;
    this.lastTick = 0;
  }

  get supported() {
    return this.voice.supported;
  }

  setEnabled(on) {
    this.enabled = on && this.supported;
    this.last = null;
  }

  /** blocked: true while a conversation is going, so updates don't talk over it. */
  tick(objects, units, now, blocked = false) {
    if (!this.enabled || blocked || now - this.lastTick < this.intervalMs) return;
    this.lastTick = now;
    if (this.voice.speaking) return;
    const { text, items } = speechSummary(objects, units);
    if (!speechChanged(this.last, items)) return;
    this.last = items;
    this.voice.say(text, { interrupt: false });
  }
}

/** Hears one question. Uses on-device recognition when the browser offers it. */
export class Listener {
  constructor(lang = 'en-US') {
    this.lang = lang;
    this.rec = null;
    this.local = false;
    this.installing = false;
  }

  static get SR() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  get supported() {
    return !!Listener.SR;
  }

  get active() {
    return !!this.rec;
  }

  async preferLocal(rec) {
    const SR = Listener.SR;
    this.local = false;
    if (!('processLocally' in rec) || typeof SR.available !== 'function') return;
    const opts = { langs: [this.lang], processLocally: true };
    try {
      const status = await SR.available(opts);
      if (status === 'available') {
        rec.processLocally = true;
        this.local = true;
      } else if (status === 'downloadable' && !this.installing && typeof SR.install === 'function') {
        // Fetch the on-device model for next time; this time use the default recognizer.
        this.installing = true;
        SR.install(opts).catch(() => {}).finally(() => { this.installing = false; });
      }
    } catch { /* keep the default recognizer */ }
  }

  /**
   * Listens for one utterance. onInterim(text) gets the words as they're heard.
   * Resolves to { alternatives: [...] } or { error } ('no-speech', 'not-allowed', 'network', 'aborted', …).
   */
  async listen({ onInterim } = {}) {
    if (this.rec) this.rec.abort();
    const rec = new Listener.SR();
    rec.lang = this.lang;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.continuous = false;
    await this.preferLocal(rec);
    this.rec = rec;
    return new Promise((resolve) => {
      let final = null, error = null;
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) final = Array.from(r, (a) => a.transcript.trim()).filter(Boolean);
          else interim += r[0].transcript;
        }
        if (interim) onInterim?.(interim);
      };
      rec.onerror = (e) => { error = e.error; };
      rec.onend = () => {
        if (this.rec === rec) this.rec = null;
        resolve(final?.length ? { alternatives: final } : { error: error || 'no-speech' });
      };
      try {
        rec.start();
      } catch (e) {
        this.rec = null;
        resolve({ error: 'start-failed', message: e.message });
      }
    });
  }

  /** Stop listening and use what was heard so far. */
  stop() {
    this.rec?.stop();
  }

  /** Stop listening and throw away what was heard. */
  abort() {
    this.rec?.abort();
  }
}

let audio = null;

/** A short rising tone when listening starts, falling when it stops, low when something failed, a tick while turning. */
export function tone(kind) {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') audio.resume();
    const [f1, f2] = { start: [660, 990], stop: [880, 520], error: [320, 220], tick: [1320, 1320] }[kind] ?? [660, 660];
    const t = audio.currentTime;
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.frequency.setValueAtTime(f1, t);
    osc.frequency.linearRampToValueAtTime(f2, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  } catch { /* no audio output: the on-screen status still shows the state */ }
}
