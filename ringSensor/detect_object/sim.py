"""Synthetic stereo scenes: project labelled 3D boxes into both cameras.

Gives ground-truth detections and frames for isolation tests, so every box
downstream of the detector can be built and tested without webcams.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .geometry import CameraPose, RigGeometry
from .types import CameraSide, Detection2D, Frame, FramePair, StereoRig


@dataclass(frozen=True)
class SimObject:
    label: str
    center_m: tuple[float, float, float]   # rig frame (x right, y down, z forward)
    size_m: tuple[float, float, float]     # width (x), height (y), depth (z)
    confidence: float = 0.9


def _project_box(pose: CameraPose, o: SimObject) -> tuple[float, float, float, float] | None:
    c, s = np.array(o.center_m), np.array(o.size_m) / 2
    corners = [c + s * np.array([sx, sy, sz]) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    pts = [pose.project(p) for p in corners]
    if any(p is None for p in pts):
        return None
    us, vs = [p[0] for p in pts], [p[1] for p in pts]
    w, h = pose.intrinsics.width_px, pose.intrinsics.height_px
    x0, x1, y0, y1 = max(0, min(us)), min(w, max(us)), max(0, min(vs)), min(h, max(vs))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return (x0, y0, x1, y1)


def render(rig: StereoRig, objects: Sequence[SimObject], t_ns: int | None = None,
           background_bgr: tuple[int, int, int] = (128, 128, 128)
           ) -> tuple[FramePair, list[Detection2D], list[Detection2D]]:
    """Frames (flat background + filled boxes) and the exact detections per camera."""
    g = RigGeometry(rig)
    t = time.monotonic_ns() if t_ns is None else t_ns
    frames, dets = {}, {}
    for side in ("left", "right"):
        pose = g.pose(side)
        img = np.empty((pose.intrinsics.height_px, pose.intrinsics.width_px, 3), np.uint8)
        img[:] = background_bgr
        side_dets = []
        for k, o in enumerate(sorted(objects, key=lambda o: -o.center_m[2])):   # far to near
            box = _project_box(pose, o)
            if box is None:
                continue
            side_dets.append(Detection2D(o.label, o.confidence, box))
            shade = 40 + (37 * k) % 180
            x0, y0, x1, y1 = (int(round(v)) for v in box)
            img[y0:y1, x0:x1] = (shade, 255 - shade, (3 * shade) % 255)
        frames[side] = Frame(side, 0, t, img)
        dets[side] = side_dets
    return FramePair(frames["left"], frames["right"]), dets["left"], dets["right"]


def conference_room(n_rows: int = 6, seats_per_row: int = 10) -> list[SimObject]:
    """A lecture-style room: rows of chairs, a table, a screen, a bag on the floor.

    Rig assumed 1.2 m above the floor, looking forward; floor is at y = +1.2 m.
    """
    objs = []
    floor = 1.2
    for r in range(n_rows):
        z = 2.0 + 0.9 * r
        for k in range(seats_per_row):
            x = (k - (seats_per_row - 1) / 2) * 0.55 * (z / 2.0) * 0.6
            objs.append(SimObject("chair", (x, floor - 0.45, z), (0.45, 0.9, 0.45), 0.8))
    objs.append(SimObject("dining table", (0.0, floor - 0.37, 1.4), (1.6, 0.75, 0.6), 0.85))
    objs.append(SimObject("tv", (0.0, -0.6, 8.0), (2.0, 1.2, 0.05), 0.9))
    objs.append(SimObject("backpack", (-0.2, floor - 0.2, 3.2), (0.3, 0.4, 0.2), 0.7))
    return objs
