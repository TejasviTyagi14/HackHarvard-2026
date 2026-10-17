// Answers spoken or typed questions about what the cameras see: "what's in front of me?",
// "how far is the chair?", "what's on my left?", "how far apart are the chair and the table?".
// Follow-ups ("how far is it?", "the other one?", "what else?") are resolved from the
// conversation so far, which the caller passes back in as `ctx`. Pure logic, no DOM.
import { clockHour, dist3 } from './geometry.js';
import { REASONS } from './scene.js';

// COCO-SSD's 80 classes plus the demo room's, with the words people actually say for them.
const CLASS_WORDS = {
  person: ['person', 'people', 'persons', 'someone', 'somebody', 'anyone', 'anybody', 'everyone', 'everybody', 'man', 'men', 'woman', 'women', 'guy', 'human', 'kid', 'child', 'children'],
  bicycle: ['bicycle', 'bike'], car: ['car'], motorcycle: ['motorcycle', 'motorbike'], airplane: ['airplane', 'plane'],
  bus: ['bus'], train: ['train'], truck: ['truck'], boat: ['boat'], 'traffic light': ['traffic light'],
  'fire hydrant': ['fire hydrant', 'hydrant'], 'stop sign': ['stop sign'], 'parking meter': ['parking meter'], bench: ['bench'],
  bird: ['bird'], cat: ['cat', 'kitty'], dog: ['dog', 'puppy'], horse: ['horse'], sheep: ['sheep'], cow: ['cow'],
  elephant: ['elephant'], bear: ['bear'], zebra: ['zebra'], giraffe: ['giraffe'],
  backpack: ['backpack', 'bag', 'rucksack'], umbrella: ['umbrella'], handbag: ['handbag', 'purse'], tie: ['tie'], suitcase: ['suitcase', 'luggage'],
  frisbee: ['frisbee'], skis: ['skis'], snowboard: ['snowboard'], 'sports ball': ['ball', 'sports ball'], kite: ['kite'],
  'baseball bat': ['baseball bat', 'bat'], 'baseball glove': ['baseball glove', 'glove'], skateboard: ['skateboard'],
  surfboard: ['surfboard'], 'tennis racket': ['tennis racket', 'racket'],
  bottle: ['bottle'], 'wine glass': ['wine glass', 'glass'], cup: ['cup', 'mug'], fork: ['fork'], knife: ['knife'], spoon: ['spoon'], bowl: ['bowl'],
  banana: ['banana'], apple: ['apple'], sandwich: ['sandwich'], orange: ['orange'], broccoli: ['broccoli'], carrot: ['carrot'],
  'hot dog': ['hot dog'], pizza: ['pizza'], donut: ['donut', 'doughnut'], cake: ['cake'],
  chair: ['chair', 'seat'], couch: ['couch', 'sofa'], 'potted plant': ['potted plant', 'plant'], bed: ['bed'],
  'dining table': ['dining table', 'table', 'desk'], toilet: ['toilet'],
  tv: ['tv', 'television', 'monitor', 'screen'], laptop: ['laptop', 'computer'], mouse: ['mouse'], remote: ['remote control', 'remote'],
  keyboard: ['keyboard'], 'cell phone': ['cell phone', 'cellphone', 'smartphone', 'phone'],
  microwave: ['microwave'], oven: ['oven'], toaster: ['toaster'], sink: ['sink'], refrigerator: ['refrigerator', 'fridge'],
  book: ['book'], clock: ['clock'], vase: ['vase'], scissors: ['scissors'], 'teddy bear': ['teddy bear', 'teddy', 'stuffed animal'],
  'hair drier': ['hair drier', 'hair dryer', 'hairdryer'], toothbrush: ['toothbrush'],
  box: ['box'], crate: ['crate'], pillar: ['pillar', 'column'],
};

// How a class is said out loud when it isn't its COCO name.
const SPOKEN = { 'dining table': 'table', 'cell phone': 'phone', tv: 'TV', 'potted plant': 'plant', 'sports ball': 'ball', 'hair drier': 'hair dryer' };

const IRREGULAR = { person: 'people', mouse: 'mice', knife: 'knives', sheep: 'sheep', skis: 'skis', scissors: 'scissors', man: 'men', woman: 'women', child: 'children' };

const GENERIC = ['things', 'thing', 'objects', 'object', 'items', 'item', 'stuff', 'anything', 'something', 'everything'];
const ME = ['the cameras', 'the camera', 'me', 'us', 'myself', 'here'];
const PRONOUNS = ['that one', 'this one', 'it', 'that', 'this', 'him', 'her', 'he', 'she'];
const PLURAL_PRONOUNS = ['them', 'they', 'those', 'these', 'both'];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a: 1, an: 1, 'half a': 0.5, to: 2, too: 2, for: 4, won: 1, ate: 8,
};

const SCENE_INTENTS = new Set(['describe', 'who', 'locate', 'exists', 'count', 'between', 'compare', 'within', 'nearest', 'farthest', 'direction', 'path']);

