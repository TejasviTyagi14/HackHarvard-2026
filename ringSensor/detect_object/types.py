"""Data contracts for detectObject.

Single source of truth for every port of the detectObject boxes
(see DETECT_OBJECT_DESIGN.md). Change a type here only with agreement from
the owners of both boxes it connects.

Units and frames
----------------
- Distances in metres, angles in degrees, timestamps in nanoseconds from
  ``time.monotonic_ns()`` on the host.
- Rig frame: origin at the midpoint between the two camera centres,
  x to the right, y down, z forward (the bisector of the two optical axes).
- Bearings: ``yaw_deg`` positive to the right, ``pitch_deg`` positive up,
  both measured from the rig origin.
- Pixel boxes: ``(x0, y0, x1, y1)`` in pixels of the source image.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from typing import Literal, Sequence

import numpy as np

CameraSide = Literal["left", "right"]
SeenBy = Literal["both", "left", "right"]
FactKind = Literal["scene", "count", "attribute", "hazard", "location"]


# ---------------------------------------------------------------------------
# Configuration inputs (X2..X4 in the design)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CameraIntrinsics:
    """Pinhole model of one webcam.

    Without a calibration, ``hfov_deg`` from the datasheet is enough: the
    focal length is derived from it and the principal point is the image
    centre. With an OpenCV calibration, pass ``K`` (3x3, row-major) and
    ``dist`` (k1, k2, p1, p2[, k3]); they take precedence over ``hfov_deg``.
    """
    width_px: int = 640
    height_px: int = 480
    hfov_deg: float = 70.0
    K: tuple[float, ...] | None = None
    dist: tuple[float, ...] | None = None

    def matrix(self) -> np.ndarray:
        if self.K is not None:
            return np.asarray(self.K, dtype=np.float64).reshape(3, 3)
        f = (self.width_px / 2.0) / math.tan(math.radians(self.hfov_deg) / 2.0)
        return np.array([[f, 0.0, self.width_px / 2.0],
                         [0.0, f, self.height_px / 2.0],
                         [0.0, 0.0, 1.0]])

    def fov_deg(self) -> tuple[float, float]:
        """(horizontal, vertical) field of view, derived from ``matrix()``."""
        k = self.matrix()
        h = 2.0 * math.degrees(math.atan(self.width_px / (2.0 * k[0, 0])))
        v = 2.0 * math.degrees(math.atan(self.height_px / (2.0 * k[1, 1])))
        return h, v


@dataclass(frozen=True)
class StereoRig:
    """How the two webcams are mounted relative to each other.

    baseline_m       distance between the two camera centres (lens to lens)
    convergence_deg  total angle between the two optical axes; positive means
                     toed-in (axes cross in front), negative means splayed out
    pitch_deg        common tilt of both cameras, positive = looking down
    height_m         camera height above the floor; enables floor-based
                     hazard checks. ``None`` disables them.
    """
    left: CameraIntrinsics = field(default_factory=CameraIntrinsics)
    right: CameraIntrinsics = field(default_factory=CameraIntrinsics)
    baseline_m: float = 0.12
    convergence_deg: float = 0.0
    pitch_deg: float = 0.0
    height_m: float | None = None

    def __post_init__(self) -> None:
        if self.baseline_m <= 0:
            raise ValueError("baseline_m must be > 0")
        if not -90.0 < self.convergence_deg < 90.0:
            raise ValueError("convergence_deg must be in (-90, 90)")


@dataclass(frozen=True)
class FocusRegion:
    """The window of space whose objects are reported.

    It is a cone in rig bearings plus a distance band:
    yaw in [yaw_min_deg, yaw_max_deg], pitch in [pitch_min_deg, pitch_max_deg],
    distance in [near_m, far_m] (only applied to objects whose distance is
    known). With ``clip_to_overlap`` the cone is also intersected with the
    part of space both cameras see, so every object in it can be
    triangulated and de-duplicated. ``require_stereo`` drops objects that
    only one camera matched.
    """
    yaw_min_deg: float = -30.0
    yaw_max_deg: float = 30.0
    pitch_min_deg: float = -25.0
    pitch_max_deg: float = 25.0
    near_m: float = 0.3
    far_m: float = 10.0
    clip_to_overlap: bool = True
    require_stereo: bool = False

    def __post_init__(self) -> None:
        if self.yaw_min_deg >= self.yaw_max_deg or self.pitch_min_deg >= self.pitch_max_deg:
            raise ValueError("FocusRegion bounds must satisfy min < max")
        if not 0.0 <= self.near_m < self.far_m:
            raise ValueError("FocusRegion requires 0 <= near_m < far_m")

    def contains(self, yaw_deg: float, pitch_deg: float, distance_m: float | None) -> bool:
        if not (self.yaw_min_deg <= yaw_deg <= self.yaw_max_deg):
            return False
        if not (self.pitch_min_deg <= pitch_deg <= self.pitch_max_deg):
            return False
        if distance_m is not None and not (self.near_m <= distance_m <= self.far_m):
            return False
        return True


# ---------------------------------------------------------------------------
# Streaming data
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Frame:
    camera: CameraSide
    seq: int
    t_ns: int
    image: np.ndarray            # HxWx3 uint8, BGR (OpenCV order)


@dataclass(frozen=True)
class FramePair:
    left: Frame
    right: Frame

    @property
    def t_ns(self) -> int:
        return (self.left.t_ns + self.right.t_ns) // 2

    @property
    def skew_ms(self) -> float:
        return abs(self.left.t_ns - self.right.t_ns) / 1e6


@dataclass(frozen=True)
class Detection2D:
    """One detector hit in one image."""
    label: str
    confidence: float
    bbox_px: tuple[float, float, float, float]


@dataclass(frozen=True)
class SceneObject:
    """One physical object after fusing both cameras."""
    id: int
    label: str
    confidence: float
    yaw_deg: float
    pitch_deg: float
    distance_m: float | None            # None when only one camera saw it
    position_m: tuple[float, float, float] | None
    width_m: float | None
    height_m: float | None
    seen_by: SeenBy
    bbox_left: tuple[float, float, float, float] | None = None
    bbox_right: tuple[float, float, float, float] | None = None
    area_frac: float = 0.0              # bbox area / image area (max over cameras)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Fact:
    """One reportable statement about the focus region.

    rank        the smallest detail level at which this fact is reported, in [0, 1]
    salience    how much the fact matters, in [0, 1] (1 = most)
    confidence  how likely the fact is true, in [0, 1]
    """
    kind: FactKind
    subject: str
    value: float | str | None
    unit: str | None
    text: str
    rank: float
    salience: float
    confidence: float
    object_ids: tuple[int, ...] = ()


@dataclass(frozen=True)
class ProcessingPlan:
    """What the pipeline computes for a given detail level (see DetailModel.plan)."""
    detail: float
    imgsz: int
    run_lighting: bool
    run_hazards: bool
    run_locations: bool


@dataclass(frozen=True)
class DetectionReport:
    t_ns: int
    detail: float
    scene: str
    scene_confidence: float
    facts: Sequence[Fact]
    objects: Sequence[SceneObject]
    summary: str
    plan: ProcessingPlan
    latency_ms: float
    skew_ms: float
    warnings: Sequence[str] = ()

    def to_dict(self) -> dict:
        """JSON-serialisable form, for logging or for downstream algorithms."""
        return asdict(self)
