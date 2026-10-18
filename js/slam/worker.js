// The mapper, running in a Web Worker so the page stays smooth: tracking every frame, depth and
// fusion on keyframes, and route planning. In demo mode it also renders the synthetic building
// and plays the part of the object detector for its furniture.
import { buildRig } from '../geometry.js';
import { StereoVO } from './vo.js';
import { World } from './world.js';
import { GoalPlanner } from './plan.js';
import { LoopCloser } from './closer.js';
import { estimateRotation } from './loop.js';
import { measureBox } from './objects.js';
import { extractWalls, squareUp } from './walls.js';
import { rawToRect, remap } from './rectify.js';
import { disparityBM, localNormalize } from './dense.js';
import { buildingScene, firstHit, poseAt, renderGray, tour, walk } from './building.js';
import { apply, invert, mulv } from './se3.js';

let cfg = null, vo = null, world = null, mapping = true;
let goal = null, planner = null, plannedAt = -Infinity, plannedVersion = -1, plannedFrom = null;
let traj = [], lastTraj = null, demo = null, lastHere = null;
let closer = null, needReloc = false, lastReloc = 0, loops = 0;
let aligned = false, alignTries = 0, rotated = false;
let mono = false, depthPipe = null, depthBusy = Promise.resolve();
const recent = new Map(); // frame id → { left, L, R, pose }, for placing objects detected in it
let walls = [], lastWalls = 0, levels = 0, wallAxis = null;

const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';
const DEPTH_MODEL = 'onnx-community/metric3d-vit-small';

/** Metric depth (m) for a grayscale frame, from Metric3D v2 running on the GPU (WebGPU). One at a time. */
function estimateDepth(gray, w, h) {
  const p = depthBusy.then(() => runDepth(gray, w, h));
  depthBusy = p.catch(() => {});
  return p;
}

async function runDepth(gray, w, h) {
  const tf = await import(TRANSFORMERS);
  if (!depthPipe) {
    post({ type: 'status', text: 'Downloading the depth model (150 MB, first time only)…' });
    try {
      // Full precision: the half-precision build wants 16-bit input, which the pipeline doesn't send.
      depthPipe = await tf.pipeline('depth-estimation', DEPTH_MODEL, { device: 'webgpu', dtype: 'fp32' });
    } catch {
      depthPipe = await tf.pipeline('depth-estimation', DEPTH_MODEL, { dtype: 'fp32' }); // no WebGPU: slower, on the CPU
    }
    post({ type: 'status', text: null });
  }
  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = gray[i];
  const out = await depthPipe(new tf.RawImage(rgb, w, h, 3));
  const t = out.predicted_depth, dims = t.dims, H2 = dims[dims.length - 2], W2 = dims[dims.length - 1];
  // The pipeline's output is already in metres (checked against the demo building's true depths).
  const k = cfg.monoScale ?? 1;
  const src = t.data, D = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(W2 - 1, (x * W2) / w), sy = Math.min(H2 - 1, (y * H2) / h);
      D[y * w + x] = src[Math.floor(sy) * W2 + Math.floor(sx)] * k;
    }
  }
  return D;
}

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

function setup(m) {
  cfg = m;
  const { w, h } = m.size;
  const cloudRange = m.world.rangeMax ?? 10; // map out to here
  const turnFrom = m.turnFrom ?? 'compass';
  vo = new StereoVO(m.rig, w, h, { maxDisp: Math.round((64 * w) / 320), cloudRange, turnFrom });
  world = new World(m.world);
  closer = new LoopCloser(vo.intr);
  mono = !!m.mono;
  if (mono) vo = new StereoVO(m.rig, w, h, { mono: true, maxRange: 15, cloudRange, turnFrom }); // the depth model sees far
  walls = [];
  wallAxis = null;
  lastWalls = levels = 0;
  world.o.minHits = mono ? 3 : 2; // model depth is noisier than stereo: want more views per voxel
  recent.clear();
  needReloc = false;
  loops = 0;
  aligned = !!m.demo;
  alignTries = 0;
  rotated = !!m.rig.Rrel || mono;
  if (mono) aligned = true;
  traj = [];
  lastTraj = null;
  planner = null;
}

