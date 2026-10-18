"""Load and save the configuration ports (rig, focus region, detail) as JSON."""
from __future__ import annotations

import json
from dataclasses import asdict, fields
from pathlib import Path

from .types import CameraIntrinsics, FocusRegion, StereoRig


def _build(cls, data: dict):
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"unknown {cls.__name__} fields: {sorted(unknown)}")
    return cls(**data)


def rig_from_dict(d: dict) -> StereoRig:
    d = dict(d)
    for side in ("left", "right"):
        if side in d:
            cam = dict(d[side])
            for k in ("K", "dist"):
                if cam.get(k) is not None:
                    cam[k] = tuple(float(v) for v in _flatten(cam[k]))   # accepts 3x3 or flat
            d[side] = _build(CameraIntrinsics, cam)
    return _build(StereoRig, d)


def _flatten(x):
    if isinstance(x, (list, tuple)):
        for v in x:
            yield from _flatten(v)
    else:
        yield x


def load_config(path: str | Path) -> dict:
    """Returns {"rig": StereoRig, "focus": FocusRegion, "detail": float|str, "detector": dict}."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return {"rig": rig_from_dict(raw.get("rig", {})),
            "focus": _build(FocusRegion, raw.get("focus", {})),
            "detail": raw.get("detail", "medium"),
            "detector": raw.get("detector", {}),
            "sources": raw.get("sources", {})}


def default_config() -> dict:
    return {"sources": {"left": 0, "right": 2, "width": 640, "height": 480, "fps": 30},
            "rig": asdict(StereoRig()), "focus": asdict(FocusRegion()), "detail": 0.5,
            "detector": {"model": "yolo11n.pt", "conf": 0.25, "vocabulary": None}}


def save_default_config(path: str | Path) -> None:
    Path(path).write_text(json.dumps(default_config(), indent=2) + "\n", encoding="utf-8")
