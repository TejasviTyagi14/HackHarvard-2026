// Landing-page hero: a prerecorded flythrough of the stereo rig building a 3D world.
// Data comes from tools/record-tour.mjs (data/tour.json + data/tour-points.bin).
// Map frame (x right, y DOWN, z forward, floor y = 0) -> three: (x, -y, -z).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const BG = '#05070a', CYAN = '#7dd3fc', GREEN = '#4ade80', WARM = '#f59e0b'; // light blue for the rig and scan, green for object labels
const REVEAL_DELAY = 2.0, REVEAL_LEN = 1.2, FADE = 0.6;
const NAMES = { 'potted plant': 'PLANT', 'dining table': 'TABLE', book: 'SHELF', refrigerator: 'FRIDGE', tv: 'TV' };

async function fetchWithProgress(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) { const b = await res.arrayBuffer(); onBytes(1); return b; }
  const reader = res.body.getReader(), out = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got); got += value.length;
    onBytes(Math.min(1, got / total));
  }
  return out.buffer;
}

const POINT_VS = /* glsl */`
attribute float gray;
attribute float atime;
attribute float kind;
uniform float uTime, uScale, uDim, uFog;
uniform vec3 uCyan;
varying vec3 vColor;
void main() {
  float age = uTime - atime;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  if (age < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); return; }
  gl_Position = projectionMatrix * mv;
  float flash = exp(-age * 2.6);
  float surf = step(0.5, kind);
  vec3 settled = mix(vec3(0.20, 0.25, 0.31), vec3(0.62, 0.70, 0.80), gray) * mix(0.75, 0.42, surf);
  float d = -mv.z;
  float fog = exp(-uFog * uFog * d * d);
  vColor = mix(settled, uCyan * 1.8, flash) * fog * uDim;
  float size = mix(0.03, 0.022, surf) * (1.0 + 1.2 * flash);
  gl_PointSize = clamp(size * uScale / max(d, 0.05), 1.0, 16.0);
}`;
const POINT_FS = /* glsl */`
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c));
  gl_FragColor = vec4(vColor * a * a, 1.0);
  #include <colorspace_fragment>
}`;
const GRID_VS = /* glsl */`
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const GRID_FS = /* glsl */`
uniform vec3 uRig, uCyan;
uniform float uTime, uDim;
varying vec3 vW;
void main() {
  vec2 p = vW.xz;
  vec2 g = abs(fract(p * 2.0 - 0.5) - 0.5) / fwidth(p * 2.0);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  vec2 G = abs(fract(p * 0.5 - 0.5) - 0.5) / fwidth(p * 0.5);
  float major = 1.0 - min(min(G.x, G.y), 1.0);
  float r = length(p - uRig.xz);
  float fade = exp(-r * 0.45);
  float ring = smoothstep(0.12, 0.0, abs(r - mod(uTime * 1.4, 6.0))) * exp(-mod(uTime * 1.4, 6.0) * 0.45);
  float a = (line * 0.045 + major * 0.08) * fade + ring * 0.22 * (line + 0.1);
  gl_FragColor = vec4(uCyan * a * uDim, 1.0);
  #include <colorspace_fragment>
}`;

export async function mountHero(container, { onProgress, motion } = {}) {
  const progress = (p) => { try { onProgress?.(p); } catch { /* caller's problem */ } };
  progress(0);
  const base = new URL('../../data/', import.meta.url);
  const tour = await (await fetch(new URL('tour.json', base))).json();
  progress(0.05);
  const bin = await fetchWithProgress(new URL(tour.points.file, base), (f) => progress(0.05 + 0.9 * f));

  const reduced = motion === undefined ? matchMedia('(prefers-reduced-motion: reduce)').matches : !motion;
  const mobile = innerWidth < 720 || matchMedia('(pointer: coarse)').matches;

  // ---------- DOM ----------
  const style = document.createElement('style');
  style.textContent = `