function headingOf(R) {
  // Camera forward (third column) flattened onto the floor; radians, + = right.
  return Math.atan2(R[2], R[8]);
}

function replan(here, now) {
  if (!goal) return null;
  const stale = !planner
    || (world.version !== plannedVersion && now - plannedAt > 1000)
    || (plannedFrom && Math.hypot(here.x - plannedFrom.x, here.z - plannedFrom.z) > 1 && now - plannedAt > 1000);
  if (stale) {
    const grid = world.gridSnapshot();
    if (!grid) return { ok: false, reason: 'no-map' };
    planner = new GoalPlanner(grid, goal, here, cfg.plan ?? {});
    plannedAt = now;
    plannedVersion = world.version;
    plannedFrom = here;
  }
  return planner.route(here);
}

function process(left, right, t, gap, id, extra = {}, depth = null) {
  const r = vo.process({ left, right, t, gap, depth });
  if (r.status === 'ok') {
    recent.set(id, { left, L: vo.last.L, R: vo.last.R, pose: { R: vo.pose.R.slice(), t: vo.pose.t.slice() } });
    if (recent.size > 8) recent.delete(recent.keys().next().value);
  }
  const now0 = performance.now();
  let loop = null, reloc = false;
  if (!mono && (r.status === 'lost' || needReloc) && world.keyframes.length > 3 && now0 - lastReloc > 500) {
    // Lost, or a loaded map: find where we are by recognising a stored keyframe.
    lastReloc = now0;
    const T = closer.relocalize(world, vo.describeLast(), lastHere && [lastHere.x, 0, lastHere.z]);
    if (T) {
      const kf = vo.relocalize(T);
      if (mapping && !needReloc) world.addKeyframe(kf);
      needReloc = false;
      reloc = true;
      r.status = 'ok';
      r.keyframe = null;
    }
  }
  if (r.keyframe && mapping && !needReloc) {
    world.addKeyframe(r.keyframe);
    loop = closer.check(world);
    if (loop) {
      // The whole map just moved: carry the tracker along and redraw the path from the keyframes.
      vo.shift(loop.C);
      loops++;
      traj = world.keyframes.flatMap((k) => world.mapPose(k.pose).t);
      lastTraj = null;
      planner = null;
    }
  }
  const relevel = world.levels !== levels;
  if (relevel) redrawPath();
  const mp = world.mapPose(vo.pose);
  if (needReloc) r.status = 'reloc';
  const here = { x: mp.t[0], z: mp.t[2] };
  if (!lastTraj || Math.hypot(here.x - lastTraj.x, here.z - lastTraj.z) > 0.1) {
    traj.push(mp.t[0], mp.t[1], mp.t[2]);
    lastTraj = here;
  }
  const now = performance.now();
  if (r.status === 'ok') lastHere = here;
  const route = r.status === 'ok' ? replan(here, now) : null;
  const image = new Uint8ClampedArray(r.image);
  const imageR = new Uint8ClampedArray(vo.last.R);
  post({
    type: 'result', id, status: r.status, x: here.x, z: here.z, y: mp.t[1], heading: headingOf(mp.R), pose: mp,
    inliers: r.inliers, rmse: r.rmse, shiftPx: r.shiftPx, keyframe: !!r.keyframe, timings: r.timings,
    vo: r.stats, features: r.features, image, imageR, size: cfg.size, floor: world.floor, route, mapping, loops, depthInfo: r.depthInfo,
    compass: r.compass && { heading: r.compass.heading, pitch: r.compass.pitch, roll: r.compass.roll, ok: r.compass.ok }, ...extra,
  }, [r.features.buffer, image.buffer, imageR.buffer]);
  if (loop) post({ type: 'loop', correction: loop.correction, loops });
  if (reloc) post({ type: 'reloc' });
  if (loop || relevel) sendMap(true);
  else if (r.keyframe && mapping && world.align) sendMap();
  return { r, mp };
}

/** After the map moved (re-levelled): the path walked comes from the keyframes again. */
function redrawPath() {
  levels = world.levels;
  traj = world.keyframes.flatMap((k) => world.mapPose(k.pose).t);
  lastTraj = null;
  planner = null;
}

