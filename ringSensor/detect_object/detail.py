"""The detail model: one number, lambda in [0, 1], controls how much is computed and reported.

Model
-----
Every candidate fact f carries a rank r(f) in [0, 1] (the smallest detail at
which it is reported), a salience s(f) and a confidence c(f).

    rank(scene)           = 0
    rank(count of class)  = r_count_lo + (r_count_hi - r_count_lo) * (1 - s)
    rank(hazard)          = r_hazard
    rank(lighting)        = r_lighting
    rank(location of obj) = r_loc_lo + (r_loc_hi - r_loc_lo) * (1 - s)

Selection at level lambda:

    D(lambda) = first N(lambda) of  sort_{(r, -s, subject)} { f : r(f) <= lambda, c(f) >= c_min }
    N(lambda) = floor(N_lo + (N_hi - N_lo) * lambda)

Because the sort key starts with r and N is non-decreasing, the outputs are
nested:  lambda1 <= lambda2  =>  D(lambda1) is a prefix of D(lambda2).

Processing plan at level lambda (what is computed, so low detail is cheap):

    imgsz(lambda)      = 32 * round((imgsz_lo + (imgsz_hi - imgsz_lo) * lambda) / 32)
    run_hazards        = lambda >= r_hazard
    run_lighting       = lambda >= r_lighting
    run_locations      = lambda >= r_loc_lo

A stage runs exactly when at least one of the facts it can produce is
reportable, so nothing is computed that the selection would discard.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

from .types import Fact, ProcessingPlan

PRESETS = {"low": 0.0, "medium": 0.5, "high": 1.0}
_EPS = 1e-9


def parse_level(level: float | str) -> float:
    """Accept 0..1 or a preset name ('low', 'medium', 'high')."""
    if isinstance(level, str):
        key = level.strip().lower()
        value = PRESETS[key] if key in PRESETS else float(key)
    else:
        value = float(level)
    if not 0.0 <= value <= 1.0 or math.isnan(value):
        raise ValueError(f"detail level must be in [0, 1], got {level!r}")
    return value


@dataclass(frozen=True)
class DetailModel:
    r_count_lo: float = 0.05
    r_count_hi: float = 0.75
    r_hazard: float = 0.60
    r_lighting: float = 0.65
    r_loc_lo: float = 0.85
    r_loc_hi: float = 1.00
    n_lo: int = 1
    n_hi: int = 40
    c_min: float = 0.30
    imgsz_lo: int = 320
    imgsz_hi: int = 960

    def __post_init__(self) -> None:
        ranks = (self.r_count_lo, self.r_count_hi, self.r_hazard, self.r_lighting,
                 self.r_loc_lo, self.r_loc_hi)
        if not all(0.0 <= r <= 1.0 for r in ranks):
            raise ValueError("all ranks must be in [0, 1]")
        if self.r_count_lo > self.r_count_hi or self.r_loc_lo > self.r_loc_hi:
            raise ValueError("rank ranges must satisfy lo <= hi")
        if not 1 <= self.n_lo <= self.n_hi:
            raise ValueError("need 1 <= n_lo <= n_hi")

    # -- ranks ---------------------------------------------------------------

    def count_rank(self, salience: float) -> float:
        return self.r_count_lo + (self.r_count_hi - self.r_count_lo) * (1.0 - _clip01(salience))

    def location_rank(self, salience: float) -> float:
        return self.r_loc_lo + (self.r_loc_hi - self.r_loc_lo) * (1.0 - _clip01(salience))

    # -- processing plan -----------------------------------------------------

    def plan(self, level: float) -> ProcessingPlan:
        lam = parse_level(level)
        imgsz = 32 * round((self.imgsz_lo + (self.imgsz_hi - self.imgsz_lo) * lam) / 32)
        return ProcessingPlan(detail=lam, imgsz=int(imgsz),
                              run_lighting=lam + _EPS >= self.r_lighting,
                              run_hazards=lam + _EPS >= self.r_hazard,
                              run_locations=lam + _EPS >= self.r_loc_lo)

    # -- selection -----------------------------------------------------------

    def max_facts(self, level: float) -> int:
        lam = parse_level(level)
        return int(math.floor(self.n_lo + (self.n_hi - self.n_lo) * lam + _EPS))

    def select(self, facts: Iterable[Fact], level: float) -> list[Fact]:
        lam = parse_level(level)
        eligible = [f for f in facts
                    if f.rank <= lam + _EPS and (f.kind == "scene" or f.confidence >= self.c_min)]
        eligible.sort(key=lambda f: (f.rank, -f.salience, f.subject))
        return eligible[: self.max_facts(lam)]


def _clip01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else float(x)
