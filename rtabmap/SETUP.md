# Mapping with RTAB-Map and the two IC780s

[RTAB-Map](https://github.com/introlab/rtabmap) (introlab, BSD licence) builds a 3D map live from a
stereo camera, corrects drift when you come back to a place, and exports the model. It's installed at
`/Applications/RTABMap.app` (version 0.23.8, Apple Silicon build).

## 1. Mount the cameras

Fix both IC780s to one rigid bar, about 10–15 cm apart, **pointing straight ahead, parallel and level**.
Your last screenshot showed them about 22° apart; at that angle little of the two views overlaps, and
stereo depth only works where they overlap.

## 2. Open it the first time

Right-click **RTABMap.app** in Applications, choose **Open**, then **Open** again. macOS asks because the
app is signed but not notarized by Apple. Allow camera access when asked (or later, in System Settings →
Privacy & Security → Camera).

## 3. Point it at the cameras

**Preferences** (⌘,) → **Source**:

| Setting | Value |
|---|---|
| Source type | Stereo |
| Driver | Usb camera |
| Device ID (left camera) | 0 |
| Right device ID | 1 |
| Width × height | 640 × 480 |
| FOURCC | MJPG (keeps two webcams within USB bandwidth) |
| Input rate | 15 Hz |

Your Mac numbers its cameras 0 = IC780, 1 = IC780, 2 = MacBook, 3 = iPhone. If the views come out
swapped (the camera on your left appears as "right"), swap 0 and 1.

## 4. Calibrate (once, and again whenever the cameras move on the bar)

Print `checkerboard-8x6-25mm-letter.pdf` at **100% / Actual size**, then check a square with a ruler: it
should be 25 mm. Tape it to something flat.

In **Source**, click **Calibrate…**:

- Board: **Chessboard**, width **8**, height **6**, square size **0.025** m.
- Hold the board where both cameras can see it. Move it around: near and far, in the corners, and
  tilted up to about 45°, until the progress bars fill.
- Press **Calibrate**, check the error is small (under about 1 px), then **Save**.

## 5. Map

**File → New database**, then press **Start**. Walk slowly and turn slowly; textured walls and furniture
work best, while blank walls and glass don't. Coming back to where you started lets it correct drift;
the loop shows as a link in the graph view.

When you're done: **Stop**, then **File → Export 3D clouds…** (point cloud or mesh, as PLY or OBJ) to open
the model in MeshLab or Blender. The database file (`~/Documents/RTAB-Map/*.db`) keeps the whole map, so
you can reopen it and keep mapping.

## Optional: settings tuned for webcams on a laptop

From the research brief, in **Preferences → Advanced**:

- Odometry strategy **Frame-to-Frame** (`Odom/Strategy=1`) with optical-flow correspondences
  (`Vis/CorType=1`), 500–1000 features.
- Occupancy grid: cell size **0.05**, range **4 m**, ray tracing **on**.
