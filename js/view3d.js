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
      const v = new THREE.Vector3(m.x, 0.4, -m.z).project(this.camera);
      const el = tags[i];
      if (!el) return;
      const hidden = v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1;
      el.style.display = hidden ? 'none' : '';
      el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    });
  }
}
