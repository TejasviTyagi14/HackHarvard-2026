"""Object detector backends. All take BGR images and return Detection2D lists.

``UltralyticsDetector`` (default) runs YOLO via the ``ultralytics`` package.
With a YOLO-World model (``yolov8s-worldv2.pt``) it accepts an open
vocabulary, e.g. ["projector", "speaker", "whiteboard"]. ``StaticDetector``
returns canned detections for tests and simulation.
"""
from __future__ import annotations

from pathlib import Path
from typing import Protocol, Sequence

import numpy as np

from .types import Detection2D


class Detector(Protocol):
    def __call__(self, images: Sequence[np.ndarray], imgsz: int) -> list[list[Detection2D]]: ...


def pick_device() -> str:
    """'cuda' on NVIDIA, 'mps' on Apple Silicon, else 'cpu'."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


class UltralyticsDetector:
    def __init__(self, model: str = "yolo11n.pt", conf: float = 0.25, iou: float = 0.5,
                 device: str | None = None, vocabulary: Sequence[str] | None = None):
        from ultralytics import YOLO
        bundled = Path(__file__).resolve().parent.parent / "models" / model
        if not Path(model).exists() and bundled.exists():
            model = str(bundled)          # reuse the copy in <project>/models/
        self.model = YOLO(model)
        if vocabulary:
            if not hasattr(self.model, "set_classes"):
                raise ValueError(f"{model} has a fixed vocabulary; use a YOLO-World model")
            self.model.set_classes(list(vocabulary))
        self.conf, self.iou = conf, iou
        self.device = device or pick_device()
        self.names = self.model.names

    def __call__(self, images: Sequence[np.ndarray], imgsz: int) -> list[list[Detection2D]]:
        results = self.model.predict(list(images), imgsz=imgsz, conf=self.conf, iou=self.iou,
                                     device=self.device, verbose=False)
        out = []
        for r in results:
            boxes = r.boxes
            xyxy = boxes.xyxy.cpu().numpy()
            cls = boxes.cls.cpu().numpy().astype(int)
            cf = boxes.conf.cpu().numpy()
            out.append([Detection2D(str(r.names[c]), float(p), tuple(float(v) for v in b))
                        for b, c, p in zip(xyxy, cls, cf)])
        return out


class StaticDetector:
    """Returns the same per-camera detections every call (for tests/simulation)."""

    def __init__(self, left: Sequence[Detection2D], right: Sequence[Detection2D]):
        self._out = [list(left), list(right)]
        self.calls: list[int] = []      # imgsz of every call, for plan tests

    def __call__(self, images: Sequence[np.ndarray], imgsz: int) -> list[list[Detection2D]]:
        self.calls.append(imgsz)
        return [list(d) for d in self._out[: len(images)]]
