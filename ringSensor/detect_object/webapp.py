"""Local web viewer for detectObject: live stereo view, settings, reports.

    .venv/bin/python -m detect_object.webapp            # then open http://127.0.0.1:8770
    .venv/bin/python -m detect_object.webapp --port 9000 --model yolo11n.pt

Standard library HTTP server only (no extra dependencies). Binds to 127.0.0.1,
so it is reachable from this computer only. All camera and model work happens
on one worker thread; the HTTP threads only read its results and queue
configuration changes, which the worker applies between frame pairs.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import threading
import time
from dataclasses import asdict, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

from .capture import list_cameras, open_stereo
from .config import rig_from_dict
from .detail import parse_level
from .droid import DroidDetail, DroidError, login_status, open_login_window
from .geometry import RigGeometry
from .pipeline import DetectObject
from .types import FocusRegion, StereoRig

INDEX_HTML = Path(__file__).with_name("web") / "index.html"
SLIDER_STEPS = 20       # the page's λ slider moves in steps of 1/20 (step="0.05" in web/index.html)


# ---------------------------------------------------------------------------
# Cameras
# ---------------------------------------------------------------------------

def describe_cameras() -> list[dict]:
    """Capture devices, without opening them on Linux.

    Each entry: ``index`` (the number OpenCV opens), ``key`` (a stable identity:
    the physical USB port on Linux, so two identical webcams can be told apart
    and a selection survives renumbering after a replug), ``name``, ``builtin``.

    Linux: /dev/videoN nodes whose sysfs ``index`` is 0 (the video node; the
    odd-numbered siblings are metadata nodes). macOS/other: indices that open
    and deliver a frame (AVFoundation offers no port information).
    """
    if not sys.platform.startswith("linux"):
        return [{"index": i, "key": f"index-{i}", "name": f"Camera {i} ({w}×{h})", "builtin": False}
                for i, w, h in list_cameras()]
    out = []
    for dev in Path("/sys/class/video4linux").glob("video*"):
        if not dev.name[5:].isdigit():
            continue
        try:
            if (dev / "index").read_text().strip() != "0":
                continue
            name = (dev / "name").read_text().strip()
            usb_if = Path(os.path.realpath(dev / "device")).name      # e.g. "1-5.3:1.0"
        except OSError:
            continue
        port = usb_if.split(":")[0]                                   # e.g. "1-5.3"
        model = name.split(":")[0].strip()
        builtin = "integrated" in name.lower()
        hub_port = port.rsplit(".", 1)[1] if "." in port else None
        where = "built-in" if builtin else (f"adapter/hub port {hub_port}" if hub_port else f"USB port {port}")
        out.append({"index": int(dev.name[5:]), "key": f"usb-{port}-{usb_if.split(':')[-1]}",
                    "name": f"{model} — {where} (video{dev.name[5:]})", "builtin": builtin})
    return sorted(out, key=lambda c: (c["builtin"], c["index"]))


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------

def _bearing_dir(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    y, p = math.radians(yaw_deg), math.radians(pitch_deg)
    return np.array([math.cos(p) * math.sin(y), -math.sin(p), math.cos(p) * math.cos(y)])


def _draw_focus(img, pose, focus: FocusRegion, dist_m: float = 5.0) -> None:
    """Outline of the focus cone, projected at ``dist_m`` into this camera."""
    n = 24
    edge = ([(focus.yaw_min_deg + (focus.yaw_max_deg - focus.yaw_min_deg) * k / n, focus.pitch_max_deg) for k in range(n + 1)]
            + [(focus.yaw_max_deg, focus.pitch_max_deg - (focus.pitch_max_deg - focus.pitch_min_deg) * k / n) for k in range(n + 1)]
            + [(focus.yaw_max_deg - (focus.yaw_max_deg - focus.yaw_min_deg) * k / n, focus.pitch_min_deg) for k in range(n + 1)]
            + [(focus.yaw_min_deg, focus.pitch_min_deg + (focus.pitch_max_deg - focus.pitch_min_deg) * k / n) for k in range(n + 1)])
    pts = []
    for yaw, pitch in edge:
        uv = pose.project(dist_m * _bearing_dir(yaw, pitch))
        if uv is not None and all(abs(v) < 1e5 for v in uv):
            pts.append((int(round(uv[0])), int(round(uv[1]))))
    if len(pts) > 2:
        cv2.polylines(img, [np.array(pts, np.int32)], True, (0, 215, 255), 1, cv2.LINE_AA)


def _label(img, text, x, y, color) -> None:
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
    y = max(th + 4, y)
    cv2.rectangle(img, (x, y - th - 4), (x + tw + 4, y), color, -1)
    cv2.putText(img, text, (x + 2, y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1, cv2.LINE_AA)


def annotate(pair, algo: DetectObject) -> np.ndarray:
    dbg = algo.last_debug
    in_focus = {o.id for o in dbg.get("in_focus", [])}
    hazards = dbg.get("hazard_ids", set())
    views = []
    for side, frame in (("left", pair.left), ("right", pair.right)):
        img = frame.image.copy()
        _draw_focus(img, algo.geometry.pose(side), algo.focus)
        for o in dbg.get("fused", []):
            box = o.bbox_left if side == "left" else o.bbox_right
            if box is None:
                continue
            if o.id in hazards:
                color, thick = (60, 60, 255), 2          # red
            elif o.id not in in_focus:
                color, thick = (150, 150, 150), 1        # grey: outside focus
            elif o.seen_by == "both":
                color, thick = (90, 220, 90), 2          # green: stereo
            else:
                color, thick = (60, 170, 255), 2         # orange: one camera only
            x0, y0, x1, y1 = (int(v) for v in box)
            cv2.rectangle(img, (x0, y0), (x1, y1), color, thick)
            d = f" {o.distance_m:.2f}m" if o.distance_m is not None else ""
            _label(img, f"{o.label}{d}", x0, y0, color)
        _label(img, side.upper(), 6, 20, (240, 240, 240))
        views.append(img)
    h = min(v.shape[0] for v in views)
    views = [cv2.resize(v, (int(v.shape[1] * h / v.shape[0]), h)) if v.shape[0] != h else v for v in views]
    return np.hstack(views)


# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------

class Viewer:
    def __init__(self, model: str):
        self.model_name = model
        self.detector = None
        self.cond = threading.Condition()
        self.running = False
        self.status = "idle"
        self.error: str | None = None
        self.jpeg: bytes | None = None
        self.frame_id = 0
        self.report: dict | None = None
        self.fps = 0.0
        self.cameras: dict = {}
        self.rig = StereoRig()
        self.focus = FocusRegion()
        self.detail = 0.5
        self.effective_focus: FocusRegion | None = RigGeometry(self.rig).effective_focus(self.focus)
        self._pending: dict = {}
        self._thread: threading.Thread | None = None
        self.droid = DroidDetail()
        self.droid_last: dict | None = None     # the last request Droid handled, for the page
        self._login: tuple[float, dict] | None = None   # (when checked, Droid's login status)
        self._login_lock = threading.Lock()

    # -- control (HTTP threads) ---------------------------------------------

    def start(self, left, right, width: int, height: int, fps: int) -> None:
        self.stop()
        with self.cond:
            self.error, self.status, self.running = None, "starting", True
            self.cameras = {"left": left, "right": right, "width": width, "height": height, "fps": fps}
        self._thread = threading.Thread(target=self._run, args=(left, right, width, height, fps),
                                        name="detect-worker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        with self.cond:
            self.running = False
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None
        with self.cond:
            if self.status != "error":
                self.status = "idle"
            self.cond.notify_all()

    def update(self, body: dict) -> None:
        """Validate a config change now (raises ValueError), apply it on the worker."""
        rig = rig_from_dict(body["rig"]) if "rig" in body else self.rig
        focus = FocusRegion(**body["focus"]) if "focus" in body else self.focus
        detail = parse_level(body["detail"]) if "detail" in body else self.detail
        eff = RigGeometry(rig).effective_focus(focus)            # raises if empty
        with self.cond:
            self.rig, self.focus, self.detail, self.effective_focus = rig, focus, detail, eff
            self._pending.update({k: True for k in ("rig", "focus", "detail") if k in body})

    def ask_droid(self, request: str) -> dict:
        """Droid turns a request ("more detail", "just the basics") into a new detail level.

        Runs on the calling HTTP thread (Droid takes a few seconds); the worker picks up the
        new level between frame pairs, like a slider change. The level is rounded to the
        slider's steps, so the page shows the level that runs. On failure nothing changes.
        """
        with self.cond:
            current = self.detail
        d = self.droid.propose(request, current)
        level = round(d.level * SLIDER_STEPS) / SLIDER_STEPS if d.changed else d.level
        changed = abs(level - current) > 1e-9
        if changed:
            self.update({"detail": level})
        result = {"request": request, "ok": d.ok, "level": level, "changed": changed,
                  "reply": d.reply, "error": d.error}
        with self.cond:
            self.droid_last = result
        return result

    def droid_status(self) -> dict:
        """Whether Droid is logged in, for the page (checked at most every 3 s)."""
        with self._login_lock:
            if self._login is None or time.monotonic() - self._login[0] > 3:
                self._login = (time.monotonic(), login_status(self.droid.droid_bin))
            return self._login[1]

    def droid_login(self) -> None:
        """Opens Droid's one-time login in a terminal window (DroidError if there is none)."""
        open_login_window(self.droid.droid_bin)

    def state(self) -> dict:
        with self.cond:
            return {"status": self.status, "error": self.error, "running": self.running,
                    "fps": round(self.fps, 2), "cameras": self.cameras,
                    "config": {"rig": asdict(self.rig), "focus": asdict(self.focus),
                               "detail": self.detail},
                    "effective_focus": asdict(self.effective_focus) if self.effective_focus else None,
                    "report": self.report, "frame_id": self.frame_id, "droid": self.droid_last}

    # -- worker thread ------------------------------------------------------

    def _run(self, left, right, width, height, fps) -> None:
        source = None
        try:
            if self.detector is None:
                self._set_status("loading detector model")
                from .detector import UltralyticsDetector
                self.detector = UltralyticsDetector(self.model_name)
            self._set_status("opening cameras")
            source = open_stereo(left, right, width, height, fps)
            pair = source.read()
            # Use the resolution the cameras actually deliver (they may ignore the request).
            with self.cond:
                (hl, wl), (hr, wr) = pair.left.image.shape[:2], pair.right.image.shape[:2]
                self.rig = replace(self.rig, left=replace(self.rig.left, width_px=wl, height_px=hl),
                                   right=replace(self.rig.right, width_px=wr, height_px=hr))
                self.effective_focus = RigGeometry(self.rig).effective_focus(self.focus)
                algo = DetectObject(self.rig, self.focus, self.detail, detector=self.detector)
                self._pending.clear()
                self.status = "running"
            t_prev = time.perf_counter()
            while True:
                with self.cond:
                    if not self.running:
                        break
                    pending, self._pending = self._pending, {}
                    rig, focus, detail = self.rig, self.focus, self.detail
                if "rig" in pending:
                    algo.set_rig(replace(rig, left=replace(rig.left, width_px=wl, height_px=hl),
                                         right=replace(rig.right, width_px=wr, height_px=hr)))
                if "focus" in pending:
                    algo.set_focus(focus)
                if "detail" in pending:
                    algo.set_detail(detail)
                report = algo.process(pair)
                img = annotate(pair, algo)
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 75])
                now = time.perf_counter()
                inst = 1.0 / max(1e-6, now - t_prev)
                t_prev = now
                with self.cond:
                    self.fps = inst if self.fps == 0 else 0.8 * self.fps + 0.2 * inst
                    if ok:
                        self.jpeg = buf.tobytes()
                    self.report = _report_json(report, algo)
                    self.frame_id += 1
                    self.cond.notify_all()
                pair = source.read()
        except Exception as exc:          # surfaced to the page, never silent
            with self.cond:
                self.error, self.status = f"{type(exc).__name__}: {exc}", "error"
        finally:
            if source is not None:
                source.close()
            with self.cond:
                self.running = False
                if self.status != "error":
                    self.status = "idle"
                self.cond.notify_all()

    def _set_status(self, s: str) -> None:
        with self.cond:
            self.status = s


