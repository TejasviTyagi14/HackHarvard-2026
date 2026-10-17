// Route planning on the floor grid, following the usual recipe for walking navigation:
//   • obstacles grown by your body radius, with a cost that fades with distance so routes keep
//     clear of walls;
//   • unseen cells blocked within 2 m of you and allowed, with a penalty, beyond that;
//   • a Dijkstra cost-to-go field rooted at the goal, computed once per goal or map change, so
//     the route from wherever you are is just a walk downhill (microseconds), and re-routing is
//     automatic;
//   • the route straightened along lines of sight, simplified, and short legs merged.
// Pure logic, no DOM.

export const PLAN_DEFAULTS = {
  radius: 0.25, // body radius (m): closer than this to an obstacle is impassable
  fade: 0.6, // extra wall-clearance cost fades out over this distance (m)
  wallCost: 6, // cost multiplier right at the edge of the radius
  unknownNear: 2, // unseen cells within this distance of you are treated as blocked
  unknownCost: 4, // …and cost this much extra beyond it
  snapRadius: 1.5, // how far a goal may be moved to reach a usable cell (m)
};

/** Cost per cell (Infinity = can't go there) for a grid snapshot { x0, z0, cell, w, h, data }. */
export function costMap(grid, user, opts = {}) {
  const o = { ...PLAN_DEFAULTS, ...opts };
  const { w, h, cell, data } = grid;
  const n = w * h;
  // Distance (in cells) to the nearest obstacle: two-pass chamfer transform.
  const dist = new Float32Array(n).fill(1e9);
  for (let i = 0; i < n; i++) if (data[i] === 1) dist[i] = 0;
  const D1 = 1, D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + D1);
      if (y > 0) {
        d = Math.min(d, dist[i - w] + D1);
        if (x > 0) d = Math.min(d, dist[i - w - 1] + D2);
        if (x < w - 1) d = Math.min(d, dist[i - w + 1] + D2);
      }
      dist[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + D1);
      if (y < h - 1) {
        d = Math.min(d, dist[i + w] + D1);
        if (x < w - 1) d = Math.min(d, dist[i + w + 1] + D2);
        if (x > 0) d = Math.min(d, dist[i + w - 1] + D2);
      }
      dist[i] = d;
    }
  }
  const cost = new Float32Array(n);
  const [ui, uj] = toCell(grid, user.x, user.z);
  const nearCells = o.unknownNear / cell;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dm = dist[i] * cell;
      if (data[i] === 1 || dm < o.radius) { cost[i] = Infinity; continue; }
      let c = 1;
      if (dm < o.radius + o.fade) c += o.wallCost * ((1 - (dm - o.radius) / o.fade) ** 2);
      if (data[i] === -1) {
        if (Math.hypot(x - ui, y - uj) < nearCells) { cost[i] = Infinity; continue; }
        c += o.unknownCost;
      }
      cost[i] = c;
    }
  }
  return { ...grid, cost, clearance: dist };
}

export function toCell(grid, x, z) {
  return [Math.floor((x - grid.x0) / grid.cell), Math.floor((z - grid.z0) / grid.cell)];
}

export function toWorld(grid, i, j) {
  return [grid.x0 + (i + 0.5) * grid.cell, grid.z0 + (j + 0.5) * grid.cell];
}

const inside = (g, i, j) => i >= 0 && j >= 0 && i < g.w && j < g.h;

/** Nearest cell to (i, j) you can stand in, within maxR cells; null if none. */
export function snapToReachable(cm, i, j, maxR) {
  let best = null, bd = Infinity;
  for (let r = 0; r <= maxR && !best; r++) {
    for (let y = j - r; y <= j + r; y++) {
      for (let x = i - r; x <= i + r; x++) {
        if (Math.max(Math.abs(x - i), Math.abs(y - j)) !== r || !inside(cm, x, y)) continue;
        if (!Number.isFinite(cm.cost[y * cm.w + x])) continue;
        const d = Math.hypot(x - i, y - j);
        if (d < bd) { bd = d; best = [x, y]; }
      }
    }
  }
  return best;
}

const NEIGHBOURS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/** Cost-to-go (m, weighted) from every cell to the goal cell; Infinity where unreachable. */
export function dijkstra(cm, gi, gj) {
  const { w, h, cost, cell } = cm;
  const n = w * h;
  const field = new Float64Array(n).fill(Infinity); // same precision as the heap, or settled cells look stale
  const heap = new MinHeap(n);
  const g = gj * w + gi;
  field[g] = 0;
  heap.push(g, 0);
  while (heap.size) {
    const [k, d] = heap.pop();
    if (d > field[k]) continue;
    const x = k % w, y = (k / w) | 0;
    for (const [dx, dy, len] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const m = ny * w + nx;
      const c = cost[m];
      if (!Number.isFinite(c)) continue;
      // No cutting corners diagonally past a blocked cell.
      if (dx && dy && (!Number.isFinite(cost[y * w + nx]) || !Number.isFinite(cost[ny * w + x]))) continue;
      const nd = d + len * cell * 0.5 * (c + cost[k]);
      if (nd < field[m]) { field[m] = nd; heap.push(m, nd); }
    }
  }
  return field;
}

/** Cells from (si, sj) downhill to the goal; null if there's no way. */
export function descend(field, cm, si, sj, maxSteps = 20000) {
  const { w, h } = cm;
  if (!inside(cm, si, sj) || !Number.isFinite(field[sj * w + si])) return null;
  const out = [[si, sj]];
  let x = si, y = sj;
  for (let s = 0; s < maxSteps; s++) {
    const here = field[y * w + x];
    if (here === 0) return out;
    let best = here, bx = -1, by = -1;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const v = field[ny * w + nx];
      if (v < best) { best = v; bx = nx; by = ny; }
    }
    if (bx < 0) return null;
    x = bx; y = by;
    out.push([x, y]);
  }
  return null;
}