function sendMap(full = false) {
  const now = performance.now();
  if (full || now - lastWalls > 2000) {
    lastWalls = now;
    ({ walls, axis: wallAxis } = squareUp(extractWalls(world.voxels.values(), { minHits: world.o.minHits, exclude: world.objects.lasting() }), wallAxis));
  }
  if (full) {
    world.pendingPoints = [...world.voxels.values()].filter((v) => v.n >= world.o.minHits);
    world.pendingReset = true;
  }
  const pts = world.takePoints();
  const grid = world.gridSnapshot();
  const trajectory = Float32Array.from(traj);
  const transfer = [pts.xyz.buffer, pts.gray.buffer, trajectory.buffer];
  if (grid) transfer.push(grid.data.buffer);
  post({
    type: 'map', ...pts, grid, trajectory, landmarks: world.confirmedLandmarks(), places: world.places,
    stats: world.stats(), start: world.toMap([0, 0, 0]), objects: world.objects.confirmed().map(({ anchor, ...o }) => o), walls,
  }, transfer);
}

// ---------------------------------------------------------------------------------------
// Demo: the worker renders the building itself, from the scripted tour or the arrow keys.

function startDemo(kind) {
  stopDemo();
  const { w, h } = cfg.size;
  const scene = buildingScene();
  demo = {
    kind, scene, rig: buildRig(cfg.rig, { w, h }), frames: kind === 'tour' ? tour({ fps: 15 }) : null,
    i: 0, t: 0, state: { x: 0, z: 0, heading: 0 }, keys: { forward: 0, turn: 0 }, frame: 0,
  };
  step();
}

function stopDemo() {
  if (demo?.timer) clearTimeout(demo.timer);
  demo = null;
}

async function step() {
  try {
    await demoStep();
  } catch (err) {
    post({ type: 'error', message: err.message, stack: err.stack });
    stopDemo();
  }
}

async function demoStep() {
  const d = demo;
  if (!d) return;
  const t0 = performance.now(), dt = 1 / 15;
  let truth;
  if (d.kind === 'tour') {
    if (d.i >= d.frames.length) {
      // Tour over: keep going from here, steered by the arrow keys.
      const end = d.frames[d.frames.length - 1];
      d.kind = 'walk';
      d.state = { x: end.x, z: end.z, heading: end.heading };
      post({ type: 'demoDone' });
    } else {
      truth = d.frames[d.i++];
    }
  }
  if (d.kind === 'walk') {
    d.state = walk(d.state, d.keys.forward * 0.9 * dt, d.keys.turn * (55 * Math.PI / 180) * dt, d.scene);
    truth = { ...d.state, pose: poseAt(d.state.x, d.state.z, d.state.heading) };
  }
  const { w, h } = cfg.size;
  const L = renderGray(d.rig.left, truth.pose, d.scene, w, h);
  const R = renderGray(d.rig.right, truth.pose, d.scene, w, h);
  const seen = d.frame % 3 === 0 ? demoSeen(d, truth.pose) : null;
  const depth = mono && (vo.needDepth || vo.status === 'init') ? await estimateDepth(L, w, h) : null;
  const { mp } = mono
    ? process(L, L, d.t, 0, `demo-${d.frame}`, { demo: d.kind, seen: seen?.objects ?? null }, depth)
    : process(L, R, d.t, 0, `demo-${d.frame}`, { demo: d.kind, seen: seen?.objects ?? null });
  // The demo "detects" its furniture perfectly, so place it with its true size.
  if (seen) {
    for (const o of seen.objects) {
      if (o.range > 4) continue;
      const c = apply(mp, o.camPoint), b = o.box;
      world.addObject({ cls: o.cls, score: 1, x: c[0], z: c[2], bottom: 0, w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], d: b.max[2] - b.min[2], yaw: 0 });
    }
  }
  // How far the map's idea of where you are is from the truth.
  const B = cfg.rig.baselineCm / 100;
  const leftCam = apply(truth.pose, [-B / 2, 0, 0]);
  const truthMap = world.toMap([leftCam[0] + B / 2, leftCam[1], leftCam[2]]);
  post({ type: 'truth', x: truthMap[0], z: truthMap[2], drift: Math.hypot(mp.t[0] - truthMap[0], mp.t[2] - truthMap[2]) });
  d.t += dt;
  d.frame++;
  d.timer = setTimeout(step, Math.max(0, 66 - (performance.now() - t0)));
}

