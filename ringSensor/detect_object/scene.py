"""Scene analyzers: scene category, lighting, floor-level hazards.

Each analyzer is a small pure function behind a narrow signature, so a
learned model (CLIP, a VLM) can replace it without touching the pipeline.
"""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from typing import Protocol, Sequence

import numpy as np

from .geometry import RigGeometry
from .types import FramePair, SceneObject

# ---------------------------------------------------------------------------
# Vocabulary helpers
# ---------------------------------------------------------------------------

# Detector label -> word used in reports (COCO names are not always natural).
ALIASES = {"chair": "seat", "dining table": "table", "tv": "screen", "couch": "sofa",
           "cell phone": "phone", "potted plant": "plant", "sports ball": "ball"}

# How much a class matters to a person in the room, in [0, 1].
IMPORTANCE = {"person": 1.0, "door": 0.9, "stairs": 0.9, "projector": 0.7, "tv": 0.7,
              "whiteboard": 0.7, "dining table": 0.6, "chair": 0.6, "couch": 0.5, "bed": 0.5,
              "laptop": 0.5, "dog": 0.6, "cat": 0.5, "car": 0.9, "bicycle": 0.7}
DEFAULT_IMPORTANCE = 0.3

_PLURALS = {"person": "people", "bench": "benches", "glass": "glasses", "knife": "knives",
            "mouse": "mice", "sofa": "sofas", "bus": "buses"}
_NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]


def alias(label: str) -> str:
    return ALIASES.get(label, label)


def importance(label: str) -> float:
    return IMPORTANCE.get(label, DEFAULT_IMPORTANCE)


def count_phrase(n: int, label: str) -> str:
    word = alias(label)
    if n != 1:
        last = word.split()[-1]
        plural = _PLURALS.get(last) or (last + "es" if last.endswith(("s", "x", "ch", "sh")) else last + "s")
        word = " ".join(word.split()[:-1] + [plural])
    num = _NUMBERS[n] if n < len(_NUMBERS) else str(n)
    return f"{num} {word}"


def direction_phrase(yaw_deg: float) -> str:
    a = abs(yaw_deg)
    if a < 8:
        return "ahead"
    side = "right" if yaw_deg > 0 else "left"
    return f"slightly {side}" if a < 20 else side


# ---------------------------------------------------------------------------
# Scene category
# ---------------------------------------------------------------------------

class SceneClassifier(Protocol):
    def __call__(self, counts: dict[str, int]) -> tuple[str, float]: ...


SCENE_WEIGHTS: dict[str, dict[str, float]] = {
    "conference room": {"chair": 1.0, "dining table": 1.0, "tv": 0.9, "laptop": 0.6,
                        "projector": 1.5, "whiteboard": 1.0, "bottle": 0.2, "cup": 0.1},
    "classroom": {"chair": 0.7, "backpack": 0.8, "book": 0.7, "whiteboard": 1.2,
                  "dining table": 0.3, "person": 0.3},
    "office": {"laptop": 1.0, "keyboard": 1.0, "mouse": 1.0, "tv": 0.6, "chair": 0.5,
               "cell phone": 0.3, "book": 0.3},
    "kitchen": {"refrigerator": 1.3, "oven": 1.3, "microwave": 1.1, "toaster": 1.0, "sink": 0.8,
                "bowl": 0.5, "knife": 0.6, "spoon": 0.5, "cup": 0.3, "bottle": 0.3},
    "dining room": {"dining table": 1.0, "chair": 0.5, "wine glass": 0.9, "fork": 0.8,
                    "knife": 0.5, "spoon": 0.5, "bowl": 0.5, "cup": 0.5, "pizza": 0.6},
    "living room": {"couch": 1.3, "tv": 0.8, "remote": 0.9, "potted plant": 0.5,
                    "vase": 0.4, "clock": 0.3, "book": 0.3},
    "bedroom": {"bed": 1.6, "teddy bear": 0.5, "clock": 0.3, "book": 0.2},
    "bathroom": {"toilet": 1.6, "sink": 0.8, "toothbrush": 1.0, "hair drier": 0.8},
    "street": {"car": 1.0, "truck": 1.0, "bus": 1.0, "traffic light": 1.2, "stop sign": 1.2,
               "fire hydrant": 1.0, "parking meter": 1.0, "motorcycle": 0.8, "bicycle": 0.6,
               "person": 0.2},
    "park": {"bench": 1.0, "kite": 0.8, "frisbee": 0.8, "bird": 0.5, "dog": 0.4,
             "sports ball": 0.4},
}


@dataclass(frozen=True)
class RuleSceneClassifier:
    """score(s) = sum_c w[s][c] * ln(1 + n_c);  confidence = softmax(score) * min(1, top / s_full)."""
    weights: dict[str, dict[str, float]] | None = None    # None = SCENE_WEIGHTS
    min_score: float = 0.6
    full_score: float = 2.0
    unknown_label: str = "unidentified scene"

    def __call__(self, counts: dict[str, int]) -> tuple[str, float]:
        table = self.weights or SCENE_WEIGHTS
        scores = {s: sum(w * math.log1p(counts.get(c, 0)) for c, w in ws.items())
                  for s, ws in table.items()}
        best = max(scores, key=scores.get)
        top = scores[best]
        if top < self.min_score:
            return self.unknown_label, 0.0
        z = np.array(list(scores.values()))
        p = float(np.exp(top - z.max()) / np.exp(z - z.max()).sum())
        return best, p * min(1.0, top / self.full_score)


