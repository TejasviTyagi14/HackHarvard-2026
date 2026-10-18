"""Isolation tests for every detectObject box (no webcams, no network)."""
from __future__ import annotations

import math
import random

import numpy as np
import pytest

from detect_object import DetailModel, DetectObject, FocusRegion, StereoRig, parse_level
from detect_object.config import default_config, load_config, rig_from_dict
from detect_object.detector import StaticDetector
from detect_object.fusion import StereoFusion
from detect_object.geometry import RigGeometry
from detect_object.scene import RuleSceneClassifier, analyze_lighting, count_phrase
from detect_object.sim import SimObject, conference_room, render
from detect_object.types import CameraIntrinsics, Fact, Frame, FramePair

RIGS = [StereoRig(baseline_m=0.12),
        StereoRig(baseline_m=0.20, convergence_deg=10.0, pitch_deg=5.0),
        StereoRig(baseline_m=0.08, convergence_deg=-6.0)]


# -- S3 rig geometry ---------------------------------------------------------

@pytest.mark.parametrize("rig", RIGS)
def test_triangulation_recovers_points(rig):
    g = RigGeometry(rig)
    rng = np.random.default_rng(0)
    for _ in range(50):
        p = np.array([rng.uniform(-1, 1), rng.uniform(-0.5, 0.5), rng.uniform(1, 8)])
        ul, ur = g.left.project(p), g.right.project(p)
        if ul is None or ur is None:
            continue
        point, miss = g.triangulate(ul, ur)
        assert miss < 1e-6
        assert np.linalg.norm(point - p) < 1e-6


def test_overlap_parallel_rig():
    rig = StereoRig(baseline_m=0.1, left=CameraIntrinsics(hfov_deg=60), right=CameraIntrinsics(hfov_deg=60))
    g = RigGeometry(rig)
    y0, y1, p0, p1 = g.overlap_bearings()
    assert (y0, y1) == pytest.approx((-30, 30))
    assert g.overlap_start_m() == pytest.approx(0.1 / (2 * math.tan(math.radians(30))))


def test_effective_focus_is_clipped_and_rejects_empty():
    g = RigGeometry(StereoRig(convergence_deg=-40.0))      # splayed: overlap only ±15°
    eff = g.effective_focus(FocusRegion())
    assert eff.yaw_min_deg == pytest.approx(-15) and eff.yaw_max_deg == pytest.approx(15)
    with pytest.raises(ValueError):
        g.effective_focus(FocusRegion(yaw_min_deg=20, yaw_max_deg=30))


# -- S5 stereo fusion ----------------------------------------------------------

@pytest.mark.parametrize("rig", RIGS)
def test_fusion_matches_and_ranges(rig):
    objs = [SimObject("chair", (-0.6, 0.3, 2.0), (0.45, 0.9, 0.45)),
            SimObject("chair", (0.5, 0.3, 3.5), (0.45, 0.9, 0.45)),
            SimObject("tv", (0.0, -0.5, 5.0), (1.2, 0.7, 0.05))]
    pair, dl, dr = render(rig, objs)
    fused = StereoFusion(RigGeometry(rig)).fuse(dl, dr, (640 * 480, 640 * 480))
    stereo = sorted((o for o in fused if o.seen_by == "both"), key=lambda o: o.distance_m)
    assert len(stereo) == 3 and len(fused) == 3
    g = RigGeometry(rig)
    for o, truth in zip(stereo, sorted(objs, key=lambda o: np.linalg.norm(o.center_m))):
        assert o.label == truth.label
        # Box centres are silhouette centres, not 3D centres: allow ~1 px of disparity error.
        z = float(np.linalg.norm(truth.center_m))
        assert abs(o.distance_m - z) <= max(0.06 * z, g.depth_resolution_m(z, 1.0))


