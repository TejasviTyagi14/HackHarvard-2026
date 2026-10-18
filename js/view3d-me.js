// You, in the 3D view: a puck on the floor under the camera, the camera itself at its real
// height, a see-through view frustum turned by the full pose (pitch and roll too), and a ray along
// the optical axis to the first thing it meets (floor or wall), with a reticle lying on that
// surface. Around the puck, a soft ellipse for where you could be and a fan for which way you
// could be facing. Everything is in three's frame; nothing is allocated per frame.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ellipse, headingR, rayHit } from './view3d-math.js';
import { THEMES, floorPlane, glowMat, levelColor, softTexture } from './view3d-parts.js';

const FAN = 64; // segments in the heading fan
const FAN_R = 1; // m
const RAY_MAX = 6; // m: the ray stops here when it meets nothing
const HALF_WALL = 0.05; // m: walls are drawn 10 cm thick
const DEG = Math.PI / 180;
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, 1);

// Used when the worker doesn't send an uncertainty: a rough size from the tracking status alone.
const FALLBACK = {
  ok: { sd: 0.05, yawSd: 1.5 * DEG, level: 'good' },
  lost: { sd: 1, yawSd: 60 * DEG, level: 'lost' },
  other: { sd: 0.3, yawSd: 12 * DEG, level: 'weak' },
};

