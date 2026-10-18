// Flat space as surfaces, and only what's left over as points. Most of the voxel cloud is floor,
// walls and the tops of furniture; drawn as dots that's a fog (one-camera depth especially), when
// those are really a few flat surfaces the view can draw solid. Each voxel here is explained by the
// floor, a wall, a detected object, or a slab (a table top, counter, bed or shelf found here);
// what nothing explains, and isn't a lone speck, is the leftover cloud still drawn as points.
// Pure logic, no DOM.

export const SURFACE_DEFAULTS = {
  // Everything lower is floor, including what's under it: one-camera depth puts a lot of noise
  // just below the floor, and nothing real can be seen through it (stairs down show on the plan).
  // Voxel centres sit at 2.5, 7.5, 12.5 cm…, so this takes the bottom two layers (World's stepHeight):
  // at 7 cm it took one, and a floor smeared ±3 cm left its whole second layer as a carpet of dots.
  floorTol: 0.1,
  wallTol: 0.12, // this close to a wall's line…
  wallPad: 0.1, // …within this of its ends…
  wallAbove: 0.15, // …and below its top + this, is wall
  wallCell: 0.25, // floor cells walls and objects are filed under, so a voxel tests only its own few
  objPad: 0.08, // an object's footprint grows by this (its box is only a rough fit)
  objBelow: 0.05, objAbove: 0.1, // and its height range by these
  slabLo: 0.25, slabHi: 1.8, // heights a slab can be at
  slabCell: 0.1, // floor cells (in the walls' frame) slabs are found in
  slabBand: 0.06, // a cell is flat where this much height (one or two 5 cm voxel layers)…
  slabMinPts: 3, // …holds this many voxels…
  slabSpread: 0.15, slabMajor: 0.55, // …and this share of the views within ±spread (a vertical surface spreads evenly)
  slabDh: 0.06, // neighbouring flat cells this close in height are the same surface…
  slabRise: 0.2, // …and level: its cells' heights (trimmed) span at most this (a ramp, not a map a few degrees off)
  slabMinArea: 0.2, slabMinSide: 0.2, slabFill: 0.5, // m², m, share of its rectangle
  slabTrim: 0.03, // share of cells left out at each side when fitting its rectangle (stray bits)
  slabTol: 0.055, // over a slab, voxels this close to its height are part of it…
  slabSpan: 2, slabLayer: 0.3, // …and so are the voxel layers (up to span each way) holding this share of its fullest
  maxSlabs: 30,
  minNeighbors: 2, // a leftover voxel needs this many occupied neighbours (of 26) not to be a speck
};

const FLOOR = 1, WALL = 2, OBJECT = 3, SLAB = 4, SPECK = 5, KEPT = 6;

// A voxel's cell (i, j, k) packs into one exact key, ((i + 2¹⁶)·S + j + 2¹⁶)·S + k + 2¹⁶, and an
// additive hash i·HA + j·HB + k·HC, so a neighbour's key and hash are just the voxel's plus an offset.
const S = 131072, HA = 0x9e3779b1 | 0, HB = 0x85ebca77 | 0, HC = 0xc2b2ae3d | 0;
// The 26 neighbours, faces first (on a surface those are the likeliest to be there).
const NB = [];
for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (a || b || c) NB.push([a, b, c]);
NB.sort((p, q) => Math.abs(p[0]) + Math.abs(p[1]) + Math.abs(p[2]) - (Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2])));
const KOFF = Float64Array.from(NB, (d) => (d[0] * S + d[1]) * S + d[2]);
const HOFF = Int32Array.from(NB, (d) => (Math.imul(d[0], HA) + Math.imul(d[1], HB) + Math.imul(d[2], HC)) | 0);
const mix = (h, mask) => { h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); return (h ^ (h >>> 16)) & mask; };

/**
 * voxels: iterable of { x, y, z, n, g } (map frame, y down, floor at 0; n = views, g = gray).
 * walls: WallMap.list(). objects: [{ x, z, bottom, w, h, d, yaw }] (bottom = map y of the base).
 * axis: the walls' direction (rad), which slabs line up with.
 * Returns { clean: { xyz, gray }, slabs: [{ x, z, w, d, yaw, h, n }], stats }:
 *   clean = voxels with n >= minHits that nothing explains (at most maxPoints, best-seen first);
 *   slabs = flat tops: w along (cos yaw, sin yaw), d across, h above the floor, n voxels;
 *   stats = { total, floor, wall, object, slab, speck, kept, capped }, where total counts only
 *   voxels with n >= minHits and is the sum of the rest (capped = left out by maxPoints).
 * Each step is its own small function: V8 optimizes those far better than one long one.
 */