/** What a perfect object detector would report in the demo: visible furniture, camera-relative. */
function demoSeen(d, rigPose) {
  const B = cfg.rig.baselineCm / 100;
  const camPose = { R: rigPose.R, t: apply(rigPose, [-B / 2, 0, 0]) };
  const toCam = invert(camPose);
  const objects = [];
  for (const b of d.scene.boxes) {
    if (b.kind !== 'furniture') continue;
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const p = apply(toCam, c);
    if (p[2] < 0.3 || Math.abs(p[0] / p[2]) > 0.75 || Math.abs(p[1] / p[2]) > 0.55) continue;
    // Not hidden behind something else.
    const len = Math.hypot(...p);
    const dir = mulv(camPose.R, p.map((x) => x / len));
    const hit = firstHit(camPose.t, dir, d.scene);
    if (hit && hit.box !== b) continue;
    // The left camera sits B/2 left of the rig's centre, which is what distances are measured from.
    const rigPoint = [p[0] - B / 2, p[1], p[2]];
    objects.push({ cls: b.cls, box: b, camPoint: p, point: rigPoint, range: Math.hypot(...rigPoint), azimuth: (Math.atan2(rigPoint[0], rigPoint[2]) * 180) / Math.PI });
  }
  return { objects };
}

// ---------------------------------------------------------------------------------------

