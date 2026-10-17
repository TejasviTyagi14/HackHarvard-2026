// Spoken navigation commands for the map page: "mark this spot as the kitchen", "take me to the
// kitchen", "take me back to the start", "go to the couch", "where am I", "how much farther",
// "stop navigating". Anything else falls through to the scene assistant. Pure logic, no DOM.
import { classFromPhrase, normalize, sayDistance, spokenName } from '../assistant.js';

const START_WORDS = /^(the )?(start|starting point|beginning|origin|where i started|where we started|where i began)$/;

const RULES = [
  ['stopNav', /\b(stop|cancel|end|quit|abort)\b.*\b(navigat\w*|route|guid\w*|directions)\b/],
  ['pauseMap', /\b(pause|stop|freeze) (the )?(mapping|map)\b/],
  ['resumeMap', /\b(resume|start|continue|unpause) (the )?(mapping|map)\b/],
  ['mark', /^(?:mark|save|remember|call|name|label|tag) (?:this spot|this place|this room|this location|this point|this area|where i am|this|here)(?: as| is)? (.+)$/],
  ['mark', /^(?:this is|this spot is|this place is|this room is|here is|we are (?:in|at)|i am (?:in|at)) (.+)$/],
  ['back', /^(?:take me|bring me|guide me|lead me|go|head|walk me|navigate|get me) back$/],
  ['go', /^(?:take|guide|lead|bring|walk|get|show) me (?:back )?to (.+)$/],
  ['go', /^(?:navigate|go|head|route me|walk|directions) (?:back )?to (.+)$/],
  ['go', /^how (?:do|can|would) i (?:get|go) (?:back )?to (.+)$/],
  ['go', /^(?:find|show) (?:me )?the way to (.+)$/],
  ['whereAmI', /\bwhere am i\b|\bwhere are we\b/],
  ['remaining', /\b(how (much )?(farther|further)|how far (is it )?(still|to go|left|now|until|till)|how long (is it )?(still|to go|left)|are we there( yet)?|how much (longer|more))\b/],
  ['places', /\b(what|which) (places|spots|rooms|locations)\b|\blist (the |my )?places\b|\bwhere can (you|i) (take me|go)\b/],
  ['locate', /^where(?: is| are) (.+)$/],
];

const clean = (name) => name.replace(/^(the|a|an|my|our) /, '').replace(/ (please|now)$/, '').trim();

/** { intent, name? } for a navigation command, or null. */
export function parseNav(text, { navigating = false } = {}) {
  const t = normalize(text);
  if (navigating && /^(stop|cancel|stop it|cancel it|that is enough)$/.test(t)) return { intent: 'stopNav' };
  for (const [intent, re] of RULES) {
    const m = t.match(re);
    if (!m) continue;
    if (intent === 'remaining' && !navigating) continue;
    const name = ['mark', 'go', 'locate'].includes(intent) && m[1] ? clean(m[1]) : null;
    if (intent === 'go' && name && START_WORDS.test(name)) return { intent: 'back' };
    return name ? { intent, name } : { intent };
  }
  return null;
}

/**
 * Where a spoken destination is: a saved place, the start, or the nearest remembered object of
 * that kind. map: { places: [{ name, x, z }], landmarks: [{ cls, x, z }], start: { x, z } }.
 */
export function resolveDestination(name, map, here) {
  const n = clean(normalize(name));
  if (!n || START_WORDS.test(n)) return { ...map.start, label: 'the start', kind: 'start' };
  const places = map.places ?? [];
  const key = (s) => clean(normalize(s));
  const exact = places.find((p) => key(p.name) === n);
  const loose = exact ?? places.find((p) => key(p.name).includes(n) || n.includes(key(p.name)));
  if (loose) return { x: loose.x, z: loose.z, label: `the ${key(loose.name)}`, kind: 'place' };
  const cls = classFromPhrase(n);
  if (cls) {
    const of = (map.landmarks ?? []).filter((l) => l.cls === cls);
    if (!of.length) return { missing: true, cls, label: spokenName(cls) };
    const best = of.reduce((a, b) => (Math.hypot(a.x - here.x, a.z - here.z) <= Math.hypot(b.x - here.x, b.z - here.z) ? a : b));
    return { x: best.x, z: best.z, label: `the ${spokenName(cls)}`, kind: 'landmark' };
  }
  return { missing: true, label: n };
}

/** "the kitchen and the start", for listing places out loud. */
export function placesSentence(map, units = 'm', here = null) {
  const names = (map.places ?? []).map((p) => {
    const d = here ? `, ${sayDistance(Math.hypot(p.x - here.x, p.z - here.z), units)} away` : '';
    return `the ${clean(normalize(p.name))}${d}`;
  });
  const objs = [...new Set((map.landmarks ?? []).map((l) => spokenName(l.cls)))];
  const parts = [];
  if (names.length) parts.push(`places: ${names.join('; ')}`);
  if (objs.length) parts.push(`things I've seen: ${objs.join(', ')}`);
  return parts.length ? `I know ${parts.join('. And ')}. I can also take you back to the start.`
    : 'No places saved yet. Say "mark this spot as" and a name, like kitchen. I can always take you back to the start.';
}
