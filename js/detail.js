// How much the assistant says: how many objects it lists, whether it adds clock directions,
// side offsets, reasons and caveats, and how finely it rounds distances. The defaults reproduce
// the answers the assistant always gave. Changes come from Droid (Factory's agent), which reads
// a request like "give me more detail" and proposes new values; this module checks them against
// DETAIL_SCHEMA before anything is applied, so a bad reply can never put the app in a bad state.
// Pure logic apart from DetailController's fetch.

/** Every parameter Droid may set, with its type, allowed values and what it changes. */
export const DETAIL_SCHEMA = {
  maxItems: { type: 'integer', min: 1, max: 10, default: 4, doc: 'Objects read out in one answer before the rest wait for "what else".' },
  summary: { type: 'boolean', default: true, doc: 'Open a scene description with a count by kind ("I see 5 things: 2 chairs, ...").' },
  clock: { type: 'boolean', default: true, doc: "Give each listed object's clock direction (\"at 11 o'clock\")." },
  lateral: { type: 'boolean', default: true, doc: 'Add how far left or right of you a single object is ("about 1 meter to your left").' },
  reasons: { type: 'boolean', default: true, doc: "Explain why an object has no distance (\"because only one camera can see it\")." },
  caveats: { type: 'boolean', default: true, doc: 'Add safety caveats, such as the detector only knowing about 80 kinds of things.' },
  precision: { type: 'enum', values: ['coarse', 'normal', 'fine'], default: 'normal', doc: 'Distance rounding: coarse = nearest half meter or foot, normal = 0.1 m / half foot, fine = centimeters / inches.' },
  updateItems: { type: 'integer', min: 1, max: 6, default: 3, doc: 'Objects with a distance said in each periodic spoken update.' },
};

export const DEFAULT_DETAIL = Object.freeze(Object.fromEntries(Object.entries(DETAIL_SCHEMA).map(([k, s]) => [k, s.default])));

/** Named starting points Droid can pick from, then adjust. */
export const DETAIL_PRESETS = {
  brief: { maxItems: 2, summary: false, clock: false, lateral: false, reasons: false, caveats: true, precision: 'coarse', updateItems: 1 },
  normal: { ...DEFAULT_DETAIL },
  detailed: { maxItems: 8, summary: true, clock: true, lateral: true, reasons: true, caveats: true, precision: 'fine', updateItems: 5 },
};

/** The current values with any missing or invalid ones replaced by defaults. */
export function normalizeDetail(detail) {
  const out = { ...DEFAULT_DETAIL };
  for (const [k, v] of Object.entries(detail ?? {})) {
    const c = checkValue(k, v);
    if (c.ok) out[k] = c.value;
  }
  return out;
}

function checkValue(key, value) {
  const s = DETAIL_SCHEMA[key];
  if (!s) return { ok: false, why: 'unknown parameter' };
  switch (s.type) {
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, why: 'not a number' };
      const v = Math.round(value);
      // Out-of-range asks ("tell me everything") are clamped rather than refused.
      return { ok: true, value: Math.max(s.min, Math.min(s.max, v)), clamped: v < s.min || v > s.max };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, why: 'not true or false' };
    case 'enum':
      return s.values.includes(value) ? { ok: true, value } : { ok: false, why: `not one of ${s.values.join(', ')}` };
    default:
      return { ok: false, why: 'bad schema' };
  }
}

/**
 * Checks a proposed update against the schema and applies the valid parts.
 * update: { preset?, set?: { key: value }, reply? } as returned by Droid.
 * Returns { detail, changed: [keys], rejected: [{ key, value, why }], reply }.
 */
export function applyDetailUpdate(current, update) {
  const base = normalizeDetail(current);
  const rejected = [];
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return { detail: base, changed: [], rejected: [{ key: null, value: update, why: 'not an object' }], reply: '' };
  }
  let next = { ...base };
  if (update.preset != null) {
    if (DETAIL_PRESETS[update.preset]) next = { ...DETAIL_PRESETS[update.preset] };
    else rejected.push({ key: 'preset', value: update.preset, why: 'unknown preset' });
  }
  const set = update.set ?? {};
  if (typeof set !== 'object' || Array.isArray(set)) {
    rejected.push({ key: 'set', value: set, why: 'not an object' });
  } else {
    for (const [k, v] of Object.entries(set)) {
      const c = checkValue(k, v);
      if (c.ok) next[k] = c.value;
      else rejected.push({ key: k, value: v, why: c.why });
    }
  }
  const changed = Object.keys(next).filter((k) => next[k] !== base[k]);
  const reply = typeof update.reply === 'string' ? update.reply.slice(0, 200) : '';
  return { detail: next, changed, rejected, reply };
}

/** The schema as Droid sees it: types, ranges, defaults and meaning, plus the presets. */
export function schemaForPrompt() {
  return { parameters: DETAIL_SCHEMA, presets: DETAIL_PRESETS };
}

/**
 * Sends a level-of-detail request to the local Droid bridge (tools/droid_bridge.py) and applies
 * the validated result. Any failure (bridge down, Droid timeout, unusable reply) keeps the
 * current values. The future request-capture feature calls handleRequest(text).
 */
export class DetailController {
  /**
   * getDetail(): current values. setDetail(detail, info): applies new values.
   * endpoint: the bridge URL. timeoutMs: how long to wait for Droid. fetchImpl: for tests.
   */
  constructor({ getDetail, setDetail, endpoint = '/api/detail', timeoutMs = 45000, fetchImpl = globalThis.fetch?.bind(globalThis), log = console }) {
    Object.assign(this, { getDetail, setDetail, endpoint, timeoutMs, fetchImpl, log });
    this.pending = null;
  }

  /** Returns { ok, detail, changed, rejected, reply, error? }. */
  async handleRequest(text) {
    const current = normalizeDetail(this.getDetail());
    const keep = (error) => {
      this.log.warn?.(`Level of detail unchanged: ${error}`);
      return { ok: false, detail: current, changed: [], rejected: [], reply: '', error };
    };
    if (!String(text ?? '').trim()) return keep('empty request');
    if (!this.fetchImpl) return keep('no fetch available');
    this.pending?.abort();
    const ctl = new AbortController();
    this.pending = ctl;
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let body;
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: String(text), current, schema: schemaForPrompt() }),
        signal: ctl.signal,
      });
      body = await res.json();
      if (!res.ok || body?.error) return keep(body?.error || `bridge answered ${res.status}`);
    } catch (e) {
      return keep(e?.name === 'AbortError' ? 'timed out or superseded' : `bridge unreachable (${e?.message ?? e})`);
    } finally {
      clearTimeout(timer);
      if (this.pending === ctl) this.pending = null;
    }
    const r = applyDetailUpdate(current, body.update);
    if (r.rejected.length) this.log.warn?.('Droid proposed values that were rejected:', r.rejected);
    if (r.changed.length) this.setDetail(r.detail, r);
    return { ok: true, ...r };
  }
}