const handlers = {
  init: setup,
  async frame(m) {
    let left = Float32Array.from(new Uint8Array(m.left)), right = Float32Array.from(new Uint8Array(m.right));
    if (mono) {
      const depth = vo.needDepth || vo.status === 'init' ? await estimateDepth(left, cfg.size.w, cfg.size.h) : null;
      process(left, left, m.t, 0, m.id, {}, depth);
      return;
    }
    if (!rotated && vo.status === 'init' && alignTries < 40) {
      // Real cameras: first measure how the two are turned relative to each other, and rectify with that.
      const rot = estimateRotation(left, right, cfg.size.w, cfg.size.h, vo.intr, cfg.rig.baselineCm / 100);
      alignTries++;
      if (rot && rot.inliers >= 25) {
        rotated = true;
        cfg.rig = { ...cfg.rig, Rrel: rot.R, vOffsetPx: 0 };
        // The measured yaw only roughly fixes the scale, so let far points count for tracking.
        vo = new StereoVO(cfg.rig, cfg.size.w, cfg.size.h, { maxDisp: vo.o.maxDisp, maxRange: 12, cloudRange: vo.o.cloudRange, turnFrom: vo.o.turnFrom });
        closer = new LoopCloser(vo.intr);
        post({ type: 'rotation', yaw: rot.yaw, pitch: rot.pitch, roll: rot.roll, angle: rot.angle, inliers: rot.inliers, R: rot.R });
      } else {
        post({ type: 'align', matches: rot?.inliers ?? 0, action: 'retry', tries: alignTries });
      }
      process(left, right, m.t, m.gap, m.id);
      return;
    }
    if (!aligned && vo.status === 'init' && alignTries < 80) {
      // …then check the pair is in the right order and level.
      const a = vo.checkAlignment(left, right);
      alignTries++;
      if (a.matches >= 8 && a.swapped) {
        post({ type: 'align', ...a, action: 'swap' });
        rotated = false; // measure the rotation again with the cameras the right way round
        cfg.rig = { ...cfg.rig, Rrel: null };
        [left, right] = [right, left]; // the page swaps them from the next frame on
      } else if (a.matches >= 8) {
        aligned = true;
        if (Math.abs(a.dy) > 0.6) {
          cfg.rig = { ...cfg.rig, vOffsetPx: (cfg.rig.vOffsetPx ?? 0) + a.dy };
          vo = new StereoVO(cfg.rig, cfg.size.w, cfg.size.h, { maxDisp: vo.o.maxDisp, maxRange: vo.o.maxRange, cloudRange: vo.o.cloudRange, turnFrom: vo.o.turnFrom });
          closer = new LoopCloser(vo.intr);
        }
        post({ type: 'align', ...a, action: 'ok', vOffsetPx: cfg.rig.vOffsetPx ?? 0 });
      } else {
        post({ type: 'align', ...a, action: 'retry', tries: alignTries });
      }
    }
    process(left, right, m.t, m.gap, m.id);
  },
  demo(m) {
    if (m.kind) startDemo(m.kind);
    else stopDemo();
  },
  keys(m) {
    if (demo) demo.keys = { forward: m.forward, turn: m.turn };
  },
  goal(m) {
    goal = m.clear ? null : { x: m.x, z: m.z, label: m.label };
    planner = null;
    // Answer right away rather than on the next frame.
    if (goal && lastHere) post({ type: 'route', route: replan(lastHere, performance.now()) });
  },
  mapping(m) {
    mapping = m.on;
  },
  landmark(m) {
    world.addLandmark(m.cls, m.p);
  },
  /** Detector boxes for a recent frame (raw left-image pixels at the processing size). */
  async objects(m) {
    const fr = recent.get(m.id);
    if (!fr || !m.dets.length || !mapping) return;
    const { w, h } = cfg.size;
    let depth;
    if (mono) {
      depth = remap(await estimateDepth(fr.left, w, h), w, h, vo.rect.mapL);
    } else {
      const nL = localNormalize(fr.L, w, h), nR = localNormalize(fr.R, w, h);
      const disp = disparityBM(nL.data, nR.data, w, h, { maxDisp: vo.o.maxDisp, texture: nL.std, validL: vo.rect.validL, validR: vo.rect.validR });
      const fB = vo.intr.f * vo.baseline;
      depth = disp.map((d) => (d > 0 ? fB / d : -1));
    }
    const mp = world.mapPose(fr.pose), toCam = invert(mp);
    const intr = { ...vo.intr, w, h };
    const seen = [];
    for (const det of m.dets) {
      const [x, y, bw, bh] = det.bbox;
      const a = rawToRect(vo.rect, x, y), b = rawToRect(vo.rect, x + bw, y + bh);
      const box = measureBox({ ...det, bbox: [a[0], a[1], b[0] - a[0], b[1] - a[1]] }, depth, intr, mp);
      if (!box) continue;
      box.t = performance.now() / 1000;
      world.addObject(box);
      if (box.feet) world.addFeet(box.feet, box.t);
      const c = apply(toCam, [box.x, box.bottom - box.h / 2, box.z]); // camera-relative, for "what's in front"
      seen.push({ cls: box.cls, point: c, range: Math.hypot(...c), azimuth: (Math.atan2(c[0], c[2]) * 180) / Math.PI });
    }
    post({ type: 'seen', objects: seen });
    if (world.levels !== levels) {
      redrawPath();
      sendMap(true);
    } else sendMap();
  },
  place(m) {
    world.setPlace(m.name, m.x, m.z);
    sendMap();
  },
  removePlace(m) {
    world.places = world.places.filter((p) => p.name !== m.name);
    sendMap();
  },
  reset() {
    stopDemo();
    vo.reset();
    world.reset();
    traj = [];
    lastTraj = null;
    goal = planner = null;
    sendMap();
  },
  settings(m) {
    if (m.world.rangeMax) vo.o.cloudRange = m.world.rangeMax;
    world.rebuild(m.world);
    cfg.world = { ...cfg.world, ...m.world };
    planner = null;
    sendMap(true);
  },
  save() {
    post({ type: 'saved', data: JSON.stringify(world.serialize({ trajectory: traj })) });
  },
  load(m) {
    stopDemo();
    const data = JSON.parse(m.data);
    world = World.deserialize(data);
    closer = new LoopCloser(vo.intr);
    traj = data.trajectory ?? [];
    lastTraj = null;
    vo.reset();
    needReloc = true; // until the current view is recognised in the loaded map
    goal = planner = null;
    sendMap(true);
  },
  assumeStart() {
    needReloc = false;
  },
  ply() {
    const buf = world.toPLY();
    post({ type: 'ply', data: buf }, [buf]);
  },
};

self.onmessage = (e) => {
  Promise.resolve()
    .then(() => handlers[e.data.type]?.(e.data))
    .catch((err) => post({ type: 'error', message: err.message, stack: err.stack }));
};
post({ type: 'ready' });