export function buildSurfaces(voxels, { minHits = 2, voxel = 0.05, walls = [], objects = [], axis = 0, maxPoints = 300000, ...tuning } = {}) {
  const o = { ...SURFACE_DEFAULTS, ...tuning };
  const yaw = Number.isFinite(axis) ? axis : 0;
  maxPoints = typeof maxPoints === 'number' && maxPoints >= 0 ? Math.floor(maxPoints) : 300000; // null or NaN would keep nothing, < 0 would throw
  const P = gather(voxels, minHits, voxel), cls = new Uint8Array(P.m);
  const stats = { total: P.m, floor: 0, wall: 0, object: 0, slab: 0, speck: 0, kept: 0, capped: 0 };
  explain(P, cls, fileUnder(walls || [], objects || [], o), o, stats);
  const slabs = findSlabs(P, cls, yaw, voxel, o);
  stats.slab = slabs.claimed;
  const kept = specks(P, cls, o.minNeighbors);
  stats.speck = P.m - stats.floor - stats.wall - stats.object - stats.slab - kept;
  const clean = leftovers(P, cls, kept, maxPoints);
  stats.kept = clean.gray.length;
  stats.capped = kept - stats.kept;
  return { clean, slabs: slabs.list, stats };
}

/** The shown voxels (n >= minHits) in flat arrays, each with its packed cell key and hash. */
function gather(voxels, minHits, voxel) {
  const refs = [];
  for (const v of voxels) if (v.n >= minHits) refs.push(v);
  const m = refs.length, inv = 1 / voxel;
  const P = { m, X: new Float32Array(m), Y: new Float32Array(m), Z: new Float32Array(m), N: new Int32Array(m), G: new Uint8Array(m), KEY: new Float64Array(m), H0: new Int32Array(m) };
  const { X, Y, Z, N, G, KEY, H0 } = P;
  for (let p = 0; p < m; p++) {
    const v = refs[p], g = v.g;
    X[p] = v.x; Y[p] = v.y; Z[p] = v.z; N[p] = v.n; G[p] = g >= 255 ? 255 : g > 0 ? g + 0.5 : 0;
    // Voxel centres sit at (i + ½)·voxel, so floor() gives i exactly where round() would be a coin toss.
    const i = Math.floor(v.x * inv), j = Math.floor(v.y * inv), k = Math.floor(v.z * inv);
    KEY[p] = ((i + 65536) * S + (j + 65536)) * S + (k + 65536);
    H0[p] = (Math.imul(i, HA) + Math.imul(j, HB) + Math.imul(k, HC)) | 0;
  }
  return P;
}

/** Floor, walls and objects: one look each, at the walls and objects filed under the voxel's cell. */
function explain({ m, X, Y, Z }, cls, f, o, stats) {
  for (let p = 0; p < m; p++) {
    const ht = -Y[p];
    if (ht < o.floorTol) { cls[p] = FLOOR; stats.floor++; continue; }
    if (!f) continue;
    const gi = Math.floor((X[p] - f.x0) / f.cell), gj = Math.floor((Z[p] - f.z0) / f.cell);
    if (gi < 0 || gj < 0 || gi >= f.nx || gj >= f.nz) continue;
    const c = gj * f.nx + gi;
    for (let e = f.start[c], end = f.start[c + 1]; e < end; e++) {
      const q = f.items[e];
      if (q < f.nw) {
        const dx = X[p] - f.wx[q], dz = Z[p] - f.wz[q], t = dx * f.wux[q] + dz * f.wuz[q];
        if (t < -o.wallPad || t > f.wl[q] + o.wallPad || Math.abs(dz * f.wux[q] - dx * f.wuz[q]) >= o.wallTol || ht >= f.wtop[q]) continue;
        cls[p] = WALL; stats.wall++;
      } else {
        const k = q - f.nw, dx = X[p] - f.ox[k], dz = Z[p] - f.oz[k];
        if (Math.abs(dx * f.oc[k] - dz * f.os[k]) >= f.ohw[k] || Math.abs(dx * f.os[k] + dz * f.oc[k]) >= f.ohd[k] || ht < f.olo[k] || ht > f.ohi[k]) continue;
        cls[p] = OBJECT; stats.object++;
      }
      break; // walls are filed before objects, so a voxel on both counts as wall
    }
  }
}

