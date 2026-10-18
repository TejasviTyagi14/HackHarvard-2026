"""Command line: python -m detect_object [--config rig.json] [--left 0 --right 2] [--detail 0.5] [--droid]"""
from __future__ import annotations

import argparse
import json
import sys
import threading

from .config import load_config, save_default_config
from .types import FocusRegion, StereoRig


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="detect_object", description=__doc__)
    ap.add_argument("--config", help="JSON config (see --write-config)")
    ap.add_argument("--write-config", metavar="PATH", help="write a default config and exit")
    ap.add_argument("--list", action="store_true", help="list camera indices and exit")
    ap.add_argument("--left", help="left camera index/device or video file")
    ap.add_argument("--right", help="right camera index/device or video file")
    ap.add_argument("--detail", help="0..1 or low|medium|high")
    ap.add_argument("--model", help="detector weights, e.g. yolo11n.pt or yolov8s-worldv2.pt")
    ap.add_argument("--json", action="store_true", help="print full reports as JSON lines")
    ap.add_argument("--preview", action="store_true", help="show both camera views with boxes")
    ap.add_argument("--max-frames", type=int, default=0, help="stop after N frame pairs")
    ap.add_argument("--droid", action="store_true",
                    help="while running, type requests like 'more detail' and Droid sets the level")
    args = ap.parse_args(argv)

    if args.write_config:
        save_default_config(args.write_config)
        print(f"wrote {args.write_config}")
        return 0

    from .capture import list_cameras, open_stereo
    if args.list:
        for i, w, h in list_cameras():
            print(f"camera {i}: {w}x{h}")
        return 0

    cfg = load_config(args.config) if args.config else {
        "rig": StereoRig(), "focus": FocusRegion(), "detail": "medium", "detector": {},
        "sources": {}}
    src = cfg["sources"]
    left = args.left if args.left is not None else src.get("left", 0)
    right = args.right if args.right is not None else src.get("right", 2)
    det_cfg = dict(cfg["detector"])
    if args.model:
        det_cfg["model"] = args.model

    from .detector import UltralyticsDetector
    from .pipeline import DetectObject
    rig = cfg["rig"]
    algo = DetectObject(rig, cfg["focus"], args.detail or cfg["detail"],
                        detector=UltralyticsDetector(**{k: v for k, v in det_cfg.items() if v is not None}))
    print(f"focus region (effective): {algo.focus}", file=sys.stderr)
    droid = _DroidInput(algo.detail) if args.droid else None

    with open_stereo(left, right, rig.left.width_px, rig.left.height_px,
                     src.get("fps", 30)) as stereo:
        for n, (pair, report) in enumerate(_pairs_and_reports(stereo, algo, droid), start=1):
            if args.json:
                print(json.dumps(report.to_dict(), default=str))
            else:
                print(f"[{report.latency_ms:6.0f} ms] {report.summary}"
                      + (f"  ! {'; '.join(report.warnings)}" if report.warnings else ""))
            if args.preview and not _show(pair, algo, report):
                break
            if args.max_frames and n >= args.max_frames:
                break
    return 0


def _pairs_and_reports(stereo, algo, droid=None):
    for pair in stereo:
        if droid is not None:
            level = droid.take()
            if level is not None:
                algo.set_detail(level)          # between frame pairs, like any config change
        yield pair, algo.process(pair)


class _DroidInput:
    """Reads requests from stdin on a background thread and asks Droid for a new level."""

    def __init__(self, level: float):
        from .droid import DroidDetail
        self.droid = DroidDetail()
        self.level = level
        self._new: float | None = None
        self._lock = threading.Lock()
        print("Droid: type a request (e.g. 'more detail', 'just the basics') and press Enter.",
              file=sys.stderr)
        threading.Thread(target=self._loop, name="droid-input", daemon=True).start()

    def take(self) -> float | None:
        with self._lock:
            new, self._new = self._new, None
            return new

    def _loop(self) -> None:
        for line in sys.stdin:
            if not line.strip():
                continue
            d = self.droid.propose(line, self.level)
            if not d.ok:
                print(f"Droid: level unchanged ({d.error})", file=sys.stderr)
                continue
            if d.changed:
                with self._lock:
                    self.level = self._new = d.level
            print(f"Droid: {d.reply or ('done' if d.changed else 'no change')} (detail {d.level:.2f})",
                  file=sys.stderr)


def _show(pair, algo, report) -> bool:
    """Draw on the main thread (required on macOS). Returns False when the user quits."""
    import cv2
    import numpy as np
    views = []
    for side, f in (("left", pair.left), ("right", pair.right)):
        img = f.image.copy()
        for o in report.objects:
            box = o.bbox_left if side == "left" else o.bbox_right
            if box is None:
                continue
            x0, y0, x1, y1 = (int(v) for v in box)
            cv2.rectangle(img, (x0, y0), (x1, y1), (0, 200, 0), 2)
            d = f" {o.distance_m:.1f}m" if o.distance_m is not None else ""
            cv2.putText(img, o.label + d, (x0, max(12, y0 - 4)), cv2.FONT_HERSHEY_SIMPLEX,
                        0.45, (0, 200, 0), 1)
        views.append(img)
    h = min(v.shape[0] for v in views)
    canvas = np.hstack([v[:h] for v in views])
    cv2.putText(canvas, report.summary[:120], (8, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                (255, 255, 255), 1)
    cv2.imshow("detect_object (q to quit)", canvas)
    return (cv2.waitKey(1) & 0xFF) != ord("q")


if __name__ == "__main__":
    sys.exit(main())
