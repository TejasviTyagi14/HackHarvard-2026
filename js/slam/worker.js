// The mapper, running in a Web Worker so the page stays smooth: tracking every frame, depth and
// fusion on keyframes, and route planning. In demo mode it also renders the synthetic building
// and plays the part of the object detector for its furniture.
import { buildRig } from '../geometry.js';
import { StereoVO } from './vo.js';
import { World } from './world.js';
import { GoalPlanner } from './plan.js';
import { LoopCloser } from './closer.js';
import { buildingScene, firstHit, poseAt, renderGray, tour, walk } from './building.js';
import { apply, invert, mulv } from './se3.js';

let cfg = null, vo = null, world = null, mapping = true;
let goal = null, planner = null, plannedAt = -Infinity, plannedVersion = -1, plannedFrom = null;
let traj = [], lastTraj = null, demo = null, lastHere = null;
let closer = null, needReloc = false, lastReloc = 0, loops = 0;

const post = (msg, transfer = []) => self.postMessage(msg, transfer);

function setup(m) {
  cfg = m;
  const { w, h } = m.size;
  vo = new StereoVO(m.rig, w, h, { maxDisp: Math.round((64 * w) / 320) });
  world = new World(m.world);
  closer = new LoopCloser(vo.intr);
  needReloc = false;
  loops = 0;
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

function process(left, right, t, gap, id, extra = {}) {
  const r = vo.process({ left, right, t, gap });
  const now0 = performance.now();
  let loop = null, reloc = false;
  if ((r.status === 'lost' || needReloc) && world.keyframes.length > 3 && now0 - lastReloc > 500) {
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
  post({
    type: 'result', id, status: r.status, x: here.x, z: here.z, y: mp.t[1], heading: headingOf(mp.R), pose: mp,
    inliers: r.inliers, rmse: r.rmse, shiftPx: r.shiftPx, keyframe: !!r.keyframe, timings: r.timings,
    vo: r.stats, features: r.features, image, size: cfg.size, floor: world.floor, route, mapping, loops, ...extra,
  }, [r.features.buffer, image.buffer]);
  if (loop) post({ type: 'loop', correction: loop.correction, loops });
  if (reloc) post({ type: 'reloc' });
  if (loop) sendMap(true);
  else if (r.keyframe && mapping && world.align) sendMap();
  return { r, mp };
}

function sendMap(full = false) {
  if (full) {
    world.pendingPoints = [...world.voxels.values()].filter((v) => v.n >= 2);
    world.pendingReset = true;
  }
  const pts = world.takePoints();
  const grid = world.gridSnapshot();
  const trajectory = Float32Array.from(traj);
  const transfer = [pts.xyz.buffer, pts.gray.buffer, trajectory.buffer];
  if (grid) transfer.push(grid.data.buffer);
  post({
    type: 'map', ...pts, grid, trajectory, landmarks: world.confirmedLandmarks(), places: world.places,
    stats: world.stats(), start: world.toMap([0, 0, 0]),
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

function step() {
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
  const seen = d.frame % 10 === 0 ? demoSeen(d, truth.pose) : null;
  const { mp } = process(L, R, d.t, 0, `demo-${d.frame}`, { demo: d.kind, seen: seen?.objects ?? null });
  if (seen) for (const o of seen.objects) if (o.range < 4) world.addLandmark(o.cls, apply(mp, o.camPoint));
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
    if (p[2] < 0.3 || Math.abs(p[0] / p[2]) > 0.65 || Math.abs(p[1] / p[2]) > 0.35) continue;
    // Not hidden behind something else.
    const len = Math.hypot(...p);
    const dir = mulv(camPose.R, p.map((x) => x / len));
    const hit = firstHit(camPose.t, dir, d.scene);
    if (hit && hit.box !== b) continue;
    // The left camera sits B/2 left of the rig's centre, which is what distances are measured from.
    const rigPoint = [p[0] - B / 2, p[1], p[2]];
    objects.push({ cls: b.cls, camPoint: p, point: rigPoint, range: Math.hypot(...rigPoint), azimuth: (Math.atan2(rigPoint[0], rigPoint[2]) * 180) / Math.PI });
  }
  return { objects };
}

// ---------------------------------------------------------------------------------------

const handlers = {
  init: setup,
  frame(m) {
    process(Float32Array.from(new Uint8Array(m.left)), Float32Array.from(new Uint8Array(m.right)), m.t, m.gap, m.id);
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
  try {
    handlers[e.data.type]?.(e.data);
  } catch (err) {
    post({ type: 'error', message: err.message, stack: err.stack });
  }
};
post({ type: 'ready' });