/**
 * Specks: a leftover voxel with fewer than `need` of its 26 neighbours shown (counting every
 * shown voxel, floor and walls too) is noise. Marks the rest KEPT; returns how many.
 */
function specks({ m, KEY, H0 }, cls, need) {
  // Open addressing on the packed keys themselves (0 = empty; real keys are far above 0).
  const mask = (1 << Math.ceil(Math.log2(2 * m + 2))) - 1, table = new Float64Array(mask + 1);
  for (let p = 0; p < m; p++) {
    const key = KEY[p];
    for (let s = mix(H0[p], mask); ; s = (s + 1) & mask) {
      const t = table[s];
      if (t === 0) { table[s] = key; break; }
      if (t === key) break; // the same cell twice: once is enough
    }
  }
  let kept = 0;
  for (let p = 0; p < m; p++) {
    if (cls[p]) continue;
    const key = KEY[p], h0 = H0[p];
    let c = 0;
    for (let d = 0; d < 26 && c < need; d++) {
      const nk = key + KOFF[d];
      for (let s = mix((h0 + HOFF[d]) | 0, mask); ; s = (s + 1) & mask) {
        const t = table[s];
        if (t === 0) break;
        if (t === nk) { c++; break; }
      }
    }
    if (c >= need) { cls[p] = KEPT; kept++; } else cls[p] = SPECK;
  }
  return kept;
}

/** The KEPT voxels as points; when there are too many, the best-seen (views counted up to 1023; ties go in order). */
function leftovers({ m, X, Y, Z, N, G }, cls, kept, maxPoints) {
  let cut = -1, ties = 0;
  if (kept > maxPoints) {
    const hist = new Int32Array(1024);
    for (let p = 0; p < m; p++) if (cls[p] === KEPT) hist[Math.min(1023, N[p])]++;
    let above = 0;
    for (cut = 1023; above + hist[cut] <= maxPoints; cut--) above += hist[cut];
    ties = maxPoints - above;
  }
  const out = Math.min(kept, maxPoints), xyz = new Float32Array(out * 3), gray = new Uint8Array(out);
  for (let p = 0, w = 0; p < m && w < out; p++) {
    if (cls[p] !== KEPT) continue;
    const nv = Math.min(1023, N[p]);
    if (nv < cut || (nv === cut && ties-- <= 0)) continue;
    xyz[w * 3] = X[p]; xyz[w * 3 + 1] = Y[p]; xyz[w * 3 + 2] = Z[p]; gray[w] = G[p];
    w++;
  }
  return { xyz, gray };
}

/**
 * Walls and objects filed under the floor cells they reach (CSR: the items of cell c are
 * items[start[c] .. start[c+1]), walls first), with what the per-voxel tests need precomputed.
 * Null when there's nothing to file.
 */
