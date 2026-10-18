"""One-step launcher: starts the detectObject server and opens the viewer in the browser.

    .venv/bin/python start_viewer.py          (Linux / macOS)

Works from any directory; uses the project's .venv if this was started with
another Python.
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("DETECT_PORT", "8770"))
URL = f"http://127.0.0.1:{PORT}"


def _port_taken(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _pick_port() -> bool:
    """Points PORT/URL at our running viewer (returns True) or at a free port (returns False).

    Another program may hold the default port; then the next free one is used.
    """
    global PORT, URL
    first = PORT
    for p in range(first, first + 50):
        PORT, URL = p, f"http://127.0.0.1:{p}"
        if _server_up():
            return True
        if not _port_taken(p):
            if p != first:
                print(f"Port {first} is used by another program; using {p} instead.")
            return False
    raise SystemExit(f"Ports {first}-{first + 49} are all in use; set DETECT_PORT to a free one.")


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
    venv = _venv_python()
    if venv is not None and Path(sys.prefix).resolve() != (ROOT / ".venv").resolve():
        os.execv(str(venv), [str(venv), str(Path(__file__).resolve()), *sys.argv[1:]])
    if _pick_port():
        print(f"Viewer already running at {URL}; opening it.")
        webbrowser.open(URL)
        return 0
    sys.path.insert(0, str(ROOT))
    from detect_object.webapp import main as serve
    threading.Thread(target=_open_when_ready, daemon=True).start()
    return serve(["--port", str(PORT), *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
