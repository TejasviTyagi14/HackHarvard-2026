# Stereo Distance

> This repo also holds **[ringSensor/](ringSensor/)**, the Python detectObject algorithm. In it,
> Droid sets the detail level λ while the algorithm runs.

A local website that takes your two IC780 webcams, shows both feeds side by side, boxes the
objects it recognises, and labels each one with a distance and a direction:

    chair · ~2.1 m · 11 o'clock

It also shows a top-down map, the distance between every pair of objects, and the distance to any
spot you click. Calibration is one step: have someone stand 2 m away and press Capture (or say
"calibrate"). You can talk to it too: ask "what's in front of me?" and it reads back every object
with its distance and direction, then keeps listening for follow-ups like "how far is it?". You enter the spacing between the cameras and the angle between them. A quick
tape-measure calibration then fine-tunes the angle and the field of view.

Everything runs in the browser on your Mac. The only download is the object detector
(TensorFlow.js COCO-SSD), fetched from a CDN the first time.

## Run it

```bash
cd ~/Documents/Claude/stereo-distance
python3 -m http.server 8765
```

Then open **http://localhost:8765** in Chrome and press **Start cameras**. The camera only works
over `localhost`, not by opening the HTML file directly. If Chrome never asks for the camera,
check System Settings → Privacy & Security → Camera → Google Chrome.

No cameras handy? Press **Demo room**: a rendered room with five boxes at known distances.
Everything runs the same way, and the table shows the true distance next to each measurement.

## Before you start: mounting

- Fix both webcams to **one rigid bar**, about 10–15 cm apart, pointing the same way.
  Calibration only holds while the cameras can't move relative to each other.
- Measure the spacing **lens centre to lens centre** and enter it under **Rig → Distance between
  the cameras**. All distances scale with this number.
- Enter the **angle between the cameras**: 0 if they're parallel, positive if they're turned toward
  each other (toed in), negative if turned apart. Under "Which camera is turned", say whether both
  are turned or just one.
- The angle matters most. At 12 cm spacing, **1° of angle error moves a 2 m reading by about 29%**.
  You can't eyeball it that precisely, so calibrate (below).
- Keep both cameras level with each other. The app learns and corrects a small vertical offset
  (shown under Camera check). Over ~10 px means one camera is tilted on the bar.

## Talking to it

Press the **mic** (or the **A** key) and ask a question. The answer is read out loud and shown in the
conversation log, and the object it's about is highlighted on the map. Then it listens again for a
follow-up, so you can keep going without touching anything. Say "thanks" or "stop", or stay quiet,
to end. **Esc** also stops it. You can type questions too.

Things you can ask:

- "What's in front of me?" / "What do you see?" (nearest first; "what else?" for the rest)
- "How far is the chair?" then "How far is it?", "What about the other one?"
- "What's closest?" / "What's the farthest thing?"
- "What's on my left?" / "What's straight ahead?" / "What's at 2 o'clock?"
- "How far apart are the chair and the table?" / "How far is it from the person?"
- "Which is closer, the chair or the table?"
- "Is there a dog?" / "How many people?"
- "Is anything within 2 meters?" / "Is anything near me?" / "Is the path clear?"
- "Calibrate" (or "calibrate at 3 meters"), "undo the calibration"
- "Use feet", "start updates", "stop updates", "say that again", "help"
- "More detail", "keep it short", "just the basics" (Droid adjusts how much it says; see below)

Answers come from the live measurements only, so it never guesses a distance it doesn't have. If an
object has no distance, it says why ("only one camera can see it").

Speech recognition is the browser's. In Chrome your voice goes to Google's speech service to become
text, unless Chrome offers on-device recognition, which the app uses when available (the note under
the mic says which). Working out the answer happens on your Mac. The first time, Chrome asks for
the microphone; on macOS also allow Chrome under System Settings → Privacy & Security → Microphone.

"Is the path clear?" only knows the detector's 80 kinds of objects. It's a convenience, not a
mobility aid.

## How much it says (Droid)

