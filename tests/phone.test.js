import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { RetellClient, normalizePhone } from '../server/retell.js';
import { PhoneSession, pairingDigits, latestQuestion } from '../server/phone-session.js';
import { createApp, configuration } from '../server/index.js';
import { Talk } from '../js/talk.js';
import { Voice } from '../js/speech.js';

const env = { PHOTON_PHONE_NUMBER: '+16175550100', RETELL_API_KEY: 'test-key', RETELL_AGENT_ID: 'agent_test', PHONE_BRIDGE_SECRET: 'a'.repeat(64) };
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(fn(), 'condition should become true'); }
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
}
function fixture(options = {}) {
  const messages = [], stopped = [], calls = new Map();
  const api = new RetellClient({ apiKey: 'test', agentId: env.RETELL_AGENT_ID, number: env.PHOTON_PHONE_NUMBER });
  api.createCall = async (to, sessionId) => {
    const call = { call_id: 'call_outbound', call_type: 'phone_call', call_status: 'ongoing', direction: 'outbound', agent_id: env.RETELL_AGENT_ID, from_number: env.PHOTON_PHONE_NUMBER, to_number: to, metadata: { stereo_session: sessionId } };
    calls.set(call.call_id, call); return call;
  };
  api.getCall = async id => { if (!calls.has(id)) throw new Error('not found'); return calls.get(id); };
  api.stopCall = async id => { stopped.push(id); };
  const session = new PhoneSession({ api, send: m => messages.push(m), ...options });
  const incoming = { call_id: 'call_inbound', call_type: 'phone_call', call_status: 'ongoing', direction: 'inbound', agent_id: env.RETELL_AGENT_ID, to_number: env.PHOTON_PHONE_NUMBER, from_number: '+16175550123' };
  calls.set(incoming.call_id, incoming);
  return { session, api, incoming, calls, messages, stopped };
}
const response = (id, content) => ({ interaction_type: 'response_required', response_id: id, transcript: [{ role: 'user', content }] });

