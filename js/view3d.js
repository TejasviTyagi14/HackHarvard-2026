// The live 3D model, drawn calm and minimal like a car's driving display: the explored floor as
// a solid surface with a faint 1 m grid, walls as matte slabs, flat tops (tables, counters) as
// thin slabs, furniture and people, and only the points none of those explain, small and faint.
// You're a puck on the floor with the camera at its real height, its view frustum and a ray to
// what it points at, inside a soft halo for how sure the map is of where you are.
// Click the floor to pick a destination. Uses three.js (from a CDN, via the import map in map.html).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FloorSurface } from './view3d-floor.js';
import { furniture, themeFurniture } from './view3d-furniture.js';
import { blocksView } from './view3d-math.js';
import { MeMarker } from './view3d-me.js';
import { Ribbon, THEMES, floorPlane, glowMat, softTexture } from './view3d-parts.js';

// Map frame: x right, y down, z forward, floor at y = 0. three.js: y up. (x, y, z) → (x, −y, −z).
const WALL_T = 0.1; // m, wall thickness
const SLAB_T = 0.03; // m, flat-top thickness
const FADED = 0.15; // opacity of a wall standing between the view and you
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
const unitBox = new THREE.BoxGeometry(1, 1, 1); // faces: +x, −x, +y (top), −y, +z, −z
const sixOf = (side, top) => [side, side, top, side, side, side];

export class MapView3D {
  constructor(container, { onPick } = {}) {
    this.container = container;
    this.onPick = onPick;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.localClippingEnabled = true;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    this.labels = document.createElement('div');
    this.labels.className = 'labels3d';
    container.appendChild(this.labels);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color();
    this.scene.fog = new THREE.Fog(0, 15, 45);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
    this.camera.position.set(-4, 7, 6);
    this.controls = new OrbitControls(this.camera, r.domElement);
    Object.assign(this.controls, { enableDamping: true, maxPolarAngle: Math.PI * 0.48, minDistance: 0.8, maxDistance: 90 });
    this.controls.target.set(0, 0, -2);

    // Soft light: a sky/ground fill and one key light whose shadow box follows you.
    this.hemi = new THREE.HemisphereLight();
    this.key = new THREE.DirectionalLight(0xffffff, 1.5);
    this.key.castShadow = true;
    const sh = this.key.shadow;
    sh.mapSize.set(2048, 2048);
    Object.assign(sh.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 45 });
    sh.bias = -0.0004;
    sh.normalBias = 0.025;
    this.scene.add(this.hemi, this.key, this.key.target);

