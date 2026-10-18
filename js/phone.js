// One browser tab owns one phone call. Camera data stays here; only text crosses the bridge.
export class PhoneConnection {
  constructor({ onStatus = () => {}, onText = () => {}, onInterrupt = () => {} } = {}) {
    Object.assign(this, { onStatus, onText, onInterrupt });
    this.pending = new Map();
    this.state = 'idle';
  }
  get supported() { return this.state === 'connected'; }
  get speaking() { return !!this.remoteSpeaking || this.pending.size > 0; }
  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(message)); return true; }
    return false;
  }
  status(state, message = '', code) { this.state = state; this.onStatus(state, message, code); }
  async dial(number, token) {
    if (this.ws) return;
    this.status('connecting');
    const ws = this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/phone`);
    const timer = setTimeout(() => { if (this.ws === ws && this.state === 'connecting') this.disconnect('Could not connect to the phone server.'); }, 20000);
    ws.onopen = () => this.send({ type: 'auth', token });
    ws.onmessage = ({ data }) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'ready') { clearTimeout(timer); this.send(number ? { type: 'dial', number } : { type: 'listen' }); }
      if (msg.type === 'status') {
        if (msg.state === 'ended') this.disconnect(this.error || msg.message || 'Call ended.');
        else this.status(msg.state, msg.message, msg.code);
      }
      if (msg.type === 'transcript' && this.supported) {
        try {
          const result = this.onText(msg.text);
          this.send({ type: 'answer', responseId: msg.responseId, text: result.text, end: !!result.action?.end });
        } catch { this.hangup('Could not answer from the camera page. Please reconnect.'); }
      }
      if (msg.type === 'turn') this.remoteSpeaking = !!msg.speaking;
      if (msg.type === 'interrupt') { this.finishAll(); this.onInterrupt(); }
      if (msg.type === 'spoken') this.finish(msg.id);
      if (msg.type === 'error') { this.error = msg.message; this.disconnect(msg.message); }
    };
    ws.onerror = () => this.disconnect('Could not connect to the phone server.');
    ws.onclose = () => { clearTimeout(timer); if (this.ws === ws) this.disconnect(this.error || 'Phone connection closed.'); };
  }
  say(text, { interrupt = true } = {}) {
    if (!this.supported || !text) return Promise.resolve();
    if (interrupt) this.cancel();
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.hangup('Phone speech timed out. Please reconnect.'); }, 125000);
      this.pending.set(id, { resolve, timer });
      if (!this.send({ type: 'speak', id, text, interrupt })) this.hangup('Phone connection closed.');
    });
  }
  finish(id) {
    const item = this.pending.get(id);
    if (item) { clearTimeout(item.timer); this.pending.delete(id); item.resolve(); }
  }
  finishAll() { for (const id of this.pending.keys()) this.finish(id); }
  cancel() { this.send({ type: 'interrupt' }); this.finishAll(); }
  hangup(message = 'Ending the call…') {
    if (!this.ws || this.state === 'ending') return;
    this.send({ type: 'hangup' });
    this.status('ending', message);
    this.endTimer = setTimeout(() => this.disconnect('Connection closed. End the call on your phone if it is still connected.'), 15000);
  }
  disconnect(message = 'Call ended.') {
    clearTimeout(this.endTimer);
    const ws = this.ws;
    this.send({ type: 'hangup' }); this.ws = null;
    ws?.close(); this.finishAll(); this.remoteSpeaking = false; this.error = '';
    this.status('idle', message);
  }
}

export function mountPhone({ talk, voice }) {
  const panel = document.getElementById('phonePanel');
  if (!panel) return;
  const form = document.getElementById('phoneForm');
  const button = document.getElementById('btnCall');
  const hangup = document.getElementById('btnHangup');
  const incoming = document.getElementById('btnIncoming');
  const agentNumber = document.getElementById('agentNumber');
  const codeLabel = document.getElementById('phoneCode');
  const status = document.getElementById('phoneStatus');
  const number = document.getElementById('phoneNumber');
  let config = null, previousSpeak;
  const labels = {
    connecting: 'Connecting to Photon…', ringing: 'Your phone is ringing. Answer to start talking.',
    waiting: 'Call the agent number below, then read the pairing code to connect this camera page.',
    pairing: 'Read the six digit pairing code to the agent on your phone.', connected: 'Connected. Speak into your phone; answers play there too.',
  };
  const phone = new PhoneConnection({
    onText: (text) => talk.answerPhone(text),
    onInterrupt: () => { talk.session++; talk.set('idle'); },
    onStatus: (state, message, code) => {
      const active = state !== 'idle';
      // Abort any browser recognition before locking all mic entry points.
      if (active && !talk.phoneActive) {
        talk.end(); previousSpeak = talk.speakAnswers;
        talk.phoneActive = true; talk.speakAnswers = true;
        voice.output = phone;
      }
      if (!active && talk.phoneActive) {
        talk.end(); talk.phoneActive = false; voice.output = null;
        talk.speakAnswers = previousSpeak;
      }
      talk.set('idle');
      for (const id of ['inFollowUp', 'inSpeakAnswers', 'inSpeak']) {
        const el = document.getElementById(id); if (el) el.disabled = active;
      }
      button.disabled = incoming.disabled = active || !config?.enabled;
      codeLabel.hidden = !code; codeLabel.textContent = code ? `Pairing code: ${code.split('').join(' ')}` : '';
      number.disabled = active;
      hangup.hidden = !active;
      panel.dataset.state = state;
      status.textContent = message || labels[state] || 'Ready to call your phone.';
    },
  });
  talk.phone = phone;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!config?.enabled || phone.state !== 'idle') return;
    const value = number.value.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(value)) { status.textContent = 'Include + and the country code, for example +1 617 555 0123.'; number.focus(); return; }
    phone.dial(value, config.token);
  });
  incoming.addEventListener('click', () => { if (config?.enabled && phone.state === 'idle') phone.dial(null, config.token); });
  hangup.addEventListener('click', () => phone.hangup());
  window.addEventListener('pagehide', () => phone.disconnect());
  fetch('/api/phone/config').then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((value) => {
    config = value; button.disabled = incoming.disabled = !value.enabled;
    agentNumber.hidden = !value.number;
    if (value.number) { agentNumber.href = `tel:${value.number}`; agentNumber.textContent = `Agent number: ${value.number}`; }
    status.textContent = value.enabled ? 'Ready. Connect an incoming call, or enter your number for a callback.' : 'Phone calling needs setup. Connect a Photon 2.0 SMS number to Retell, then add the server settings described in the README.';
  }).catch(() => { status.textContent = 'Phone calling needs the Node server. Start the site with npm start.'; });
}