def _report_json(report, algo) -> dict:
    d = json.loads(json.dumps(report.to_dict(), default=float))
    focus_ids = {o.id for o in algo.last_debug.get("in_focus", [])}
    d["all_objects"] = [
        {"id": o.id, "label": o.label, "seen_by": o.seen_by, "confidence": round(o.confidence, 3),
         "distance_m": None if o.distance_m is None else round(o.distance_m, 3),
         "yaw_deg": round(o.yaw_deg, 1), "pitch_deg": round(o.pitch_deg, 1),
         "in_focus": o.id in focus_ids}
        for o in algo.last_debug.get("fused", [])]
    return d


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    viewer: Viewer = None   # set in main()

    def log_message(self, fmt, *args) -> None:   # keep the terminal quiet
        pass

    def _json(self, obj, code=HTTPStatus.OK) -> None:
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/":
            body = INDEX_HTML.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/cameras":
            self._json({"cameras": describe_cameras(), "platform": sys.platform})
        elif path == "/api/state":
            self._json(self.viewer.state())
        elif path == "/api/report.json":
            self._json(self.viewer.state()["report"] or {})
        elif path == "/api/droid-status":
            self._json(self.viewer.droid_status())
        elif path == "/stream.mjpg":
            self._stream()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        try:
            body = self._body()
            if path == "/api/start":
                self.viewer.start(_src(body["left"]), _src(body["right"]), int(body.get("width", 640)),
                                  int(body.get("height", 480)), int(body.get("fps", 30)))
            elif path == "/api/stop":
                self.viewer.stop()
            elif path == "/api/config":
                self.viewer.update(body)
            elif path == "/api/detail-request":
                result = self.viewer.ask_droid(str(body["request"]))
                self._json({**result, "ok": result["ok"]})
                return
            elif path == "/api/droid-login":
                # Opens a window, so JSON only: another site's page cannot send JSON here unasked.
                if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                    self._json({"ok": False, "error": "send JSON"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
                    return
                self.viewer.droid_login()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            self._json({"ok": True})
        except (ValueError, KeyError, TypeError, DroidError) as exc:
            self._json({"ok": False, "error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def _stream(self) -> None:
        v = self.viewer
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        last = -1
        try:
            while True:
                with v.cond:
                    v.cond.wait_for(lambda: v.frame_id != last or not v.running, timeout=1.0)
                    jpeg, last = v.jpeg, v.frame_id
                    running = v.running
                if jpeg is None:
                    if not running:
                        return
                    continue
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                 + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
                if not running:
                    return
        except (BrokenPipeError, ConnectionResetError):
            return


def _src(v):
    return int(v) if isinstance(v, str) and v.isdigit() else v


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="detect_object.webapp")
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--model", default="yolo11n.pt")
    args = ap.parse_args(argv)
    Handler.viewer = Viewer(args.model)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"detectObject viewer: http://127.0.0.1:{args.port}  (Ctrl+C to quit)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        Handler.viewer.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