test('phone normalization rejects local, invalid, and non-string input', () => {
  assert.equal(normalizePhone('+1 (617) 555-0123'), '+16175550123');
  for (const v of ['6175550123', '+0123456789', '+1;echo hi', '+123', null, {}, '+1234567890123456']) assert.throws(() => normalizePhone(v));
});
test('spoken pairing digits and complete latest utterance are parsed', () => {
  assert.equal(pairingDigits('The code is one, two, three, four, five, six.'), '123456');
  assert.equal(pairingDigits('123 456'), '123456');
  assert.equal(latestQuestion([{ role: 'user', content: 'old' }, { role: 'agent', content: 'answer' }, { role: 'user', content: 'How far' }, { role: 'user', content: 'is the chair?' }]), 'How far is the chair?');
});
test('incoming caller cannot access measurements until the page code matches', async t => {
  const f = fixture(); t.after(() => f.session.end()); await f.session.start(); const ws = new Socket();
  assert.equal(f.session.attach(ws, f.incoming), true);
  f.session.handle(response(1, 'what is in front of me'));
  assert.equal(f.messages.some(m => m.type === 'transcript'), false); assert.match(ws.sent.at(-1).content, /did not match/);
  f.session.handle(response(2, f.session.code));
  assert.equal(f.session.paired, true); assert.equal(f.messages.at(-1).state, 'connected');
  f.session.handle(response(3, 'How far is the chair?'));
  assert.deepEqual(f.messages.at(-1), { type: 'transcript', text: 'How far is the chair?', responseId: 3 });
});
test('three wrong pairing attempts end the call without leaking the scene', async t => {
  const f = fixture(); t.after(() => f.session.end()); await f.session.start(); const ws = new Socket(); f.session.attach(ws, f.incoming);
  for (let id = 1; id <= 3; id++) f.session.handle(response(id, '000000'));
  assert.equal(ws.sent.at(-1).end_call, true); assert.equal(f.messages.some(m => m.type === 'transcript'), false);
});
test('outbound call is bound to the requesting browser, agent and Photon SMS number', async t => {
  const f = fixture(); t.after(() => f.session.end()); await f.session.start('+16175550123');
  const call = f.calls.get('call_outbound');
  for (const bad of [{ ...call, agent_id: 'another_agent' }, { ...call, from_number: '+16175550000' }, { ...call, metadata: { stereo_session: 'other-tab' } }, { ...call, call_status: 'ended' }]) assert.equal(f.session.accepts(bad), false);
  assert.equal(f.session.attach(new Socket(), call), true); assert.equal(f.session.paired, true);
});
test('duplicate response requests do not execute app actions twice; stale answers are ignored', async t => {
  const f = fixture(); t.after(() => f.session.end()); await f.session.start('+16175550123'); const ws = new Socket(); f.session.attach(ws, f.calls.get('call_outbound'));
  f.session.handle(response(1, 'calibrate')); f.session.answer({ responseId: 1, text: 'Calibrating.' });
  f.session.handle(response(1, 'calibrate')); f.session.handle(response(2, 'calibrate'));
  assert.equal(f.messages.filter(m => m.type === 'transcript').length, 1);
  assert.equal(ws.sent.at(-1).response_id, 2); assert.equal(ws.sent.at(-1).content, 'Calibrating.');
  f.session.handle(response(3, 'use feet')); const count = ws.sent.length;
  f.session.answer({ responseId: 1, text: 'stale' }); assert.equal(ws.sent.length, count);
  f.session.answer({ responseId: 3, text: 'Using feet.' }); assert.equal(ws.sent.at(-1).content, 'Using feet.');
});
test('silence reminders and ping messages do not re-run the last question', async t => {
  const f = fixture(); t.after(() => f.session.end()); await f.session.start('+16175550123'); const ws = new Socket(); f.session.attach(ws, f.calls.get('call_outbound'));
  f.session.handle({ interaction_type: 'reminder_required', response_id: 1, transcript: [{ role: 'user', content: 'calibrate' }] });
  assert.equal(f.messages.some(m => m.type === 'transcript'), false);
  f.session.handle({ interaction_type: 'ping_pong', timestamp: 123 });
  assert.deepEqual(ws.sent.at(-1), { response_type: 'ping_pong', timestamp: 123 });
});
test('an unresponsive browser gets an explicit unavailable response and end-call flag', async t => {
  const f = fixture({ answerTimeoutMs: 10 }); t.after(() => f.session.end()); await f.session.start('+16175550123'); const ws = new Socket(); f.session.attach(ws, f.calls.get('call_outbound'));
  f.session.handle(response(1, 'what do you see')); await until(() => ws.sent.at(-1).end_call === true);
  assert.match(ws.sent.at(-1).content, /not responding/);
});
test('cancel during Dial stops a late call result and retains the lock until cleanup', async () => {
  let release, closed = 0; const f = fixture({ onClosed: () => closed++ });
  f.api.createCall = () => new Promise(r => { release = r; });
  const starting = f.session.start('+16175550123'); await f.session.end(); assert.equal(closed, 0);
  release({ call_id: 'late-call' }); await starting;
  assert.deepEqual(f.stopped, ['late-call']); assert.equal(closed, 1);
});
test('call setup can arrive before Dial returns without reverting connected status', async t => {
  const f = fixture(); t.after(() => f.session.end()); let release;
  f.api.createCall = () => new Promise(r => { release = r; });
  const starting = f.session.start('+16175550123');
  const call = { ...f.incoming, direction: 'outbound', from_number: env.PHOTON_PHONE_NUMBER, to_number: '+16175550123', metadata: { stereo_session: f.session.id } };
  f.session.attach(new Socket(), call); release(call); await starting;
  assert.equal(f.messages.at(-1).state, 'connected'); assert.equal(f.session.pollTimer, undefined);
});
test('phone navigation announcements use agent_interrupt and caller turn resolves playback', async t => {
  const f = fixture(); t.after(() => f.session.end()); await f.session.start('+16175550123'); const ws = new Socket(); f.session.attach(ws, f.calls.get('call_outbound'));
  f.session.speak({ id: 'nav', text: 'Turn left.' }); assert.equal(ws.sent.at(-1).response_type, 'agent_interrupt');
  f.session.handle({ interaction_type: 'update_only', turntaking: 'user_turn' });
  assert.ok(f.messages.some(m => m.type === 'spoken' && m.id === 'nav')); assert.equal(f.messages.at(-1).type, 'interrupt');
});
test('goodbye ends after the answer is spoken; provider hangup releases resources', async () => {
  let closed = 0; const f = fixture({ onClosed: () => closed++ }); await f.session.start('+16175550123'); const ws = new Socket(); f.session.attach(ws, f.calls.get('call_outbound'));
  f.session.handle(response(1, 'goodbye')); f.session.answer({ responseId: 1, text: 'Goodbye.', end: true });
  assert.equal(ws.sent.at(-1).end_call, true); ws.close(); await tick(); assert.equal(closed, 1); assert.deepEqual(f.stopped, []);
});
test('Retell API requests use the Photon number, session metadata, and documented stop endpoint', async () => {
  const requests = [];
  const api = new RetellClient({ apiKey: 'test', agentId: 'agent', number: '+16175550100', fetchImpl: async (url, opts) => { requests.push({ url, ...opts }); return { ok: true, status: 204 }; } });
  await api.createCall('+16175550123', 'session'); await api.stopCall('call_id');
  assert.deepEqual(JSON.parse(requests[0].body), { from_number: '+16175550100', to_number: '+16175550123', override_agent_id: 'agent', metadata: { stereo_session: 'session' } });
  assert.equal(requests[1].url, 'https://api.retellai.com/v2/stop-call/call_id');
});
test('phone mode never starts browser recognition and answers use fresh measurements', () => {
  let mic = 0, localSpeech = 0; const object = { id: 1, cls: 'chair', range: 2, bearing: 0, P: [0, 0, 2], seenBy: 'both' };
  const talk = new Talk({ voice: { cancel() {}, say() { localSpeech++; } }, getScene: () => ({ objects: [object], pins: [], units: 'm', status: 'ok', hfovDeg: 70 }), onTurn() {}, onAction() {}, onState() {} });
  talk.listener = { supported: true, abort() {}, listen() { mic++; } }; talk.phoneActive = true;
  talk.toggle(); talk.listen(); const first = talk.answerPhone('how far is the chair');
  object.range = 3; object.P = [0, 0, 3]; const second = talk.answerPhone('how far is it');
  assert.equal(mic, 0); assert.equal(localSpeech, 0); assert.match(first.text, /2 meters/); assert.match(second.text, /3 meters/);
  assert.equal(talk.answerPhone('goodbye').action.end, true);
});
test('shared Voice routes calibration and guidance to phone without browser audio', async () => {
  const texts = [], voice = new Voice(); voice.output = { supported: true, speaking: false, say: async text => texts.push(text), cancel() {} };
  await voice.say('Turn left.'); assert.deepEqual(texts, ['Turn left.']);
});
async function startApp(t, api, customEnv = env) {
  const app = createApp({ env: customEnv, api }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}
async function openBrowser(base) {
  const { token } = await (await fetch(base + '/api/phone/config')).json();
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/phone', { origin: base }), messages = [];
  ws.on('message', data => messages.push(JSON.parse(data))); await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', token })); await until(() => messages.some(m => m.type === 'ready'));
  return { ws, messages, send: m => ws.send(JSON.stringify(m)) };
}
test('server does not expose secrets, configuration or call controls through a public tunnel', async t => {
  const { base } = await startApp(t, fixture().api, {});
  assert.equal((await fetch(base)).status, 200);
  for (const name of ['/.env', '/.git/config', '/server/index.js', '/node_modules/ws/package.json']) assert.equal((await fetch(base + name)).status, 404);
  const config = await (await fetch(base + '/api/phone/config')).json(); assert.equal(config.enabled, false); assert.equal(config.missing.length, 4);
  assert.equal((await fetch(base, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/api/phone/config', { headers: { 'X-Forwarded-For': '203.0.113.1' } })).status, 403);
  assert.equal(configuration({ ...env, PHONE_BRIDGE_SECRET: 'short' }).enabled, false);
});
test('WebSocket bridge rejects unauthenticated browsers and incorrect provider secrets', async t => {
  const { base } = await startApp(t, fixture().api);
  const browser = new WebSocket(base.replace('http', 'ws') + '/api/phone', { origin: base }); await once(browser, 'open');
  browser.send(JSON.stringify({ type: 'listen' })); const [code] = await once(browser, 'close'); assert.equal(code, 1008);
  const provider = new WebSocket(base.replace('http', 'ws') + '/api/retell/llm/wrong/call_inbound');
  const error = await new Promise(r => provider.once('error', r)); assert.match(error.message, /403/);
});
test('real browser/provider WebSockets pair inbound calls, relay exact answers, and stop on disconnect', async t => {
  const f = fixture(), { base } = await startApp(t, f.api), browser = await openBrowser(base);
  browser.send({ type: 'listen' }); await until(() => browser.messages.some(m => m.state === 'waiting'));
  const code = browser.messages.find(m => m.state === 'waiting').code;
  const provider = new WebSocket(base.replace('http', 'ws') + `/api/retell/llm/${env.PHONE_BRIDGE_SECRET}/call_inbound`), replies = [];
  provider.on('message', d => replies.push(JSON.parse(d))); await once(provider, 'open'); await until(() => replies.length > 0);
  provider.send(JSON.stringify(response(1, 'what do you see'))); await until(() => replies.some(m => m.response_id === 1));
  assert.equal(browser.messages.some(m => m.type === 'transcript'), false);
  provider.send(JSON.stringify(response(2, code))); await until(() => browser.messages.some(m => m.state === 'connected'));
  provider.send(JSON.stringify(response(3, 'how far is the chair'))); await until(() => browser.messages.some(m => m.type === 'transcript'));
  browser.send({ type: 'answer', responseId: 3, text: 'The chair is about 2 meters away.' });
  await until(() => replies.some(m => m.response_id === 3)); assert.equal(replies.at(-1).content, 'The chair is about 2 meters away.');
  browser.ws.close(); await until(() => f.stopped.length === 1); assert.deepEqual(f.stopped, ['call_inbound']); provider.close();
});
test('one camera page owns phone mode; another page cannot take its call', async t => {
  const f = fixture(), { base } = await startApp(t, f.api), a = await openBrowser(base), b = await openBrowser(base);
  a.send({ type: 'listen' }); await until(() => a.messages.some(m => m.state === 'waiting'));
  b.send({ type: 'listen' }); await until(() => b.messages.some(m => m.type === 'error'));
  assert.match(b.messages.at(-1).message, /Another camera page/); a.ws.close(); b.ws.close();
});
