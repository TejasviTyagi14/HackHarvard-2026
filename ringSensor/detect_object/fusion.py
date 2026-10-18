"""Stereo fusion: match per-camera detections into physical objects.

Two detections (one per camera) are the same object when they have the same
label, their rays converge in front of the rig, the rays pass close to each
other, the vertical bearings agree and the boxes have similar heights.
Matched pairs are triangulated; unmatched detections stay monocular
(bearing only, no distance).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .geometry import RigGeometry, bearing
from .types import CameraSide, Detection2D, SceneObject


@dataclass(frozen=True)
class FusionParams:
    miss_abs_m: float = 0.10          # rays may pass this far apart ...
    miss_rel: float = 0.08            # ... plus this fraction of the range
    max_pitch_diff_deg: float = 4.0   # vertical bearing agreement
    max_height_ratio: float = 1.6     # bbox heights within this ratio
    far_yaw_diff_deg: float = 0.4     # near-parallel rays: treat as one far object
    max_range_m: float = 50.0


def _center(b: tuple[float, float, float, float]) -> tuple[float, float]:
    return (b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0


class StereoFusion:
    def __init__(self, geometry: RigGeometry, params: FusionParams = FusionParams()):
        self.g = geometry
        self.p = params

    def _match_cost(self, dl: Detection2D, dr: Detection2D):
        """(cost, point, far) for a candidate pair, or None if incompatible."""
        if dl.label != dr.label:
            return None
        hl = dl.bbox_px[3] - dl.bbox_px[1]
        hr = dr.bbox_px[3] - dr.bbox_px[1]
        if min(hl, hr) <= 0 or max(hl, hr) / min(hl, hr) > self.p.max_height_ratio:
            return None
        cl, cr = _center(dl.bbox_px), _center(dr.bbox_px)
        yl, pl = bearing(self.g.left.pixel_ray(*cl))
        yr, pr = bearing(self.g.right.pixel_ray(*cr))
        dpitch = abs(pl - pr)
        if dpitch > self.p.max_pitch_diff_deg:
            return None
        size_term = abs(math.log(hl / hr)) / math.log(self.p.max_height_ratio)
        pitch_term = dpitch / self.p.max_pitch_diff_deg
        tri = self.g.triangulate(cl, cr)
        if tri is not None:
            point, miss = tri
            rng = float(np.linalg.norm(point))
            if rng <= self.p.max_range_m and miss <= self.p.miss_abs_m + self.p.miss_rel * rng:
                miss_term = miss / (self.p.miss_abs_m + self.p.miss_rel * rng)
                return miss_term + pitch_term + size_term, point, False
        # Rays (almost) parallel: the object is far beyond triangulation range.
        if abs(yl - yr) <= self.p.far_yaw_diff_deg:
            return 1.0 + pitch_term + size_term, None, True
        return None

    def fuse(self, left: Sequence[Detection2D], right: Sequence[Detection2D],
             image_area: tuple[float, float]) -> list[SceneObject]:
        """Fuse one frame pair. ``image_area`` = (left_px2, right_px2).

        Matching is a minimum-cost assignment per label, where leaving a
        detection unmatched costs ``UNMATCHED`` on each side. With several
        identical objects this prefers the consistent global solution over a
        locally perfect but wrong pair.
        """
        used_l, used_r, objects = set(), set(), []
        for label in sorted({d.label for d in left} & {d.label for d in right}):
            li = [i for i, d in enumerate(left) if d.label == label]
            ri = [j for j, d in enumerate(right) if d.label == label]
            pairs = {}
            cost = np.full((len(li), len(ri)), np.inf)
            for a, i in enumerate(li):
                for b, j in enumerate(ri):
                    m = self._match_cost(left[i], right[j])
                    if m is not None:
                        cost[a, b] = m[0]
                        pairs[a, b] = m
            for a, b in _assign(cost, UNMATCHED):
                i, j = li[a], ri[b]
                used_l.add(i)
                used_r.add(j)
                objects.append(self._stereo_object(len(objects), left[i], right[j],
                                                   pairs[a, b][1], image_area))
        for side, dets, used, area in (("left", left, used_l, image_area[0]),
                                       ("right", right, used_r, image_area[1])):
            for k, det in enumerate(dets):
                if k not in used:
                    objects.append(self._mono_object(len(objects), side, det, area))
        return objects

    def _stereo_object(self, oid, dl, dr, point, image_area) -> SceneObject:
        area = max(_area(dl.bbox_px) / image_area[0], _area(dr.bbox_px) / image_area[1])
        conf = 1.0 - (1.0 - dl.confidence) * (1.0 - dr.confidence)   # two independent views
        if point is None:   # far object: bearing from the average of both rays
            d = self.g.left.pixel_ray(*_center(dl.bbox_px)) + self.g.right.pixel_ray(*_center(dr.bbox_px))
            yaw, pitch = bearing(d)
            return SceneObject(oid, dl.label, conf, yaw, pitch, None, None, None, None,
                               "both", dl.bbox_px, dr.bbox_px, area)
        yaw, pitch = bearing(point)
        dist = float(np.linalg.norm(point))
        w, h = self._metric_size(dl.bbox_px, "left", dist)
        return SceneObject(oid, dl.label, conf, yaw, pitch, dist,
                           tuple(float(v) for v in point), w, h, "both", dl.bbox_px, dr.bbox_px, area)

    def _mono_object(self, oid, side: CameraSide, det, image_area) -> SceneObject:
        yaw, pitch = bearing(self.g.pose(side).pixel_ray(*_center(det.bbox_px)))
        bl = det.bbox_px if side == "left" else None
        br = det.bbox_px if side == "right" else None
        return SceneObject(oid, det.label, det.confidence, yaw, pitch, None, None, None, None,
                           side, bl, br, _area(det.bbox_px) / image_area)

    def _metric_size(self, bbox, side: CameraSide, dist: float) -> tuple[float, float]:
        """Approximate width/height in metres from the angular size at ``dist``."""
        pose = self.g.pose(side)
        x0, y0, x1, y1 = bbox
        cx, cy = _center(bbox)
        ang_w = math.acos(float(np.clip(pose.pixel_ray(x0, cy) @ pose.pixel_ray(x1, cy), -1, 1)))
        ang_h = math.acos(float(np.clip(pose.pixel_ray(cx, y0) @ pose.pixel_ray(cx, y1), -1, 1)))
        return 2 * dist * math.tan(ang_w / 2), 2 * dist * math.tan(ang_h / 2)


def _area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


UNMATCHED = 2.0     # cost of leaving one detection unmatched (match costs are ~0..3)


def _assign(cost: np.ndarray, unmatched: float) -> list[tuple[int, int]]:
    """Min-cost partial assignment; inf = forbidden. Returns matched (row, col) pairs.

    Pads to a square (n+m) matrix where every row/column may instead take a
    dummy at cost ``unmatched``, then solves it with the Hungarian algorithm.
    """
    n, m = cost.shape
    if n == 0 or m == 0:
        return []
    big = 1e9
    size = n + m
    c = np.full((size, size), big)
    c[:n, :m] = np.where(np.isfinite(cost), cost, big)
    c[:n, m:] = np.where(np.eye(n), unmatched, big)          # row i unmatched
    c[n:, :m] = np.where(np.eye(m), unmatched, big)          # column j unmatched
    c[n:, m:] = 0.0
    cols = _hungarian(c)
    return [(i, j) for i, j in enumerate(cols[:n]) if j < m and np.isfinite(cost[i, j])]


def _hungarian(c: np.ndarray) -> list[int]:
    """Square min-cost assignment (Kuhn-Munkres with potentials), O(n^3). Returns col per row."""
    n = c.shape[0]
    u, v = np.zeros(n + 1), np.zeros(n + 1)
    p = np.zeros(n + 1, dtype=int)          # p[j] = row assigned to column j (1-based)
    way = np.zeros(n + 1, dtype=int)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = np.full(n + 1, np.inf)
        used = np.zeros(n + 1, dtype=bool)
        while True:
            used[j0] = True
            i0 = p[j0]
            cur = c[i0 - 1] - u[i0] - v[1:]
            free = ~used[1:]
            better = free & (cur < minv[1:])
            minv[1:][better] = cur[better]
            way[1:][better] = j0
            masked = np.where(free, minv[1:], np.inf)
            j1 = int(np.argmin(masked)) + 1
            delta = masked[j1 - 1]
            u[p[used]] += delta
            v[used] -= delta
            minv[1:][free] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
    cols = [0] * n
    for j in range(1, n + 1):
        cols[p[j] - 1] = j - 1
    return cols