const END = /^(stop|stop listening|quiet|be quiet|shush|shut up|cancel|never ?mind|that is all|that is it|that will be all|thanks|thank you|thank you very much|thanks a lot|goodbye|good bye|bye|done|i am done|no|nope|nothing|no thanks|no thank you)( thanks| thank you)?$/;
const HELP = /\b(help|what can (you|i) (do|ask|say)|what do i say|commands|how does this work)\b/;
const REPEAT = /\b(repeat|say (that|it) again|say again|come again|pardon|what did you say|one more time)\b|^(what|sorry|huh|eh)$/;
const MORE = /^(what else|anything else|what more|more|tell me more|keep going|go on|continue|the rest|and then|next|others|the others|who else)( is there| do you see)?$/;
const PATH = /\b(path|way)\b.*\b(clear|blocked|free|open)\b|\bin (my|the) way\b|\bcan i (walk|go|move|step) (forward|ahead|straight)\b|\bsafe to (walk|go|move)\b|\bblocking\b/;
const BETWEEN = /\b(between|apart)\b/;
const CALIBRATE = /\b(re)?calibrat(e|ion|ing)\b/;
const COMPARE = /\b(closer|nearer|farther|further)\b/;
const EXISTS = /^(is there|are there|is anyone|is anybody|is someone|is somebody|do you see|can you see|do you notice|any)\b/;
const DESCRIBE = /\b(what|see|look|describe|scan|around|front|ahead|surroundings|view|there|here|room|visible|going on)\b/;

export const HELP_TEXT = 'You can ask: what is in front of me, what is closest, how far is the chair, what is on my left, '
  + "what is at 2 o'clock, how far apart are the chair and the table, which is closer, is the path clear, "
  + 'or is anything within 2 meters. You can also say what else, repeat, use feet, start updates, calibrate, or stop.';

// ---------------------------------------------------------------------------------------
// Words

export function plural(word) {
  const parts = word.split(' ');
  const last = parts.pop();
  const p = IRREGULAR[last] ?? (/(s|x|z|ch|sh)$/.test(last) ? `${last}es` : /[^aeiou]y$/.test(last) ? `${last.slice(0, -1)}ies` : `${last}s`);
  return [...parts, p].join(' ');
}

const article = (w) => (/^[aeiou]/i.test(w) && !/^(uni|eu|one)/i.test(w) ? 'an' : 'a');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const spokenClass = (cls) => SPOKEN[cls] ?? cls;
// A name like "box A" or "point 2" is said as is; a plain class takes "a" / "the".
const proper = (o) => !!o.name && o.name.toLowerCase() !== o.cls;
const aName = (o) => (proper(o) ? o.name : `${article(spokenClass(o.cls))} ${spokenClass(o.cls)}`);
const theName = (o) => (proper(o) ? o.name : `the ${spokenClass(o.cls)}`);

function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "80 centimeters", "2.1 meters", "7 feet" — distances the way they're said out loud. */
export function sayDistance(m, units = 'm') {
  if (units === 'ft') {
    const ft = m * 3.28084;
    if (ft < 1) return `${Math.max(1, Math.round(ft * 12))} inches`;
    const r = ft < 10 ? Math.round(ft * 2) / 2 : Math.round(ft);
    return `${r} ${r === 1 ? 'foot' : 'feet'}`;
  }
  if (m < 0.95) return `${Math.max(10, Math.round(m * 10) * 10)} centimeters`;
  const r = m < 10 ? Math.round(m * 10) / 10 : Math.round(m);
  return `${r} ${r === 1 ? 'meter' : 'meters'}`;
}

function whyNot(o) {
  switch (o.reason) {
    case REASONS.solo: return 'only one camera can see it';
    case REASONS.far: return "it's too far away to measure";
    case REASONS.texture: return 'its surface is too plain to match';
    case REASONS.edge: return "it's at the edge of the picture";
    default: return "I can't get a clean match on it";
  }
}

const clockOf = (o) => `${clockHour(o.azimuth)} o'clock`;

function whereIs(o, units) {
  if (o.range == null) return `at ${clockOf(o)}, but I can't tell how far, because ${whyNot(o)}`;
  return `about ${sayDistance(o.range, units)} away at ${clockOf(o)}`;
}

function lateral(o, units) {
  if (!o.ground) return '';
  const x = o.ground.x;
  if (Math.abs(x) < 0.15) return ', straight ahead of you';
  return `, about ${sayDistance(Math.abs(x), units)} to your ${x < 0 ? 'left' : 'right'}`;
}

/** "a chair, 2.1 meters, at 11 o'clock" */
function shortLine(o, units, withClock = true) {
  const d = o.range != null ? sayDistance(o.range, units) : 'distance unknown';
  return withClock ? `${aName(o)}, ${d}, at ${clockOf(o)}` : `${aName(o)}, ${d}`;
}