# ---------------------------------------------------------------------------
# Lighting
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Lighting:
    level: str           # dark | dim | normal | bright
    source: str          # daylight-like | neutral white | warm artificial
    luminance: float     # mean relative luminance Y, 0..1
    cct_k: float         # correlated colour temperature estimate, kelvin
    confidence: float

    @property
    def text(self) -> str:
        return f"{self.level}, {self.source} light (about {round(self.cct_k, -2):.0f} K)"


def analyze_lighting(pair: FramePair) -> Lighting:
    """Gray-world estimate over both images.

    sRGB -> linear -> XYZ -> chromaticity (x, y) -> McCamy's CCT formula.
    Webcam auto-white-balance pulls CCT toward ~5000-6500 K, so confidence is capped.
    """
    rgb = []
    for f in (pair.left, pair.right):
        small = f.image[::4, ::4].reshape(-1, 3).astype(np.float64) / 255.0
        rgb.append(small[:, ::-1])                                   # BGR -> RGB
    c = np.concatenate(rgb)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    r, g, b = lin.mean(axis=0)
    X = 0.4124 * r + 0.3576 * g + 0.1805 * b
    Y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    Z = 0.0193 * r + 0.1192 * g + 0.9505 * b
    s = X + Y + Z
    if s <= 1e-9:
        return Lighting("dark", "unknown", 0.0, 0.0, 0.9)
    x, y = X / s, Y / s
    n = (x - 0.3320) / (0.1858 - y)
    cct = float(np.clip(449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33, 1000, 25000))
    lum = float((0.2126 * lin[:, 0] + 0.7152 * lin[:, 1] + 0.0722 * lin[:, 2]).mean())
    level = "dark" if lum < 0.02 else "dim" if lum < 0.08 else "normal" if lum < 0.35 else "bright"
    source = "daylight-like" if cct >= 5000 else "neutral white" if cct >= 4000 else "warm artificial"
    return Lighting(level, source, lum, cct, 0.5 if level != "dark" else 0.8)


# ---------------------------------------------------------------------------
# Floor-level hazards
# ---------------------------------------------------------------------------

NOT_HAZARD = {"person", "chair", "couch", "bed", "dining table", "tv", "refrigerator", "oven",
              "toilet", "sink", "car", "truck", "bus", "train", "airplane", "boat"}
FLOOR_ITEMS = {"backpack", "handbag", "suitcase", "bottle", "sports ball", "umbrella",
               "skateboard", "book", "cat", "dog", "cup", "shoe", "box", "cable"}


@dataclass(frozen=True)
class Hazard:
    object_id: int
    label: str
    distance_m: float | None
    yaw_deg: float
    confidence: float

    @property
    def text(self) -> str:
        d = f", {self.distance_m:.1f} m" if self.distance_m is not None else ""
        return f"possible trip hazard: {alias(self.label)} on the floor, {direction_phrase(self.yaw_deg)}{d}"


def find_hazards(objects: Sequence[SceneObject], geometry: RigGeometry, image_h: int,
                 max_height_m: float = 0.45, max_distance_m: float = 4.0) -> list[Hazard]:
    """Low objects resting on the floor in front of the rig.

    With rig.height_m known: intersect the ray through the bottom of the box
    with the floor plane, then require object height <= max_height_m and
    floor distance <= max_distance_m. Without it: fall back to "box touches
    the bottom 15 % of the image and the class is a typical floor item".
    """
    out = []
    for o in objects:
        if o.label in NOT_HAZARD:
            continue
        side, box = ("left", o.bbox_left) if o.bbox_left is not None else ("right", o.bbox_right)
        cx, bottom = (box[0] + box[2]) / 2, box[3]
        if geometry.rig.height_m is not None:
            fp = geometry.floor_point(side, cx, bottom)
            if fp is None:
                continue
            floor_d = math.hypot(fp[0], fp[2])
            if floor_d > max_distance_m:
                continue
            if o.height_m is not None:
                h = o.height_m
            else:
                pose = geometry.pose(side)
                top = pose.pixel_ray(cx, box[1])
                dist_cam = float(np.linalg.norm(fp - pose.center))
                ang = math.acos(float(np.clip(top @ pose.pixel_ray(cx, bottom), -1, 1)))
                h = 2 * dist_cam * math.tan(ang / 2)
            if h <= max_height_m:
                out.append(Hazard(o.id, o.label, o.distance_m or floor_d, o.yaw_deg,
                                  min(0.9, o.confidence)))
        elif bottom >= 0.85 * image_h and o.label in FLOOR_ITEMS:
            out.append(Hazard(o.id, o.label, o.distance_m, o.yaw_deg, 0.5 * o.confidence))
    return out


def label_counts(objects: Sequence[SceneObject]) -> dict[str, int]:
    return dict(Counter(o.label for o in objects))