def test_assignment_prefers_consistent_matches():
    from detect_object.fusion import _assign
    cost = np.array([[0.0, np.inf], [0.0, 0.0]])   # greedy could pick (1,0) and strand row 0
    assert sorted(_assign(cost, 2.0)) == [(0, 0), (1, 1)]
    rng = np.random.default_rng(3)
    for _ in range(50):                              # brute-force check on small matrices
        import itertools
        c = rng.uniform(0, 3, (3, 4))
        c[rng.random((3, 4)) < 0.3] = np.inf
        got = _assign(c, 2.0)
        def total(pairs):
            return sum(c[i, j] for i, j in pairs) + 2.0 * (7 - 2 * len(pairs))
        best = min(total(p) for k in range(4) for rows in itertools.combinations(range(3), k)
                   for cols in itertools.permutations(range(4), k)
                   for p in [list(zip(rows, cols))] if all(np.isfinite(c[i, j]) for i, j in p))
        assert total(got) == pytest.approx(best)


def test_fusion_keeps_monocular_objects():
    rig = StereoRig()
    pair, dl, dr = render(rig, [SimObject("cup", (0.0, 0.0, 2.0), (0.1, 0.1, 0.1))])
    fused = StereoFusion(RigGeometry(rig)).fuse(dl, [], (640 * 480, 640 * 480))
    assert len(fused) == 1 and fused[0].seen_by == "left" and fused[0].distance_m is None


# -- S8 detail model -------------------------------------------------------------

def _random_facts(rng, n=60):
    kinds = ["count", "hazard", "attribute", "location"]
    return [Fact("scene", "scene", "x", None, "x", 0.0, 1.0, 0.1)] + [
        Fact(rng.choice(kinds), f"s{i}", i, None, f"f{i}", rng.random(), rng.random(), rng.random())
        for i in range(n)]


def test_detail_selection_is_nested():
    m = DetailModel()
    rng = random.Random(1)
    for _ in range(200):
        facts = _random_facts(rng)
        a, b = sorted((rng.random(), rng.random()))
        da, db = m.select(facts, a), m.select(facts, b)
        assert db[: len(da)] == da                       # D(a) is a prefix of D(b)
        assert all(f.rank <= a + 1e-9 for f in da)
        assert len(da) <= m.max_facts(a)


def test_detail_lowest_level_is_scene_only():
    facts = _random_facts(random.Random(2))
    assert [f.kind for f in DetailModel().select(facts, 0.0)] == ["scene"]


def test_plan_is_monotone():
    m = DetailModel()
    plans = [m.plan(x / 20) for x in range(21)]
    for p, q in zip(plans, plans[1:]):
        assert q.imgsz >= p.imgsz
        assert q.run_hazards >= p.run_hazards and q.run_lighting >= p.run_lighting
        assert q.run_locations >= p.run_locations
    assert plans[0].imgsz == 320 and plans[-1].imgsz == 960


def test_parse_level():
    assert parse_level("low") == 0.0 and parse_level("HIGH") == 1.0 and parse_level("0.3") == 0.3
    for bad in (-0.1, 1.5, "huge", float("nan")):
        with pytest.raises(ValueError):
            parse_level(bad)


# -- S7 scene analyzers -----------------------------------------------------------

def test_scene_classifier():
    clf = RuleSceneClassifier()
    assert clf({"chair": 40, "dining table": 2, "tv": 1})[0] == "conference room"
    assert clf({"bed": 1, "clock": 1})[0] == "bedroom"
    assert clf({"refrigerator": 1, "oven": 1, "bowl": 2})[0] == "kitchen"
    assert clf({}) == ("unidentified scene", 0.0)


def _flat_pair(bgr):
    img = np.full((120, 160, 3), bgr, np.uint8)
    return FramePair(Frame("left", 0, 0, img), Frame("right", 0, 0, img))


def test_lighting():
    assert analyze_lighting(_flat_pair((255, 235, 225))).source == "daylight-like"   # bluish white
    assert analyze_lighting(_flat_pair((120, 180, 255))).source == "warm artificial"  # orange
    assert analyze_lighting(_flat_pair((5, 5, 5))).level == "dark"