/** "3 boxes, a pillar and a crate", nearest kind first. */
function groupPhrase(list) {
  const groups = new Map();
  for (const o of byDistance(list)) groups.set(o.cls, (groups.get(o.cls) ?? 0) + 1);
  return joinList([...groups].map(([cls, n]) => {
    const w = spokenClass(cls);
    return n === 1 ? `${article(w)} ${w}` : `${n} ${plural(w)}`;
  }));
}

const byDistance = (list) => [...list].sort((a, b) => (a.range ?? Infinity) - (b.range ?? Infinity));

// ---------------------------------------------------------------------------------------
// Parsing

/** Lower-cases, expands contractions, and turns spoken numbers into digits where they matter. */
export function normalize(text) {
  let t = ` ${String(text ?? '').toLowerCase()} `.replace(/[’‘`´]/g, "'");
  t = t.replace(/\b(\d{1,2}):00\b/g, '$1 oclock').replace(/\bo\s*'?\s*clock\b/g, ' oclock');
  t = t.replace(/\b(what|where|who|how|there|that|it|here)'s\b/g, '$1 is').replace(/\bwhats\b/g, 'what is').replace(/\bwheres\b/g, 'where is');
  t = t.replace(/\bi'm\b/g, 'i am').replace(/\b(\w+)'re\b/g, '$1 are').replace(/\bcan't\b/g, 'can not').replace(/n't\b/g, ' not').replace(/'s\b/g, '');
  t = t.replace(/[^a-z0-9.\s]/g, ' ').replace(/\.(?!\d)/g, ' ');
  t = t.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half a|an|a|to|too|for|won|ate)\s+(oclock|meters?|metres?|feet|foot|ft|centimeters?|inch(?:es)?)\b/g,
    (s, w, u) => (['to', 'too', 'for', 'won', 'ate'].includes(w) && u !== 'oclock' ? s : `${NUMBER_WORDS[w]} ${u}`));
  t = t.replace(/\b(point|spot|pin|marker|number)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (s, p, w) => `${p} ${NUMBER_WORDS[w]}`);
  t = t.replace(/\b(point|spot|pin|marker) number (\d+)\b/g, '$1 $2');
  t = t.replace(/\s+/g, ' ').trim();
  // Fillers that don't change the question.
  for (let prev = null; prev !== t;) {
    prev = t;
    t = t.replace(/^(hey|hi|hello|ok|okay|alright|all right|so|um|uh|please|and|well|now)\s+/, '').replace(/\s+(please|now)$/, '');
  }
  return t;
}

function buildLexicon(scene) {
  const entries = [];
  const add = (phrase, ref) => entries.push({ tokens: phrase.split(' '), ref });
  const known = new Set();
  for (const [cls, words] of Object.entries(CLASS_WORDS)) {
    known.add(cls);
    for (const w of words) {
      add(w, { type: 'class', cls });
      if (plural(w) !== w) add(plural(w), { type: 'class', cls, plural: true });
    }
  }
  for (const o of scene.objects ?? []) {
    if (!known.has(o.cls)) {
      known.add(o.cls);
      add(o.cls, { type: 'class', cls: o.cls });
      add(plural(o.cls), { type: 'class', cls: o.cls, plural: true });
    }
    if (o.name) add(o.name.toLowerCase(), { type: 'item', key: `o${o.id}` });
  }
  for (const w of GENERIC) add(w, { type: 'all' });
  for (const w of ME) add(w, { type: 'me' });
  for (const w of PRONOUNS) add(w, { type: 'pronoun' });
  for (const w of PLURAL_PRONOUNS) add(w, { type: 'pronoun', plural: true });
  add('the other one', { type: 'other' });
  add('other one', { type: 'other' });
  add('the others', { type: 'other', plural: true });
  return entries.sort((a, b) => b.tokens.length - a.tokens.length);
}

function qualifierFor(tokens, r) {
  const before = tokens.slice(Math.max(0, r.i - 2), r.i);
  const after = tokens.slice(r.end, r.end + 4).join(' ');
  if (before.some((w) => /^(closest|nearest|nearer|closer)$/.test(w)) || /^(closest|nearest) to (me|us)/.test(after)) return 'nearest';
  if (before.some((w) => /^(farthest|furthest|farther|further)$/.test(w))) return 'farthest';
  if (before.includes('left') || /^(on|to|at) (the|my|your) left/.test(after)) return 'left';
  if (before.includes('right') || /^(on|to|at) (the|my|your) right/.test(after)) return 'right';
  if (before.some((w) => /^(middle|center|centre)$/.test(w)) || /^(in the (middle|center|centre)|straight ahead|ahead|in front)/.test(after)) return 'ahead';
  if (before.includes('other')) return 'other';
  return null;
}

/** Everything the question refers to, in order: object classes, named items, points, pronouns, "me". */
function findRefs(tokens, lex) {
  const refs = [];
  for (let i = 0; i < tokens.length;) {
    if (/^(point|spot|pin|marker)$/.test(tokens[i]) && /^\d+$/.test(tokens[i + 1] ?? '')) {
      refs.push({ type: 'pin', n: Number(tokens[i + 1]), i, end: i + 2 });
      i += 2;
      continue;
    }
    const hit = lex.find((e) => e.tokens.every((w, k) => tokens[i + k] === w));
    if (hit) {
      refs.push({ ...hit.ref, i, end: i + hit.tokens.length });
      i += hit.tokens.length;
    } else {
      i++;
    }
  }
  for (const r of refs) r.qual = qualifierFor(tokens, r);
  return refs;
}

function sceneItems(scene) {
  return [
    ...(scene.objects ?? []).map((o) => ({ ...o, key: `o${o.id}` })),
    ...(scene.pins ?? []).map((p) => ({ ...p, cls: 'point', name: `point ${p.id}`, key: `p${p.id}` })),
  ];
}

function applyQualifier(list, qual, ctx) {
  const sorted = byDistance(list);
  switch (qual) {
    case 'nearest': return sorted.slice(0, 1);
    case 'farthest': {
      const measured = sorted.filter((o) => o.range != null);
      return measured.length ? measured.slice(-1) : sorted.slice(-1);
    }
    case 'left': return sorted.filter((o) => o.azimuth < -5);
    case 'right': return sorted.filter((o) => o.azimuth > 5);
    case 'ahead': return sorted.filter((o) => Math.abs(o.azimuth) <= 12);
    case 'other': {
      const others = new Set(ctx.others ?? []);
      const rest = sorted.filter((o) => others.has(o.key));
      return rest.length ? rest : sorted.filter((o) => !(ctx.subjects ?? []).includes(o.key));
    }
    default: return sorted;
  }
}

function resolveRef(ref, scene, ctx) {
  const items = sceneItems(scene);
  const byKey = (k) => items.find((o) => o.key === k);
  let list;
  switch (ref.type) {
    case 'class': list = items.filter((o) => o.cls === ref.cls); break;
    case 'item': list = [byKey(ref.key)].filter(Boolean); break;
    case 'pin': list = items.filter((o) => o.key === `p${ref.n}`); break;
    case 'pronoun': list = ((ref.plural ? ctx.group : ctx.subjects) ?? []).map(byKey).filter(Boolean); break;
    case 'other': list = (ctx.others ?? []).map(byKey).filter(Boolean); break;
    case 'all': list = items.filter((o) => o.cls !== 'point'); break;
    default: list = [];
  }
  return applyQualifier(list, ref.type === 'other' ? null : ref.qual, ctx);
}

function updatesIntent(t) {
  if (!/\b(updates?|announcements?|announcing|announce|commentary|call ?outs?|calling out|narrat\w*|keep me (posted|updated|informed))\b/.test(t)) return null;
  if (/\b(stop|turn off|disable|pause|no more|quit|end|cancel|enough)\b/.test(t)) return false;
  if (/\b(start|turn on|enable|resume|begin|keep me|give me)\b/.test(t)) return true;
  return null;
}

function unitsIntent(t) {
  let m = t.match(/\b(in|use|using|switch to|change to|go to|give me) (feet|foot|ft|imperial)\b/);
  if (m) return { units: 'ft', match: m[0] };
  m = t.match(/\b(in|use|using|switch to|change to|go to|give me) (meters|metres|meter|metre|metric)\b/);
  if (m) return { units: 'm', match: m[0] };
  return null;
}

function withinIntent(t, units) {
  const m = t.match(/\b(within|closer than|nearer than|less than|under|inside)\s+(\d+(?:\.\d+)?)\s*(m|meters?|metres?|cm|centimeters?|ft|feet|foot|inch(?:es)?)?\b/);
  if (m) {
    let v = Number(m[2]);
    const u = m[3] || (units === 'ft' ? 'ft' : 'm');
    if (/^(ft|feet|foot)$/.test(u)) v *= 0.3048;
    else if (/^(cm|centi)/.test(u)) v /= 100;
    else if (/^inch/.test(u)) v *= 0.0254;
    return { limit: v };
  }
  if (/\barms? (reach|length)\b/.test(t)) return { limit: 0.7 };
  if (/\b(near|close to|next to) (me|us)\b|\bnearby\b|\b(anything|something|anyone|anybody|someone|somebody) (near|close)\b/.test(t)) return { limit: 1.5 };
  return null;
}

function directionIntent(t) {
  const clock = t.match(/\b(\d{1,2}) oclock\b/);
  if (clock && Number(clock[1]) >= 1 && Number(clock[1]) <= 12) return { hour: Number(clock[1]) };
  if (/\b(on|to|at) (my|the|your) left\b|\bleft (hand )?side\b|\bleft of (me|us)\b/.test(t)) return { side: 'left' };
  if (/\b(on|to|at) (my|the|your) right\b|\bright (hand )?side\b|\bright of (me|us)\b/.test(t)) return { side: 'right' };
  if (/\b(straight|dead|directly|right) (ahead|in front)\b|\bin the (middle|center|centre)\b/.test(t)) return { side: 'ahead' };
  return null;
}

/** The COCO class a phrase names ("the couch" → 'couch', "a TV" → 'tv'), or null. */
export function classFromPhrase(phrase) {
  const tokens = normalize(phrase).split(' ');
  const entries = buildLexicon({ objects: [] }).filter((e) => e.ref.type === 'class');
  for (let i = 0; i < tokens.length; i++) {
    const hit = entries.find((e) => e.tokens.every((w, k) => tokens[i + k] === w));
    if (hit) return hit.ref.cls;
  }
  return null;
}

/** How a class is said out loud ('dining table' → 'table'). */
export const spokenName = (cls) => SPOKEN[cls] ?? cls;

// ---------------------------------------------------------------------------------------
// Answers. Each returns { intent, text, subjects?, group?, others?, more? } where the lists
// hold item keys ("o3" = object 3, "p1" = point 1) for follow-up questions.

function nothingText(scene) {
  if (scene.status === 'detector-off') return 'Object detection is turned off, so I can only measure spots you click in the left view.';
  if (scene.status === 'detector-error') return "The object detector didn't load, so I can only measure spots you click in the left view.";
  return "I don't see anything I recognize right now.";
}

function describe(objs, scene, units, { who = false } = {}) {
  const list = byDistance(objs);
  if (!list.length) return { intent: who ? 'who' : 'describe', text: who ? "I don't see anyone." : nothingText(scene), subjects: [], group: [], more: [] };
  const intent = who ? 'who' : 'describe';
  if (list.length === 1) {
    const o = list[0];
    return { intent, text: `I see ${aName(o)}, ${whereIs(o, units)}.`, subjects: [o.key], group: [o.key], more: [] };
  }
  const kinds = new Set(list.map((o) => o.cls)).size;
  const summary = kinds === 1 ? `I see ${groupPhrase(list)}.` : `I see ${list.length} things: ${groupPhrase(list)}.`;
  const shown = list.slice(0, 4), rest = list.slice(4);
  let text = `${summary} Nearest first: ${shown.map((o) => cap(shortLine(o, units))).join('. ')}.`;
  if (rest.length) text += ` ${rest.length === 1 ? 'One more' : `${rest.length} more`} farther away. Say "what else" to hear ${rest.length === 1 ? 'it' : 'them'}.`;
  return { intent, text, subjects: [shown[0].key], group: list.map((o) => o.key), more: rest.map((o) => o.key) };
}

function missing(ref, scene, ctx, units) {
  const objs = sceneItems(scene).filter((o) => o.cls !== 'point');
  const seen = objs.length ? ` I can see ${groupPhrase(objs)}.` : '';
  if (ref.type === 'pronoun' || ref.type === 'other') {
    return { intent: 'locate', text: ctx.subjects?.length ? `I can't see that anymore.${seen}` : `I'm not sure what you mean.${seen}` };
  }
  if (ref.type === 'pin') return { intent: 'locate', text: `There's no point ${ref.n}. Click the left view to add one.` };
  if (ref.type === 'item') return { intent: 'locate', text: `I can't see that right now.${seen}` };
  const name = spokenClass(ref.cls);
  const where = { left: ' on your left', right: ' on your right', ahead: ' straight ahead' }[ref.qual] ?? '';
  if (where && objs.some((o) => o.cls === ref.cls)) {
    const r = locate({ ...ref, qual: null }, scene, ctx, units);
    return { ...r, text: `There's no ${name}${where}. ${r.text}` };
  }
  return { intent: 'locate', text: `I don't see ${article(name)} ${name}${where} right now.${seen}`, subjects: [], others: [] };
}

function locate(ref, scene, ctx, units) {
  const list = resolveRef(ref, scene, ctx);
  if (!list.length) return missing(ref, scene, ctx, units);
  if (list.length === 1) {
    const o = list[0];
    // "How far is it?" keeps the alternatives in play; "the other one" can flip back again.
    const others = ref.type === 'pronoun' ? ctx.others ?? [] : ref.type === 'other' ? (ctx.subjects ?? []).filter((k) => k !== o.key) : [];
    return {
      intent: 'locate',
      text: `${cap(theName(o))} is ${whereIs(o, units)}${o.range != null ? lateral(o, units) : ''}.`,
      subjects: [o.key], group: [o.key], others,
    };
  }
  const [a, b, ...rest] = list;
  let text = `I see ${groupPhrase(list)}. The nearest is ${whereIs(a, units)}`;
  text += rest.length
    ? `. The next is ${whereIs(b, units)}, and there ${rest.length === 1 ? 'is 1 more' : `are ${rest.length} more`} farther away.`
    : `. The other is ${whereIs(b, units)}.`;
  return { intent: 'locate', text, subjects: [a.key], group: list.map((o) => o.key), others: [b, ...rest].map((o) => o.key) };
}

function exists(ref, scene, ctx, units) {
  if (!resolveRef(ref, scene, ctx).length) {
    const m = missing(ref, scene, ctx, units);
    return { ...m, intent: 'exists', text: `No. ${m.text}` };
  }
  const r = locate(ref, scene, ctx, units);
  return { ...r, intent: 'exists', text: `Yes. ${r.text}` };
}

function count(things, objs, scene, ctx, units) {
  const ref = things[0];
  if (!ref) {
    if (!objs.length) return { intent: 'count', text: nothingText(scene) };
    return { intent: 'count', text: `I see ${objs.length} ${objs.length === 1 ? 'thing' : 'things'}: ${groupPhrase(objs)}.`, group: objs.map((o) => o.key) };
  }
  const list = resolveRef(ref, scene, ctx);
  const name = ref.type === 'class' ? spokenClass(ref.cls) : 'thing';
  if (!list.length) return { intent: 'count', text: `I don't see any ${plural(name)}.` };
  const n = list.length === 1 ? `${article(name)} ${name}, ${whereIs(list[0], units)}` : `${list.length} ${plural(name)}. The nearest is ${whereIs(list[0], units)}`;
  return { intent: 'count', text: `I see ${n}.`, subjects: [list[0].key], group: list.map((o) => o.key), others: list.slice(1).map((o) => o.key) };
}

/** The two things a "between", "apart" or "which is closer" question is about. */
function twoThings(things, scene, ctx, units) {
  if (things.length >= 2) {
    const la = resolveRef(things[0], scene, ctx);
    if (!la.length) return { fail: missing(things[0], scene, ctx, units) };
    const lb = resolveRef(things[1], scene, ctx).filter((o) => o.key !== la[0].key);
    if (!lb.length) {
      return resolveRef(things[1], scene, ctx).length
        ? { fail: { text: `I only see one ${spokenClass(la[0].cls)}.` } }
        : { fail: missing(things[1], scene, ctx, units) };
    }
    return { a: la[0], b: lb[0] };
  }
  if (things.length === 1) {
    const l = resolveRef(things[0], scene, ctx);
    if (l.length >= 2) return { a: l[0], b: l[1], same: true, many: l.length > 2 };
    return { fail: l.length ? locate(things[0], scene, ctx, units) : missing(things[0], scene, ctx, units) };
  }
  return { fail: { text: 'Between which two things?' } };
}

function between(things, scene, ctx, units) {
  const p = twoThings(things, scene, ctx, units);
  if (p.fail) return { intent: 'between', ...p.fail };
  const { a, b } = p;
  const keys = [a.key, b.key];
  if (!a.point || !b.point) {
    const o = a.point ? b : a;
    return { intent: 'between', text: `I can't tell how far ${theName(o)} is, so I can't measure the gap: ${whyNot(o)}.`, subjects: keys, group: keys };
  }
  const d = sayDistance(dist3(a.point, b.point), units);
  const names = p.same && !proper(a)
    ? `The ${p.many ? 'two nearest ' : ''}${plural(spokenClass(a.cls))}`
    : `${cap(theName(a))} and ${theName(b)}`;
  return { intent: 'between', text: `${names} are about ${d} apart.`, subjects: keys, group: keys };
}

function compare(things, scene, ctx, units, t) {
  const p = twoThings(things, scene, ctx, units);
  if (p.fail) return { intent: 'compare', ...p.fail };
  const { a, b } = p;
  const keys = [a.key, b.key];
  const unknown = [a, b].find((o) => o.range == null);
  if (unknown) return { intent: 'compare', text: `I can't tell how far ${theName(unknown)} is: ${whyNot(unknown)}.`, subjects: keys, group: keys };
  const far = /\b(farther|further)\b/.test(t);
  const [win, lose] = (a.range < b.range) !== far ? [a, b] : [b, a];
  return {
    intent: 'compare',
    text: `${cap(theName(win))} is ${far ? 'farther' : 'closer'}: about ${sayDistance(win.range, units)}, versus ${sayDistance(lose.range, units)} for ${theName(lose)}.`,
    subjects: [win.key, lose.key], group: keys,
  };
}

function extreme(objs, scene, units, far) {
  const measured = byDistance(objs).filter((o) => o.range != null);
  const intent = far ? 'farthest' : 'nearest';
  if (!measured.length) {
    return { intent, text: objs.length ? `I can see ${groupPhrase(objs)}, but I can't measure how far any of it is yet.` : nothingText(scene) };
  }
  const o = far ? measured[measured.length - 1] : measured[0];
  return { intent, text: `The ${far ? 'farthest I can measure' : 'closest'} is ${aName(o)}, ${whereIs(o, units)}${lateral(o, units)}.`, subjects: [o.key], group: [o.key] };
}

function direction(dir, objs, scene, units) {
  let list, where;
  if (dir.hour) {
    list = objs.filter((o) => clockHour(o.azimuth) === dir.hour);
    where = `at ${dir.hour} o'clock`;
  } else if (dir.side === 'left') {
    list = objs.filter((o) => o.azimuth < -5);
    where = 'on your left';
  } else if (dir.side === 'right') {
    list = objs.filter((o) => o.azimuth > 5);
    where = 'on your right';
  } else {
    list = objs.filter((o) => Math.abs(o.azimuth) <= 12);
    where = 'straight ahead';
  }
  list = byDistance(list);
  if (!list.length) {
    let text = `I don't see anything ${where}.`;
    if (dir.hour && scene.hfovDeg) {
      const half = scene.hfovDeg / 2;
      const az = (dir.hour > 6 ? dir.hour - 12 : dir.hour) * 30;
      if (az + 15 < -half || az - 15 > half) text += ` The cameras only see from about ${clockHour(-half)} to ${clockHour(half)} o'clock.`;
    }
    return { intent: 'direction', text, subjects: [], group: [] };
  }
  const shown = list.slice(0, 4), rest = list.slice(4);
  let text = `${cap(where)}: ${joinList(shown.map((o) => shortLine(o, units, !dir.hour)))}.`;
  if (rest.length) text += ` And ${rest.length} more farther away.`;
  return { intent: 'direction', text, subjects: [shown[0].key], group: list.map((o) => o.key), more: rest.map((o) => o.key) };
}

function withinAnswer(w, objs, units) {
  const lim = sayDistance(w.limit, units);
  const list = byDistance(objs.filter((o) => o.range != null && o.range <= w.limit));
  if (!list.length) {
    const c = byDistance(objs).find((o) => o.range != null);
    return {
      intent: 'within',
      text: `Nothing I can see is within ${lim}.${c ? ` The closest is ${aName(c)}, ${whereIs(c, units)}.` : ''}`,
      subjects: c ? [c.key] : [],
    };
  }
  const shown = list.slice(0, 4), rest = list.slice(4);
  return {
    intent: 'within',
    text: `${list.length === 1 ? 'One thing is' : `${list.length} things are`} within ${lim}: ${joinList(shown.map((o) => shortLine(o, units)))}.${rest.length ? ` And ${rest.length} more.` : ''}`,
    subjects: [shown[0].key], group: list.map((o) => o.key), more: rest.map((o) => o.key),
  };
}

function path(objs, units) {
  // A corridor about shoulder-width wide, 3 m deep, straight ahead.
  const inPath = byDistance(objs.filter((o) => o.ground && Math.abs(o.ground.x) < 0.45 && o.ground.z > 0 && o.ground.z < 3));
  const caveat = " I only recognize about 80 kinds of things, so don't rely on me alone.";
  if (inPath.length) {
    const o = inPath[0];
    const more = inPath.length > 1 ? ` ${inPath.length - 1 === 1 ? 'Something else is' : `${inPath.length - 1} more things are`} behind it.` : '';
    return { intent: 'path', text: `${cap(aName(o))} is in your path, about ${sayDistance(o.ground.z, units)} ahead.${more}`, subjects: [o.key], group: inPath.map((x) => x.key) };
  }
  const unsure = objs.filter((o) => !o.ground && Math.abs(o.azimuth) < 12);
  let text = `I don't see anything in your path for the next ${sayDistance(3, units)}.`;
  if (unsure.length) text += ` There is ${aName(unsure[0])} ahead, though, and I can't tell how far it is.`;
  return { intent: 'path', text: text + caveat, subjects: unsure.length ? [unsure[0].key] : [] };
}

function more(ctx, scene, units) {
  const items = sceneItems(scene);
  const list = (ctx.more ?? []).map((k) => items.find((o) => o.key === k)).filter(Boolean);
  if (!list.length) return { intent: 'more', text: "That's everything I can see.", more: [] };
  const shown = list.slice(0, 4), rest = list.slice(4);
  return {
    intent: 'more',
    text: `Also ${joinList(shown.map((o) => shortLine(o, units)))}.${rest.length ? ` And ${rest.length} more.` : ''}`,
    subjects: [shown[0].key], group: shown.map((o) => o.key), more: rest.map((o) => o.key),
  };
}

function statusText(scene) {
  if (scene.status === 'no-video') return "The cameras aren't running yet. Start them, then ask me again.";
  if (scene.status === 'loading') return "I'm still loading the object detector. Ask me again in a few seconds.";
  return null;
}

function sceneRoute(t, scene, ctx, units) {
  const refs = findRefs(t.split(' '), buildLexicon(scene));
  const things = refs.filter((r) => ['class', 'item', 'pin', 'pronoun', 'other'].includes(r.type));
  const objs = sceneItems(scene).filter((o) => o.cls !== 'point');

  if (MORE.test(t)) return more(ctx, scene, units);
  if (PATH.test(t)) return path(objs, units);
  if (/\bhow many\b/.test(t)) return count(things, objs, scene, ctx, units);
  if (COMPARE.test(t) && things.length >= 2 && !/\d/.test(t)) return compare(things, scene, ctx, units, t);
  if (BETWEEN.test(t) || (things.length >= 2 && /\bfrom\b/.test(t))) return between(things, scene, ctx, units);
  if (things.length) return EXISTS.test(t) ? exists(things[0], scene, ctx, units) : locate(things[0], scene, ctx, units);
  const within = withinIntent(t, units);
  if (within) return withinAnswer(within, objs, units);
  if (/\b(closest|nearest)\b/.test(t)) return extreme(objs, scene, units, false);
  if (/\b(farthest|furthest)\b/.test(t)) return extreme(objs, scene, units, true);
  const dir = directionIntent(t);
  if (dir) return direction(dir, objs, scene, units);
  if (/\bwho\b/.test(t)) return describe(objs.filter((o) => o.cls === 'person'), scene, units, { who: true });
  if (DESCRIBE.test(t) || refs.some((r) => r.type === 'all')) return describe(objs, scene, units);
  return { intent: 'unknown', text: 'Sorry, I didn\'t catch that. Try "what is in front of me?" or "how far is the chair?"' };
}

function route(t, scene, ctx) {
  const units = scene.units || 'm';
  if (!t) return { intent: 'unknown', text: "I didn't hear a question." };
  if (END.test(t)) return { intent: 'end', text: /thank/.test(t) ? "You're welcome." : 'OK.', action: { end: true } };
  if (CALIBRATE.test(t)) {
    // The page runs the calibration and does its own talking, so this turn says nothing.
    if (/\b(undo|cancel|revert|reset)\b/.test(t)) return { intent: 'calibrate', text: '', action: { calibrate: 'undo', end: true } };
    const d = t.match(/(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|foot)\b/);
    const range = d ? Number(d[1]) * (/^(ft|feet|foot)$/.test(d[2]) ? 0.3048 : 1) : null;
    return { intent: 'calibrate', text: '', action: { calibrate: 'capture', range, end: true } };
  }
  const upd = updatesIntent(t);
  if (upd != null) {
    return { intent: 'updates', text: upd ? "OK, I'll call out changes every 2 seconds." : 'OK, no more updates.', action: { updates: upd } };
  }
  const u = unitsIntent(t);
  if (u) {
    const rest = t.replace(u.match, ' ').replace(/\b(from now on|instead|please)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const ack = u.units === 'ft' ? "OK, I'll use feet." : "OK, I'll use meters.";
    const scene2 = { ...scene, units: u.units };
    if (!rest || /^(ok|okay|and|tell me|say it|units)$/.test(rest)) {
      // Say the last answer again in the new units.
      if (ctx.lastQuestion && !statusText(scene)) {
        const again = route(ctx.lastQuestion, scene2, ctx);
        return { ...again, text: `${ack} ${again.text}`, action: { units: u.units }, keepQuestion: true };
      }
      return { intent: 'units', text: ack, action: { units: u.units } };
    }
    const r = route(rest, scene2, ctx);
    return { ...r, action: { ...(r.action ?? {}), units: u.units }, asked: rest };
  }
  if (HELP.test(t)) return { intent: 'help', text: HELP_TEXT };
  if (REPEAT.test(t)) return { intent: 'repeat', text: ctx.lastText || "I haven't said anything yet." };
  const gate = statusText(scene);
  if (gate) return { intent: 'status', text: gate };
  const r = sceneRoute(t, scene, ctx, units);
  return scene.paused ? { ...r, text: `The view is paused, so this is from the frozen frame. ${r.text}` } : r;
}

/**
 * Answers one question.
 * scene: { objects, pins, units, status ('ok' | 'no-video' | 'loading' | 'detector-off' | 'detector-error'), paused, hfovDeg }
 * ctx: the `ctx` returned by the previous answer (or {} to start a conversation).
 * Returns { question, intent, text, action, focus (object id to highlight or null), ctx }.
 */
export function answer(question, scene, ctx = {}) {
  const t = normalize(question);
  const out = route(t, scene, ctx);
  const focusKey = out.subjects?.find((k) => k.startsWith('o'));
  const isScene = SCENE_INTENTS.has(out.intent);
  return {
    question, intent: out.intent, text: out.text, action: out.action ?? null,
    focus: focusKey ? Number(focusKey.slice(1)) : null,
    ctx: {
      subjects: out.subjects ?? ctx.subjects ?? [],
      group: out.group ?? out.subjects ?? ctx.group ?? [],
      others: out.others ?? (isScene ? [] : ctx.others ?? []),
      more: out.more ?? ctx.more ?? [],
      lastText: out.intent === 'repeat' ? ctx.lastText : out.text,
      lastQuestion: !out.keepQuestion && isScene ? out.asked ?? t : ctx.lastQuestion,
    },
  };
}

/** Speech recognition offers a few guesses; answer the first one that makes sense. */
export function answerBest(alternatives, scene, ctx = {}) {
  let first = null;
  for (const alt of alternatives) {
    const r = answer(alt, scene, ctx);
    if (r.intent !== 'unknown') return r;
    first ??= r;
  }
  return first ?? answer('', scene, ctx);
}
