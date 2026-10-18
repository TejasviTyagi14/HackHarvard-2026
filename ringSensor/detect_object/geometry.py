"""Stereo rig geometry: pixel rays, bearings, triangulation, stereo overlap.

Pure numpy (OpenCV only for lens undistortion when a calibration is given),
so it behaves identically on Linux and macOS.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .types import CameraIntrinsics, CameraSide, FocusRegion, StereoRig


def _rot_yaw(deg: float) -> np.ndarray:
    """Rotation about +y (down). Positive turns the forward axis to the right."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def _rot_pitch(deg: float) -> np.ndarray:
    """Rotation about +x (right). Positive tilts the forward axis down."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, s], [0.0, -s, c]])


def bearing(direction: np.ndarray) -> tuple[float, float]:
    """(yaw_deg, pitch_deg) of a rig-frame direction; pitch positive up."""
    x, y, z = (float(v) for v in direction)
    return math.degrees(math.atan2(x, z)), math.degrees(math.atan2(-y, math.hypot(x, z)))


@dataclass(frozen=True)
class CameraPose:
    side: CameraSide
    intrinsics: CameraIntrinsics
    center: np.ndarray        # rig frame, metres
    R: np.ndarray             # camera -> rig rotation
    yaw_deg: float            # optical-axis yaw in the rig frame

    def pixel_ray(self, u: float, v: float) -> np.ndarray:
        """Unit direction (rig frame) of the ray through pixel (u, v)."""
        K = self.intrinsics.matrix()
        if self.intrinsics.dist is not None:
            import cv2  # only needed with a real calibration
            pt = cv2.undistortPoints(np.array([[[u, v]]], dtype=np.float64), K,
                                     np.asarray(self.intrinsics.dist, dtype=np.float64))
            xn, yn = float(pt[0, 0, 0]), float(pt[0, 0, 1])
        else:
            xn, yn = (u - K[0, 2]) / K[0, 0], (v - K[1, 2]) / K[1, 1]
        d = self.R @ np.array([xn, yn, 1.0])
        return d / np.linalg.norm(d)

    def project(self, point: np.ndarray) -> tuple[float, float] | None:
        """Pixel of a rig-frame point, or None if it is behind the camera."""
        pc = self.R.T @ (np.asarray(point, dtype=np.float64) - self.center)
        if pc[2] <= 1e-9:
            return None
        K = self.intrinsics.matrix()
        return (K[0, 0] * pc[0] / pc[2] + K[0, 2], K[1, 1] * pc[1] / pc[2] + K[1, 2])


class RigGeometry:
    """Everything derived from a StereoRig. Immutable; rebuild on rig change."""

    def __init__(self, rig: StereoRig):
        self.rig = rig
        half = rig.convergence_deg / 2.0
        pitch = _rot_pitch(rig.pitch_deg)
        b = rig.baseline_m / 2.0
        # Toed-in: the left camera turns right (+yaw), the right camera turns left.
        self.left = CameraPose("left", rig.left, np.array([-b, 0.0, 0.0]),
                               pitch @ _rot_yaw(+half), +half)
        self.right = CameraPose("right", rig.right, np.array([+b, 0.0, 0.0]),
                                pitch @ _rot_yaw(-half), -half)

    def pose(self, side: CameraSide) -> CameraPose:
        return self.left if side == "left" else self.right

    # -- stereo overlap ----------------------------------------------------

    def overlap_bearings(self) -> tuple[float, float, float, float]:
        """(yaw_min, yaw_max, pitch_min, pitch_max) both cameras see, far field."""
        lh, lv = self.rig.left.fov_deg()
        rh, rv = self.rig.right.fov_deg()
        yaw_min = max(self.left.yaw_deg - lh / 2, self.right.yaw_deg - rh / 2)
        yaw_max = min(self.left.yaw_deg + lh / 2, self.right.yaw_deg + rh / 2)
        v = min(lv, rv) / 2
        return yaw_min, yaw_max, -self.rig.pitch_deg - v, -self.rig.pitch_deg + v

    def overlap_start_m(self) -> float:
        """Distance along the forward axis where the two FoVs start to overlap."""
        lh, _ = self.rig.left.fov_deg()
        rh, _ = self.rig.right.fov_deg()
        a = math.tan(math.radians(lh / 2 + self.left.yaw_deg))      # left inner edge, toward +x
        c = math.tan(math.radians(rh / 2 - self.right.yaw_deg))     # right inner edge, toward -x
        if a + c <= 0:
            return math.inf
        return self.rig.baseline_m / (a + c)

    def effective_focus(self, focus: FocusRegion) -> FocusRegion:
        """The focus region after clipping to the stereo overlap (if requested)."""
        if not focus.clip_to_overlap:
            return focus
        y0, y1, p0, p1 = self.overlap_bearings()
        yaw_min, yaw_max = max(focus.yaw_min_deg, y0), min(focus.yaw_max_deg, y1)
        pitch_min, pitch_max = max(focus.pitch_min_deg, p0), min(focus.pitch_max_deg, p1)
        if yaw_min >= yaw_max or pitch_min >= pitch_max:
            raise ValueError("focus region does not intersect the stereo overlap; "
                             "widen it or set clip_to_overlap=False")
        return FocusRegion(yaw_min, yaw_max, pitch_min, pitch_max,
                           max(focus.near_m, self.overlap_start_m()), focus.far_m,
                           clip_to_overlap=False, require_stereo=focus.require_stereo)

    # -- triangulation -----------------------------------------------------

    def triangulate(self, uv_left: tuple[float, float], uv_right: tuple[float, float]
                    ) -> tuple[np.ndarray, float] | None:
        """Midpoint of the closest approach of two pixel rays.

        Returns (point_rig_m, miss_m), or None if the rays do not converge in
        front of both cameras.
        """
        p1, d1 = self.left.center, self.left.pixel_ray(*uv_left)
        p2, d2 = self.right.center, self.right.pixel_ray(*uv_right)
        w0 = p1 - p2
        b = float(d1 @ d2)
        d, e = float(d1 @ w0), float(d2 @ w0)
        denom = 1.0 - b * b
        if denom < 1e-12:
            return None
        s = (b * e - d) / denom
        t = (e - b * d) / denom
        if s <= 0 or t <= 0:
            return None
        q1, q2 = p1 + s * d1, p2 + t * d2
        return (q1 + q2) / 2.0, float(np.linalg.norm(q1 - q2))

    def depth_resolution_m(self, distance_m: float, pixel_error: float = 1.0) -> float:
        """Expected 1-sigma distance error: dZ ~ Z^2 * d_theta / b."""
        f = self.rig.left.matrix()[0, 0]
        return distance_m ** 2 * (pixel_error / f) / self.rig.baseline_m

    def floor_point(self, side: CameraSide, u: float, v: float) -> np.ndarray | None:
        """Where the pixel ray hits the floor (needs rig.height_m), rig frame."""
        h = self.rig.height_m
        if h is None:
            return None
        pose = self.pose(side)
        d = pose.pixel_ray(u, v)
        if d[1] <= 1e-6:           # ray at or above the horizon
            return None
        return pose.center + d * ((h - pose.center[1]) / d[1])
