// The live 3D model: the building's point cloud as it's mapped, the path walked, where you are
// now, the planned route, and named places. Click the floor to pick a destination.
// Uses three.js (from a CDN, via the import map in map.html).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Map frame: x right, y down, z forward, floor at y = 0. three.js: y up. (x, y, z) → (x, −y, −z).
const V = (x, y, z) => new THREE.Vector3(x, -y, -z);

export class MapView3D {
  constructor(container, { onPick } = {}) {
    this.container = container;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);
    this.labels = document.createElement('div');
    this.labels.className = 'labels3d';
    container.appendChild(this.labels);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e14);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 300);
    this.camera.position.set(-4, 7, 6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0, -2);
    this.scene.add(new THREE.GridHelper(60, 60, 0x2b3547, 0x161c27));
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2030, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(4, 10, 3);
    this.scene.add(sun);
    this.things = new THREE.Group(); // furniture models for the objects seen
    this.scene.add(this.things);
    this.walls = new THREE.Group(); // flat vertical surfaces found in the points
    this.scene.add(this.walls);

    // Point cloud with room for 2 million points; drawn up to however many have arrived.
    this.cap = 2_000_000;
    this.n = 0;
    this.pos = new THREE.BufferAttribute(new Float32Array(this.cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Uint8Array(this.cap * 3), 3, true).setUsage(THREE.DynamicDrawUsage);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', this.pos);
    geom.setAttribute('color', this.col);
    geom.setDrawRange(0, 0);
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.2); // hide points above this height
    this.cloud = new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, clippingPlanes: [this.clip] }));
    this.cloud.frustumCulled = false;
    this.scene.add(this.cloud);

    this.trail = this.line(0x38bdf8, 20000);
    this.route = this.line(0xfbbf24, 512);
    this.me = this.marker();
    this.goal = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.28, 32), new THREE.MeshBasicMaterial({ color: 0xfbbf24, side: THREE.DoubleSide }));
    this.goal.rotation.x = -Math.PI / 2;
    this.goal.visible = false;
    this.scene.add(this.goal);

    this.mode = 'follow';
    this.markers = [];
    this.wire();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  line(color, cap) {
    const attr = new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', attr);
    g.setDrawRange(0, 0);
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
    l.frustumCulled = false;
    this.scene.add(l);
    return { l, attr, cap };
  }

  setLine({ l, attr, cap }, pts) {
    const n = Math.min(cap, pts.length);
    for (let i = 0; i < n; i++) attr.setXYZ(i, pts[i][0], pts[i][1], pts[i][2]);
    attr.needsUpdate = true;
    l.geometry.setDrawRange(0, n);
  }

  marker() {
    // A small arrow standing for you: where the cameras are and which way they face.
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.45, 16), new THREE.MeshBasicMaterial({ color: 0x38bdf8 }));
    body.rotation.x = -Math.PI / 2; // point along −z (three.js "forward")
    g.add(body);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.27, 32), new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    g.add(ring);
    this.scene.add(g);
    return g;
  }

  wire() {
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || !this.onPick) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) this.onPick({ x: hit.x, z: -hit.z });
    });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  resetPoints() {
    this.n = 0;
    this.cloud.geometry.setDrawRange(0, 0);
  }

  /** xyz: Float32Array in the map frame; gray: Uint8Array. */
  addPoints(xyz, gray) {
    const count = Math.min(gray.length, this.cap - this.n);
    for (let i = 0; i < count; i++) {
      const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
      this.pos.setXYZ(this.n + i, x, -y, -z);
      // Brightness from the camera image, tinted warm near the floor and cool up high.
      // (The colour attribute is normalised, so three.js wants 0–1 here.)
      const h = Math.max(0, Math.min(1, -y / 2.5)), g = gray[i] / 255;
      this.col.setXYZ(this.n + i, Math.min(1, g * (1.05 - 0.25 * h)), g * 0.95, Math.min(1, g * (0.8 + 0.35 * h)));
    }
    this.pos.addUpdateRange?.(this.n * 3, count * 3);
    this.col.addUpdateRange?.(this.n * 3, count * 3);
    this.pos.needsUpdate = this.col.needsUpdate = true;
    this.n += count;
    this.cloud.geometry.setDrawRange(0, this.n);
  }

  setTrajectory(flat) {
    const pts = [];
    for (let i = 0; i + 2 < flat.length; i += 3) pts.push([flat[i], -flat[i + 1], -flat[i + 2]]);
    this.setLine(this.trail, pts);
  }

  setPose(p) {
    this.user = p;
    this.me.position.copy(V(p.x, p.y, p.z));
    this.me.position.y = Math.max(0.05, this.me.position.y);
    this.me.rotation.y = -p.heading;
  }

  setRoute(path) {
    this.setLine(this.route, (path ?? []).map(([x, z]) => [x, 0.03, -z]));
  }

  setGoal(g) {
    this.goal.visible = !!g;
    if (g) this.goal.position.set(g.x, 0.02, -g.z);
  }

  /** [{ label, x, z, kind: 'place' | 'landmark' | 'start' }] shown as text tags. */
  setMarkers(list) {
    this.markers = list;
    this.labels.innerHTML = list.map((m) => `<span class="tag3d ${m.kind}">${m.label.replace(/[<&>]/g, '')}</span>`).join('');
  }

  /** Sized furniture models for the objects in the map (see slam/objects.js). */
  setObjects(list) {
    this.things.clear();
    for (const o of list) {
      const g = furniture(o.cls, o.w, o.h, o.d);
      g.position.set(o.x, -o.bottom, -o.z); // map (x, y down, z) → three (x, up, −z)
      g.rotation.y = -o.yaw; // front faces back the way it was seen from
      this.things.add(g);
    }
  }

  /** Walls: segments on the floor plan with a height (see slam/walls.js). */
  setWalls(list) {
    this.walls.clear();
    for (const w of list) {
      const dx = w.x1 - w.x0, dz = w.z1 - w.z0, L = Math.hypot(dx, dz) + 0.1;
      const m = new THREE.Mesh(unitBox, wallMat(this.clip));
      m.scale.set(L, w.top, 0.08);
      m.position.set((w.x0 + w.x1) / 2, w.top / 2, -(w.z0 + w.z1) / 2);
      m.rotation.y = Math.atan2(dz, dx); // local x along the wall
      const e = new THREE.LineSegments(unitEdges, edgeMat);
      e.scale.copy(m.scale); e.position.copy(m.position); e.rotation.copy(m.rotation);
      this.walls.add(m, e);
    }
  }

  setWallsVisible(on) {
    this.walls.visible = on;
  }

  setPointsVisible(on) {
    this.cloud.visible = on;
  }

  setObjectsVisible(on) {
    this.things.visible = on;
  }

  setClipHeight(h) {
    this.clip.constant = h;
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enableRotate = mode !== 'top';
    if (mode === 'top' && this.user) {
      this.controls.target.set(this.user.x, 0, -this.user.z);
      this.camera.position.set(this.user.x, 14, -this.user.z + 0.01);
    }
  }

  frame() {
    const u = this.user;
    if (u && this.mode === 'follow') {
      // Behind and above you, looking where you look.
      const fx = Math.sin(u.heading), fz = Math.cos(u.heading);
      const want = new THREE.Vector3(u.x - fx * 3.2, 2.6, -(u.z - fz * 3.2));
      this.camera.position.lerp(want, 0.08);
      this.controls.target.lerp(new THREE.Vector3(u.x + fx * 1.5, 0.6, -(u.z + fz * 1.5)), 0.12);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    // Place the text tags over their spots.
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const tags = this.labels.children;
    this.markers.forEach((m, i) => {
      const v = new THREE.Vector3(m.x, m.y ?? 0.4, -m.z).project(this.camera);
      const el = tags[i];
      if (!el) return;
      const hidden = v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1;
      el.style.display = hidden ? 'none' : '';
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    });
  }
}

