import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG } from '../js/geometry.js';
import { REASONS, speechSummary } from '../js/scene.js';
import { answer, sayDistance } from '../js/assistant.js';
import { DEFAULT_DETAIL, DETAIL_PRESETS, DetailController, applyDetailUpdate, normalizeDetail } from '../js/detail.js';

function obj(id, cls, range, azimuth, extra = {}) {
  const point = range == null ? null : [range * Math.sin(azimuth * DEG), 0, range * Math.cos(azimuth * DEG)];
  return { id, cls, range, azimuth, point, ground: point && { x: point[0], z: point[2] }, quality: range == null ? 'none' : 'stereo', reason: null, ...extra };
}
const objects = [
  obj(1, 'person', 1.5, 0),
  obj(2, 'chair', 2.1, -28),
  obj(3, 'chair', 3.4, 25),
  obj(4, 'dining table', 4.2, 5),
  obj(5, 'cup', null, 31, { reason: REASONS.solo }),
  obj(6, 'bottle', 4.8, -10),
];
const sceneWith = (detail) => ({ objects, pins: [], units: 'm', status: 'ok', paused: false, hfovDeg: 70, detail });
const say = (q, detail) => answer(q, sceneWith(detail)).text;

test('defaults are the answers the assistant always gave', () => {
  assert.equal(say("what's in front of me"), say("what's in front of me", DEFAULT_DETAIL));
  assert.match(say("what's in front of me"), /Nearest first: A person, 1\.5 meters, at 12 o'clock\. .*2 more farther away/);
});

test('maxItems and summary shape a scene description', () => {
  const brief = say("what's in front of me", { maxItems: 2, summary: false });
  assert.equal(brief, `A person, 1.5 meters, at 12 o'clock. A chair, 2.1 meters, at 11 o'clock. 4 more farther away. Say "what else" to hear them.`);
  const full = say("what's in front of me", { maxItems: 10 });
  assert.doesNotMatch(full, /what else/);
  assert.match(full, /cup, distance unknown/);
});

test('clock, lateral, reasons and caveats can each be turned off', () => {
  assert.doesNotMatch(say("what's in front of me", { clock: false }), /o'clock/);
  assert.match(say('how far is the person'), /straight ahead of you/);
  assert.doesNotMatch(say('how far is the person', { lateral: false }), /straight ahead of you/);
  assert.match(say('where is the cup'), /only one camera can see it/);
  assert.equal(say('where is the cup', { reasons: false }), "The cup is at 1 o'clock, distance unknown.");
  const clear = (detail) => answer('is the path clear', { ...sceneWith(detail), objects: objects.slice(1, 3) }).text;
  assert.match(clear(), /rely on me alone/);
  assert.doesNotMatch(clear({ caveats: false }), /rely on me alone/);
});

test('precision changes how distances are rounded', () => {
  assert.equal(sayDistance(2.14), '2.1 meters');
  assert.equal(sayDistance(2.14, 'm', 'fine'), '2.14 meters');
  assert.equal(sayDistance(0.437, 'm', 'fine'), '44 centimeters');
  assert.equal(sayDistance(2.14, 'm', 'coarse'), '2 meters');
  assert.equal(sayDistance(0.3, 'm', 'coarse'), 'half a meter');
  assert.equal(sayDistance(2.14, 'ft', 'fine'), '7 feet');
  assert.equal(sayDistance(2.0, 'ft', 'fine'), '6 feet 7 inches');
  assert.equal(sayDistance(2.14, 'ft', 'coarse'), '7 feet');
  assert.match(say('how far is the person', { precision: 'fine' }), /1\.5 meters/);
});

test('updateItems sets how many measured objects a spoken update names', () => {
  assert.equal(speechSummary(objects).items.filter((i) => i.range != null).length, 3);
  assert.equal(speechSummary(objects, 'm', 1).items.filter((i) => i.range != null).length, 1);
});

test('applyDetailUpdate applies valid values, clamps ranges and rejects the rest', () => {
  const r = applyDetailUpdate(DEFAULT_DETAIL, { set: { maxItems: 99, clock: false, precision: 'fine', bogus: 1, summary: 'yes' }, reply: 'OK.' });
  assert.equal(r.detail.maxItems, 10);
  assert.equal(r.detail.clock, false);
  assert.equal(r.detail.precision, 'fine');
  assert.equal(r.detail.summary, true);
  assert.deepEqual(r.changed.sort(), ['clock', 'maxItems', 'precision']);
  assert.deepEqual(r.rejected.map((x) => x.key).sort(), ['bogus', 'summary']);
  assert.equal(r.reply, 'OK.');
});

test('a preset applies first and set overrides it', () => {
  const r = applyDetailUpdate(DEFAULT_DETAIL, { preset: 'brief', set: { maxItems: 3 } });
  assert.deepEqual(r.detail, { ...DETAIL_PRESETS.brief, maxItems: 3 });
  assert.equal(applyDetailUpdate(DEFAULT_DETAIL, { preset: 'loud' }).rejected[0].key, 'preset');
});

test('garbage never changes anything', () => {
  for (const bad of [null, 'more', [1], { set: [1] }, { set: 'x' }]) {
    const r = applyDetailUpdate(DEFAULT_DETAIL, bad);
    assert.deepEqual(r.detail, DEFAULT_DETAIL);
    assert.deepEqual(r.changed, []);
  }
  assert.deepEqual(normalizeDetail({ maxItems: 'lots', clock: false }), { ...DEFAULT_DETAIL, clock: false });
});

/** A controller wired to an in-memory detail and a fake bridge. */
function rig(fetchImpl, start = DEFAULT_DETAIL) {
  const box = { detail: { ...start }, sets: 0 };
  const warnings = [];
  const ctl = new DetailController({
    getDetail: () => box.detail,
    setDetail: (d) => { box.detail = d; box.sets++; },
    fetchImpl, timeoutMs: 50, log: { warn: (...a) => warnings.push(a.join(' ')) },
  });
  return { ctl, box, warnings };
}
const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });

