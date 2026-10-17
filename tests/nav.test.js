import test from 'node:test';
import assert from 'node:assert/strict';
import { GoalPlanner, costMap } from '../js/slam/plan.js';
import { Guide, maneuvers, turnCategory, turnPhrase, distanceToPath } from '../js/slam/guide.js';
import { parseNav, placesSentence, resolveDestination } from '../js/slam/navtalk.js';

// A 10 m × 8 m floor split by a wall at x = 5 with a 1 m door at z = 3…4. Everything seen.
function twoRooms() {
  const cell = 0.05, w = 200, h = 160, data = new Int8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = j * cell;
    if (z < 3 || z >= 4) for (let i = 99; i <= 101; i++) data[j * w + i] = 1;
    data[j * w] = data[j * w + w - 1] = 1;
  }
  for (let i = 0; i < w; i++) data[i] = data[(h - 1) * w + i] = 1;
  return { x0: 0, z0: 0, cell, w, h, data };
}

test('turn categories follow the breaks, with a 5° margin', () => {
  assert.equal(turnCategory(10), 'straight');
  assert.equal(turnCategory(30), 'slight');
  assert.equal(turnCategory(90), 'turn');
  assert.equal(turnCategory(140), 'sharp');
  assert.equal(turnCategory(175), 'uturn');
  assert.equal(turnCategory(23, 'straight'), 'straight', 'stays put inside the margin');
  assert.equal(turnCategory(26, 'straight'), 'slight');
  assert.equal(turnCategory(43, 'turn'), 'turn');
  assert.equal(turnPhrase(-90, 'turn'), 'turn left');
  assert.equal(turnPhrase(30, 'slight'), 'bear right');
});

