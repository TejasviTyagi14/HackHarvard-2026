// Turn-by-turn walking directions from a planned route.
//   • Turns are sorted by how far they bend: straight < 20° < slight < 45° < turn < 120° < sharp
//     < 160° < U-turn, with a 5° margin so an instruction doesn't flip near a boundary.
//   • "In 5 meters, turn left" about 5 m before a turn, "Turn left now" at about 1.5 m, with
//     "then …" when the next turn follows closely.
//   • At least 2 s between messages; warnings (tracking lost) go first.
//   • Facing the wrong way: "Turn right, to 3 o'clock", ticking while you turn, then "Go straight".
//   • More than 1 m off the route for over a second: "Re-routing". Within 0.5 m of the goal: arrived.
// Pure logic: feed it poses and routes, it returns what to say. Headings: radians, + = right.
import { sayDistance } from '../assistant.js';

export const TURN_BREAKS = [20, 45, 120, 160];
const CATS = ['straight', 'slight', 'turn', 'sharp', 'uturn'];

export const GUIDE_DEFAULTS = {
  far: 5, near: 1.5, chain: 3, minGap: 2, arrive: 0.5, offRoute: 1, offRouteSec: 1, backOnRoute: 0.5,
  alignStart: 35, alignDone: 10, warnEvery: 5, tickEvery: 0.6, units: 'm',
};

export const wrapDeg = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const bearing = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** Category for a turn of |angle| degrees; `prev` keeps an earlier category within the margin. */
export function turnCategory(absDeg, prev = null, margin = 5) {
  const raw = TURN_BREAKS.findIndex((b) => absDeg < b);
  const idx = raw < 0 ? 4 : raw;
  if (prev == null) return CATS[idx];
  const p = CATS.indexOf(prev);
  const lo = p === 0 ? -Infinity : TURN_BREAKS[p - 1] - margin, hi = p === 4 ? Infinity : TURN_BREAKS[p] + margin;
  return absDeg >= lo && absDeg < hi ? prev : CATS[idx];
}

export function turnPhrase(angle, cat) {
  const side = angle < 0 ? 'left' : 'right';
  switch (cat) {
    case 'straight': return 'continue straight';
    case 'slight': return `bear ${side}`;
    case 'turn': return `turn ${side}`;
    case 'sharp': return `make a sharp ${side}`;
    default: return 'make a U-turn';
  }
}

const clockOf = (deg) => {
  const h = ((Math.round(deg / 30) % 12) + 12) % 12;
  return h === 0 ? 12 : h;
};

