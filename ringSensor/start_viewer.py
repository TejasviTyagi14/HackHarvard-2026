"""One-step launcher: starts the detectObject server and opens the viewer in the browser.

    .venv/bin/python start_viewer.py          (Linux / macOS)

Works from any directory; uses the project's .venv if this was started with
another Python.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("DETECT_PORT", "8765"))
URL = f"http://127.0.0.1:{PORT}"


def _venv_python() -> Path | None:
    for rel in ("bin/python", "Scripts/python.exe"):
        p = ROOT / ".venv" / rel
        if p.exists():
            return p
    return None


def _server_up() -> bool:
    try:
        with urllib.request.urlopen(URL + "/api/state", timeout=1):
            return True
    except OSError:
        return False


def _open_when_ready() -> None:
    for _ in range(60):
        if _server_up():
            webbrowser.open(URL)
            return
        time.sleep(0.5)
    print(f"Server did not come up; open {URL} manually.", file=sys.stderr)


def main() -> int:
    if _server_up():
        print(f"Viewer already running at {URL}; opening it.")
        webbrowser.open(URL)
        return 0
    venv = _venv_python()
    if venv is not None and Path(sys.prefix).resolve() != (ROOT / ".venv").resolve():
        os.execv(str(venv), [str(venv), str(Path(__file__).resolve()), *sys.argv[1:]])
    sys.path.insert(0, str(ROOT))
    from detect_object.webapp import main as serve
    threading.Thread(target=_open_when_ready, daemon=True).start()
    return serve(["--port", str(PORT), *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