How many objects it lists, whether it adds directions and reasons, and how finely it rounds
distances are parameters that Droid (Factory's agent) sets while the app runs. Say or type "more
detail", "keep it short", "just the basics" or "stop saying the o'clock", and Droid picks the new
settings. To use it, set `FACTORY_API_KEY` and run the site with `npm start`
(`python3 tools/droid_bridge.py`) instead of `python3 -m http.server 8765`. Without the bridge,
the assistant keeps its usual level of detail.
See [docs/DROID_DETAIL.md](docs/DROID_DETAIL.md).

## The phases, and the check for each one on the real cameras

| # | Phase | Where | Check before moving on |
|---|-------|-------|------------------------|
| 0 | Setup | Setup checklist, Camera check | Checklist shows camera access granted and **2 IC780** found. Run the **10-second focus check** on a still scene: both cameras should read "steady". |
| 1 | Two live streams | The two views | Both views live at the chosen resolution. Stand behind the rig and cover the camera on your **left**: the **Left** view should go dark. If not, press ⇄. |
| 2 | Object detection | Boxes on both views | A chair or a person gets a box in **both** views. "Seen by: both" in the table. |
| 3 | Calibration | Calibrate with a person (or with a tape measure) | Person at 2 m → Capture, then at 4 m → Capture. The table shows them reading within ~3% at both distances. |
| 4 | Distance & angle | Labels, table | Stand at a taped 1.5 m and 3 m. The person label reads within ~5% and "12 o'clock" when straight ahead. |
| 5 | Website | Map, between-objects list, Debug | Objects land in the right places on the map. Clicking a box lists its distance to everything else. |
| 6 | Spoken updates | **Speak** button | Says the nearest objects every 2 s, and only when something changes (a new object, or ≥ 0.5 m of movement). |
| 7 | Record & replay, tests | Record & replay, `node --test` | Record 10 s, then open it under **Recording**: the same objects and distances appear. `node --test` passes. |
| 8 | Conversation | Mic / A key | Ask "what's in front of me?" and hear every object with its distance. Then ask "how far is it?" without pressing anything. |

## Calibrating with a person

This updates the spacing and the angle between the cameras from someone standing in front of them.
There's nothing to click in the views.

1. Have the other person stand **straight ahead**, facing the cameras, about 2 m away. Measure
   along the floor, from below the cameras to where they stand.
2. Press **Capture** under **Calibrate with a person**, or say "calibrate". After a 3-second countdown
   (spoken, if Speak answers is on), the app matches about 20 points on their torso in each frame
   for 3 seconds. It then updates the **angle** right away.
3. To update the **spacing** too, have them step back to a second measured distance, about twice
   as far (4 m), and press the second **Capture** (or say "calibrate" again). Both numbers then
   update together.

**Undo** puts back the numbers you had before. "Calibrate at 3 meters" sets the distance by voice.

Why a second distance is needed for the spacing: at one distance, cameras set wider apart and
turned in a bit more give exactly the same picture as cameras closer together and turned in less.
So one capture can pin down only one of the two. It keeps the spacing you measured with a ruler
and solves the angle, which is the one you can't measure by eye. The spacing matters less with
distance and the angle doesn't, so a second distance separates them.

For a good capture:
- Only the person being measured should be in view, and they should hold still.
- Clothing with some pattern or folds matches better than a plain flat colour.
- Use distances that differ clearly (2 m and 4 m, not 2 m and 2.5 m). The app tells you when
  they're too close together.

In the demo room, a stand-in person appears at each distance you capture. Set "Mount the virtual
cameras off by" and "…and their spacing off by" under **Demo room** to practise recovering a rig
you got wrong.

## Calibrating with a tape measure

This older method fixes the angle and the field of view from points you click. It's useful when
there's no second person around.


1. Put something textured (a book, a box, a patterned shirt) straight ahead, about 1 m from the
   **middle of the bar**.
2. Press **Pick target** and click it in the **left** view. The app finds the same spot in the right
   view. If its crosshair lands somewhere else, click the right spot in the right view.
3. Type the distance you measured and press **Add sample**.
4. Repeat at about 2 m, then press **Solve**. You'll see the angle and the field of view before and
   after, plus what each sample reads. Press **Apply**.

One sample fixes only the angle. Two samples at clearly different distances fix the angle and the
field of view. Redo it whenever the cameras shift on the bar.

## How a distance is worked out

1. Both frames are captured together and scaled to 640 px wide.
2. COCO-SSD finds objects in each view. Boxes of the same class at the same height and size are
   paired across the two views.
3. For five points inside each box, the app slides a small patch along the line where that point
   *must* appear in the other camera (the epipolar line, which follows from the spacing, angle and
   field of view) and keeps the best normalized cross-correlation match.
4. The two rays through the matched pixels are intersected. The distance comes from the
   nearer-biased middle of the five results, so points that land on the background behind the
   object are ignored.
5. A tracker keeps object identities stable and reports the median over the last second.

When it can't get a distance, the label says **distance unavailable** and the table says why:
seen by one camera only, surface too plain, too far for this spacing, or the rays don't meet
(check the angle or the left/right order). The direction still shows.

## How accurate to expect

The error grows with the square of the distance. With 12 cm spacing and a 70° lens, a one-pixel
matching error is worth:

| Distance | 1 m | 2 m | 3 m | 4 m | 6 m |
|---|---|---|---|---|---|
| Error per pixel | 2 cm | 7 cm | 16 cm | 29 cm | 66 cm |

Matching usually lands within half a pixel on textured surfaces. Calibration error adds to that.
Wider spacing gives better range: 15 cm cuts these numbers by a fifth. Past the point where the
expected error tops 35%, the app reports "too far for this camera spacing" rather than guess.

Known limits:
- The two webcams aren't shutter-synced, so frames can be up to ~30 ms apart. Fast-moving objects
  read less reliably than still ones.
- Lens distortion isn't modelled, so objects near the image edges read a little less accurately
  than objects near the centre.
- The detector knows COCO's 80 everyday classes. For anything else, click it in the left view to
  measure it as a point.

## Troubleshooting

- **The second camera won't start.** Two USB 2.0 webcams on one hub can run out of bandwidth.
  Set 640 × 480 under Detection & display, or plug the cameras into different ports. Quit Zoom,
  FaceTime and Photo Booth.
- **"Left and right look swapped".** Press **Swap** in the banner (or ⇄). This check is decisive
  with parallel cameras. With toe-in, only nearby objects give clear evidence.
- **Distances jitter.** Run the focus check. If a camera keeps refocusing, add light or press
  **Lock focus** (offered only if the browser exposes focus control for that camera). Otherwise,
  use a UVC camera-control app to turn autofocus off.
- **Everything reads too far or too near by a similar factor.** Re-measure the spacing between the
  cameras, then recalibrate.

## Files

```
index.html, css/style.css   the page
js/app.js                   controller: sources → detect → measure → track → draw
js/geometry.js              rig model, rays, triangulation, directions, calibration fit
js/stereo.js                grayscale frames, NCC, epipolar and band search, sharpness
js/scene.js                 box pairing, per-object measuring, tracker, labels, speech text
js/demo.js                  the synthetic demo room (renderer + ground truth)
js/detector.js              COCO-SSD loader
js/sources.js               cameras, recordings, demo canvases
js/render.js                drawing the views, map and rig sketch
js/personcal.js             person calibration: find, match, solve spacing and angle
js/assistant.js             answers questions about the scene, with follow-up context
js/detail.js                level-of-detail parameters, their checks, and the Droid controller
tools/droid_bridge.py       serves the site and runs Droid for level-of-detail requests
js/talk.js                  the listen → answer → speak → listen-again loop
js/speech.js                shared voice, periodic updates, speech recognition, tones
js/recorder.js              side-by-side recording
tests/                      node --test suites for the pure modules
```

Run the tests with `node --test` from this folder (and `python3 -m unittest discover tests` for the Droid bridge). They cover the geometry, matching, calibration,
pairing, tracking, speech, question-answering and person-calibration logic, including end-to-end
measurements on the rendered demo room.
