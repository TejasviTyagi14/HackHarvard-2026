"""Droid detail control (detect_object.droid): a fake droid CLI stands in, no network.

The one live test talks to the real Droid; it runs only when FACTORY_API_KEY is set.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import stat
import sys
import textwrap

import pytest

from detect_object import DetailModel, DroidDetail
from detect_object.droid import decide, describe_levels


def _result(text: str, is_error: bool = False) -> str:
    return json.dumps({"type": "result", "is_error": is_error, "result": text, "session_id": "s1",
                       "duration_ms": 900})


@pytest.fixture
def fake_droid(tmp_path, monkeypatch):
    """Returns make(stdout, exit_code=0, sleep=0) -> path of a call log written by the fake."""
    def make(stdout: str, exit_code: int = 0, sleep: float = 0) -> object:
        log = tmp_path / "call.json"
        script = tmp_path / "droid"
        script.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import json, os, sys, time
            json.dump({{"argv": sys.argv[1:], "cwd_files": os.listdir("."), "stdin": sys.stdin.read()}},
                      open({str(log)!r}, "w"))
            time.sleep({sleep})
            sys.stdout.write({stdout!r})
            sys.exit({exit_code})
        """))
        script.chmod(script.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv("DROID_BIN", str(script))
        return log
    return make


def test_droid_sets_the_level(fake_droid):
    fake_droid(_result('{"level": 0.75, "reply": "More detail."}'))
    d = DroidDetail().propose("more detail please", 0.5)
    assert (d.ok, d.level, d.changed, d.reply) == (True, 0.75, True, "More detail.")


def test_droid_runs_read_only_without_tools_in_an_empty_dir(fake_droid):
    log = fake_droid(_result('{"level": null, "reply": ""}'))
    DroidDetail().propose("shorter", 0.5)
    call = json.loads(log.read_text())
    argv = call["argv"]
    assert argv[0] == "exec"
    assert "--auto" not in argv and "--skip-permissions-unsafe" not in argv
    assert argv[argv.index("--only-tools") + 1] == "TodoWrite"
    assert argv[argv.index("--output-format") + 1] == "json"
    assert call["cwd_files"] == []
    assert '"shorter"' in call["stdin"] and "current lambda: 0.5" in call["stdin"]


def test_instructions_follow_the_detail_model():
    text = describe_levels(DetailModel(r_hazard=0.42, r_loc_lo=0.9))
    assert "0.42 and up: hazards" in text
    assert "0.90 to 1.00" in text


@pytest.mark.parametrize("answer, level, changed, ok", [
    ({"level": 1.7}, 1.0, True, True),            # clamped
    ({"level": -3}, 0.0, True, True),
    ({"level": "high"}, 1.0, True, True),         # preset names work
    ({"level": None}, 0.5, False, True),          # not about detail: unchanged
    ({"level": 0.5}, 0.5, False, True),
    ({"level": "loud"}, 0.5, False, False),
    ({"level": True}, 0.5, False, False),
    ({"level": [1]}, 0.5, False, False),
    ({"level": float("nan")}, 0.5, False, False),
])
def test_decide_checks_droids_answer(answer, level, changed, ok):
    d = decide(answer, 0.5)
    assert (d.level, d.changed, d.ok) == (level, changed, ok)


@pytest.mark.parametrize("stdout, exit_code, sleep, why", [
    (_result("Authentication failed.", is_error=True), 0, 0, "Authentication failed"),
    (_result("I would rather not."), 0, 0, "JSON object"),
    ("crash", 1, 0, "exit 1"),
    (_result("{}"), 0, 3, "longer than"),
])
def test_failures_keep_the_level(fake_droid, monkeypatch, stdout, exit_code, sleep, why):
    fake_droid(stdout, exit_code, sleep)
    monkeypatch.setenv("DROID_TIMEOUT", "1")
    d = DroidDetail().propose("more detail", 0.3)
    assert (d.ok, d.level, d.changed) == (False, 0.3, False)
    assert why in d.error


def test_missing_droid_and_bad_requests(monkeypatch):
    monkeypatch.setenv("DROID_BIN", "/nonexistent/droid")
    assert "not installed" in DroidDetail().propose("more", 0.5).error
    assert DroidDetail().propose("   ", 0.5).error == "empty request"
    assert "longer than" in DroidDetail().propose("x" * 501, 0.5).error


def test_viewer_applies_droids_level(fake_droid):
    pytest.importorskip("cv2")
    from detect_object.webapp import Viewer
    fake_droid(_result('{"level": 0.9, "reply": "I will tell you where things are."}'))
    v = Viewer("yolo11n.pt")
    r = v.ask_droid("where is everything?")
    assert r["ok"] and r["changed"] and v.detail == 0.9
    assert v.state()["droid"]["reply"] == "I will tell you where things are."
    assert v._pending == {"detail": True}       # the worker applies it before the next frame pair


def test_viewer_keeps_the_level_on_failure(fake_droid):
    pytest.importorskip("cv2")
    from detect_object.webapp import Viewer
    fake_droid("crash", exit_code=1)
    v = Viewer("yolo11n.pt")
    r = v.ask_droid("more")
    assert not r["ok"] and v.detail == 0.5 and v._pending == {}


def test_cli_applies_droid_levels_between_frames(fake_droid, monkeypatch):
    from detect_object.__main__ import _DroidInput, _pairs_and_reports
    fake_droid(_result('{"level": 0.2, "reply": "Keeping it short."}'))
    monkeypatch.setattr(sys, "stdin", io.StringIO("keep it short\n"))
    droid = _DroidInput(0.5)
    for _ in range(100):                       # the reader thread asks Droid in the background
        if droid._new is not None:
            break
        import time
        time.sleep(0.05)

    class Algo:
        detail = 0.5
        def set_detail(self, v): self.detail = v
        def process(self, pair): return self.detail

    algo = Algo()
    levels = [r for _, r in _pairs_and_reports(["frame1", "frame2"], algo, droid)]
    assert levels == [0.2, 0.2]


@pytest.mark.skipif(not os.environ.get("FACTORY_API_KEY") or not shutil.which("droid"),
                    reason="needs FACTORY_API_KEY and the droid CLI")
def test_live_droid_lowers_detail_for_a_brief_request(monkeypatch):
    monkeypatch.delenv("DROID_BIN", raising=False)
    d = DroidDetail().propose("just the basics, keep it short", 0.75)
    assert d.ok, d.error
    assert d.level < 0.75