    this.floor = new FloorSurface();
    this.things = new THREE.Group(); // furniture models for the objects seen
    this.walls = new THREE.Group(); // flat vertical surfaces found in the points
    this.slabs = new THREE.Group(); // flat horizontal surfaces (table tops, counters, beds)
    this.scene.add(this.floor.mesh, this.things, this.walls, this.slabs);
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.2); // hide what's above this height
    const clipped = (o) => ({ clippingPlanes: [this.clip], ...o });
    const matte = (o) => new THREE.MeshStandardMaterial(clipped({ roughness: 0.9, metalness: 0, ...o }));
    this.wallMat = { side: matte(), top: matte(), cap: new THREE.MeshBasicMaterial(clipped({ side: THREE.BackSide })) };
    this.wallMats = sixOf(this.wallMat.side, this.wallMat.top);
    this.slabMat = { side: matte(), top: matte() };
    this.slabMats = sixOf(this.slabMat.side, this.slabMat.top);
    this.wallRecs = [];
    this.wallSegs = new Float32Array(0); // [ax, az, bx, bz, top, …] in three's frame, for the ray and the fading
    this.wallCount = 0;
    this.slabMeshes = [];

    // Dots. The raw cloud has room for 2 million points and is drawn up to however many have
    // arrived ("All dots"); the leftover cloud is replaced whole by each setCleanPoints.
    this.cap = 2_000_000;
    this.n = 0;
    this.pos = new THREE.BufferAttribute(new Float32Array(this.cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Uint8Array(this.cap * 3), 3, true).setUsage(THREE.DynamicDrawUsage);
    const dotsMat = () => new THREE.PointsMaterial(clipped({ size: 0.025, vertexColors: true, transparent: true, depthWrite: false }));
    this.cloud = this.points(this.pos, this.col, dotsMat());
    this.restCap = 0;
    this.rest = this.points(null, null, dotsMat()); // the leftovers
    this.hasClean = false; // until leftovers first arrive, the raw cloud stands in for them
    this.showAll = false;

    // The path walked (thin, on the floor), the route (a glowing ribbon) and the goal.
    this.trail = new Ribbon(20000, 0.05, glowMat({}), 0.01);
    this.route = new Ribbon(512, 0.35, glowMat({ map: softTexture('band'), opacity: 0.85 }), 0.016);
    this.trail.mesh.renderOrder = 1;
    this.route.mesh.renderOrder = 2;
    this.goal = new THREE.Mesh(floorPlane, glowMat({ map: softTexture('ring') }));
    this.goal.renderOrder = 2;
    this.goal.visible = false;
    this.me = new MeMarker();
    this.scene.add(this.trail.mesh, this.route.mesh, this.goal, this.me.group);

    this.followDist = 3.6;
    this.markers = [];
    this.v = new THREE.Vector3(); // scratch, so the render loop allocates nothing
    this.want = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.setTheme('dark');
    this.setMode('follow'); // (sets the controls up for it: the wheel is the follow distance, no panning)
    this.wire();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.last = performance.now();
    const loop = () => {
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  points(pos, col, mat) {
    const g = new THREE.BufferGeometry();
    if (pos) { g.setAttribute('position', pos); g.setAttribute('color', col); }
    g.setDrawRange(0, 0);
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    this.scene.add(p);
    return p;
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
    // Following you, the wheel moves the chase camera nearer or further instead of orbiting.
    el.addEventListener('wheel', (e) => {
      if (this.mode !== 'follow') return;
      e.preventDefault();
      this.followDist = Math.min(16, Math.max(1.5, this.followDist * Math.exp(e.deltaY * 0.0015)));
    }, { passive: false });
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 'dark' | 'light': recolours everything in place (nothing is rebuilt but the floor texture). */
  setTheme(name) {
    const t = THEMES[name] ?? THEMES.dark;
    this.theme = THEMES[name] ? name : 'dark';
    this.t = t;
    this.scene.background.set(t.bg);
    this.scene.fog.color.set(t.bg);
    this.hemi.color.set(t.sky);
    this.hemi.groundColor.set(t.ground);
    this.hemi.intensity = t.hemi;
    this.key.intensity = t.key;
    this.renderer.toneMappingExposure = t.exposure;
    this.floor.setTheme(t);
    themeFurniture(t);
    this.wallMat.side.color.set(t.wall);
    this.wallMat.top.color.set(t.wallTop);
    this.wallMat.cap.color.set(t.wallCap);
    for (const w of this.wallRecs) if (w.fadeMats) { w.fadeMats[0].color.set(t.wall); w.fadeMats[2].color.set(t.wallTop); }
    this.slabMat.side.color.set(t.obj);
    this.slabMat.top.color.set(t.objTop);
    for (const c of [this.cloud, this.rest]) { c.material.color.set(t.dots); c.material.opacity = t.dotsOpacity; }
    this.trail.mesh.material.color.set(t.trail);
    this.trail.mesh.material.opacity = t.trailOpacity;
    this.route.mesh.material.color.set(t.accent);
    this.goal.material.color.set(t.accent);
    this.me.setTheme(t);
    this.container.classList.toggle('light', this.theme === 'light');
  }

  resetPoints() {
    this.n = 0;
    this.cloud.geometry.setDrawRange(0, 0);
  }

  /** Raw points, appended. xyz: Float32Array in the map frame; gray: Uint8Array. */
  addPoints(xyz, gray) {
    const count = Math.min(gray.length, this.cap - this.n);
    for (let i = 0; i < count; i++) {
      this.pos.setXYZ(this.n + i, xyz[i * 3], -xyz[i * 3 + 1], -xyz[i * 3 + 2]);
      const f = shade(gray[i]);
      this.col.setXYZ(this.n + i, f, f, f);
    }
    this.pos.addUpdateRange?.(this.n * 3, count * 3);
    this.col.addUpdateRange?.(this.n * 3, count * 3);
    this.pos.needsUpdate = this.col.needsUpdate = true;
    this.n += count;
    this.cloud.geometry.setDrawRange(0, this.n);
  }

  /**
   * The leftover points (not floor, wall, object or flat top), replacing the last set. The arrays
   * are copied, not kept. null clears them and shows the raw cloud again until the next set.
   */
  setCleanPoints(xyz, gray) {
    if (!xyz) {
      this.hasClean = false;
      this.rest.geometry.setDrawRange(0, 0);
      return this.syncDots();
    }
    const n = Math.floor(xyz.length / 3);
    if (n > this.restCap || !this.restCap) { // (an empty first set still needs the buffers)
      // Grow with room to spare; the old buffers are freed.
      this.restCap = Math.max(65536, Math.ceil(n * 1.5));
      this.rest.geometry.dispose();
      this.rest.geometry = new THREE.BufferGeometry();
      this.rest.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.restCap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      this.rest.geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.restCap * 3), 3, true).setUsage(THREE.DynamicDrawUsage));
    }
    const P = this.rest.geometry.attributes.position, C = this.rest.geometry.attributes.color;
    const p = P.array, c = C.array;
    for (let i = 0, k = 0; i < n; i++, k += 3) {
      p[k] = xyz[k]; p[k + 1] = -xyz[k + 1]; p[k + 2] = -xyz[k + 2];
      c[k] = c[k + 1] = c[k + 2] = shade(gray ? gray[i] : 160) * 255;
    }
    P.clearUpdateRanges?.(); C.clearUpdateRanges?.();
    P.addUpdateRange?.(0, n * 3);
    C.addUpdateRange?.(0, n * 3);
    P.needsUpdate = C.needsUpdate = true;
    this.rest.geometry.setDrawRange(0, n);
    this.hasClean = true;
    this.syncDots();
  }

  syncDots() {
    const raw = this.showAll || !this.hasClean;
    this.cloud.visible = raw;
    this.rest.visible = !raw;
  }

  /** The floor grid (see the 'map' message): drawn as the explored floor. null clears it. */
  setGrid(grid) {
    this.floor.setGrid(grid ?? null);
  }

  setTrajectory(flat) {
    const p = this.trail.pts, n = Math.min(this.trail.cap, Math.floor((flat?.length ?? 0) / 3));
    for (let i = 0; i < n; i++) { p[i * 2] = flat[i * 3]; p[i * 2 + 1] = -flat[i * 3 + 2]; }
    this.trail.update(n);
  }

  /** p: { x, y, z, heading, R, status } (R: camera → map, row-major), or null to hide the marker. */
  setPose(p) {
    this.user = p;
    this.me.setPose(p);
  }

  /** unc: { cxx, cxz, czz, yawSd, level } from the worker, or undefined (then from the status). */
  setUncertainty(unc) {
    this.me.setUncertainty(unc);
  }

  /** { hfovDeg, aspect } of the camera: sets the view frustum's shape. */
  setCameraModel(m) {
    this.me.setCameraModel(m);
  }

  setRoute(path) {
    const pts = path ?? [], p = this.route.pts, n = Math.min(this.route.cap, pts.length);
    for (let i = 0; i < n; i++) { p[i * 2] = pts[i][0]; p[i * 2 + 1] = -pts[i][1]; }
    this.route.update(n);
  }

  setGoal(g) {
    this.goal.visible = !!g;
    if (g) this.goal.position.set(g.x, 0.018, -g.z);
  }

  /** [{ label, x, z, kind: 'place' | 'landmark' | 'start' }] shown as text tags. */
  setMarkers(list) {
    this.markers = list;
    this.labels.innerHTML = list.map((m) => `<span class="tag3d ${m.kind}">${m.label.replace(/[<&>]/g, '')}</span>`).join('');
  }

  /** Sized furniture models for the objects in the map (see slam/objects.js). */
  setObjects(list) {
    const sig = list.map((o) => [o.cls, o.x, o.z, o.w, o.h, o.d, o.yaw, o.bottom].map((v) => (typeof v === 'number' ? v.toFixed(2) : v)).join()).join('|');
    if (sig === this.objectSig) return;
    this.objectSig = sig;
    this.things.clear(); // the models share geometries and materials, so there's nothing to free
    for (const o of list) {
      const g = furniture(o.cls, o.w, o.h, o.d, o.bottom ?? 0);
      g.position.set(o.x, -(o.bottom ?? 0), -o.z); // map (x, y down, z) → three (x, up, −z)
      g.rotation.y = -o.yaw; // front faces back the way it was seen from
      this.things.add(g);
    }
  }

  /** Walls: segments on the floor plan with a height, [{ x0, z0, x1, z1, top }] (see slam/walls.js). */
  setWalls(list) {
    const sig = list.map((w) => `${w.x0.toFixed(2)},${w.z0.toFixed(2)},${w.x1.toFixed(2)},${w.z1.toFixed(2)},${w.top.toFixed(2)}`).join('|');
    if (sig === this.wallSig) return;
    this.wallSig = sig;
    while (this.wallRecs.length < list.length) this.wallRecs.push(this.wallRec());
    const segs = (this.wallSegs = new Float32Array(list.length * 5));
    list.forEach((w, i) => {
      const rec = this.wallRecs[i], dx = w.x1 - w.x0, dz = w.z1 - w.z0;
      rec.g.scale.set(Math.hypot(dx, dz) + WALL_T, w.top, WALL_T); // longer by the thickness, so corners close
      rec.g.position.set((w.x0 + w.x1) / 2, w.top / 2, -(w.z0 + w.z1) / 2);
      rec.g.rotation.y = Math.atan2(dz, dx); // local x along the wall
      rec.g.visible = true;
      segs.set([w.x0, -w.z0, w.x1, -w.z1, w.top], i * 5);
    });
    for (let i = list.length; i < this.wallRecs.length; i++) this.wallRecs[i].g.visible = false;
    this.wallCount = list.length;
  }

  wallRec() {
    // The box, plus its inside faces drawn flat: where 'Hide above' cuts a wall open, that reads
    // as a solid top instead of a hollow shell.
    const front = new THREE.Mesh(unitBox, this.wallMats), back = new THREE.Mesh(unitBox, this.wallMat.cap);
    front.castShadow = front.receiveShadow = true;
    const g = new THREE.Group();
    g.add(front, back);
    this.walls.add(g);
    return { g, front, back, fade: 1, fadeMats: null };
  }

  /** Flat tops: [{ x, z, w, d, yaw, h }] (h = height above the floor, w along (cos yaw, sin yaw)). */
  setSlabs(list) {
    list ??= [];
    const sig = list.map((s) => [s.x, s.z, s.w, s.d, s.yaw, s.h].map((v) => v.toFixed(2)).join()).join('|');
    if (sig === this.slabSig) return;
    this.slabSig = sig;
    while (this.slabMeshes.length < list.length) {
      const m = new THREE.Mesh(unitBox, this.slabMats);
      m.castShadow = m.receiveShadow = true;
      this.slabs.add(m);
      this.slabMeshes.push(m);
    }
    this.slabMeshes.forEach((m, i) => {
      const s = list[i];
      m.visible = !!s;
      if (!s) return;
      m.scale.set(s.w, SLAB_T, s.d);
      m.position.set(s.x, s.h - SLAB_T / 2, -s.z);
      m.rotation.y = s.yaw; // three's local x → (cos yaw, 0, −sin yaw) = the map's (cos yaw, sin yaw)
    });
  }

  setWallsVisible(on) {
    this.walls.visible = on;
  }

  /** true: show every raw point; false: only the leftovers that no surface explains. */
  setPointsVisible(on) {
    this.showAll = !!on;
    this.syncDots();
  }

  setObjectsVisible(on) {
    this.things.visible = on;
    this.slabs.visible = on;
  }

  setClipHeight(h) {
    this.clip.constant = h;
  }

  setMode(mode) {
    this.mode = mode;
    const c = this.controls;
    c.enableRotate = mode !== 'top';
    c.enablePan = mode === 'orbit';
    c.enableZoom = mode !== 'follow';
    if (mode === 'top') {
      const u = this.me.has ? this.me.pos : c.target;
      c.target.set(u.x, 0, u.z);
      this.camera.position.set(u.x, 14, u.z + 0.01);
    }
  }

  frame() {
    const now = performance.now(), dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    // The ray only stops at walls you can see: none when they're hidden, and not above 'Hide above'.
    this.me.update(dt, this.wallSegs, this.walls.visible ? this.wallCount : 0, this.clip.constant);
    this.chase(dt);
    this.controls.update();
    this.fadeWalls(dt);
    // Fog starts a little past what you're looking at, so zooming out doesn't wash things away.
    const d = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = d + 10;
    this.scene.fog.far = d + 40;
    // The key light (and its shadow box) follows you, in 0.5 m steps so shadows don't shimmer.
    const f = this.me.has ? this.me.pos : this.controls.target;
    const fx = Math.round(f.x * 2) / 2, fz = Math.round(f.z * 2) / 2;
    this.key.position.set(fx + 5, 14, fz + 4);
    this.key.target.position.set(fx, 0, fz);
    if (this.goal.visible) {
      const s = 0.8 + 0.06 * Math.sin(now / 400);
      this.goal.scale.set(s, 1, s);
    }
    this.renderer.render(this.scene, this.camera);
    this.placeTags();
  }

  /** Follow me: behind and above, looking where you look. From above: stays over you. */
  chase(dt) {
    if (!this.me.has) return;
    const u = this.me.pos, c = this.controls;
    if (this.mode === 'follow') {
      const fx = Math.sin(this.me.heading), fz = -Math.cos(this.me.heading), D = this.followDist;
      this.want.set(u.x - fx * D, 0.7 * D + 0.3, u.z - fz * D);
      this.look.set(u.x + fx * 1.4, 0.5, u.z + fz * 1.4);
      this.camera.position.lerp(this.want, damp(dt, 0.35));
      c.target.lerp(this.look, damp(dt, 0.2));
    } else if (this.mode === 'top') {
      this.v.set(u.x - c.target.x, 0, u.z - c.target.z).multiplyScalar(damp(dt, 0.25));
      c.target.add(this.v);
      this.camera.position.add(this.v);
    }
  }

  /** Walls between the view and you fade out (smoothly), so they never hide you. */
  fadeWalls(dt) {
    const c = this.camera.position, u = this.me.pos, k = damp(dt, 0.12);
    for (let i = 0; i < this.wallCount; i++) {
      const rec = this.wallRecs[i];
      // Does the sight line from the camera to your spot on the floor cross this wall below its top?
      const want = this.me.has && blocksView(c, u.x, u.z, this.wallSegs, i, this.clip.constant, WALL_T) ? FADED : 1;
      if (rec.fade === want) continue;
      rec.fade += (want - rec.fade) * k;
      if (Math.abs(rec.fade - want) < 0.005) rec.fade = want;
      const solid = rec.fade === 1;
      if (!solid && !rec.fadeMats) {
        rec.fadeMats = sixOf(this.wallMat.side.clone(), this.wallMat.top.clone());
        // (clone() copies the clip plane by value, so point it back at the live one)
        for (const m of new Set(rec.fadeMats)) Object.assign(m, { transparent: true, depthWrite: false, clippingPlanes: [this.clip] });
      }
      rec.front.material = solid ? this.wallMats : rec.fadeMats;
      rec.back.visible = solid;
      if (!solid) rec.fadeMats[0].opacity = rec.fadeMats[2].opacity = rec.fade;
    }
  }

  placeTags() {
    // Place the text tags over their spots.
    const w = this.container.clientWidth, h = this.container.clientHeight, tags = this.labels.children, v = this.v;
    for (let i = 0; i < this.markers.length; i++) {
      const m = this.markers[i], el = tags[i];
      if (!el) continue;
      v.set(m.x, m.y ?? 0.4, -m.z).project(this.camera);
      const hidden = v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1;
      el.style.display = hidden ? 'none' : '';
      if (!hidden) el.style.transform = `translate(${(((v.x + 1) / 2) * w).toFixed(1)}px, ${(((1 - v.y) / 2) * h).toFixed(1)}px) translate(-50%, -100%)`;
    }
  }
}

/** Dot brightness from the camera image's gray, kept in a narrow band so dots stay quiet. */
const shade = (g) => 0.62 + (0.38 * g) / 255;