// ---------------------------------------------------------------------------------------
// Furniture: simple models built from boxes, scaled to the measured width, height and depth.
// Local frame: base at y = 0, centred, front toward +z.

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const unitEdges = new THREE.EdgesGeometry(unitBox);
const edgeMat = new THREE.LineBasicMaterial({ color: 0x0b0e14, transparent: true, opacity: 0.5 });
const COLORS = {
  chair: 0xc084fc, couch: 0x34d399, bed: 0x818cf8, 'dining table': 0xd9a066, bench: 0xd9a066, tv: 0x64748b,
  laptop: 0x94a3b8, 'potted plant': 0x22c55e, refrigerator: 0xe2e8f0, oven: 0xcbd5e1, microwave: 0xcbd5e1,
  sink: 0xcbd5e1, toilet: 0xf1f5f9, suitcase: 0xf472b6, backpack: 0xf472b6, person: 0xfb7185,
};
let wallMaterial = null;
const wallMat = (clip) => (wallMaterial ??= new THREE.MeshLambertMaterial({
  color: 0x9fb3c8, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: [clip],
}));
const mats = new Map();
const matFor = (color) => {
  if (!mats.has(color)) mats.set(color, new THREE.MeshLambertMaterial({ color }));
  return mats.get(color);
};

function furniture(cls, w, h, d) {
  const g = new THREE.Group();
  const color = COLORS[cls] ?? 0xc084fc;
  // A box spanning x0..x1, y0..y1, z0..z1 in fractions of the object's size (x, z centred on 0).
  const part = (x0, x1, y0, y1, z0, z1, c = color) => {
    const m = new THREE.Mesh(unitBox, matFor(c));
    m.scale.set((x1 - x0) * w, (y1 - y0) * h, (z1 - z0) * d);
    m.position.set(((x0 + x1) / 2) * w, ((y0 + y1) / 2) * h, ((z0 + z1) / 2) * d);
    const e = new THREE.LineSegments(unitEdges, edgeMat);
    e.scale.copy(m.scale);
    e.position.copy(m.position);
    g.add(m, e);
  };
  const legs = (top, t = 0.08) => {
    for (const x of [-0.5, 0.5 - t]) for (const z of [-0.5, 0.5 - t]) part(x, x + t, 0, top, z, z + t);
  };
  const dark = 0x334155;
  switch (cls) {
    case 'chair':
      legs(0.47, 0.1);
      part(-0.5, 0.5, 0.47, 0.53, -0.5, 0.5); // seat
      part(-0.5, 0.5, 0.53, 1, -0.5, -0.38); // back
      break;
    case 'dining table': case 'bench':
      legs(0.92, 0.07);
      part(-0.5, 0.5, 0.92, 1, -0.5, 0.5);
      break;
    case 'couch':
      part(-0.5, 0.5, 0, 0.5, -0.5, 0.5);
      part(-0.5, 0.5, 0.5, 1, -0.5, -0.25);
      part(-0.5, -0.38, 0.5, 0.72, -0.25, 0.5);
      part(0.38, 0.5, 0.5, 0.72, -0.25, 0.5);
      break;
    case 'bed':
      part(-0.5, 0.5, 0, 0.6, -0.5, 0.5);
      part(-0.5, 0.5, 0.6, 0.72, -0.5, 0.45, 0xe2e8f0); // mattress
      part(-0.5, 0.5, 0, 1, -0.5, -0.44, dark); // headboard
      break;
    case 'tv': case 'laptop':
      part(-0.5, 0.5, 0.15, 1, -0.5, 0.5, dark);
      part(-0.46, 0.46, 0.2, 0.95, 0.5, 0.52, 0x0ea5e9); // screen
      part(-0.15, 0.15, 0, 0.15, -0.5, 0.5, dark);
      break;
    case 'person': {
      // Standing upright on the floor, facing you.
      part(-0.32, -0.04, 0, 0.47, -0.3, 0.3, 0x475569); // legs
      part(0.04, 0.32, 0, 0.47, -0.3, 0.3, 0x475569);
      part(-0.38, 0.38, 0.47, 0.83, -0.4, 0.4); // body
      part(-0.5, -0.38, 0.5, 0.82, -0.3, 0.3); // arms
      part(0.38, 0.5, 0.5, 0.82, -0.3, 0.3);
      const r = 0.075 * h;
      const head = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), matFor(0xfcd34d));
      head.position.y = h - r;
      g.add(head);
      break;
    }
    case 'potted plant': {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * w, 0.22 * w, 0.35 * h, 16), matFor(0xb45309));
      pot.position.y = 0.175 * h;
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), matFor(color));
      leaves.scale.set(w, 0.65 * h, d);
      leaves.position.y = 0.67 * h;
      g.add(pot, leaves);
      break;
    }
    default:
      part(-0.5, 0.5, 0, 1, -0.5, 0.5);
  }
  return g;
}