def test_count_phrase():
    assert count_phrase(60, "chair") == "60 seats"
    assert count_phrase(1, "tv") == "one screen"
    assert count_phrase(2, "bench") == "two benches"


# -- S1 top level: whole pipeline on the simulator -----------------------------------

def _run(detail, rig, objs, frames=3):
    pair, dl, dr = render(rig, objs)
    algo = DetectObject(rig, FocusRegion(), detail, detector=StaticDetector(dl, dr))
    for _ in range(frames):
        report = algo.process(pair)
    return report, algo


def test_pipeline_levels_on_conference_room():
    rig = StereoRig(height_m=1.2, left=CameraIntrinsics(hfov_deg=90), right=CameraIntrinsics(hfov_deg=90))
    objs = conference_room()
    low, _ = _run("low", rig, objs)
    mid, _ = _run("medium", rig, objs)
    high, algo = _run("high", rig, objs)

    assert low.scene == "conference room"
    assert [f.kind for f in low.facts] == ["scene"] and low.objects == ()
    assert {f.kind for f in mid.facts} == {"scene", "count"}
    assert any(f.subject == "seat" and f.value >= 30 for f in mid.facts)
    kinds = {f.kind for f in high.facts}
    assert {"scene", "count", "hazard", "attribute", "location"} <= kinds
    assert any(f.kind == "hazard" and f.subject == "backpack" for f in high.facts)
    # Nesting holds end to end on the same input.
    assert list(mid.facts[: len(low.facts)]) == list(low.facts)
    assert algo.detector.calls[-1] == 960
    assert high.to_dict()["plan"]["imgsz"] == 960


def test_focus_region_filters_objects():
    rig = StereoRig()
    objs = [SimObject("cup", (-1.2, 0.0, 2.0), (0.1, 0.1, 0.1)),     # ~31° left
            SimObject("cup", (0.0, 0.0, 2.0), (0.1, 0.1, 0.1))]       # ahead
    narrow = FocusRegion(yaw_min_deg=-10, yaw_max_deg=10)
    pair, dl, dr = render(rig, objs)
    algo = DetectObject(rig, narrow, "high", detector=StaticDetector(dl, dr))
    report = algo.process(pair)
    assert [o.label for o in report.objects] == ["cup"]
    assert abs(report.objects[0].yaw_deg) < 1


def test_size_mismatch_warns():
    rig = StereoRig(left=CameraIntrinsics(1280, 720), right=CameraIntrinsics(1280, 720))
    pair, dl, dr = render(StereoRig(), [])
    report = DetectObject(rig, FocusRegion(), 0.5, detector=StaticDetector([], [])).process(pair)
    assert any("geometry will be wrong" in w for w in report.warnings)


# -- configuration and capture ------------------------------------------------------

def test_config_round_trip(tmp_path):
    import json
    cfg = default_config()
    cfg["rig"]["left"]["K"] = [[600, 0, 320], [0, 600, 240], [0, 0, 1]]
    p = tmp_path / "rig.json"
    p.write_text(json.dumps(cfg))
    loaded = load_config(p)
    assert loaded["rig"].left.matrix()[0, 0] == 600
    with pytest.raises(ValueError):
        rig_from_dict({"baseline": 0.1})


def test_file_streams_pair(tmp_path):
    cv2 = pytest.importorskip("cv2")
    from detect_object.capture import open_stereo
    paths = []
    for side in ("left", "right"):
        path = str(tmp_path / f"{side}.avi")
        vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), 10, (160, 120))
        for i in range(5):
            vw.write(np.full((120, 160, 3), i * 40, np.uint8))
        vw.release()
        paths.append(path)
    with open_stereo(*paths) as src:
        pairs = list(src)
    assert len(pairs) == 5 and all(p.skew_ms < 1 for p in pairs)