/** True if a straight walk from a to b (cells) stays on usable, low-cost cells. */
export function lineOfSight(cm, a, b, maxCost = 2.5) {
  let [x, y] = a;
  const [x1, y1] = b;
  const dx = Math.abs(x1 - x), dy = Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    const c = cm.cost[y * cm.w + x];
    if (!(c <= maxCost)) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function rdp(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
  let far = -1, fd = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
    if (d > fd) { fd = d; far = i; }
  }
  if (fd <= tol) return [a, b];
  return [...rdp(pts.slice(0, far + 1), tol).slice(0, -1), ...rdp(pts.slice(far), tol)];
}

/**
 * Turns a cell path into a few waypoints (world x, z): straightened where there's a clear line
 * of sight, simplified (0.25 m), and with legs under 1 m merged when that stays clear.
 */
export function smooth(cm, cells) {
  if (!cells || cells.length < 2) return cells?.map(([i, j]) => toWorld(cm, i, j)) ?? null;
  // Pull the path straight: from each kept point, go as far along the path as stays in sight.
  const keep = [cells[0]];
  let a = 0;
  while (a < cells.length - 1) {
    let b = a + 1;
    while (b + 1 < cells.length && lineOfSight(cm, cells[a], cells[b + 1])) b++;
    keep.push(cells[b]);
    a = b;
  }
  let pts = rdp(keep.map(([i, j]) => toWorld(cm, i, j)), 0.25);
  for (let i = 1; i < pts.length - 1;) {
    const short = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < 1;
    if (short && lineOfSight(cm, toCell(cm, ...pts[i - 1]), toCell(cm, ...pts[i + 1]))) pts.splice(i, 1);
    else i++;
  }
  return pts;
}

export const pathLength = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

/**
 * A planner for one goal: build it when the goal or map changes, then call route(user) as often
 * as you like. If the goal can't be reached it guides to the reachable point closest to it.
 */
export class GoalPlanner {
  constructor(grid, goal, user, opts = {}) {
    this.o = { ...PLAN_DEFAULTS, ...opts };
    this.grid = grid;
    this.goal = goal;
    this.cm = costMap(grid, user, this.o);
    const [gi, gj] = toCell(grid, goal.x, goal.z);
    const snapped = snapToReachable(this.cm, gi, gj, Math.round(this.o.snapRadius / grid.cell));
    this.snapped = snapped ? toWorld(grid, ...snapped) : null;
    this.field = snapped ? dijkstra(this.cm, snapped[0], snapped[1]) : null;
    this.partial = false;
    const [ui, uj] = toCell(grid, user.x, user.z);
    const startCell = snapToReachable(this.cm, ui, uj, 6);
    if (!this.field || !startCell || !Number.isFinite(this.field[startCell[1] * grid.w + startCell[0]])) {
      // Unreachable: aim for the cell you *can* reach that's closest to the goal.
      this.fallback(startCell, gi, gj);
    }
  }

  fallback(startCell, gi, gj) {
    if (!startCell) { this.field = null; return; }
    const fromUser = dijkstra(this.cm, startCell[0], startCell[1]);
    let best = null, bd = Infinity;
    for (let j = 0; j < this.grid.h; j++) {
      for (let i = 0; i < this.grid.w; i++) {
        if (!Number.isFinite(fromUser[j * this.grid.w + i])) continue;
        const d = Math.hypot(i - gi, j - gj);
        if (d < bd) { bd = d; best = [i, j]; }
      }
    }
    if (!best) { this.field = null; return; }
    this.partial = true;
    this.snapped = toWorld(this.grid, ...best);
    this.gap = bd * this.grid.cell; // how far short of the real goal this gets you
    this.field = dijkstra(this.cm, best[0], best[1]);
  }

  /** { ok, path: [[x, z], …] starting at the user, length, partial, gap } */
  route(user) {
    if (!this.field) return { ok: false, reason: 'no-route' };
    const [ui, uj] = toCell(this.grid, user.x, user.z);
    const s = snapToReachable(this.cm, ui, uj, 6);
    if (!s) return { ok: false, reason: 'boxed-in' };
    const cells = descend(this.field, this.cm, s[0], s[1]);
    if (!cells) return { ok: false, reason: 'no-route' };
    const pts = smooth(this.cm, cells);
    pts[0] = [user.x, user.z];
    return { ok: true, path: pts, length: pathLength(pts), partial: this.partial, gap: this.gap ?? 0 };
  }
}

class MinHeap {
  constructor(cap) {
    this.k = new Int32Array(cap + 1);
    this.v = new Float64Array(cap + 1);
    this.size = 0;
  }
  push(k, v) {
    if (this.size + 1 >= this.k.length) {
      const k2 = new Int32Array(this.k.length * 2), v2 = new Float64Array(this.v.length * 2);
      k2.set(this.k); v2.set(this.v);
      this.k = k2; this.v = v2;
    }
    let i = ++this.size;
    while (i > 1 && this.v[i >> 1] > v) { this.k[i] = this.k[i >> 1]; this.v[i] = this.v[i >> 1]; i >>= 1; }
    this.k[i] = k; this.v[i] = v;
  }
  pop() {
    const k = this.k[1], v = this.v[1];
    const lk = this.k[this.size], lv = this.v[this.size--];
    let i = 1;
    for (;;) {
      let c = i * 2;
      if (c > this.size) break;
      if (c + 1 <= this.size && this.v[c + 1] < this.v[c]) c++;
      if (this.v[c] >= lv) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = lk; this.v[i] = lv;
    return [k, v];
  }
}