function fileUnder(walls, objects, o) {
  const nw = walls.length, no = objects.length;
  if (!nw && !no) return null;
  const f = {
    nw, wx: new Float64Array(nw), wz: new Float64Array(nw), wux: new Float64Array(nw), wuz: new Float64Array(nw), wl: new Float64Array(nw), wtop: new Float64Array(nw),
    ox: new Float64Array(no), oz: new Float64Array(no), oc: new Float64Array(no), os: new Float64Array(no),
    ohw: new Float64Array(no), ohd: new Float64Array(no), olo: new Float64Array(no), ohi: new Float64Array(no),
  };
  const box = []; // each item's floor-plan bounds [x0, z0, x1, z1]
  walls.forEach((w, q) => {
    const L = Math.hypot(w.x1 - w.x0, w.z1 - w.z0);
    f.wx[q] = w.x0; f.wz[q] = w.z0; f.wl[q] = L; f.wtop[q] = (w.top ?? Infinity) + o.wallAbove;
    f.wux[q] = L > 1e-9 ? (w.x1 - w.x0) / L : 1; f.wuz[q] = L > 1e-9 ? (w.z1 - w.z0) / L : 0;
    const r = o.wallPad + o.wallTol;
    box.push([Math.min(w.x0, w.x1) - r, Math.min(w.z0, w.z1) - r, Math.max(w.x0, w.x1) + r, Math.max(w.z0, w.z1) + r]);
  });
  objects.forEach((b, k) => {
    // The same footprint test as inObject() in walls.js: w along (cos yaw, −sin yaw), d across it.
    const c = Math.cos(b.yaw || 0), s = Math.sin(b.yaw || 0), base = -(b.bottom || 0);
    f.ox[k] = b.x; f.oz[k] = b.z; f.oc[k] = c; f.os[k] = s;
    f.ohw[k] = b.w / 2 + o.objPad; f.ohd[k] = b.d / 2 + o.objPad;
    f.olo[k] = base - o.objBelow; f.ohi[k] = base + b.h + o.objAbove;
    const ex = f.ohw[k] * Math.abs(c) + f.ohd[k] * Math.abs(s), ez = f.ohw[k] * Math.abs(s) + f.ohd[k] * Math.abs(c);
    box.push([b.x - ex, b.z - ez, b.x + ex, b.z + ez]);
  });
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  // A broken item mustn't spoil the rest, and a wall with no length has no line to be near.
  const ok = box.map((b, q) => b.every(Number.isFinite) && (q >= nw || f.wl[q] > 1e-6));
  box.forEach((b, q) => { if (ok[q]) { x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); } });
  if (!(x1 >= x0 && z1 >= z0)) return null;
  let cell = o.wallCell;
  const cells = ((x1 - x0) / cell + 1) * ((z1 - z0) / cell + 1);
  if (cells > 1 << 22) cell *= Math.sqrt(cells / (1 << 22)); // a very spread-out map: coarser cells
  const nx = Math.floor((x1 - x0) / cell) + 1, nz = Math.floor((z1 - z0) / cell) + 1, r2 = cell * cell / 2;
  // An item reaches a cell when the cell's centre is within half its diagonal of the item's area.
  const pairs = [];
  box.forEach((b, q) => {
    if (!ok[q]) return;
    for (let gj = Math.floor((b[1] - z0) / cell); gj <= Math.floor((b[3] - z0) / cell); gj++) {
      for (let gi = Math.floor((b[0] - x0) / cell); gi <= Math.floor((b[2] - x0) / cell); gi++) {
        const cx = x0 + (gi + 0.5) * cell, cz = z0 + (gj + 0.5) * cell;
        let da, db;
        if (q < nw) {
          const dx = cx - f.wx[q], dz = cz - f.wz[q], t = dx * f.wux[q] + dz * f.wuz[q];
          da = Math.max(0, -o.wallPad - t, t - f.wl[q] - o.wallPad);
          db = Math.max(0, Math.abs(dz * f.wux[q] - dx * f.wuz[q]) - o.wallTol);
        } else {
          const k = q - nw, dx = cx - f.ox[k], dz = cz - f.oz[k];
          da = Math.max(0, Math.abs(dx * f.oc[k] - dz * f.os[k]) - f.ohw[k]);
          db = Math.max(0, Math.abs(dx * f.os[k] + dz * f.oc[k]) - f.ohd[k]);
        }
        if (da * da + db * db <= r2) pairs.push(gj * nx + gi, q);
      }
    }
  });
  const start = new Int32Array(nx * nz + 1), items = new Int32Array(pairs.length / 2);
  for (let e = 0; e < pairs.length; e += 2) start[pairs[e] + 1]++;
  for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * nz);
  for (let e = 0; e < pairs.length; e += 2) items[fill[pairs[e]]++] = pairs[e + 1]; // in item order: walls first
  return Object.assign(f, { x0, z0, cell, nx, nz, start, items });
}

/**
 * Horizontal flat surfaces among the voxels nothing has explained yet: cells (in the walls' frame)
 * with a thin band of height holding most of their views, joined with neighbours at the same height,
 * kept when level and filling most of a good-sized rectangle. Marks the voxels on them SLAB.
 * Returns { list, claimed }.
 */