export class MeMarker {
  constructor() {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.has = false;
    this.t = THEMES.dark;
    this.mats = {
      body: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 }),
      lens: glowMat({ opacity: 1, side: THREE.FrontSide }),
      fill: glowMat({ opacity: 0.07 }),
      edge: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false }),
      ray: glowMat({ opacity: 0.95 }),
      rayGlow: glowMat({ opacity: 0.14 }),
      puck: glowMat({ map: softTexture('disc'), opacity: 0.3 }),
      ring: glowMat({ opacity: 0.95 }),
      reticle: glowMat({ map: softTexture('ring'), opacity: 1 }),
      dot: glowMat({ map: softTexture('disc'), opacity: 0.9 }),
      halo: glowMat({ map: softTexture('halo'), opacity: 0.42 }),
      fan: glowMat({ vertexColors: true, opacity: 0.55 }),
      stem: new THREE.LineBasicMaterial({ transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false }),
    };
    const M = this.mats;
    this.tinted = [M.lens, M.fill, M.edge, M.ray, M.rayGlow, M.puck, M.ring, M.reticle, M.dot, M.stem]; // follow the status colour
    const order = (o, n) => { o.renderOrder = n; return o; };

    // The camera's own frame (x right, y down, z forward), placed by the pose each frame.
    this.cam = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.07, 0.07, 2, 0.022), this.mats.body);
    body.position.z = -0.04;
    body.castShadow = true;
    const lens = order(new THREE.Mesh(new THREE.CircleGeometry(0.021, 24), this.mats.lens), 9);
    lens.position.z = -0.003;
    this.frustum = new THREE.Group();
    this.fill = order(new THREE.Mesh(new THREE.BufferGeometry(), this.mats.fill), 7);
    this.edges = order(new THREE.LineSegments(new THREE.BufferGeometry(), this.mats.edge), 8);
    this.frustum.add(this.fill, this.edges);
    // A unit cylinder along +z from 0 to 1, stretched to the ray's length.
    const rod = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.ray = order(new THREE.Mesh(rod, this.mats.ray), 9);
    this.rayGlow = order(new THREE.Mesh(rod, this.mats.rayGlow), 8);
    this.cam.add(body, lens, this.frustum, this.ray, this.rayGlow);

    // On the floor, under the camera.
    this.halo = order(new THREE.Mesh(floorPlane, this.mats.halo), 3);
    this.fanPos = new THREE.BufferAttribute(new Float32Array((FAN + 2) * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const fanCol = new Float32Array((FAN + 2) * 4).fill(1);
    fanCol[3] = 0.6; // opaque-ish at the centre, fading to nothing at the rim
    for (let k = 1; k < FAN + 2; k++) fanCol[k * 4 + 3] = 0;
    const fanIdx = [];
    for (let k = 0; k < FAN; k++) fanIdx.push(0, k + 2, k + 1);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', this.fanPos);
    fg.setAttribute('color', new THREE.BufferAttribute(fanCol, 4));
    fg.setIndex(fanIdx);
    this.fan = order(new THREE.Mesh(fg, this.mats.fan), 4);
    this.fan.frustumCulled = false;
    this.puck = order(new THREE.Mesh(floorPlane, this.mats.puck), 5);
    this.puck.scale.setScalar(0.5);
    this.ring = order(new THREE.Mesh(new THREE.RingGeometry(0.19, 0.212, 56).rotateX(-Math.PI / 2), this.mats.ring), 6);
    this.stemPos = new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage);
    this.stem = order(new THREE.Line(new THREE.BufferGeometry().setAttribute('position', this.stemPos), this.mats.stem), 6);
    this.stem.frustumCulled = false;
    this.halo.position.y = 0.006;
    this.fan.position.y = 0.009;
    this.puck.position.y = 0.012;
    this.ring.position.y = 0.013;
    this.floorParts = new THREE.Group();
    this.floorParts.add(this.halo, this.fan, this.puck, this.ring);

    // Where the ray lands: a reticle lying on that surface, with a dot in the middle.
    this.reticle = new THREE.Group();
    this.reticle.add(order(new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), this.mats.reticle), 10), order(new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), this.mats.dot), 10));
    this.group.add(this.cam, this.floorParts, this.stem, this.reticle);

    // Pose and uncertainty: targets (from the worker) and the smoothed values drawn.
    this.pos = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.heading = 0;
    this.posT = new THREE.Vector3();
    this.qT = new THREE.Quaternion();
    this.headingT = 0;
    this.status = 'init';
    this.unc = null;
    this.ell = { a: 0.3, b: 0.3, th: 0, fan: 10 * DEG }; // drawn
    this.ellT = { a: 0.3, b: 0.3, th: 0, fan: 10 * DEG }; // target
    this.fanDrawn = -1;
    this.col = new THREE.Color(this.t.accent);
    this.colT = new THREE.Color(this.t.accent);
    this.haloCol = new THREE.Color(this.t.accent);
    this.haloColT = new THREE.Color(this.t.accent);
    this.m4 = new THREE.Matrix4();
    this.dir = new THREE.Vector3();
    this.nrm = new THREE.Vector3();
    this.hit = { len: 0, hit: 0, nx: 0, nz: 0 }; // the ray's hit, reused each frame
    this.setCameraModel({ hfovDeg: 70, aspect: 16 / 9 });
  }

  setTheme(t) {
    this.t = t;
    this.mats.body.color.set(t.body);
    this.refreshLevel();
    this.col.copy(this.colT);
    this.haloCol.copy(this.haloColT);
  }

  /** The camera's field of view: the frustum is rebuilt (1 m deep, in camera coordinates; open at the far end). */
  setCameraModel({ hfovDeg = 70, aspect = 16 / 9 } = {}) {
    const tx = Math.tan((hfovDeg * DEG) / 2), ty = tx / (aspect || 16 / 9);
    const c = [[-tx, -ty, 1], [tx, -ty, 1], [tx, ty, 1], [-tx, ty, 1]];
    const tri = [], seg = [];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      tri.push(0, 0, 0, ...a, ...b);
      seg.push(0, 0, 0, ...a, ...a, ...b);
    }
    this.fill.geometry.dispose();
    this.edges.geometry.dispose();
    this.fill.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
    this.edges.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  }

  /** p: { x, y, z, heading, R, status } in the map frame (R: camera → map, row-major), or null to hide. */
  setPose(p) {
    if (!p) {
      this.has = false;
      this.group.visible = false;
      return;
    }
    const R = p.R ?? headingR(p.heading);
    // three = S·map with S = diag(1, −1, −1), so the camera's frame in three is S·R.
    this.m4.set(R[0], R[1], R[2], 0, -R[3], -R[4], -R[5], 0, -R[6], -R[7], -R[8], 0, 0, 0, 0, 1);
    this.qT.setFromRotationMatrix(this.m4);
    this.posT.set(p.x, -p.y, -p.z);
    this.headingT = p.heading ?? this.headingT;
    this.status = p.status ?? 'ok';
    // First pose, or a jump (loop closure, relocalised): go straight there.
    if (!this.has || this.pos.distanceToSquared(this.posT) > 2.25) {
      this.pos.copy(this.posT);
      this.q.copy(this.qT);
      this.heading = this.headingT;
    }
    this.has = true;
    this.group.visible = true;
    if (!this.unc) this.applyUnc();
    this.refreshLevel();
  }

  /** unc: { cxx, cxz, czz, yawSd, level } (map floor-plane covariance, m²; rad), or undefined. */
  setUncertainty(unc) {
    const ok = unc && [unc.cxx, unc.cxz, unc.czz, unc.yawSd].every(Number.isFinite);
    this.unc = ok ? unc : null;
    this.applyUnc();
    this.refreshLevel();
  }

  applyUnc() {
    let { cxx, cxz, czz, yawSd } = this.unc ?? {};
    if (!this.unc) {
      const f = FALLBACK[this.status] ?? FALLBACK.other;
      cxx = czz = f.sd * f.sd;
      cxz = 0;
      yawSd = f.yawSd;
    }
    // 2-sigma ellipse of the 2×2 covariance; the halo mesh is turned by rotation.y = th.
    const e = ellipse(cxx, cxz, czz);
    const clamp = (v) => Math.min(8, Math.max(0.3, v)); // never smaller than just around the puck
    this.ellT.a = clamp(2 * e.a);
    this.ellT.b = clamp(2 * e.b);
    this.ellT.th = e.th;
    this.ellT.fan = Math.min(Math.PI, Math.max(3 * DEG, 2 * yawSd));
  }

  /** Marker colour from the tracking status (and the uncertainty's level); halo from the level. */
  refreshLevel() {
    const st = this.status === 'ok' ? 'good' : this.status === 'lost' ? 'lost' : 'weak';
    const lv = this.unc?.level ?? (FALLBACK[this.status] ?? FALLBACK.other).level;
    const worst = st === 'lost' || lv === 'lost' ? 'lost' : st === 'weak' || lv === 'weak' ? 'weak' : 'good';
    this.colT.set(levelColor(this.t, worst));
    this.haloColT.set(levelColor(this.t, lv));
  }

  /** Once per frame. walls: Float32Array [ax, az, bx, bz, top, …] in three's frame; n walls, cut at height clipH. */
  update(dt, walls, n, clipH = Infinity) {
    if (!this.has) return;
    const k = damp(dt, 0.06);
    this.pos.lerp(this.posT, k);
    this.q.slerp(this.qT, k);
    this.heading += wrapPi(this.headingT - this.heading) * k;
    const o = this.pos, d = this.dir.copy(FWD).applyQuaternion(this.q);
    this.cam.position.copy(o);
    this.cam.quaternion.copy(this.q);
    this.floorParts.position.set(o.x, 0, o.z);
    this.stemPos.setXYZ(0, o.x, 0.012, o.z);
    this.stemPos.setXYZ(1, o.x, o.y - 0.04, o.z);
    this.stemPos.needsUpdate = true;

    // The ray: first hit on the floor plane or a wall (2D crossing, then the height there),
    // stopping at the wall's face (it's drawn 10 cm thick); the reticle lies on it, facing you.
    const { len, hit, nx, nz } = rayHit(o, d, walls, n, clipH, this.hit, RAY_MAX, HALF_WALL);
    this.reticle.visible = hit > 0;
    if (hit === 1) {
      this.reticle.position.set(o.x + d.x * len, 0.014, o.z + d.z * len);
      this.reticle.quaternion.setFromUnitVectors(FWD, UP);
    } else if (hit === 2) {
      this.reticle.position.set(o.x + d.x * len + nx * 0.008, o.y + d.y * len, o.z + d.z * len + nz * 0.008);
      this.reticle.quaternion.setFromUnitVectors(FWD, this.nrm.set(nx, 0, nz));
    }
    this.ray.scale.set(0.006, 0.006, len);
    this.rayGlow.scale.set(0.022, 0.022, len);
    this.frustum.scale.setScalar(Math.min(1, Math.max(0.25, len)));

    // Halo and fan ease toward their new size.
    const e = this.ell, t = this.ellT, kh = damp(dt, 0.3);
    e.a += (t.a - e.a) * kh;
    e.b += (t.b - e.b) * kh;
    e.th += (wrapPi(2 * (t.th - e.th)) / 2) * kh; // the ellipse looks the same turned by 180°
    e.fan += (t.fan - e.fan) * kh;
    this.halo.scale.set(2 * e.a, 1, 2 * e.b);
    this.halo.rotation.y = e.th;
    this.fan.rotation.y = -this.heading;
    if (Math.abs(e.fan - this.fanDrawn) > 1e-4) this.drawFan(e.fan);

    const kc = damp(dt, 0.15);
    this.col.lerp(this.colT, kc);
    this.haloCol.lerp(this.haloColT, kc);
    for (const m of this.tinted) m.color.copy(this.col);
    this.mats.halo.color.copy(this.haloCol);
    this.mats.fan.color.copy(this.haloCol);
  }

  drawFan(A) {
    // A circular sector of half-angle A around three's −z (forward at heading 0).
    this.fanPos.setXYZ(0, 0, 0, 0);
    for (let k = 0; k <= FAN; k++) {
      const a = -A + (2 * A * k) / FAN;
      this.fanPos.setXYZ(k + 1, Math.sin(a) * FAN_R, 0, -Math.cos(a) * FAN_R);
    }
    this.fanPos.needsUpdate = true;
    this.fanDrawn = A;
  }
}
