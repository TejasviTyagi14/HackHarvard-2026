# Handoff: stereo-distance / Stereo Map

Context for a new Claude session picking this project up. Last updated 2026-10-18.

## What this is

A local, no-build web app (plain ES modules, three.js and TF.js from CDNs) for two webcams:

- **`index.html` — Measure page.** Live views from both cameras, COCO-SSD object boxes, distance and clock direction per object ("chair · ~2.1 m · 11 o'clock"), object-to-object distances, voice Q&A ("what's in front of me?"), and calibration (tape measure or a person standing about 2 m away).
- **`map.html` — Map a building.** Walk around and it builds a live 3D model: point cloud, a floor plan with free and blocked cells, sized furniture models, people, walls, routes with spoken turn-by-turn directions, saved places, loop closure, and save/load/PLY export. It works with **two cameras** (stereo depth) or **one camera** (depth from the Metric3D v2 model on WebGPU, a 150 MB download the first time).

## Run it

```bash
cd ~/Documents/Claude/stereo-distance
python3 -m http.server 8765        # then open http://localhost:8765/map.html in Chrome
node --test tests/*.test.js        # 84 tests (use the glob: `node --test tests/` fails)
```

- Use Chrome: it needs camera permission, and WebGPU for one-camera mode.
- After code changes, hard-refresh (⌘⇧R), because the browser caches the ES modules.
- The parent folder's `.claude/launch.json` has a "stereo-distance" entry on port 8765 for the Claude browser pane.
- The browser pane **cannot open real cameras**. Real-camera testing is done by the user in Chrome.
- In the pane, test with the **Demo building** source. Its settings are separate from the user's Chrome; set "Cameras: Two" for the demo, because mono mode on the synthetic building loses tracking at sharp turns.

## Git

- Remote: `https://github.com/TejasviTyagi14/HackHarvard-2026` (**public**). Push over HTTPS with the keychain; there is no `gh` and no SSH.
- Local `main` is **about 11 commits ahead of origin and not pushed**. **Ask the user before pushing.**

## User preferences (important)

- Wants it **quick and low-usage**. Don't over-explore; act.
- Ask before pushing, installing packages, or downloading anything.
- Don't bypass macOS security (Gatekeeper quarantine on RTAB-Map was left alone).
- Non-specialist, casual phrasing. They report what they see with screenshots of the map page. Interpret their requests generously, and say how you interpreted them.

## Hardware and the user's real setup

- Two "IC780 1080P HD" webcams (USB 2.0, identical serials).
- Device order on their Mac: 0 = IC780, 1 = IC780, 2 = MacBook, 3 = iPhone.
- The field of view is **unconfirmed** (the default HFOV is 70°). An HFOV error of 5° measurably hurts tracking.
- Their real rig was once toed in about 22°. The app measures the rotation between the cameras from the images and rectifies by half of it on each side.
- **They now mostly use one-camera mode.** It "kinda worked" but was noisy.
- Their last real screenshot showed: 652 keyframes, 33 fps, about 27 points tracked, 8 loops closed, "Floor assumed". Plants, laptop and table were detected as objects.

## Code map (`js/slam/` is pure logic, tested in node)