function findSlabs({ m, X, Y, Z, N }, cls, yaw, voxel, o) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw), sc = o.slabCell;
  // Candidates sorted by (cell, height) in one key, views last: cell (2 × 16 bits) · 2048 + height
  // above `lo` in 1/2047ths of the range, then · 256 + views (up to 255). They reach slabSpread past
  // the slab heights, so the flatness check is fair at the edges.
  const lo = o.slabLo - o.slabSpread, hi = o.slabHi + o.slabSpread, hq = 2047 / (hi - lo), HW = 2048 * 256;
  let nc = 0;
  for (let p = 0; p < m; p++) if (!cls[p] && -Y[p] >= lo && -Y[p] <= hi) nc++;
  const keys = new Float64Array(nc);
  for (let p = 0, k = 0; p < m; p++) {
    const ht = -Y[p];
    if (cls[p] || ht < lo || ht > hi) continue;
    const ci = Math.floor((X[p] * ca + Z[p] * sa) / sc) + 32768, cj = Math.floor((Z[p] * ca - X[p] * sa) / sc) + 32768;
    keys[k++] = ((ci * 65536 + cj) * 2048 + Math.round((ht - lo) * hq)) * 256 + Math.max(0, Math.min(255, N[p]));
  }
  keys.sort();

  // Each cell's flat levels: its band of heights seen most often, then the next, while one holds
  // slabMinPts voxels. Views, not voxels: a top seen often from one camera fills 4–5 voxel layers
  // all alike, and only how often each layer was seen still says where the top really is.
  const hs = new Float64Array(nc), ws = new Float64Array(nc), used = new Uint8Array(nc);
  const fCell = [], fH = [], fN = [], minPts = Math.max(1, o.slabMinPts);
  for (let s = 0; s < nc;) {
    const cell = Math.floor(keys[s] / HW);
    let e = s;
    for (; e < nc && Math.floor(keys[e] / HW) === cell; e++) {
      const r = keys[e] - cell * HW, q = Math.floor(r / 256);
      hs[e] = lo + q / hq; ws[e] = r - q * 256;
    }
    for (;;) {
      // Two pointers over each stretch of unused heights (taken levels are contiguous runs), with
      // the views in the window [i, j) summed as it slides.
      let bi = 0, bj = 0, bw = 0;
      for (let i = s, j = s, w = 0; i < e; i++) {
        if (used[i]) { j = i + 1; w = 0; continue; }
        while (j < e && !used[j] && hs[j] - hs[i] <= o.slabBand + 1e-9) w += ws[j++];
        if (j - i >= minPts && w > bw) { bi = i; bj = j; bw = w; }
        w -= ws[i];
      }
      if (!bw) break;
      let sum = 0;
      for (let i = bi; i < bj; i++) { sum += hs[i] * ws[i]; used[i] = 1; }
      const h = sum / bw;
      let near = 0;
      for (let i = s; i < e; i++) if (Math.abs(hs[i] - h) <= o.slabSpread) near += ws[i];
      if (h >= o.slabLo && h <= o.slabHi && bw >= o.slabMajor * near) { fCell.push(cell); fH.push(h); fN.push(bw); }
    }
    s = e;
  }

  // Surfaces: flat cells joined across the 8 neighbours when at the same height (levels of one
  // cell are different shelves, never joined). Breadth-first; each component is a run of `order`.
  const nf = fCell.length, first = new Map(), seen = new Uint8Array(nf), order = new Int32Array(nf);
  const tmp = new Int32Array(nf), tmpH = new Float64Array(nf);
  for (let q = nf - 1; q >= 0; q--) first.set(fCell[q], q);
  const found = [];
  for (let q0 = 0, tail = 0; q0 < nf; q0++) {
    if (seen[q0]) continue;
    const cs = tail;
    seen[q0] = 1; order[tail++] = q0;
    for (let head = cs; head < tail; head++) {
      const q = order[head];
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue;
          const key = fCell[q] + di * 65536 + dj;
          let r = first.get(key);
          if (r === undefined) continue;
          for (; r < nf && fCell[r] === key; r++) {
            if (!seen[r] && Math.abs(fH[r] - fH[q]) < o.slabDh) { seen[r] = 1; order[tail++] = r; }
          }
        }
      }
    }
    const cells = tail - cs;
    if (cells * sc * sc < o.slabMinArea) continue;
    // Its rectangle: the cells' extent along and across the axis, a few stray cells trimmed off.
    const range = (t, pick) => {
      for (let i = 0; i < cells; i++) t[i] = pick(order[cs + i]);
      t = t.subarray(0, cells).sort();
      return [t[Math.floor(o.slabTrim * (cells - 1))], t[Math.ceil((1 - o.slabTrim) * (cells - 1))]];
    };
    // Level, too: a ramp, or a floor that depth error bends up, joins up cell by cell just the same.
    const [h0, h1] = range(tmpH, (q) => fH[q]);
    if (h1 - h0 > o.slabRise) continue;
    const [i0, i1] = range(tmp, (q) => Math.floor(fCell[q] / 65536)), [j0, j1] = range(tmp, (q) => fCell[q] % 65536);
    let inside = 0, sh = 0, sn = 0;
    for (let i = cs; i < tail; i++) {
      const c = fCell[order[i]], ci = Math.floor(c / 65536), cj = c % 65536;
      if (ci < i0 || ci > i1 || cj < j0 || cj > j1) continue;
      inside++; sh += fH[order[i]] * fN[order[i]]; sn += fN[order[i]];
    }
    const wa = (i1 - i0 + 1) * sc, wb = (j1 - j0 + 1) * sc;
    if (wa < o.slabMinSide || wb < o.slabMinSide || inside * sc * sc < o.slabMinArea || inside < o.slabFill * (i1 - i0 + 1) * (j1 - j0 + 1)) continue;
    found.push({ a0: (i0 - 32768) * sc, a1: (i1 - 32767) * sc, b0: (j0 - 32768) * sc, b1: (j1 - 32767) * sc, h: sh / sn, cells: inside });
  }
  found.sort((p, q) => q.cells - p.cells);
  const kept = found.slice(0, Math.min(o.maxSlabs, 255));
  if (!kept.length) return { list: [], claimed: 0 };

  // How thick each slab is: one-camera depth smears a flat top over a few voxel layers. Over its
  // rectangle, each slab counts the voxels layer by layer (k = −span … span about its height) and
  // takes in the layers beside its own that hold at least slabLayer of the fullest one.
  const span = o.slabSpan, L = 2 * span + 1, reach = (span + 0.5) * voxel, hlo = o.slabLo - reach, hhi = o.slabHi + reach;
  const prof = new Int32Array(kept.length * L), slabOf = new Uint8Array(m), layerOf = new Uint8Array(m);
  for (let p = 0; p < m; p++) {
    const ht = -Y[p];
    if (cls[p] || ht < hlo || ht > hhi) continue;
    const a = X[p] * ca + Z[p] * sa, b = Z[p] * ca - X[p] * sa;
    let best = 0, bd = reach;
    for (let q = 0; q < kept.length; q++) {
      const s = kept[q];
      if (a < s.a0 || a >= s.a1 || b < s.b0 || b >= s.b1 || Math.abs(ht - s.h) >= bd) continue;
      bd = Math.abs(ht - s.h); best = q + 1; // the nearest in height, for shelves one over another
    }
    if (!best) continue;
    const k = Math.max(0, Math.min(L - 1, Math.round((ht - kept[best - 1].h) / voxel) + span));
    slabOf[p] = best; layerOf[p] = k; prof[(best - 1) * L + k]++;
  }
  kept.forEach((s, q) => {
    const c = prof.subarray(q * L, q * L + L), full = Math.max(1, o.slabLayer * Math.max(c[span - 1] ?? 0, c[span], c[span + 1] ?? 0));
    let k0 = span, k1 = span;
    while (k0 > 0 && c[k0 - 1] >= full) k0--;
    while (k1 < L - 1 && c[k1 + 1] >= full) k1++;
    Object.assign(s, { k0, k1, n: 0, amin: Infinity, amax: -Infinity, bmin: Infinity, bmax: -Infinity });
  });

  // Its layers, and anything within slabTol of its height, are the slab; their extent tightens the rectangle.
  let claimed = 0;
  for (let p = 0; p < m; p++) {
    if (!slabOf[p]) continue;
    const s = kept[slabOf[p] - 1], k = layerOf[p];
    if ((k < s.k0 || k > s.k1) && Math.abs(-Y[p] - s.h) > o.slabTol) continue;
    const a = X[p] * ca + Z[p] * sa, b = Z[p] * ca - X[p] * sa;
    cls[p] = SLAB; claimed++; s.n++;
    if (a < s.amin) s.amin = a;
    if (a > s.amax) s.amax = a;
    if (b < s.bmin) s.bmin = b;
    if (b > s.bmax) s.bmax = b;
  }
  const list = kept.filter((s) => s.n > 0).map((s) => {
    const a0 = Math.max(s.a0, s.amin - voxel / 2), a1 = Math.min(s.a1, s.amax + voxel / 2);
    const b0 = Math.max(s.b0, s.bmin - voxel / 2), b1 = Math.min(s.b1, s.bmax + voxel / 2);
    const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
    return { x: am * ca - bm * sa, z: am * sa + bm * ca, w: a1 - a0, d: b1 - b0, yaw, h: s.h, n: s.n };
  });
  return { list, claimed };
}