/** Turns along a route: [{ at: [x, z], along: m from the start, angle: ° (+ right), cat }]. */
export function maneuvers(path) {
  const out = [];
  let along = 0;
  for (let i = 1; i < path.length; i++) {
    along += dist(path[i - 1], path[i]);
    if (i === path.length - 1) break;
    const angle = wrapDeg(bearing(path[i], path[i + 1]) - bearing(path[i - 1], path[i]));
    out.push({ at: path[i], along, angle, cat: turnCategory(Math.abs(angle)) });
  }
  return out;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export class Guide {
  constructor(opts = {}) {
    this.o = { ...GUIDE_DEFAULTS, ...opts };
    this.active = false;
  }

  /** goal: { x, z, label } */
  start(goal, now) {
    Object.assign(this, {
      active: true, goal, startedAt: now, lastSaid: -Infinity, route: null, offSince: null,
      announced: new Map(), cats: new Map(), aligned: false, turning: false, lastTick: -Infinity,
      lastWarn: -Infinity, lastNoRoute: -Infinity, introduced: false, arrived: false,
    });
  }

  stop() {
    this.active = false;
  }

  d(m) {
    return sayDistance(m, this.o.units);
  }

  /**
   * pose: { x, z, heading (rad) }; route: planner output { ok, path, length, partial, gap };
   * tracking: 'ok' | 'lost'. Returns { say: [{ text, priority: 'warn' | 'turn' | 'info' }],
   * tone: 'tick' | null, status: { text, remaining, headingError } }.
   */
  update({ pose, route, tracking = 'ok', now }) {
    const o = this.o, out = { say: [], tone: null, status: null };
    if (!this.active) return out;
    // Everything due this update is said as one message; its flags only stick once it's said.
    const due = [];
    const add = (text, priority = 'info', commit = null) => due.push({ text, priority, commit });
    const flush = () => {
      if (!due.length) return out;
      const priority = due.some((d) => d.priority === 'warn') ? 'warn' : due.some((d) => d.priority === 'turn') ? 'turn' : 'info';
      if (priority !== 'warn' && now - this.lastSaid < o.minGap) return out;
      out.say.push({ text: due.map((d) => d.text).join(' '), priority });
      this.lastSaid = now;
      for (const d of due) d.commit?.();
      return out;
    };
    const here = [pose.x, pose.z];
    const label = this.goal.label ? ` at ${this.goal.label}` : '';

    if (tracking !== 'ok') {
      if (now - this.lastWarn >= o.warnEvery) add('Stop, and turn slowly back the way you came.', 'warn', () => { this.lastWarn = now; });
      out.status = { text: 'Tracking lost: stop and turn slowly' };
      return flush();
    }
    if (dist(here, [this.goal.x, this.goal.z]) < o.arrive) {
      add(`You have arrived${label}.`, 'warn');
      this.active = false;
      this.arrived = true;
      out.status = { text: 'Arrived', remaining: 0 };
      return flush();
    }
    if (!route?.ok) {
      // Give the planner a moment before saying there's no way.
      if (now - this.startedAt >= 1.5 && now - this.lastNoRoute >= 10) add("I can't find a way there from here yet. Look around so I can see more.", 'info', () => { this.lastNoRoute = now; });
      out.status = { text: 'No route yet' };
      return flush();
    }
    const path = route.path;
    const remaining = route.length;

    if (!this.introduced) {
      const more = route.partial ? ` I can only get you to within ${this.d(route.gap)} of it.` : '';
      add(`Route${this.goal.label ? ` to ${this.goal.label}` : ''}: ${this.d(remaining)}.${more}`, 'info', () => { this.introduced = true; });
    }

    // Leaving the route: after a second more than 1 m off, re-route; back within 0.5 m clears it.
    if (!this.route) this.route = path;
    const off = distanceToPath(here, this.route);
    if (off > o.offRoute) {
      this.offSince ??= now;
      if (now - this.offSince >= o.offRouteSec) {
        add('Re-routing.', 'turn', () => {
          this.route = path;
          this.announced.clear();
          this.aligned = false;
          this.offSince = null;
        });
      }
    } else if (off < o.backOnRoute) {
      this.offSince = null;
    }

    // Which way to face for the first leg (look at least 1 m ahead).
    const ahead = pointAlong(path, Math.min(1, remaining));
    const err = wrapDeg(bearing(here, ahead) - (pose.heading * 180) / Math.PI);
    const turnDir = err < 0 ? 'left' : 'right';

    if (!this.aligned || Math.abs(err) > 60) {
      if (Math.abs(err) > o.alignStart) {
        if (!this.turning) {
          add(Math.abs(err) > 150 ? 'Turn around.' : `Turn ${turnDir}, to ${clockOf(err)} o'clock.`, 'turn', () => { this.turning = true; });
        } else if (now - this.lastTick >= o.tickEvery) {
          out.tone = 'tick';
          this.lastTick = now;
        }
        out.status = { text: `Turn ${turnDir} ${Math.round(Math.abs(err))}°`, remaining, headingError: err };
        return flush();
      }
      if (this.turning && Math.abs(err) > o.alignDone) {
        if (now - this.lastTick >= o.tickEvery) { out.tone = 'tick'; this.lastTick = now; }
        out.status = { text: `Keep turning ${turnDir}`, remaining, headingError: err };
        return flush();
      }
      if (this.turning) add('Go straight.', 'turn');
      this.turning = false;
      this.aligned = true;
    }

    // The next real turn along the route, with category hysteresis per turn.
    const turns = maneuvers(path).map((m) => {
      const key = `${Math.round(m.at[0] * 2)},${Math.round(m.at[1] * 2)}`;
      const cat = turnCategory(Math.abs(m.angle), this.cats.get(key) ?? null);
      this.cats.set(key, cat);
      return { ...m, key, cat };
    }).filter((m) => m.cat !== 'straight');
    const next = turns[0];
    if (!next) {
      out.status = { text: `Straight on, ${this.d(remaining)} to go`, remaining, headingError: err };
      return flush();
    }
    const phrase = turnPhrase(next.angle, next.cat);
    const then = turns[1] && turns[1].along - next.along < o.chain ? `, then ${turnPhrase(turns[1].angle, turns[1].cat)}` : '';
    const flags = this.announced.get(next.key) ?? {};
    this.announced.set(next.key, flags);
    if (next.along <= o.near) {
      if (!flags.now) add(`${cap(phrase)} now${then}.`, 'turn', () => { flags.now = flags.far = true; });
    } else if (next.along <= o.far + 0.5) {
      if (!flags.far) add(`In ${this.d(Math.max(1, Math.round(next.along)))}, ${phrase}${then}.`, 'turn', () => { flags.far = true; });
    }
    out.status = { text: `In ${Math.round(next.along)} m, ${phrase}`, remaining, headingError: err };
    return flush();
  }
}

/** Point `s` metres along a polyline. */
export function pointAlong(path, s) {
  for (let i = 1; i < path.length; i++) {
    const L = dist(path[i - 1], path[i]);
    if (s <= L || i === path.length - 1) {
      const f = L ? Math.min(1, s / L) : 0;
      return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f];
    }
    s -= L;
  }
  return path[path.length - 1];
}

/** Shortest distance from p to a polyline. */
export function distanceToPath(p, path) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const [a, b] = [path[i - 1], path[i]];
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz));
  }
  return path.length === 1 ? dist(p, path[0]) : best;
}
