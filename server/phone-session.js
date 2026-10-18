import { randomUUID, randomInt } from 'node:crypto';
import { normalizePhone } from './retell.js';

export function pairingDigits(text) {
  const words = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
  return text.toLowerCase().replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, w => words[w]).replace(/[^\d]/g, '');
}
export function latestQuestion(transcript) {
  if (!Array.isArray(transcript)) return '';
  const pieces = [];
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (item?.role !== 'user') { if (pieces.length) break; else continue; }
    if (typeof item.content === 'string') pieces.unshift(item.content);
  }
  return pieces.join(' ').trim().slice(0, 4000);
}

export class PhoneSession {
  constructor({ api, send, onClosed = () => {}, answerTimeoutMs = 8000 }) {
    Object.assign(this, { api, send, onClosed, answerTimeoutMs });
    this.id = randomUUID(); this.code = String(randomInt(100000, 1000000));
    this.latestId = -1; this.interruptId = 0; this.closed = false; this.attempts = 0;
  }
  async start(number) {
    this.mode = number ? 'outbound' : 'inbound';
    if (!number) {
      this.send({ type: 'status', state: 'waiting', code: this.code });
      this.waitTimer = setTimeout(() => this.end('No call received. Connect again when you are ready.'), 5 * 60 * 1000);
      return;
    }
    this.send({ type: 'status', state: 'connecting' });
    this.dialPending = true;
    try {
      const call = await this.api.createCall(normalizePhone(number), this.id);
      this.dialPending = false; this.callId = call.call_id;
      if (this.closed) { await this.stopCall(); this.onClosed(); return; }
      if (!this.provider) {
        this.send({ type: 'status', state: 'ringing' });
        this.waitTimer = setTimeout(() => this.end('The phone did not connect. Check the number and Photon SIP settings.'), 65000);
        this.pollTimer = setInterval(() => this.checkRinging(), 3000);
      }
    } catch {
      this.dialPending = false;
      if (this.closed) this.onClosed();
      else await this.end('Could not place the call. Check Retell and the Photon outbound SIP settings.');
    }
  }
  async checkRinging() {
    if (this.checking || this.closed || this.provider || !this.callId) return;
    this.checking = true;
    try {
      const call = await this.api.getCall(this.callId);
      if (['ended', 'error', 'not_connected'].includes(call.call_status)) await this.end('Call did not connect or was declined.', false);
    } catch { /* The overall connection timeout bounds transient status failures. */ }
    finally { this.checking = false; }
  }
  accepts(call) {
    if (this.closed || this.provider || !this.api.matches(call)) return false;
    if (this.mode === 'outbound') return call.direction === 'outbound' && call.metadata?.stereo_session === this.id;
    return call.direction === 'inbound';
  }
  attach(ws, call) {
    if (!this.accepts(call)) return false;
    this.provider = ws; this.callId = call.call_id; this.paired = this.mode === 'outbound';
    clearTimeout(this.waitTimer); clearInterval(this.pollTimer);
    this.durationTimer = setTimeout(() => this.end('Call reached the 20-minute limit. Connect again to continue.'), 20 * 60 * 1000);
    // An unpaired caller cannot hold the camera session indefinitely.
    if (!this.paired) this.pairTimer = setTimeout(() => this.end('Pairing timed out. Please connect again.'), 90000);
    ws.on('message', data => { let msg; try { msg = JSON.parse(data.toString()); } catch { ws.close(1008, 'Invalid message'); return; } this.handle(msg); });
    ws.on('error', () => this.end('Phone connection failed.'));
    ws.on('close', (code = 1000) => this.end(code === 1000 ? 'Call ended.' : 'Phone connection was interrupted.', code !== 1000));
    this.providerSend({ response_type: 'config', config: { auto_reconnect: false, call_details: true } });
    this.respond(0, this.paired
      ? 'You are connected to Stereo Distance. This is an AI voice. Ask what is in front of you, or ask about a distance.'
      : 'This is Stereo Distance, speaking with an AI voice. Read the six digit pairing code shown on your camera page, one digit at a time.');
    this.send({ type: 'status', state: this.paired ? 'connected' : 'pairing', code: this.paired ? undefined : this.code });
    return true;
  }
  providerSend(message) { if (this.provider?.readyState === 1) this.provider.send(JSON.stringify(message)); }
  respond(id, text, end = false) {
    this.providerSend({ response_type: 'response', response_id: id, content: text, content_complete: true, end_call: end });
  }
  handle(msg) {
    if (this.closed || !msg || typeof msg !== 'object') return;
    if (msg.interaction_type === 'ping_pong') { this.providerSend({ response_type: 'ping_pong', timestamp: msg.timestamp }); return; }
    if (msg.interaction_type === 'update_only') {
      if (['agent_turn', 'user_turn'].includes(msg.turntaking)) this.send({ type: 'turn', speaking: msg.turntaking === 'agent_turn' });
      if (msg.turntaking === 'user_turn') { this.finishSpeech(); this.send({ type: 'interrupt' }); }
      return;
    }
    if (!['response_required', 'reminder_required'].includes(msg.interaction_type) || !Number.isSafeInteger(msg.response_id) || msg.response_id < 0 || msg.response_id < this.latestId) return;
    const id = msg.response_id;
    if (id === this.latestId) { if (this.lastAnswer) this.respond(id, this.lastAnswer.text, this.lastAnswer.end); return; }
    this.latestId = id; clearTimeout(this.answerTimer); this.pendingId = null;
    if (msg.interaction_type === 'reminder_required') {
      this.lastAnswer = null;
      this.respond(id, this.paired ? 'I am here. Ask about an object or a distance, or say goodbye to end the call.' : 'Please read the six digit code shown on the camera page, one digit at a time.'); return;
    }
    const text = latestQuestion(msg.transcript);
    if (!this.paired) {
      if (pairingDigits(text) === this.code) {
        this.paired = true; clearTimeout(this.pairTimer);
        this.send({ type: 'status', state: 'connected' });
        this.respond(id, 'Connected to your camera page. What would you like to know?');
      } else { this.attempts++; this.respond(id, this.attempts >= 3 ? 'The code did not match. Please reconnect from the camera page and try again.' : 'That code did not match. Please read each of the six digits again.', this.attempts >= 3); }
      return;
    }
    const key = JSON.stringify(msg.transcript?.map(item => [item?.role, item?.content]));
    if (key === this.lastKey && this.lastAnswer) { this.respond(id, this.lastAnswer.text, this.lastAnswer.end); return; }
    this.lastKey = key; this.lastAnswer = null;
    if (!text) { this.respond(id, 'What would you like to know about the camera view?'); return; }
    this.pendingId = id;
    this.send({ type: 'transcript', text, responseId: id });
    this.answerTimer = setTimeout(() => {
      this.pendingId = null;
      this.respond(id, 'The camera page is not responding. Please reopen it and connect again.', true);
      this.send({ type: 'error', message: 'The camera page did not respond to the phone call.' });
    }, this.answerTimeoutMs);
  }
  answer({ responseId, text, end = false }) {
    if (this.closed || !this.paired || responseId !== this.pendingId || typeof text !== 'string' || text.length > 4000) return;
    clearTimeout(this.answerTimer); this.pendingId = null;
    this.lastAnswer = { text, end: end === true };
    this.respond(responseId, text, end === true);
  }
  speak({ id, text, interrupt = true }) {
    if (this.closed || !this.paired || !this.provider || typeof text !== 'string' || !text.trim() || text.length > 4000 || typeof id !== 'string' || id.length > 100) { this.send({ type: 'spoken', id }); return; }
    if (this.output && !interrupt) { this.send({ type: 'spoken', id }); return; }
    this.finishSpeech(); this.output = id;
    this.providerSend({ response_type: 'agent_interrupt', interrupt_id: ++this.interruptId, content: text, content_complete: true });
    // Retell turn-taking signals playback completion or caller barge-in. Bound missing signals.
    this.speechTimer = setTimeout(() => this.finishSpeech(), 2000 + text.length * 90);
  }
  finishSpeech() {
    clearTimeout(this.speechTimer);
    if (this.output) this.send({ type: 'spoken', id: this.output });
    this.output = null;
  }
  interrupt() {
    if (this.output) this.providerSend({ response_type: 'agent_interrupt', interrupt_id: ++this.interruptId, content: '', content_complete: true });
    this.finishSpeech();
  }
  async stopCall() {
    if (!this.callId) return true;
    try { await this.api.stopCall(this.callId); return true; }
    catch { this.send({ type: 'error', message: 'Could not confirm hangup. End the call on your phone.' }); return false; }
  }
  async end(message = 'Call ended.', stop = true) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.waitTimer); clearTimeout(this.pairTimer); clearTimeout(this.durationTimer); clearTimeout(this.answerTimer); clearInterval(this.pollTimer);
    this.finishSpeech();
    if (stop && this.callId) await this.stopCall();
    this.provider?.close();
    this.send({ type: 'status', state: 'ended', message });
    if (!this.dialPending) this.onClosed();
  }
}
