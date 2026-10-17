import test from 'node:test';
import assert from 'node:assert/strict';
import { DEG } from '../js/geometry.js';
import { REASONS } from '../js/scene.js';
import { answer, answerBest, normalize, plural, sayDistance } from '../js/assistant.js';

// A small room: someone straight ahead, two chairs, a table, and a cup only one camera sees.
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
];
const scene = { objects, pins: [], units: 'm', status: 'ok', paused: false, hfovDeg: 70 };

/** Runs a conversation, returning each answer's text. */
function chat(lines, s = scene) {
  let ctx = {};
  return lines.map((q) => {
    const r = answer(q, s, ctx);
    ctx = r.ctx;
    return r;
  });
}

test('normalize handles contractions, clock times and spoken numbers', () => {
  assert.equal(normalize("What's at 2:00?"), 'what is at 2 oclock');
  assert.equal(normalize("Hey, what's at two o'clock please"), 'what is at 2 oclock');
  assert.equal(normalize('anything within a meter'), 'anything within 1 meter');
  assert.equal(normalize('how far is point two'), 'how far is point 2');
  assert.equal(normalize("What's to o'clock"), 'what is 2 oclock');
});

test('words and distances read naturally', () => {
  assert.equal(plural('person'), 'people');
  assert.equal(plural('box'), 'boxes');
  assert.equal(plural('wine glass'), 'wine glasses');
  assert.equal(sayDistance(2.13), '2.1 meters');
  assert.equal(sayDistance(1.0), '1 meter');
  assert.equal(sayDistance(0.42), '40 centimeters');
  assert.equal(sayDistance(2.13, 'ft'), '7 feet');
  assert.equal(sayDistance(0.2, 'ft'), '8 inches');
});

test('"what is in front of me" lists everything, nearest first, with distances', () => {
  const [r] = chat(["What's in front of me?"]);
  assert.equal(r.intent, 'describe');
  assert.match(r.text, /^I see 5 things: a person, 2 chairs, a table and a cup\./);
  assert.match(r.text, /Nearest first: A person, 1\.5 meters, at 12 o'clock\. A chair, 2\.1 meters, at 11 o'clock\. A chair, 3\.4 meters, at 1 o'clock\. A table, 4\.2 meters, at 12 o'clock\./);
  assert.match(r.text, /One more farther away/);
  assert.equal(r.focus, 1);
});

test('"what else" continues the list, then says that is all', () => {
  const [, more, done] = chat(['what do you see', 'what else', 'anything else']);
  assert.equal(more.intent, 'more');
  assert.equal(more.text, "Also a cup, distance unknown, at 1 o'clock.");
  assert.equal(done.text, "That's everything I can see.");
});

