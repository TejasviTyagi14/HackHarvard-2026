"""Stereo capture from two USB webcams (or two video files), Linux and macOS.

Platform notes
--------------
- Linux uses V4L2. Sources may be indices (0, 2, ...) or paths ("/dev/video2").
  Two USB webcams on one bus usually need MJPG to fit the USB bandwidth, so
  MJPG is requested by default.
- macOS uses AVFoundation. Sources must be indices; the order is the one
  macOS reports (``python -m detect_object --list``). The terminal app needs
  camera permission (System Settings > Privacy & Security > Camera).
- Capture devices are opened on the calling (main) thread and read on a
  background thread; no GUI calls happen off the main thread (macOS forbids it).
"""
from __future__ import annotations

import os
import re
import sys
import threading
import time

import cv2

from .types import CameraSide, Frame, FramePair


def default_api() -> int:
    if sys.platform.startswith("linux"):
        return cv2.CAP_V4L2
    if sys.platform == "darwin":
        return cv2.CAP_AVFOUNDATION
    if sys.platform.startswith("win"):
        return cv2.CAP_DSHOW
    return cv2.CAP_ANY


def _is_file(source: int | str) -> bool:
    return isinstance(source, str) and not source.startswith("/dev/") and os.path.isfile(source)


def _as_source(source: int | str) -> int | str:
    """Camera index for OpenCV. Device paths (also /dev/v4l/by-id links) become their
    index, because OpenCV's V4L2 backend can only open cameras by number."""
    if isinstance(source, str) and source.isdigit():
        return int(source)
    if isinstance(source, str) and source.startswith("/dev/"):
        m = re.fullmatch(r"/dev/video(\d+)", os.path.realpath(source))
        if m:
            return int(m.group(1))
    return source


def _device_users(dev: str) -> list[str]:
    """Names of other processes holding ``dev`` open (Linux /proc scan; [] elsewhere)."""
    try:
        target = os.path.realpath(dev)
        names = set()
        for pid in os.listdir("/proc"):
            if not pid.isdigit() or int(pid) == os.getpid():
                continue
            fd_dir = f"/proc/{pid}/fd"
            try:
                if any(os.path.realpath(os.path.join(fd_dir, fd)) == target for fd in os.listdir(fd_dir)):
                    with open(f"/proc/{pid}/comm") as f:
                        names.add(f"{f.read().strip()} (pid {pid})")
            except OSError:
                continue
        return sorted(names)
    except OSError:
        return []


def list_cameras(max_index: int = 10) -> list[tuple[int, int, int]]:
    """(index, width, height) of every camera index that opens and delivers a frame."""
    found = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i, default_api())
        if cap.isOpened():
            ok, img = cap.read()
            if ok and img is not None:
                found.append((i, img.shape[1], img.shape[0]))
        cap.release()
    return found


class CameraStream:
    """Continuously grabs frames on a thread; consumers get the latest one."""

    def __init__(self, side: CameraSide, source: int | str, width: int = 640, height: int = 480,
                 fps: int = 30, mjpg: bool = True):
        self.side = side
        self.source = _as_source(source)
        self._cap = cv2.VideoCapture(self.source, default_api())
        if not self._cap.isOpened():
            hint = ""
            if sys.platform == "darwin":
                hint = " On macOS, grant camera access to your terminal app and use an index."
            elif isinstance(self.source, int):
                users = _device_users(f"/dev/video{self.source}")
                if users:
                    hint = (f" It is in use by: {', '.join(users)}. Close the camera there "
                            "(a browser tab, video call or camera app) and start again.")
            raise RuntimeError(f"cannot open {side} camera {source!r}.{hint}")
        if mjpg:
            self._cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self._cap.set(cv2.CAP_PROP_FPS, fps)
        self._cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self._cond = threading.Condition()
        self._latest: Frame | None = None
        self._error: str | None = None
        self._running = True
        self._thread = threading.Thread(target=self._loop, name=f"cam-{side}", daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        seq = 0
        failures = 0
        while self._running:
            ok, img = self._cap.read()
            t = time.monotonic_ns()
            if not ok or img is None:
                failures += 1
                if failures >= 30:
                    with self._cond:
                        self._error = f"{self.side} camera stopped delivering frames"
                        self._cond.notify_all()
                    return
                time.sleep(0.01)
                continue
            failures = 0
            with self._cond:
                self._latest = Frame(self.side, seq, t, img)
                self._cond.notify_all()
            seq += 1

    def wait_newer(self, after_seq: int, timeout: float) -> Frame:
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._latest is None or self._latest.seq <= after_seq:
                if self._error:
                    raise RuntimeError(self._error)
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"no new frame from {self.side} camera in {timeout:.1f} s")
                self._cond.wait(left)
            return self._latest

    def close(self) -> None:
        self._running = False
        self._thread.join(timeout=1.0)
        self._cap.release()


class FileStream:
    """Reads a video file frame by frame on demand; timestamps follow the file clock."""

    def __init__(self, side: CameraSide, path: str):
        self.side = side
        self._cap = cv2.VideoCapture(path)
        if not self._cap.isOpened():
            raise RuntimeError(f"cannot open video file {path!r}")
        self._seq = -1

    def wait_newer(self, after_seq: int, timeout: float) -> Frame:
        while self._seq <= after_seq:
            ok, img = self._cap.read()
            if not ok:
                raise EOFError(f"{self.side} video ended")
            self._seq += 1
        t_ns = int(self._cap.get(cv2.CAP_PROP_POS_MSEC) * 1e6)
        return Frame(self.side, self._seq, t_ns, img)

    def close(self) -> None:
        self._cap.release()


class StereoSource:
    """Pairs the newest frames of two streams, waiting for the laggard if skew is too large."""

    def __init__(self, left, right, max_skew_ms: float = 40.0, timeout_s: float = 2.0):
        self.left, self.right = left, right
        self.max_skew_ms, self.timeout_s = max_skew_ms, timeout_s
        self._last = {"left": -1, "right": -1}

    def read(self) -> FramePair:
        fl = self.left.wait_newer(self._last["left"], self.timeout_s)
        fr = self.right.wait_newer(self._last["right"], self.timeout_s)
        if abs(fl.t_ns - fr.t_ns) / 1e6 > self.max_skew_ms:
            if fl.t_ns < fr.t_ns:
                fl = self.left.wait_newer(fl.seq, self.timeout_s)
            else:
                fr = self.right.wait_newer(fr.seq, self.timeout_s)
        self._last = {"left": fl.seq, "right": fr.seq}
        return FramePair(fl, fr)

    def __iter__(self):
        while True:
            try:
                yield self.read()
            except EOFError:
                return

    def close(self) -> None:
        self.left.close()
        self.right.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def open_stereo(left: int | str, right: int | str, width: int = 640, height: int = 480,
                fps: int = 30, max_skew_ms: float = 40.0) -> StereoSource:
    def make(side: CameraSide, src):
        return FileStream(side, src) if _is_file(src) else CameraStream(side, src, width, height, fps)
    ls = make("left", left)
    try:
        rs = make("right", right)
    except Exception:
        ls.close()
        raise
    return StereoSource(ls, rs, max_skew_ms)