test('the route goes through the door and keeps off the walls', () => {
  const g = twoRooms();
  const user = { x: 2, z: 1 };
  const p = new GoalPlanner(g, { x: 8, z: 1 }, user);
  const r = p.route(user);
  assert.ok(r.ok);
  const cross = r.path.findIndex((q, i) => i && (q[0] - 5) * (r.path[i - 1][0] - 5) <= 0);
  const [a, b] = [r.path[cross - 1], r.path[cross]];
  const z = a[1] + ((5 - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  assert.ok(z > 3.2 && z < 3.8, `through the door at z = ${z.toFixed(2)}`);
  assert.ok(r.path.length <= 5, `${r.path.length} waypoints`);
  // Moving along re-uses the same field: still a route, and shorter.
  const later = p.route({ x: 4, z: 3.5 });
  assert.ok(later.ok && later.length < r.length);
});

test('unseen space: blocked near you, allowed with a penalty further away', () => {
  const g = twoRooms();
  for (let j = 0; j < g.h; j++) for (let i = 120; i < 200; i++) if (g.data[j * g.w + i] !== 1) g.data[j * g.w + i] = -1;
  const far = costMap(g, { x: 1, z: 1 });
  const nearMe = costMap(g, { x: 6.5, z: 3.5 });
  const k = 70 * g.w + 140; // x = 7, z = 3.5
  assert.ok(Number.isFinite(far.cost[k]) && far.cost[k] > 1, 'unseen and far: passable, at a cost');
  assert.equal(nearMe.cost[k], Infinity, 'unseen and close: blocked');
});

test('a goal inside a wall is moved to the nearest usable spot; unreachable goals get the closest point', () => {
  const g = twoRooms();
  const p = new GoalPlanner(g, { x: 5, z: 1.5 }, { x: 2, z: 1 });
  assert.ok(p.snapped && Math.abs(p.snapped[0] - 5) > 0.25, 'snapped out of the wall');
  // Close the door: room B can't be reached.
  for (let j = 60; j < 80; j++) for (let i = 99; i <= 101; i++) g.data[j * g.w + i] = 1;
  const q = new GoalPlanner(g, { x: 8, z: 1 }, { x: 2, z: 1 });
  const r = q.route({ x: 2, z: 1 });
  assert.ok(r.ok && r.partial, 'guides to the closest reachable point');
  assert.ok(r.gap > 2.5, `still ${r.gap.toFixed(1)} m short`);
});

test('maneuvers along an L-shaped route', () => {
  const m = maneuvers([[0, 0], [0, 6], [-4, 6]]);
  assert.equal(m.length, 1);
  assert.equal(m[0].cat, 'turn');
  assert.ok(m[0].angle < 0, 'a left turn');
  assert.equal(m[0].along, 6);
  assert.ok(Math.abs(distanceToPath([1, 3], [[0, 0], [0, 6]]) - 1) < 1e-9);
});

/** Walks a route at 1 m/s, collecting what the guide says. */
function walkRoute(path, { heading = 0, start = 0 } = {}) {
  const guide = new Guide();
  guide.start({ x: path.at(-1)[0], z: path.at(-1)[1], label: 'the kitchen' }, start);
  const said = [];
  let t = start, h = heading;
  // Stand still, turning toward the route first if needed.
  const want = Math.atan2(path[1][0] - path[0][0], path[1][1] - path[0][1]);
  const pos = [...path[0]];
  let seg = 1;
  for (let k = 0; k < 400 && guide.active; k++) {
    const rest = [pos, ...path.slice(seg)];
    const length = rest.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - rest[i - 1][0], p[1] - rest[i - 1][1]) : 0), 0);
    const out = guide.update({ pose: { x: pos[0], z: pos[1], heading: h }, route: { ok: true, path: rest, length }, now: t });
    for (const s of out.say) said.push(s.text);
    t += 0.1;
    const err = Math.atan2(Math.sin(want - h), Math.cos(want - h));
    if (seg === 1 && Math.abs(err) > 0.05) { h += Math.sign(err) * Math.min(Math.abs(err), 0.06); continue; }
    // Walk 0.1 m toward the next waypoint, facing it.
    const tgt = path[seg];
    const d = Math.hypot(tgt[0] - pos[0], tgt[1] - pos[1]);
    h = Math.atan2(tgt[0] - pos[0], tgt[1] - pos[1]);
    if (d <= 0.1) { pos[0] = tgt[0]; pos[1] = tgt[1]; seg = Math.min(seg + 1, path.length - 1); }
    else { pos[0] += ((tgt[0] - pos[0]) / d) * 0.1; pos[1] += ((tgt[1] - pos[1]) / d) * 0.1; }
  }
  return said;
}

test('walking directions: intro, early warning, "now", arrival', () => {
  const said = walkRoute([[0, 0], [0, 8], [-4, 8]]);
  assert.equal(said[0], 'Route to the kitchen: 12 meters.');
  assert.ok(said.includes('In 5 meters, turn left.'), said.join(' | '));
  assert.ok(said.includes('Turn left now.'), said.join(' | '));
  assert.equal(said.at(-1), 'You have arrived at the kitchen.');
  assert.ok(said.indexOf('In 5 meters, turn left.') < said.indexOf('Turn left now.'));
});

test('facing the wrong way: turn first, then go straight', () => {
  const said = walkRoute([[0, 0], [0, 4]], { heading: Math.PI / 2 });
  assert.equal(said[0], "Route to the kitchen: 4 meters. Turn left, to 9 o'clock.");
  assert.equal(said[1], 'Go straight.');
  assert.equal(said.at(-1), 'You have arrived at the kitchen.');
  const around = walkRoute([[0, 0], [0, 4]], { heading: Math.PI });
  assert.equal(around[0], 'Route to the kitchen: 4 meters. Turn around.');
});

