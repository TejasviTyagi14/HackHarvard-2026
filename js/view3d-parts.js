// Shared bits for the 3D view: the two colour themes, soft round textures drawn once on a
// canvas, and flat ribbons lying on the floor (the route and the path walked).
import * as THREE from 'three';

// Calm, near-neutral surfaces and one accent colour. Surface colours are albedos: what you see
// also depends on the lights below and the tone mapping, so these were tuned by eye.
export const THEMES = {
  dark: {
    bg: 0x0f1218, floor: 0x353b46, blocked: 0x2c313b, grid: 0x535b69, gridAlpha: 0.85,
    wall: 0xc9d0da, wallTop: 0xe6eaef, wallCap: 0xa9b1bd,
    obj: 0xa7b0bd, objTop: 0xadb5c0, objDeep: 0x707a88, person: 0xe4e9ef,
    dots: 0x8b95a5, dotsOpacity: 0.75, body: 0xe8ecf1,
    accent: 0x3b82f6, accent2: 0x38bdf8, warn: 0xf59e0b, err: 0xef4444, trail: 0x7dd3fc, trailOpacity: 0.22,
    sky: 0xffffff, ground: 0x5a6273, hemi: 2.75, key: 0.95, exposure: 1.0,
  },
  light: {
    bg: 0xe7eaee, floor: 0xf6f7f9, blocked: 0xe6e9ed, grid: 0xd9dee5, gridAlpha: 1,
    wall: 0x8f9aa8, wallTop: 0xaab3bf, wallCap: 0x7c8794,
    obj: 0xbcc4ce, objTop: 0xd2d8df, objDeep: 0x8e98a5, person: 0xdde3ea,
    dots: 0x6b7685, dotsOpacity: 0.7, body: 0x4b5563,
    accent: 0x2563eb, accent2: 0x2563eb, warn: 0xd97706, err: 0xdc2626, trail: 0x2563eb, trailOpacity: 0.3,
    sky: 0xffffff, ground: 0xc4cad3, hemi: 2.3, key: 1.4, exposure: 1.12,
  },
};

/** Colour for a confidence level: 'good' / 'ok' → accent, 'weak' → amber, 'lost' → red. */
export const levelColor = (t, level) => (level === 'lost' ? t.err : level === 'weak' ? t.warn : t.accent);

// Radial alpha profiles, from the centre (0) to the edge (1).
const PROFILES = {
  disc: [[0, 1], [0.6, 0.95], [1, 0]], // filled, soft edge
  ring: [[0, 0], [0.55, 0], [0.74, 1], [0.84, 1], [1, 0]], // soft ring
  halo: [[0, 0.32], [0.7, 0.42], [0.88, 0.75], [1, 0]], // faint fill with a brighter rim
};
const textures = {};

/** White textures whose alpha carries the shape; tint them with the material colour. */
export function softTexture(kind) {
  if (textures[kind]) return textures[kind];
  const S = 128, c = Object.assign(document.createElement('canvas'), { width: S, height: kind === 'band' ? 1 : S });
  const ctx = c.getContext('2d');
  // 'band': across a ribbon (u = 0..1), bright in the middle and soft at both edges.
  const g = kind === 'band' ? ctx.createLinearGradient(0, 0, S, 0) : ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  const stops = kind === 'band' ? [[0, 0], [0.2, 0.55], [0.42, 0.8], [0.5, 1], [0.58, 0.8], [0.8, 0.55], [1, 0]] : PROFILES[kind];
  for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, c.height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (textures[kind] = t);
}

/** Flat, unlit and see-through; not tone mapped, so the accent stays bright. */
export const glowMat = (opts) => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, ...opts });

/** A unit plane lying on the floor (three's xz), facing up. */
export const floorPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

/**
 * A flat strip of constant width along a path on the floor. Write points into `pts` as
 * [x, z, x, z, …] in three's coordinates, then call update(n). Nothing is allocated after setup.
 */
export class Ribbon {
  constructor(cap, width, material, y = 0.01) {
    this.cap = cap;
    this.width = width;
    this.y = y;
    this.pts = new Float32Array(cap * 2);
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage);
    const uv = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) uv[i * 4 + 2] = 1; // u runs across the strip
    const idx = new (cap * 2 > 65535 ? Uint32Array : Uint16Array)(Math.max(0, cap - 1) * 6);
    for (let i = 0; i + 1 < cap; i++) idx.set([2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2], i * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.pos);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  update(n) {
    const p = this.pts, h = this.width / 2, y = this.y;
    // Drop points closer than 2 cm to the last kept one (they only make spiky joins).
    let m = 0;
    for (let i = 0; i < Math.min(n, this.cap); i++) {
      if (m && Math.hypot(p[i * 2] - p[(m - 1) * 2], p[i * 2 + 1] - p[(m - 1) * 2 + 1]) < 0.02) continue;
      p[m * 2] = p[i * 2]; p[m * 2 + 1] = p[i * 2 + 1]; m++;
    }
    for (let i = 0; i < m; i++) {
      // Sideways from the direction through the neighbours: smooth joins without miter spikes.
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
      let tx = p[b * 2] - p[a * 2], tz = p[b * 2 + 1] - p[a * 2 + 1];
      const L = Math.hypot(tx, tz) || 1;
      tx /= L; tz /= L;
      const x = p[i * 2], z = p[i * 2 + 1];
      this.pos.setXYZ(2 * i, x - tz * h, y, z + tx * h);
      this.pos.setXYZ(2 * i + 1, x + tz * h, y, z - tx * h);
    }
    // Upload only the part drawn (the trail's buffer is 20,000 points long).
    this.pos.clearUpdateRanges?.();
    if (m) this.pos.addUpdateRange?.(0, m * 6);
    this.pos.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, m > 1 ? (m - 1) * 6 : 0);
  }
}