| File | What it does |
|---|---|
| `js/mapapp.js` | Map page controller: camera sources, sends frames to the worker, runs COCO-SSD every 1.5 s on the left view and posts `{type:'objects', id, dets}`, draws the floor plan (walls as lines, object footprints), handles voice/navigation and settings (`MAP_DEFAULTS`, localStorage key `stereo-map:v1`), and draws the compass dial. |
| `js/view3d.js` | three.js view: point cloud, trail, route, me marker, HTML tags, procedural furniture (`furniture(cls,w,h,d)`: chair, table, couch, bed, TV/laptop, plant, person, box), walls (`setWalls`), toggles for Points/Objects/Walls, and the clip height. Map (x, y down, z) maps to three (x, −y, −z). |
| `js/slam/worker.js` | Web Worker that runs everything. Messages in: init, frame, demo, keys, goal, mapping, objects, landmark, place, settings, save, load, ply, …. Messages out: result (pose, compass, features, images), map (points, grid, objects, walls, places, …), seen, route, loop, reloc, align, rotation, status. It keeps a ring buffer `recent` of the last 8 frames, so detections can be measured with that frame's depth. Metric3D is loaded through transformers.js 4.3.1 (fp32, WebGPU) and calls are serialized. |
| `js/slam/vo.js` | `StereoVO`: rectify, track KLT features, solve the pose, decide keyframes (dense block-matching depth or model depth rescaled to the tracked points), plus the camera check, relocalization and loop-closure shift. Options include `mono`, `maxRange`, `cloudRange` (= the "Map out to" setting, default 10 m), `minStart`/`minInliers` (10, which the user asked for), `turnFrom: 'compass'\|'points'` and `compassWeight: 15`. |
| `js/slam/compass.js` | **Visual compass**: direct image alignment of about 1,200 high-gradient pixels (pyramid levels 3, 2, 1), with brightness gain and offset and Huber weighting. Its reference is the latest keyframe with depth (kept while it still matches), or a recent frame for rotation only. It reports `{heading (0° at start, + = right), pitch, roll, ok}`. `poseTerms(R,t,…)` adds its photometric evidence into `refinePose` (the `extra` hook), so the **turn and the distance are solved jointly**: pixels mostly give the turn, points mostly the distance. When the points are lost, the pose rotation follows the compass. |
| `js/slam/se3.js` | SE(3) math; `refinePose(pose, X, uv, intr, {huber, fixR, extra})`. |
| `js/slam/world.js` | `World`: 5 cm voxels (a voxel is shown after `minHits` views; 3 in mono, 2 in stereo), log-odds floor grid with ray tracing, and floor-plane fit. `refitFloor()` runs every 15 keyframes while the floor is only assumed. `addFeet()` re-levels the map from people's feet (floor = 'people'). Also `relevel`/`reanchor`, objects (`ObjectMap`), landmarks, places, serialize/deserialize, and PLY. |
| `js/slam/objects.js` | `measureBox(det, depth, intr, mapPose)`: turns a detector box plus depth into a sized 3D box on the floor. Depth front-to-back comes from the `TYPICAL` sizes table. People are upright, have height from the floor to the top of the head, and report feet points. `ObjectMap` merges sightings; people follow the newest sighting and expire after 6 s; `lasting()` = furniture only. |
| `js/slam/walls.js` | `extractWalls(voxels, {exclude: objects})`: 10 cm columns with ≥ 0.6 m vertical extent, then sequential RANSAC lines, split at gaps of 0.4 m, with duplicate suppression. `squareUp(walls, axis)` snaps walls within 20° to 90°/180° of the building's main direction and joins pieces that line up. The worker re-extracts every 2 s. |
| `js/slam/loop.js`, `closer.js`, `posegraph.js` | Loop closure (BRIEF, 3D-3D RANSAC, 4-DOF pose graph) and relocalization. |
| `js/slam/plan.js`, `guide.js`, `navtalk.js` | Routes (Dijkstra field plus smoothing) and spoken directions. |
| `js/slam/building.js` | Synthetic demo building: `renderGray`, `tour`, `poseAt`, `firstHit`, and furniture blocks with classes. Use it for headless experiments. |
| `js/slam/rectify.js`, `klt.js`, `dense.js` | Rectification (`rawToRect`), KLT pyramids, block matching. |
| `rtabmap/SETUP.md` | Guide for RTAB-Map 0.23.8 (installed at `/Applications/RTABMap.app`) with a printable checkerboard. This is an alternative open-source mapper, separate from the web app. |

## What was built, in order

1. Measure page: stereo distances, the user's spacing/angle inputs, voice back-and-forth, calibration from a person at about 2 m.
2. Map page: building mapper (VO, voxels, floor grid, routes, voice), loop closure, relocalization.
3. Fixes for the real rig: camera order/offset check, both previews, measured rotation between the cameras, rectification.
4. RTAB-Map setup guide.
5. One-camera mode (Metric3D). Start/track threshold lowered to 10 points.
6. Sized 3D furniture instead of dots.
7. People; floor levelled from people's feet and re-searched in the voxel cloud; range raised to 10 m (up to 15); walls from vertical planes.
8. **Latest:** walls squared to 90°/180°; a visual compass (heading from 0°, plus tilt) solved jointly with the points; compass dial; "Turning from" setting.

## Demo-tour numbers (headless, 320×180, 10 fps)

| Setting | Turn error | Drift |
|---|---|---|
| Points only | 2.9° | 0.175 m over 14 m |
| Compass + points (joint) | 0.9–1.2° | 0.14 m |
| Only 30 features (keeps losing points), compass | 22° | — |
| Only 30 features, points | 130° | — |

**Rejected approaches, and why:**

| Tried | Result |
|---|---|
| Compass alone for the turn, points only for translation | Drifted 23°: a small sideways step looks like a small turn to both. |
| Compass rotation as the KLT search guess | Hurt badly with a wrong FOV (loop test failed). |
| Compass weight 60 without that guess | Unstable. |

## Open items and good next steps

- **Nothing from steps 6–8 has been tested on the real cameras.** That includes the compass, people, floor levelling, walls, squaring and the 10 m range. Ask the user for screenshots or recordings. The Recording source replays files, so a recording would allow headless debugging.
- The one-camera map is noisy. Ideas: minHits is 3 in mono now; consider depth-edge filtering or confidence-weighted fusion.
- Walls are re-extracted from scratch each time (no persistence), so they can flicker. Doorway edges can produce thin slivers. Walls aren't fed to the route planner, which only uses the grid.
- The floor was "assumed" on real footage. Levelling from people and the periodic re-search are new and untested.
- The FOV is unknown. There is no lens-distortion or checkerboard calibration in the web app.
- In the demo, the dining table is seen only once, so it's never confirmed (objects need two sightings).
- A person's feet are trusted only when the box doesn't touch the bottom edge of the image.
- Headless debugging pattern: a scratch node script that imports `js/slam/*`, renders the demo with `renderGray(rig.left, pose, scene, W, H)` along `tour({fps:10})`, runs `StereoVO`, and compares with `fr.pose`. See the tests in `tests/slam.test.js`, `tests/compass.test.js` and `tests/loop.test.js`.