test('back-to-back turns are chained, and leaving the route re-routes', () => {
  const said = walkRoute([[0, 0], [0, 6], [2, 6], [2, 10]]);
  assert.ok(said.some((s) => /turn right now, then turn left/i.test(s)), said.join(' | '));
  const g = new Guide();
  g.start({ x: 0, z: 10 }, 0);
  const route = { ok: true, path: [[0, 0], [0, 10]], length: 10 };
  let out = [];
  for (let t = 0; t < 6; t += 0.1) {
    const r = g.update({ pose: { x: t < 1 ? 0 : 2, z: 1, heading: 0 }, route, now: t });
    out = out.concat(r.say.map((s) => s.text));
  }
  assert.ok(out.some((x) => x.startsWith('Re-routing.')), out.join(' | '));
  const lost = new Guide();
  lost.start({ x: 0, z: 10 }, 0);
  assert.equal(lost.update({ pose: { x: 0, z: 0, heading: 0 }, route, tracking: 'lost', now: 0 }).say[0].priority, 'warn');
});

test('spoken navigation commands', () => {
  assert.deepEqual(parseNav('Mark this spot as the kitchen'), { intent: 'mark', name: 'kitchen' });
  assert.deepEqual(parseNav('this is my office'), { intent: 'mark', name: 'office' });
  assert.deepEqual(parseNav('take me to the kitchen please'), { intent: 'go', name: 'kitchen' });
  assert.deepEqual(parseNav('how do I get to the couch'), { intent: 'go', name: 'couch' });
  assert.deepEqual(parseNav('take me back to the start'), { intent: 'back' });
  assert.deepEqual(parseNav('take me back'), { intent: 'back' });
  assert.deepEqual(parseNav('stop navigating'), { intent: 'stopNav' });
  assert.deepEqual(parseNav('stop', { navigating: true }), { intent: 'stopNav' });
  assert.equal(parseNav('stop'), null, 'plain "stop" ends the conversation when not navigating');
  assert.deepEqual(parseNav('where am I?'), { intent: 'whereAmI' });
  assert.deepEqual(parseNav('how much farther', { navigating: true }), { intent: 'remaining' });
  assert.equal(parseNav('how much farther'), null);
  assert.deepEqual(parseNav('what places do you know'), { intent: 'places' });
  assert.equal(parseNav("what's in front of me"), null, 'scene questions fall through');
});

test('destinations: saved places, the start, and remembered objects', () => {
  const map = { start: { x: 0, z: 0 }, places: [{ name: 'Kitchen', x: 4, z: 2 }, { name: 'front door', x: -3, z: 9 }], landmarks: [{ cls: 'couch', x: 6, z: 5 }, { cls: 'couch', x: 1, z: 1 }] };
  const here = { x: 0, z: 0 };
  assert.deepEqual(resolveDestination('the kitchen', map, here), { x: 4, z: 2, label: 'the kitchen', kind: 'place' });
  assert.equal(resolveDestination('door', map, here).label, 'the front door');
  assert.equal(resolveDestination('start', map, here).kind, 'start');
  assert.deepEqual(resolveDestination('the sofa', map, here), { x: 1, z: 1, label: 'the couch', kind: 'landmark' });
  assert.equal(resolveDestination('the toilet', map, here).missing, true);
  assert.equal(resolveDestination('narnia', map, here).missing, true);
  assert.match(placesSentence(map), /places: the kitchen; the front door\. And things I've seen: couch/);
});

test('no "can\'t find a way" before the planner has had a moment', () => {
  const g = new Guide();
  g.start({ x: 0, z: 5, label: 'the door' }, 10);
  assert.equal(g.update({ pose: { x: 0, z: 0, heading: 0 }, route: null, now: 10.1 }).say.length, 0);
  const route = { ok: true, path: [[0, 0], [0, 5]], length: 5 };
  assert.equal(g.update({ pose: { x: 0, z: 0, heading: 0 }, route, now: 10.5 }).say[0].text, 'Route to the door: 5 meters.');
  const h = new Guide();
  h.start({ x: 0, z: 5 }, 0);
  assert.match(h.update({ pose: { x: 0, z: 0, heading: 0 }, route: null, now: 2 }).say[0].text, /can't find a way/);
});