.hero-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2}
.hero-fade{position:absolute;inset:0;pointer-events:none;background:${BG};opacity:0;z-index:1}
.hero-label{position:absolute;left:0;top:0;white-space:nowrap;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.12em;color:${GREEN};padding:4px 7px 4px 8px;background:rgba(5,7,10,.62);border-left:2px solid currentColor;opacity:0;will-change:transform,opacity;text-shadow:0 0 8px rgba(74,222,128,.45)}
.hero-label.near{color:${WARM};text-shadow:0 0 8px rgba(245,158,11,.5)}
.hero-label::after{content:'';position:absolute;left:-2px;top:100%;width:1px;height:14px;background:currentColor;opacity:.6}`;
  container.appendChild(style);
  const renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(mobile ? 1.5 : 2, devicePixelRatio || 1));
  renderer.setClearColor(BG, 1);
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none';
  container.appendChild(canvas);
  const fadeEl = document.createElement('div'); fadeEl.className = 'hero-fade'; container.appendChild(fadeEl);
  const labelsEl = document.createElement('div'); labelsEl.className = 'hero-labels'; container.appendChild(labelsEl);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.FogExp2(BG, 0.075);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 80);
  scene.add(new THREE.HemisphereLight(0x5f8aa6, 0x05070a, 1.6));
  const sun = new THREE.DirectionalLight(0x9fdcf0, 0.9); sun.position.set(3, 8, 4); scene.add(sun);
  const cyan = new THREE.Color(CYAN);

  // ---------- poses ----------
  const F = tour.frames, NF = F.length, fps = tour.fps, duration = tour.duration;
  const fPos = new Float32Array(NF * 3), fQuat = [];
  {
    const m = new THREE.Matrix4();
    F.forEach((fr, i) => {
      const R = fr.R; // row-major camera -> map; three rotation = S·R, S = diag(1,-1,-1)
      m.set(R[0], R[1], R[2], 0, -R[3], -R[4], -R[5], 0, -R[6], -R[7], -R[8], 0, 0, 0, 0, 1);
      fQuat.push(new THREE.Quaternion().setFromRotationMatrix(m));
      fPos[3 * i] = fr.p[0]; fPos[3 * i + 1] = -fr.p[1]; fPos[3 * i + 2] = -fr.p[2];
    });
  }
  function poseAt(t, pos, quat) {
    const x = Math.max(0, Math.min(NF - 1.0001, t * fps)), i = Math.floor(x), f = x - i;
    const s = f * f * (3 - 2 * f) * 0.5 + f * 0.5; // gentle ease between samples
    pos.set(fPos[3 * i], fPos[3 * i + 1], fPos[3 * i + 2]).lerp(_v.set(fPos[3 * i + 3], fPos[3 * i + 4], fPos[3 * i + 5]), s);
    if (quat) quat.copy(fQuat[i]).slerp(fQuat[i + 1], s);
  }
  const _v = new THREE.Vector3();

  // ---------- points ----------
  const NP = tour.points.count, stride = mobile ? 2 : 1, n = Math.floor(NP / stride);
  const X = new Int16Array(bin, 0, NP), Y = new Int16Array(bin, 2 * NP, NP), Z = new Int16Array(bin, 4 * NP, NP);
  const G8 = new Uint8Array(bin, 6 * NP, NP), K8 = new Uint8Array(bin, 7 * NP, NP), T16 = new Uint16Array(bin, 8 * NP, NP);
  const pos = new Float32Array(n * 3), gray = new Uint8Array(n), kind = new Uint8Array(n), atime = new Float32Array(n);
  for (let j = 0, i = 0; j < n; j++, i += stride) {
    pos[3 * j] = X[i] / 1000; pos[3 * j + 1] = -Y[i] / 1000; pos[3 * j + 2] = -Z[i] / 1000;
    gray[j] = G8[i]; kind[j] = K8[i]; atime[j] = T16[i] * 0.05;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('gray', new THREE.BufferAttribute(gray, 1, true));
  pg.setAttribute('kind', new THREE.BufferAttribute(kind, 1));
  pg.setAttribute('atime', new THREE.BufferAttribute(atime, 1));
  pg.computeBoundingSphere();
  const pUniforms = { uTime: { value: 0 }, uScale: { value: 500 }, uDim: { value: 1 }, uFog: { value: 0.075 }, uCyan: { value: cyan } };
  const pMat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: pUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(pg, pMat);
  points.frustumCulled = false;
  scene.add(points);

  // ---------- floor grid + trail ----------
  const gUniforms = { uRig: { value: new THREE.Vector3() }, uCyan: { value: cyan }, uTime: { value: 0 }, uDim: { value: 1 } };
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(40, 40).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({ vertexShader: GRID_VS, fragmentShader: GRID_FS, uniforms: gUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  grid.position.set(3, 0.002, -2.5);
  scene.add(grid);
  const trailPos = new Float32Array(NF * 3);
  for (let i = 0; i < NF; i++) { trailPos[3 * i] = fPos[3 * i]; trailPos[3 * i + 1] = 0.01; trailPos[3 * i + 2] = fPos[3 * i + 2]; }
  const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: cyan, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
  trail.frustumCulled = false;
  scene.add(trail);

  // ---------- solids ----------
  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), unitBoxE = new THREE.EdgesGeometry(unitBox);
  const pot = new THREE.CylinderGeometry(0.5, 0.38, 1, 8).translate(0, 0.5, 0), potE = new THREE.EdgesGeometry(pot);
  const leaf = new THREE.IcosahedronGeometry(0.5, 0), leafE = new THREE.EdgesGeometry(leaf);
  const head = new THREE.IcosahedronGeometry(1, 1), headE = new THREE.EdgesGeometry(head);
  const shared = [unitBox, unitBoxE, pot, potE, leaf, leafE, head, headE, pg, trailGeo, grid.geometry];
  const solids = []; // { group, body, edge, seen, baseBody, baseEdge, center, half, cls, label }

  function addPart(group, body, edge, geo, geoE, sx, sy, sz, x, y, z) {
    const m = new THREE.Mesh(geo, body); m.scale.set(sx, sy, sz); m.position.set(x, y, z);
    const e = new THREE.LineSegments(geoE, edge); e.scale.copy(m.scale); e.position.copy(m.position);
    group.add(m, e);
  }
  // Local frame: origin at floor centre, x = W, z = D, back of the object at −z.
  function furniture(cls, group, body, edge, W, H, D) {
    const b = (sx, sy, sz, x, y, z) => addPart(group, body, edge, unitBox, unitBoxE, sx, sy, sz, x, y, z);
    if (cls === 'bed') {
      b(W, H * 0.55, D, 0, 0, 0); b(W * 0.96, H * 0.35, D * 0.92, 0, H * 0.55, D * 0.03);
      b(W, H * 1.9, 0.06, 0, 0, -D / 2 + 0.03); b(W * 0.6, 0.1, 0.28, 0, H * 0.9, -D / 2 + 0.24);
    } else if (cls === 'couch') {
      b(W, H * 0.5, D * 0.75, 0, 0, D * 0.125); b(W, H, D * 0.25, 0, 0, -D * 0.375);
      b(0.15, H * 0.7, D * 0.75, W / 2 - 0.075, 0, D * 0.125); b(0.15, H * 0.7, D * 0.75, -W / 2 + 0.075, 0, D * 0.125);
    } else if (cls === 'chair') {
      b(W, 0.05, D, 0, H * 0.48, 0); b(W, H * 0.47, 0.04, 0, H * 0.53, -D / 2 + 0.02);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b(0.04, H * 0.48, 0.04, sx * (W / 2 - 0.03), 0, sz * (D / 2 - 0.03));
    } else if (cls === 'dining table') {
      b(W, 0.05, D, 0, H - 0.05, 0);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b(0.05, H - 0.05, 0.05, sx * (W / 2 - 0.05), 0, sz * (D / 2 - 0.05));
    } else if (cls === 'book' || cls === 'shelf') {
      b(0.03, H, D, W / 2 - 0.015, 0, 0); b(0.03, H, D, -W / 2 + 0.015, 0, 0); b(W, H, 0.02, 0, 0, -D / 2 + 0.01);
      for (const f of [0, 0.25, 0.5, 0.75, 0.985]) b(W, 0.03, D, 0, H * f, 0);
      for (let i = 0; i < 6; i++) b(W * 0.12, H * 0.16, D * 0.7, -W * 0.35 + (i % 3) * W * 0.3, H * (i < 3 ? 0.03 : 0.53), 0);
    } else if (cls === 'potted plant') {
      const r = Math.min(W, D);
      addPart(group, body, edge, pot, potE, r * 0.6, H * 0.3, r * 0.6, 0, 0, 0);
      addPart(group, body, edge, leaf, leafE, W * 1.05, H * 0.75, D * 1.05, 0, H * 0.3 + H * 0.36, 0);
    } else if (cls === 'tv') {
      b(W * 0.9, H * 0.42, D, 0, 0, 0); b(W, H * 0.55, 0.05, 0, H * 0.44, 0);
    } else if (cls === 'refrigerator') {
      b(W, H * 0.64, D, 0, 0, 0); b(W, H * 0.34, D, 0, H * 0.66, 0);
    } else if (cls === 'person') {
      b(W * 0.24, H * 0.46, D * 0.55, -W * 0.16, 0, 0); b(W * 0.24, H * 0.46, D * 0.55, W * 0.16, 0, 0);
      b(W * 0.72, H * 0.33, D * 0.8, 0, H * 0.46, 0);
      b(W * 0.13, H * 0.34, D * 0.45, -W * 0.44, H * 0.45, 0); b(W * 0.13, H * 0.34, D * 0.45, W * 0.44, H * 0.45, 0);
      addPart(group, body, edge, head, headE, H * 0.065, H * 0.075, H * 0.065, 0, H * 0.925, 0);
    } else {
      b(W, H, D, 0, 0, 0);
    }
  }
  function nearestPath(x, z) {
    let best = Infinity, bx = 0, bz = 0;
    for (let i = 0; i < NF; i++) { const d = (fPos[3 * i] - x) ** 2 + (fPos[3 * i + 2] - z) ** 2; if (d < best) { best = d; bx = fPos[3 * i]; bz = fPos[3 * i + 2]; } }
    return [bx, bz];
  }
  function addSolid(b, isWall) {
    // map AABB -> three AABB
    const x0 = b.min[0], x1 = b.max[0], y0 = -b.max[1], y1 = -b.min[1], z0 = -b.max[2], z1 = -b.min[2];
    const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const person = b.cls === 'person';
    const body = isWall
      ? new THREE.MeshBasicMaterial({ color: 0x0b1822, transparent: true, opacity: 0, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: person ? 0x3a2c24 : 0x1a2733, emissive: person ? 0x1a0e06 : 0x060d12, transparent: true, opacity: 0 });
    const edge = new THREE.LineBasicMaterial({ color: person ? 0xffc27a : cyan, transparent: true, opacity: 0, depthWrite: false });
    const group = new THREE.Group();
    group.position.set(cx, y0, cz);
    if (isWall) addPart(group, body, edge, unitBox, unitBoxE, sx, sy, sz, 0, 0, 0);
    else {
      // Face the tour path; long side constraints per class.
      const [px, pz] = nearestPath(cx, cz);
      let ax = cx - px, az = cz - pz; const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
      const longX = sx >= sz, cls = b.cls;
      let best = -Infinity, yaw = 0;
      for (const k of [0, 1, 2, 3]) {
        const a = k * Math.PI / 2, localXalongX = k % 2 === 0;
        if ((cls === 'couch' || cls === 'tv' || cls === 'person') && localXalongX !== longX) continue;
        if (cls === 'bed' && localXalongX === longX) continue;
        const score = -Math.sin(a) * ax + -Math.cos(a) * az;
        if (score > best) { best = score; yaw = a; }
      }
      group.rotation.y = yaw;
      const swap = Math.round(yaw / (Math.PI / 2)) % 2 === 1;
      furniture(cls, group, body, edge, swap ? sz : sx, sy, swap ? sx : sz);
    }
    group.visible = false;
    scene.add(group);
    const s = { group, body, edge, seen: b.seen >= 0 ? b.seen : (reduced ? 0 : Infinity), baseBody: isWall ? 0.5 : 0.92, baseEdge: isWall ? 0.55 : 0.5,
      min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1), top: new THREE.Vector3(cx, y1 + 0.12, cz), label: null, alpha: 0, near: false, dm: -1, wall: isWall };
    if (!isWall) {
      const el = document.createElement('span');
      el.className = 'hero-label';
      el.dataset.name = NAMES[b.cls] || b.cls.toUpperCase();
      el.textContent = el.dataset.name;
      labelsEl.appendChild(el);
      s.label = el;
    }
    solids.push(s);
  }
  tour.walls.forEach((w) => addSolid(w, true));
  tour.boxes.forEach((b) => addSolid(b, false));

  // ---------- the rig ----------
  const rig = new THREE.Group();
  const TH = Math.tan(35 * Math.PI / 180), DEPTH = 1.2, hw = DEPTH * TH, hh = hw * 9 / 16;
  const rigMat = new THREE.LineBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(2.2), transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false });
  {
    const c = [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]], v = [];
    for (const [x, y] of c) v.push(0, 0, 0, x, y, DEPTH);
    for (let i = 0; i < 4; i++) { const [a, b2] = [c[i], c[(i + 1) % 4]]; v.push(a[0], a[1], DEPTH, b2[0], b2[1], DEPTH); }
    const k = 0.12; for (let i = 0; i < 4; i++) { const [a, b2] = [c[i], c[(i + 1) % 4]]; v.push(a[0] * k, a[1] * k, DEPTH * k, b2[0] * k, b2[1] * k, DEPTH * k); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); shared.push(g);
    rig.add(new THREE.LineSegments(g, rigMat));
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 0.05), new THREE.MeshBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(1.6), toneMapped: false }));
    shared.push(body.geometry); rig.add(body);
  }
  const scanMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(CYAN).multiplyScalar(1.5), transparent: true, opacity: 0.2, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const scan = new THREE.Mesh(new THREE.PlaneGeometry(2, 2 * 9 / 16), scanMat); shared.push(scan.geometry);
  const scanEdge = new THREE.LineSegments(new THREE.EdgesGeometry(scan.geometry), rigMat); shared.push(scanEdge.geometry);
  scan.add(scanEdge); rig.add(scan);
  scene.add(rig);
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1, new THREE.Color(CYAN).multiplyScalar(1.8).getHex(), 0.16, 0.09);
  arrow.line.material.toneMapped = false; arrow.cone.material.toneMapped = false;
  scene.add(arrow);
  const foot = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
  shared.push(foot.geometry); scene.add(foot);
  const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]); shared.push(stemGeo);
  const stem = new THREE.Line(stemGeo, new THREE.LineBasicMaterial({ color: cyan, transparent: true, opacity: 0.35, depthWrite: false }));
  scene.add(stem);

  // ---------- post ----------
  let composer = null, bloom = null;
  if (!mobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 0.2);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }
  let vw = 1, vh = 1;
  function resize() {
    vw = Math.max(1, container.clientWidth); vh = Math.max(1, container.clientHeight);
    renderer.setSize(vw, vh, false);
    composer?.setSize(vw, vh);
    camera.aspect = vw / vh; camera.updateProjectionMatrix();
    pUniforms.uScale.value = (vh * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    dirty = true;
  }
  const ro = new ResizeObserver(resize);

  // ---------- state ----------
  let tourT = reduced ? duration + 10 : 0, wall = 0, fadeT = -1, scrollP = 0, scrollS = 0, paused = false, mode = 'tour', raf = 0, last = 0, dirty = true, controls = null;
  const rigPos = new THREE.Vector3(), rigQ = new THREE.Quaternion(), fwd = new THREE.Vector3(), vel = new THREE.Vector3(), velS = new THREE.Vector3();
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), camPos = new THREE.Vector3(), look = new THREE.Vector3();
  const want = new THREE.Vector3(), wantLook = new THREE.Vector3(), top = new THREE.Vector3(), topLook = new THREE.Vector3(), tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const keys = new Set();

  function chaseTarget(t, outPos, outLook) {
    fwd.set(0, 0, 1).applyQuaternion(rigQ); fwd.y = 0; fwd.normalize();
    const side = tmp.crossVectors(fwd, up);
    outPos.copy(rigPos).addScaledVector(fwd, -3.1).addScaledVector(side, 0.9 * Math.sin(t * 0.21)).add(_v.set(0, 2.15 + 0.25 * Math.sin(t * 0.17), 0));
    outLook.copy(rigPos).addScaledVector(fwd, 1.6).addScaledVector(side, 0.25 * Math.sin(t * 0.13 + 1)); outLook.y -= 0.35;
  }
  function updateRig(t) {
    poseAt(t, rigPos, rigQ);
    rig.position.copy(rigPos); rig.quaternion.copy(rigQ);
    poseAt(t + 0.3, pB); poseAt(Math.max(0, t - 0.3), pA);
    vel.subVectors(pB, pA).multiplyScalar(1 / 0.6);
    velS.lerp(vel, 0.15);
    const sp = velS.length();
    if (sp > 0.03) { arrow.visible = true; arrow.setDirection(tmp.copy(velS).normalize()); arrow.setLength(0.35 + sp * 1.4, 0.16, 0.09); }
    else arrow.visible = false;
    arrow.position.copy(rigPos); arrow.position.y -= 0.32;
    foot.position.set(rigPos.x, 0.012, rigPos.z);
    stem.position.set(rigPos.x, 0, rigPos.z); stem.scale.y = Math.max(0.01, rigPos.y - 0.03);
    const ph = (wall * 0.75) % 1, z = 0.08 + ph * (DEPTH - 0.08);
    scan.position.set(0, 0, z); scan.scale.set(z * TH, z * TH, 1);
    scanMat.opacity = 0.22 * Math.sin(ph * Math.PI);
    foot.scale.setScalar(1 + 0.25 * Math.sin(wall * 3));
    gUniforms.uRig.value.copy(rigPos);
    trailGeo.setDrawRange(0, Math.max(1, Math.min(NF, Math.floor(t * fps) + 1)));
  }
  function updateSolids(t) {
    for (const s of solids) {
      const a0 = (t - s.seen - REVEAL_DELAY) / REVEAL_LEN;
      const a = a0 <= 0 ? 0 : a0 >= 1 ? 1 : a0 * a0 * (3 - 2 * a0);
      s.group.visible = a > 0.002;
      if (!s.group.visible) continue;
      const flash = a0 > 0 ? Math.exp(-a0 * 1.2) : 0;
      s.body.opacity = a * s.baseBody;
      s.edge.opacity = Math.min(1, a * (s.baseEdge + 0.7 * flash));
    }
  }
  const proj = new THREE.Vector3();
  // Does a wall cut the floor-plane segment rig -> box centre? (slab test against each wall footprint)
  function wallBetween(s) {
    const ox = rigPos.x, oz = rigPos.z, dx = (s.min.x + s.max.x) / 2 - ox, dz = (s.min.z + s.max.z) / 2 - oz;
    for (const w of solids) {
      if (!w.wall) continue;
      let t0 = 0, t1 = 1;
      for (let a = 0; a < 2; a++) {
        const o = a ? oz : ox, d = a ? dz : dx, lo = a ? w.min.z : w.min.x, hi = a ? w.max.z : w.max.x;
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { t0 = 2; break; } continue; }
        let u = (lo - o) / d, v = (hi - o) / d; if (u > v) { const q = u; u = v; v = q; }
        t0 = Math.max(t0, u); t1 = Math.min(t1, v);
      }
      if (t0 <= t1 && t0 < 0.97) return true;
    }
    return false;
  }
  function updateLabels(t) {
    const fade = 1 - Math.min(1, scrollS * 1.6);
    let shown = 0;
    for (const s of solids) {
      if (!s.label) continue;
      let target = 0, dist = 0;
      if (t > s.seen + REVEAL_DELAY && fade > 0) {
        const cx = Math.max(s.min.x, Math.min(rigPos.x, s.max.x)), cz = Math.max(s.min.z, Math.min(rigPos.z, s.max.z));
        dist = Math.hypot(cx - rigPos.x, cz - rigPos.z);
        const ahead = (s.top.x - rigPos.x) * fwd.x + (s.top.z - rigPos.z) * fwd.z;
        if (dist < 5 && ahead > -0.2 && shown < 7 && !wallBetween(s)) {
          proj.copy(s.top).project(camera);
          if (proj.z < 1 && Math.abs(proj.x) < 0.95 && Math.abs(proj.y) < 0.92) { target = 1; shown++; }
        }
      }
      s.alpha = reduced ? target : s.alpha + (target - s.alpha) * 0.12;
      if (s.alpha < 0.01 && target === 0) { if (s.label.style.opacity !== '0') s.label.style.opacity = '0'; s.alpha = 0; continue; }
      proj.copy(s.top).project(camera);
      const x = (proj.x * 0.5 + 0.5) * vw, y = (-proj.y * 0.5 + 0.5) * vh - 18;
      s.label.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      s.label.style.opacity = (s.alpha * fade).toFixed(3);
      const dm = Math.round(dist * 10);
      if (dm !== s.dm) { s.dm = dm; s.label.textContent = `${s.label.dataset.name} · ${(dm / 10).toFixed(1)} m`; }
      const near = dist < 1.2;
      if (near !== s.near) { s.near = near; s.label.classList.toggle('near', near); }
    }
  }
  function moveKeys(dt) {
    if (!controls || !keys.size) return;
    const f = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const r = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    if (!f && !r) return;
    camera.getWorldDirection(want); want.y = 0; want.normalize();
    wantLook.crossVectors(want, up);
    tmp.set(0, 0, 0).addScaledVector(want, f * 2.5 * dt).addScaledVector(wantLook, r * 2.5 * dt);
    controls.target.add(tmp); camera.position.add(tmp);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    if (reduced && !dirty && mode === 'tour' && !controls) return;
    wall += reduced ? 0 : dt;
    if (!reduced) {
      tourT += dt;
      if (tourT > duration && fadeT < 0) fadeT = 0;
      if (fadeT >= 0) {
        fadeT += dt;
        if (fadeT >= FADE && tourT > duration) {
          tourT = 0; velS.set(0, 0, 0);
          updateRig(0);
          if (mode === 'tour') { chaseTarget(0, camPos, look); }
        }
        if (fadeT >= 2 * FADE) fadeT = -1;
      }
    }
    // Follow the page's scroll with a little damping, so wheel steps glide instead of jumping.
    scrollS += (scrollP - scrollS) * (1 - Math.exp(-dt * 9));
    if (Math.abs(scrollP - scrollS) < 1e-4) scrollS = scrollP;
    else dirty = true;
    const t = Math.min(tourT, duration);
    updateRig(t);
    pUniforms.uTime.value = reduced ? 1e4 : tourT;
    gUniforms.uTime.value = wall;
    updateSolids(reduced ? 1e4 : tourT);

    if (mode === 'tour') {
      if (reduced) {
        want.set(rigPos.x - 4.5, 7.5, rigPos.z + 6.5); wantLook.set(2.8, 0, -2.4);
        camPos.copy(want); look.copy(wantLook);
      } else {
        chaseTarget(wall, want, wantLook);
        const k = 1 - Math.exp(-dt * 2.2);
        camPos.lerp(want, k); look.lerp(wantLook, 1 - Math.exp(-dt * 3));
      }
      const e = scrollS * scrollS * (3 - 2 * scrollS);
      top.set(rigPos.x, 9.5, rigPos.z + 1.6); topLook.set(rigPos.x, 0, rigPos.z - 0.3);
      camera.position.lerpVectors(camPos, top, e);
      tmp.lerpVectors(look, topLook, e);
      camera.lookAt(tmp);
    } else {
      moveKeys(dt);
      controls.update(dt);
    }
    const dim = 1 - 0.4 * scrollS;
    pUniforms.uDim.value = dim; gUniforms.uDim.value = dim;
    const loopFade = fadeT < 0 ? 0 : fadeT < FADE ? fadeT / FADE : Math.max(0, 2 - fadeT / FADE);
    fadeEl.style.opacity = Math.max(loopFade, scrollS * 0.35).toFixed(3);
    updateLabels(t);
    if (composer) composer.render(); else renderer.render(scene, camera);
    if (Math.abs(scrollP - scrollS) < 1e-4) dirty = false;
  }

  // ---------- input ----------
  const onKey = (e) => {
    if (!controls) return;
    const k = e.key.toLowerCase();
    if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) return;
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.type === 'keydown') { keys.add(k); if (k.startsWith('arrow')) e.preventDefault(); } else keys.delete(k);
  };
  addEventListener('keydown', onKey); addEventListener('keyup', onKey);

  // ---------- start ----------
  resize(); ro.observe(container);
  updateRig(Math.min(tourT, duration));
  if (reduced) { camPos.set(rigPos.x - 4.5, 7.5, rigPos.z + 6.5); look.set(2.8, 0, -2.4); }
  else chaseTarget(0, camPos, look);
  raf = requestAnimationFrame(frame);
  progress(1);

  return {
    setScroll(p) { scrollP = Math.max(0, Math.min(1, +p || 0)); dirty = true; },
    takeControl({ zoom = true } = {}) {
      if (controls) return;
      mode = 'orbit';
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true; controls.dampingFactor = 0.08;
      controls.enableZoom = zoom; // off when the wheel should keep scrolling the page
      controls.minDistance = 0.8; controls.maxDistance = 22; controls.maxPolarAngle = Math.PI * 0.49;
      controls.target.copy(rigPos);
      controls.addEventListener('change', () => { dirty = true; });
      canvas.style.cursor = 'grab';
    },
    resumeTour() {
      if (!controls) return;
      camPos.copy(camera.position); look.copy(controls.target);
      controls.dispose(); controls = null; keys.clear();
      canvas.style.touchAction = ''; canvas.style.cursor = '';
      mode = 'tour'; dirty = true;
    },
    setPaused(b) {
      b = !!b;
      if (b === paused) return;
      paused = b;
      if (paused) { cancelAnimationFrame(raf); raf = 0; } else { last = 0; dirty = true; raf = requestAnimationFrame(frame); }
    },
    dispose() {
      cancelAnimationFrame(raf); ro.disconnect();
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKey);
      controls?.dispose();
      for (const s of solids) { s.body.dispose(); s.edge.dispose(); }
      shared.forEach((g) => g.dispose());
      pMat.dispose(); grid.material.dispose(); trail.material.dispose(); rigMat.dispose(); scanMat.dispose(); arrow.dispose?.();
      composer?.dispose?.(); bloom?.dispose?.();
      renderer.dispose();
      canvas.remove(); fadeEl.remove(); labelsEl.remove(); style.remove();
    },
  };
}
