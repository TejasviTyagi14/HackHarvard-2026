"""detectObject: find which objects are in a focus region seen by two webcams.

    from detect_object import DetectObject, StereoRig, FocusRegion, open_stereo

    algo = DetectObject(StereoRig(baseline_m=0.12), FocusRegion(), detail=0.5)
    with open_stereo(0, 2) as cams:
        for report in algo.run(cams):
            print(report.summary)
"""
from .detail import PRESETS, DetailModel, parse_level
from .droid import DetailDecision, DroidDetail
from .pipeline import DetectObject
from .types import (CameraIntrinsics, DetectionReport, Fact, FocusRegion, Frame, FramePair,
                    ProcessingPlan, SceneObject, StereoRig)


def open_stereo(*args, **kwargs):
    """See detect_object.capture.open_stereo (imported lazily: needs OpenCV)."""
    from .capture import open_stereo as _open
    return _open(*args, **kwargs)


__all__ = ["DetectObject", "StereoRig", "CameraIntrinsics", "FocusRegion", "DetailModel",
           "PRESETS", "parse_level", "DetectionReport", "Fact", "Frame", "FramePair",
           "ProcessingPlan", "SceneObject", "open_stereo", "DroidDetail", "DetailDecision"]
