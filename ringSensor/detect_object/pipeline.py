"""detectObject: stereo frames + rig + focus region + detail level -> DetectionReport."""
from __future__ import annotations

import time
from typing import Iterator

from .describe import TemporalSmoother, build_facts, summarize
from .detail import DetailModel, parse_level
from .detector import Detector, UltralyticsDetector
from .fusion import FusionParams, StereoFusion
from .geometry import RigGeometry
from .scene import RuleSceneClassifier, SceneClassifier, analyze_lighting, find_hazards, label_counts
from .types import DetectionReport, FocusRegion, FramePair, StereoRig


class DetectObject:
    """The detectObject black box.

    Inputs:  a stream of FramePair (``process`` / ``run``) plus three
             configuration ports: rig geometry, focus region, detail level.
    Output:  one DetectionReport per processed frame pair.

    Configuration changes (``set_*``) apply from the next frame pair on.
    Changing the rig or the focus region resets temporal smoothing.
    """

    def __init__(self, rig: StereoRig = StereoRig(), focus: FocusRegion = FocusRegion(),
                 detail: float | str = "medium", detector: Detector | None = None,
                 scene_classifier: SceneClassifier | None = None,
                 model: DetailModel = DetailModel(), fusion: FusionParams = FusionParams(),
                 smoothing_window: int = 5, max_skew_ms: float = 40.0):
        self.model = model
        self.fusion_params = fusion
        self.detector = detector if detector is not None else UltralyticsDetector()
        self.classify = scene_classifier or RuleSceneClassifier()
        self.smoother = TemporalSmoother(smoothing_window)
        self.max_skew_ms = max_skew_ms
        self.last_debug: dict = {}
        self.detail = parse_level(detail)
        self._focus_requested = focus
        self.set_rig(rig)

    # -- configuration ports --------------------------------------------------

    def set_rig(self, rig: StereoRig) -> None:
        self.rig = rig
        self.geometry = RigGeometry(rig)
        self.fusion = StereoFusion(self.geometry, self.fusion_params)
        self.set_focus(self._focus_requested)

    def set_focus(self, focus: FocusRegion) -> None:
        self._focus_requested = focus
        self.focus = self.geometry.effective_focus(focus)
        self.smoother.reset()

    def set_detail(self, detail: float | str) -> None:
        self.detail = parse_level(detail)

    # -- processing ---------------------------------------------------------

    def process(self, pair: FramePair) -> DetectionReport:
        t0 = time.perf_counter()
        warnings = []
        plan = self.model.plan(self.detail)
        for f, cam in ((pair.left, self.rig.left), (pair.right, self.rig.right)):
            h, w = f.image.shape[:2]
            if (w, h) != (cam.width_px, cam.height_px):
                warnings.append(f"{f.camera} frame is {w}x{h}, rig says "
                                f"{cam.width_px}x{cam.height_px}; geometry will be wrong")
        if pair.skew_ms > self.max_skew_ms:
            warnings.append(f"camera skew {pair.skew_ms:.0f} ms > {self.max_skew_ms:.0f} ms; "
                            "moving objects may not match")

        dets_l, dets_r = self.detector([pair.left.image, pair.right.image], plan.imgsz)
        area = (float(pair.left.image.shape[0] * pair.left.image.shape[1]),
                float(pair.right.image.shape[0] * pair.right.image.shape[1]))
        fused = self.fusion.fuse(dets_l, dets_r, area)
        objects = [o for o in fused
                   if self.focus.contains(o.yaw_deg, o.pitch_deg, o.distance_m)
                   and (o.seen_by == "both" or not self.focus.require_stereo)]

        counts, scene = self.smoother.update(label_counts(objects), self.classify(label_counts(objects)))
        lighting = analyze_lighting(pair) if plan.run_lighting else None
        hazards = (find_hazards(objects, self.geometry, pair.left.image.shape[0])
                   if plan.run_hazards else [])
        candidates = build_facts(scene, counts, objects, lighting, hazards, self.model,
                                 plan.run_locations)
        facts = self.model.select(candidates, self.detail)
        if scene[1] < 0.3:
            warnings.append("low scene confidence")

        shown = {i for f in facts for i in f.object_ids}
        # Telemetry for debugging tools (e.g. the web viewer); not part of the report contract.
        self.last_debug = {"fused": fused, "in_focus": objects,
                           "hazard_ids": {h.object_id for h in hazards}}
        return DetectionReport(
            t_ns=pair.t_ns, detail=self.detail, scene=scene[0], scene_confidence=scene[1],
            facts=tuple(facts), objects=tuple(o for o in objects if o.id in shown),
            summary=summarize(facts), plan=plan,
            latency_ms=(time.perf_counter() - t0) * 1e3, skew_ms=pair.skew_ms,
            warnings=tuple(warnings))

    def run(self, source) -> Iterator[DetectionReport]:
        """Process a StereoSource (or any iterable of FramePair) until it ends."""
        for pair in source:
            yield self.process(pair)