test('DetailController sends the request with the current values and schema', async () => {
  let sent;
  const { ctl, box } = rig(async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ update: { set: { maxItems: 6 }, reply: 'More detail.' } }) };
  });
  const r = await ctl.handleRequest('tell me more');
  assert.equal(sent.url, '/api/detail');
  assert.equal(sent.body.request, 'tell me more');
  assert.deepEqual(sent.body.current, DEFAULT_DETAIL);
  assert.ok(sent.body.schema.parameters.maxItems);
  assert.equal(r.ok, true);
  assert.equal(box.detail.maxItems, 6);
  assert.equal(r.reply, 'More detail.');
});

test('DetailController keeps the current values when anything goes wrong', async () => {
  const cases = [
    reply(502, { error: 'Droid took longer than 40 s' }),
    async () => { throw new TypeError('Failed to fetch'); },
    (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  ];
  for (const f of cases) {
    const { ctl, box, warnings } = rig(f);
    const r = await ctl.handleRequest('more detail');
    assert.equal(r.ok, false);
    assert.equal(box.sets, 0);
    assert.deepEqual(box.detail, DEFAULT_DETAIL);
    assert.equal(warnings.length, 1);
  }
  const { ctl, box } = rig(reply(200, { update: 'not an object' }));
  await ctl.handleRequest('more detail');
  assert.equal(box.sets, 0);
});

test('DetailController does not call setDetail when nothing changed', async () => {
  const { ctl, box } = rig(reply(200, { update: { preset: null, set: {}, reply: '' } }));
  const r = await ctl.handleRequest("what's the weather");
  assert.equal(r.ok, true);
  assert.equal(box.sets, 0);
});

test('requests about the amount of detail go to Droid; other questions do not', () => {
  for (const q of ['give me more detail', 'less detail please', 'keep it short', 'be more concise', 'just the basics',
    "stop saying the o'clock", 'you talk too much', 'can you be more detailed', 'too wordy', 'make your answers longer']) {
    const r = answer(q, sceneWith());
    assert.equal(r.intent, 'detail', q);
    assert.equal(r.action.end, true);
    assert.ok(r.action.detail, q);
  }
  for (const [q, intent] of [['tell me more', 'more'], ['what else', 'more'], ['is anything less than 2 meters', 'within'],
    ['how far is the chair', 'locate'], ["what's in front of me", 'describe'], ['is the path clear', 'path'], ['stop updates', 'updates']]) {
    assert.equal(answer(q, sceneWith()).intent, intent, q);
  }
});

test('on a phone call a detail request goes to Droid without ending the call', () => {
  const r = answer('give me more detail', { ...sceneWith(), phone: true });
  assert.equal(r.intent, 'detail');
  assert.equal(r.action.end, false);       // js/phone.js turns `end` into hanging up
  assert.ok(r.action.detail);
});
