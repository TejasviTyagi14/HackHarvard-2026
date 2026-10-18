"""Shared data contracts for the Ring Sensor project.

Single source of truth for every block boundary in ARCHITECTURE.md.
Change a type here only with agreement from the owners of both blocks it connects.
Units: distances in millimetres, angles in radians, timestamps in microseconds
on the ring clock (converted to host clock by S2).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal, Protocol, Sequence

# ---------------------------------------------------------------------------
# Hardware / firmware -> host  (F1/F2/F4 -> S1)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ImuSample:
    t_us: int
    quat_wxyz: tuple[float, float, float, float]  # orientation, world frame
    accel_mps2: tuple[float, float, float]
    gyro_rps: tuple[float, float, float]


@dataclass(frozen=True)
class DepthFrame:
    t_us: int
    width: int                     # zones, e.g. 8
    height: int                    # zones, e.g. 8
    range_mm: Sequence[int]        # row-major, len = width*height, 0 = invalid
    confidence: Sequence[int]      # 0..255 per zone
    fov_rad: tuple[float, float]   # horizontal, vertical


@dataclass(frozen=True)
class ImageFrame:
    t_us: int
    jpeg: bytes
    width_px: int
    height_px: int


@dataclass(frozen=True)
class SensorPacket:
    seq: int                                   # detects drops
    payload: ImuSample | DepthFrame | ImageFrame


class PressType(Enum):
    SINGLE = "single"   # scan with active profile
    DOUBLE = "double"   # repeat last answer / more detail
    LONG = "long"       # push-to-talk for voice command


@dataclass(frozen=True)
class TriggerEvent:
    t_us: int
    press: PressType


@dataclass(frozen=True)
class BatteryStatus:
    device: Literal["ring", "trigger"]
    percent: int


# ---------------------------------------------------------------------------
# Host -> firmware  (S1 -> F2/F3)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SensorConfig:
    depth_on: bool = True
    depth_hz: int = 15
    depth_zones: Literal[16, 64] = 64          # 4x4 or 8x8
    camera_on: bool = True
    camera_res: Literal["QVGA", "VGA"] = "QVGA"
    imu_hz: int = 100


@dataclass(frozen=True)
class HapticCommand:
    pattern: Literal["ack", "error", "ready", "proximity"]
    intensity: float = 1.0                     # 0..1; proximity maps distance -> intensity


# ---------------------------------------------------------------------------
# Host internal  (S2..S9)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FusedFrame:
    t_us: int
    depth: DepthFrame | None
    image: ImageFrame | None
    imu: ImuSample


@dataclass(frozen=True)
class PointingRay:
    origin_mm: tuple[float, float, float]      # world frame (see Q1 in ARCHITECTURE.md)
    direction: tuple[float, float, float]      # unit vector
    uncertainty_rad: float


@dataclass(frozen=True)
class Roi:
    """Region of interest in normalised sensor coords (0..1)."""
    x0: float = 0.375
    y0: float = 0.375
    x1: float = 0.625
    y1: float = 0.625                           # default = centre 2x2 of 8x8


@dataclass(frozen=True)
class DepthResult:
    nearest_mm: int | None
    nearest_dir: tuple[float, float, float] | None
    points_mm: Sequence[tuple[float, float, float]] = ()   # empty if profile doesn't need them


@dataclass(frozen=True)
class Detection:
    label: str
    confidence: float
    bbox: tuple[float, float, float, float]    # normalised x0,y0,x1,y1
    text: str | None = None                     # OCR result, if task == "ocr"
    distance_mm: int | None = None              # filled by joining with DepthResult


@dataclass(frozen=True)
class SceneDescription:
    objects: Sequence[Detection]
    summary: str                                # free-form, from VLM
    relations: Sequence[str] = ()               # e.g. "cup on table"


@dataclass(frozen=True)
class Observation:
    """What S7 stores per scan."""
    t_us: int
    ray: PointingRay
    depth: DepthResult | None
    detections: Sequence[Detection] = ()


@dataclass(frozen=True)
class Answer:
    distance_mm: int | None = None
    direction_hint: str | None = None           # "slightly left", "ahead"
    objects: Sequence[Detection] = ()
    text: str | None = None
    low_confidence: bool = False                # must be spoken, never silent (Q4)
    error: str | None = None


# ---------------------------------------------------------------------------
# Profiles & intents  (S12..S15)
# ---------------------------------------------------------------------------

MapKind = Literal["none", "ray_cache", "object_list", "voxel_hash", "octree"]
Stage = Literal["depth", "perceive", "describe"]
PerceiveTask = Literal["detect", "describe", "ocr", "find"]


@dataclass(frozen=True)
class MapConfig:
    kind: MapKind = "object_list"
    resolution_mm: int = 50                     # voxel_hash / octree only
    retention_s: int = 300
    capacity: int = 256                         # ray_cache / object_list


@dataclass(frozen=True)
class Profile:
    name: str
    sensors: SensorConfig
    roi: Roi
    stages: frozenset[Stage]
    perceive_task: PerceiveTask | None
    map: MapConfig
    answer_fields: frozenset[Literal["distance", "label", "direction", "text"]]
    verbosity: Literal["terse", "normal", "detailed"] = "normal"
    continuous: Literal["off", "haptic", "speech"] = "off"
    continuous_hz: int = 0
    plugins: Sequence[str] = ()                 # module paths under plugins/, added by S14
    args: dict[str, str] = field(default_factory=dict)   # e.g. {"label": "door"}
    version: int = 1


@dataclass(frozen=True)
class Transcript:
    text: str
    confidence: float


@dataclass(frozen=True)
class ChangeProfile:
    profile: str


@dataclass(frozen=True)
class AdjustParameter:
    path: str                                   # dotted path into Profile, e.g. "verbosity"
    value: str | int | float | bool


@dataclass(frozen=True)
class OneShotQuery:
    profile: str
    args: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Unsupported:
    request: str
    hint: str = ""


Intent = ChangeProfile | AdjustParameter | OneShotQuery | Unsupported


@dataclass(frozen=True)
class Candidate:
    """Output of S14 (Droid)."""
    profile_json: str | None
    plugin_diff: str | None                     # unified diff, restricted to plugins/ and profiles/
    tests_diff: str | None
    rationale: str


@dataclass(frozen=True)
class ValidationReport:
    passed: bool
    p95_latency_ms: float
    est_power_mw: float
    accuracy: dict[str, float]                  # metric -> value on replay set
    failures: Sequence[str] = ()


# ---------------------------------------------------------------------------
# Block interfaces (black boxes). Implement these; don't reach around them.
# ---------------------------------------------------------------------------

class PoseEstimator(Protocol):                  # S3
    def update(self, sample: ImuSample) -> None: ...
    def ray_at(self, t_us: int) -> PointingRay: ...


class DepthStage(Protocol):                     # S4 (and Droid plugins that extend it)
    def __call__(self, frame: DepthFrame, ray: PointingRay, roi: Roi) -> DepthResult: ...


class Perceiver(Protocol):                      # S5
    def __call__(self, image: ImageFrame, roi: Roi, task: PerceiveTask,
                 args: dict[str, str]) -> Sequence[Detection]: ...


class Describer(Protocol):                      # S6
    def __call__(self, frame: FusedFrame, detections: Sequence[Detection],
                 depth: DepthResult | None) -> SceneDescription: ...


class SceneMap(Protocol):                       # S7 - one implementation per MapKind
    def insert(self, obs: Observation) -> None: ...
    def nearest(self, ray: PointingRay, max_mm: int = 4000) -> DepthResult | None: ...
    def objects_in_cone(self, ray: PointingRay, half_angle_rad: float) -> Sequence[Detection]: ...
    def find(self, label: str, max_age_s: float) -> Sequence[Detection]: ...
    def prune(self, now_us: int) -> None: ...


class QueryEngine(Protocol):                    # S8
    def answer(self, trigger: TriggerEvent, frame: FusedFrame, profile: Profile) -> Answer: ...


class Composer(Protocol):                       # S9
    def __call__(self, answer: Answer, verbosity: str) -> str: ...


class Tts(Protocol):                            # S10
    def speak(self, text: str, interrupt: bool = True) -> None: ...


class Asr(Protocol):                            # S11
    def transcribe(self, audio_pcm16: bytes, sample_rate: int) -> Transcript: ...


class Interpreter(Protocol):                    # S12
    def __call__(self, transcript: Transcript, registry: Sequence[Profile],
                 active: Profile) -> Intent: ...


class ProfileManager(Protocol):                 # S13
    def apply(self, profile: Profile) -> SensorConfig: ...
    def registry(self) -> Sequence[Profile]: ...
    def register(self, profile: Profile) -> None: ...
    def rollback(self, name: str) -> None: ...


class Adapter(Protocol):                        # S14 - wraps Droid
    def adapt(self, request: Unsupported, active: Profile) -> Candidate: ...


class Validator(Protocol):                      # S15
    def validate(self, candidate: Candidate) -> ValidationReport: ...
