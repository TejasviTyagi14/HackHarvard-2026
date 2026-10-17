// The back-and-forth: listen for a question, answer it from the live scene, say the answer, then
// listen again for a follow-up until the user goes quiet or says "thanks" / "stop".
import { answerBest } from './assistant.js';
import { Listener, tone } from './speech.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Talk {
  /**
   * voice: shared Voice. getScene(): the scene snapshot answers are built from.
   * onTurn(result), onAction(action), onState(state, detail) report back to the page.
   * answer(alternatives, scene, ctx): what to reply (defaults to the scene assistant).
   */
  constructor({ voice, getScene, onTurn, onAction, onState, answer = answerBest }) {
    Object.assign(this, { voice, getScene, onTurn, onAction, onState, answer });
    this.listener = new Listener();
    this.ctx = {};
    this.state = 'idle'; // idle | listening | thinking | speaking
    this.session = 0; // bumps on every new turn, so stale callbacks stand down
    this.followUp = true;
    this.speakAnswers = true;
    this.lastActive = -Infinity;
  }

  get supported() {
    return this.listener.supported;
  }

  /** True during a turn and for a few seconds after, so periodic updates don't cut in. */
  get busy() {
    return this.state !== 'idle' || performance.now() - this.lastActive < 4000;
  }

  set(state, detail = '') {
    this.state = state;
    this.lastActive = performance.now();
    this.onState(state, detail);
  }

  /** The mic button: start listening, finish early, or cut into an answer and listen. */
  toggle() {
    if (this.state === 'listening') return this.listener.stop();
    return this.listen();
  }

  /** Stop everything: listening, speaking, follow-ups. */
  end() {
    this.session++;
    this.listener.abort();
    this.voice.cancel();
    if (this.state !== 'idle') tone('stop');
    this.set('idle');
  }

  async listen() {
    if (!this.supported) return this.set('idle', 'unsupported');
    const session = ++this.session;
    this.voice.cancel();
    await this.voice.idle(1500); // never open the mic while the speakers are talking
    if (session !== this.session) return;
    tone('start');
    this.set('listening');
    await sleep(150);
    if (session !== this.session) return;
    const heard = await this.listener.listen({
      onInterim: (text) => { if (session === this.session) this.onState('listening', text); },
    });
    if (session !== this.session) return;
    if (heard.error) {
      tone(heard.error === 'no-speech' || heard.error === 'aborted' ? 'stop' : 'error');
      return this.set('idle', heard.error);
    }
    tone('stop');
    return this.respond(heard.alternatives, { spoken: true, session });
  }

  /** A typed (or tapped) question. Answers are still spoken, but no follow-up listening. */
  ask(text) {
    const session = ++this.session;
    this.listener.abort();
    return this.respond([text], { spoken: false, session });
  }

  async respond(alternatives, { spoken, session }) {
    this.set('thinking');
    const result = this.answer(alternatives, this.getScene(), this.ctx);
    this.ctx = result.ctx;
    this.onTurn(result);
    if (result.action) this.onAction(result.action);
    if (this.speakAnswers && result.text) {
      this.set('speaking');
      await this.voice.say(result.text);
      if (session !== this.session) return;
    }
    if (spoken && this.followUp && !result.action?.end) return this.listen();
    this.set('idle', result.action?.end ? 'ended' : '');
  }
}
