"""Turn analyzer outputs into candidate facts, and smooth them over time."""
from __future__ import annotations

import math
import statistics
from collections import Counter, deque
from dataclasses import dataclass
from typing import Sequence

from .detail import DetailModel
from .scene import Hazard, Lighting, alias, count_phrase, direction_phrase, importance
from .types import Fact, SceneObject

# Weights of the class-salience model:
#   s_c = W_COUNT * min(1, ln(1+n)/ln(1+N_REF)) + W_AREA * min(1, sqrt(A)) + W_IMP * I(c)
W_COUNT, W_AREA, W_IMP, N_REF = 0.35, 0.25, 0.40, 20
LOCATIONS_PER_CLASS = 3    # location facts only for the most salient few of each class


def class_salience(n: int, area_frac: float, label: str) -> float:
    return (W_COUNT * min(1.0, math.log1p(n) / math.log1p(N_REF))
            + W_AREA * min(1.0, math.sqrt(max(0.0, area_frac)))
            + W_IMP * importance(label))


def object_salience(o: SceneObject) -> float:
    """s_o = 0.5 sqrt(area) + 0.25 I(label) + 0.25 / (1 + distance)."""
    near = 1.0 / (1.0 + o.distance_m) if o.distance_m is not None else 0.0
    return min(1.0, 0.5 * math.sqrt(o.area_frac) + 0.25 * importance(o.label) + 0.25 * near)


@dataclass
class TemporalSmoother:
    """Median counts and modal scene over the last ``window`` frame pairs (declared state)."""
    window: int = 5

    def __post_init__(self) -> None:
        self._counts: deque[dict[str, int]] = deque(maxlen=self.window)
        self._scenes: deque[tuple[str, float]] = deque(maxlen=self.window)

    def reset(self) -> None:
        self._counts.clear()
        self._scenes.clear()

    def update(self, counts: dict[str, int], scene: tuple[str, float]
               ) -> tuple[dict[str, int], tuple[str, float]]:
        self._counts.append(counts)
        self._scenes.append(scene)
        labels = set().union(*self._counts)
        smoothed = {}
        for lab in labels:
            m = statistics.median(c.get(lab, 0) for c in self._counts)
            if m >= 0.5:
                smoothed[lab] = int(math.floor(m + 0.5))
        name = Counter(s for s, _ in self._scenes).most_common(1)[0][0]
        conf = statistics.fmean(c for s, c in self._scenes if s == name)
        return smoothed, (name, conf)


def build_facts(scene: tuple[str, float], counts: dict[str, int], objects: Sequence[SceneObject],
                lighting: Lighting | None, hazards: Sequence[Hazard],
                model: DetailModel, with_locations: bool) -> list[Fact]:
    """All candidate facts F for one frame pair, each with its rank."""
    facts = [Fact("scene", "scene", scene[0], None, scene[0], 0.0, 1.0, scene[1])]

    by_label: dict[str, list[SceneObject]] = {}
    for o in objects:
        by_label.setdefault(o.label, []).append(o)
    for label, n in counts.items():
        objs = by_label.get(label, [])
        area = sum(o.area_frac for o in objs)
        s = class_salience(n, area, label)
        conf = statistics.fmean(o.confidence for o in objs) if objs else 0.5
        facts.append(Fact("count", alias(label), n, "count", count_phrase(n, label),
                          model.count_rank(s), s, conf, tuple(o.id for o in objs)))

    for h in hazards:
        facts.append(Fact("hazard", alias(h.label), h.distance_m, "m", h.text,
                          model.r_hazard, 1.0, h.confidence, (h.object_id,)))

    if lighting is not None:
        facts.append(Fact("attribute", "lighting", lighting.source, None,
                          f"lighting: {lighting.text}", model.r_lighting, 0.6, lighting.confidence))

    if with_locations:
        for objs in by_label.values():
            for o in sorted(objs, key=object_salience, reverse=True)[:LOCATIONS_PER_CLASS]:
                s = object_salience(o)
                where = direction_phrase(o.yaw_deg)
                dist = f", {o.distance_m:.1f} m" if o.distance_m is not None else ""
                facts.append(Fact("location", f"{alias(o.label)}#{o.id}", o.distance_m, "m",
                                  f"{alias(o.label)} {where}{dist}", model.location_rank(s), s,
                                  o.confidence, (o.id,)))
    return facts


def summarize(selected: Sequence[Fact]) -> str:
    """One sentence per fact kind, most important first."""
    parts = [f.text for f in selected if f.kind == "scene"]
    counts = [f.text for f in selected if f.kind == "count"]
    if counts:
        parts.append(", ".join(counts))
    parts += [f.text for f in selected if f.kind in ("hazard", "attribute", "location")]
    return " ".join(p[:1].upper() + p[1:] + "." for p in parts)