test('asking about a class with two instances, then following up', () => {
  const [a, b, c] = chat(['how far is the chair', 'how far is it', 'what about the other one']);
  assert.match(a.text, /^I see 2 chairs\. The nearest is about 2\.1 meters away at 11 o'clock\. The other is about 3\.4 meters away at 1 o'clock\.$/);
  assert.match(b.text, /^The chair is about 2\.1 meters away at 11 o'clock, about 1 meter to your left\.$/);
  assert.match(c.text, /^The chair is about 3\.4 meters away at 1 o'clock, about 1\.4 meters to your right\.$/);
  assert.equal(c.focus, 3);
});

test('qualifiers pick the right instance', () => {
  assert.match(answer('where is the chair on my right', scene).text, /3\.4 meters/);
  assert.match(answer('how far is the closest chair', scene).text, /2\.1 meters/);
  assert.match(answer('where is the left chair', scene).text, /2\.1 meters/);
  assert.match(answer('is there a chair straight ahead', scene).text, /^No\. There's no chair straight ahead\. I see 2 chairs/);
});

test('objects without a distance say why', () => {
  assert.equal(answer('where is the mug', scene).text, "The cup is at 1 o'clock, but I can't tell how far, because only one camera can see it.");
});

test('missing objects say so and list what is visible', () => {
  const r = answer('is there a dog?', scene);
  assert.equal(r.intent, 'exists');
  assert.equal(r.text, "No. I don't see a dog right now. I can see a person, 2 chairs, a table and a cup.");
  assert.match(answer('do you see anyone', scene).text, /^Yes\. The person is about 1\.5 meters away at 12 o'clock, straight ahead of you\.$/);
});

test('distance between two objects, and between two of the same kind', () => {
  const a = answer('how far is the chair from the table', scene);
  assert.equal(a.intent, 'between');
  // nearest chair (2.1 m @ -28°) to table (4.2 m @ 5°)
  assert.match(a.text, /^The chair and the table are about 2\.7 meters apart\.$/);
  assert.match(answer('how far apart are the chairs', scene).text, /^The chairs are about 2\.7 meters apart\.$/);
  assert.match(answer('how far is the cup from the person', scene).text, /can't tell how far the cup is/);
  assert.match(answer('how far is the chair from me', scene).text, /^I see 2 chairs/);
});

test('which is closer', () => {
  assert.equal(answer('which is closer, the table or the person', scene).text, 'The person is closer: about 1.5 meters, versus 4.2 meters for the table.');
  assert.match(answer('is the table farther than the chair', scene).text, /^The table is farther/);
});

test('directions: sides and clock hours', () => {
  assert.equal(answer("what's on my left", scene).text, "On your left: a chair, 2.1 meters, at 11 o'clock.");
  assert.match(answer('what is on the right side', scene).text, /^On your right: a chair, 3\.4 meters, at 1 o'clock and a cup, distance unknown, at 1 o'clock\.$/);
  assert.match(answer('what is straight ahead', scene).text, /^Straight ahead: a person, 1\.5 meters/);
  assert.match(answer("what's at 1:00", scene).text, /^At 1 o'clock: a chair/);
  assert.equal(answer("anything at 3 o'clock", scene).text, "I don't see anything at 3 o'clock. The cameras only see from about 11 to 1 o'clock.");
});

test('closest, farthest, counting and nearby', () => {
  assert.match(answer('what is closest to me', scene).text, /^The closest is a person, about 1\.5 meters away/);
  assert.match(answer("what's the furthest thing", scene).text, /^The farthest I can measure is a table, about 4\.2 meters/);
  assert.match(answer('how many chairs are there', scene).text, /^I see 2 chairs\. The nearest is about 2\.1 meters/);
  assert.equal(answer('how many dogs', scene).text, "I don't see any dogs.");
  assert.match(answer('anything within 2 meters?', scene).text, /^One thing is within 2 meters: a person, 1\.5 meters, at 12 o'clock\.$/);
  assert.match(answer('is anything near me', scene).text, /^One thing is within 1\.5 meters/);
  assert.match(answer('anything within 1 meter', scene).text, /^Nothing I can see is within 1 meter\. The closest is a person/);
});

test('path check names the obstacle and hedges', () => {
  assert.match(answer('is the path clear', scene).text, /^A person is in your path, about 1\.5 meters ahead\./);
  const clear = { ...scene, objects: objects.filter((o) => o.id !== 1 && o.id !== 4) };
  assert.match(answer('can I walk forward', clear).text, /^I don't see anything in your path for the next 3 meters\. .*don't rely on me alone\.$/);
});

test('units, updates, repeat, help and goodbye', () => {
  const [q, u] = chat(['where is the person', 'use feet']);
  assert.equal(u.action.units, 'ft');
  assert.equal(u.text, "OK, I'll use feet. The person is about 5 feet away at 12 o'clock, straight ahead of you.");
  const inFeet = answer('how far is the table in feet', scene);
  assert.equal(inFeet.action.units, 'ft');
  assert.match(inFeet.text, /14 feet/);
  assert.deepEqual(answer('start updates', scene).action, { updates: true });
  assert.deepEqual(answer('stop the announcements', scene).action, { updates: false });
  const [, again] = chat(['how many people', 'say that again']);
  assert.equal(again.text, chat(['how many people'])[0].text);
  assert.equal(answer('help', scene).intent, 'help');
  assert.deepEqual(answer('thank you', scene).action, { end: true });
  assert.equal(answer('thanks', scene).text, "You're welcome.");
  assert.deepEqual(answer('stop', scene).action, { end: true });
  assert.ok(q.text);
});

test('the camera state is explained instead of guessing', () => {
  assert.match(answer("what's in front of me", { ...scene, status: 'no-video' }).text, /cameras aren't running/);
  assert.match(answer("what's in front of me", { ...scene, status: 'loading' }).text, /still loading/);
  assert.match(answer('what do you see', { ...scene, objects: [] }).text, /I don't see anything I recognize/);
  assert.match(answer('what do you see', { ...scene, paused: true }).text, /^The view is paused/);
});

test('named demo objects and clicked points can be referred to', () => {
  const demo = { ...scene, objects: [obj(7, 'box', 1.7, -15, { name: 'box A' }), obj(8, 'box', 2.5, 11, { name: 'box B' })], pins: [{ id: 1, range: 6.1, azimuth: 30, point: [3.05, 0, 5.3], ground: { x: 3.05, z: 5.3 } }] };
  assert.match(answer('how far is box B', demo).text, /^Box B is about 2\.5 meters away/);
  assert.match(answer('how far apart are box A and box B', demo).text, /^Box A and box B are about 1\.2 meters apart\.$/);
  assert.match(answer('how far is point 1', demo).text, /^Point 1 is about 6\.1 meters away at 1 o'clock/);
  assert.match(answer('how far is point three', demo).text, /no point 3/);
});

test('unclear speech falls back to the next recognition guess', () => {
  const r = answerBest(['what a sin front of me', "what's in front of me"], scene);
  assert.equal(r.intent, 'describe');
  assert.equal(answer('purple monkey dishwasher', scene).intent, 'unknown');
});

test('"calibrate" hands over to the person calibration', () => {
  assert.deepEqual(answer('calibrate', scene).action, { calibrate: 'capture', range: null, end: true });
  assert.equal(answer('calibrate', scene).text, '');
  assert.deepEqual(answer('calibrate at 3 meters', scene).action, { calibrate: 'capture', range: 3, end: true });
  assert.ok(Math.abs(answer("let's recalibrate at 10 feet", scene).action.range - 3.048) < 1e-9);
  assert.deepEqual(answer('undo the calibration', scene).action, { calibrate: 'undo', end: true });
  // Works before the cameras are up too: the page explains what's missing.
  assert.equal(answer('calibrate', { ...scene, status: 'no-video' }).intent, 'calibrate');
});

