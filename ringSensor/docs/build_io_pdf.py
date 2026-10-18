"""Build docs/detectObject_IO.pdf (inputs, outputs, focus region, detail model).

    .venv/bin/python docs/build_io_pdf.py
"""
from __future__ import annotations

import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (KeepTogether, Paragraph, Preformatted, SimpleDocTemplate, Spacer,
                                Table, TableStyle)

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from detect_object import CameraIntrinsics, DetectObject, FocusRegion, StereoRig  # noqa: E402
from detect_object.detector import StaticDetector  # noqa: E402
from detect_object.geometry import RigGeometry  # noqa: E402
from detect_object.sim import conference_room, render  # noqa: E402

# Fonts with the glyphs we need (λ, ≤, θ, ², ∈ ...). DejaVu ships with most Linux
# distributions; on macOS point FONT_DIR at any DejaVu copy, or Helvetica is used.
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
BODY, BOLD, MONO = "Helvetica", "Helvetica-Bold", "Courier"
if (FONT_DIR / "DejaVuSans.ttf").exists():
    pdfmetrics.registerFont(TTFont("DV", str(FONT_DIR / "DejaVuSans.ttf")))
    pdfmetrics.registerFont(TTFont("DVB", str(FONT_DIR / "DejaVuSans-Bold.ttf")))
    pdfmetrics.registerFont(TTFont("DVM", str(FONT_DIR / "DejaVuSansMono.ttf")))
    pdfmetrics.registerFontFamily("DV", normal="DV", bold="DVB", italic="DV", boldItalic="DVB")
    BODY, BOLD, MONO = "DV", "DVB", "DVM"

INK = colors.HexColor("#1d2330")
ACCENT = colors.HexColor("#2f5d8a")
RULE = colors.HexColor("#c9d2dc")
TINT = colors.HexColor("#eef2f6")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("h1", fontName=BOLD, fontSize=17, leading=21, textColor=INK, spaceAfter=4)
SUB = ParagraphStyle("sub", fontName=BODY, fontSize=9.5, leading=13, textColor=colors.HexColor("#56606e"),
                     spaceAfter=8)
H2 = ParagraphStyle("h2", fontName=BOLD, fontSize=12.5, leading=16, textColor=ACCENT, spaceBefore=10,
                    spaceAfter=4)
H3 = ParagraphStyle("h3", fontName=BOLD, fontSize=10, leading=13, textColor=INK, spaceBefore=6, spaceAfter=2)
P = ParagraphStyle("p", fontName=BODY, fontSize=9, leading=12.6, textColor=INK, alignment=TA_LEFT,
                   spaceAfter=5)
CELL = ParagraphStyle("cell", parent=P, fontSize=7.9, leading=10.2, spaceAfter=0)
CELLB = ParagraphStyle("cellb", parent=CELL, fontName=BOLD)
CODE = ParagraphStyle("code", fontName=MONO, fontSize=7.6, leading=9.6, textColor=INK,
                      backColor=TINT, borderPadding=5, spaceBefore=3, spaceAfter=7)
EQ = ParagraphStyle("eq", parent=P, fontName=MONO, fontSize=8.4, leading=12, leftIndent=10,
                    backColor=TINT, borderPadding=5, spaceBefore=2, spaceAfter=8)


def table(rows, widths, header=True):
    data = [[Paragraph(str(c), CELLB if (header and i == 0) else CELL) for c in r]
            for i, r in enumerate(rows)]
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1 if header else 0)
    style = [("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
             ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
             ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4)]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), TINT), ("LINEBELOW", (0, 0), (-1, 0), 0.8, ACCENT)]
    t.setStyle(TableStyle(style))
    return t


def example_levels():
    rig = StereoRig(height_m=1.2, left=CameraIntrinsics(hfov_deg=90), right=CameraIntrinsics(hfov_deg=90))
    pair, dl, dr = render(rig, conference_room(), t_ns=0)
    rows = [["λ", "facts", "imgsz", "summary (simulated room: 60 seats, 36 of them inside the focus cone)"]]
    for lam in (0.0, 0.25, 0.5, 0.75, 1.0):
        r = DetectObject(rig, FocusRegion(), lam, detector=StaticDetector(dl, dr)).process(pair)
        rows.append([f"{lam:.2f}", str(len(r.facts)), str(r.plan.imgsz), r.summary])
    return rows


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(BODY, 7.5)
    canvas.setFillColor(colors.HexColor("#7a8490"))
    canvas.drawString(18 * mm, 10 * mm, "detectObject — inputs and outputs")
    canvas.drawRightString(A4[0] - 18 * mm, 10 * mm, f"{doc.page}")
    canvas.restoreState()


def build(out: Path) -> None:
    g = RigGeometry(StereoRig())
    y0, y1, p0, p1 = g.overlap_bearings()
    dz = {z: g.depth_resolution_m(z) for z in (1, 3, 5, 10)}
    s = []

    s += [Paragraph("detectObject: inputs and outputs", H1),
          Paragraph("Two USB webcams, one laptop. What goes in, what comes out, and why each was chosen. "
                    "Companion to DETECT_OBJECT_DESIGN.md (black-box specification) and the code in "
                    "detect_object/.", SUB)]

    s += [Paragraph("1. The box in one paragraph", H2),
          Paragraph("detectObject receives a continuous stream of frames from two webcams mounted a known "
                    "distance apart. For every pair of frames taken at nearly the same moment, it detects "
                    "objects in each image, matches the two views into physical objects (so one chair "
                    "seen by both cameras counts once and gets a distance), keeps only the objects inside "
                    "a <b>focus region</b>, and then produces a ranked list of <b>facts</b> about that region. "
                    "A single number, the <b>detail level λ ∈ [0, 1]</b>, decides how many of those facts "
                    "are computed and reported. The output is one <font face='%s'>DetectionReport</font> per "
                    "frame pair, which is both human-readable (a summary sentence) and machine-readable "
                    "(typed facts with rank, salience and confidence)." % MONO, P),
          table([["Stage", "Box", "Does", "Code"],
                 ["Capture", "S1.1", "Pairs the newest left/right frames; skew ≤ 40 ms", "capture.py"],
                 ["Geometry", "S1.2", "Camera poses, pixel rays, stereo overlap, effective focus region", "geometry.py"],
                 ["Detector", "S1.3", "YOLO11n boxes in both images (OTS)", "detector.py"],
                 ["Fusion", "S1.4", "Min-cost matching across cameras, triangulation", "fusion.py"],
                 ["Focus filter", "S1.5", "Keeps objects inside the focus region", "pipeline.py"],
                 ["Detail planner", "S1.6", "λ → what to compute (resolution, analyzers)", "detail.py"],
                 ["Scene, lighting, hazards", "S1.7–S1.9", "Scene name, smoothed counts, light, trip hazards", "scene.py, describe.py"],
                 ["Facts + selector", "S1.10", "Ranks candidate facts, selects by λ, writes the report", "describe.py, detail.py"]],
                [32, 20, 90, 32])]

    s += [Paragraph("2. Inputs", H2),
          Paragraph("There are four inputs. Only the first is a stream; the other three are configuration "
                    "that changes rarely, so they are separate ports (rule R3 of the black-box format: "
                    "configuration arrives on declared wires). The detector model is a fifth, install-time "
                    "choice.", P),
          table([["Input", "Type and units", "Default", "Why this input"],
                 ["<b>Camera streams</b> (left, right)",
                  "BGR uint8 frames, 640×480 @ 30 fps each, MJPEG over USB 2.0; monotonic ns timestamps",
                  "devices 0 and 2 (Linux) / indices from --list (macOS)",
                  "Two viewpoints are what make distance measurable: a single camera gives bearing only. "
                  "640×480 MJPEG is the largest format two webcams can reliably share on one USB 2.0 bus, "
                  "and it is more than the detector needs at λ ≤ 0.5."],
                 ["<b>Rig</b>: baseline_m", "metres, > 0", "0.12",
                  "Sets the stereo depth resolution: δZ ≈ Z²·δθ / b. Doubling b halves the distance error."],
                 ["<b>Rig</b>: convergence_deg", "degrees, (−90, 90); + = toed in", "0",
                  "The angle between the cameras moves and shrinks the overlap region and bends every ray. "
                  "Without it, triangulation is biased at every distance."],
                 ["<b>Rig</b>: pitch_deg", "degrees; + = looking down", "0",
                  "Converts image rows into true elevation, so the vertical focus window and the floor plane are right."],
                 ["<b>Rig</b>: height_m", "metres above the floor, or None", "None",
                  "Optional. Gives a floor plane, which turns 'is this a trip hazard?' into geometry "
                  "(object ≤ 0.45 m tall, ≤ 4 m away) instead of a guess from image position."],
                 ["<b>Rig</b>: per camera width_px, height_px, hfov_deg (or K, dist)",
                  "pixels; degrees; optional OpenCV 3×3 K + distortion", "640, 480, 70°",
                  "The focal length in pixels converts pixels into angles. The datasheet HFOV is enough to start; "
                  "a checkerboard calibration (K, dist) removes lens distortion when you need accuracy."],
                 ["<b>Focus region</b>", "yaw/pitch window (deg), near/far band (m), 2 flags",
                  "yaw ±30°, pitch ±25°, 0.3–10 m, clipped to stereo overlap",
                  "Says where to look, independently of the cameras. Defined in rig bearings, not pixels, "
                  "so it stays valid when you change camera, resolution or mounting (section 3)."],
                 ["<b>Detail level λ</b>", "float in [0, 1] or low/medium/high = 0/0.5/1",
                  "0.5 (medium)",
                  "One scalar is the simplest contract another algorithm can drive (e.g. raise λ when the "
                  "user asks for more). It controls both cost and content (section 4)."],
                 ["Detector model (install time)", "Ultralytics weights file", "yolo11n.pt (COCO-80)",
                  "Fast on a laptop CPU, the same weights run on Linux and macOS. Use yolov8s-worldv2.pt with "
                  "a vocabulary for classes COCO lacks (projector, speaker, whiteboard)."]],
                [33, 38, 30, 73]),
          Spacer(1, 4),
          Paragraph("<b>What I need from you.</b> Measured baseline (lens centre to lens centre), the angle "
                    "between the two cameras' optical axes, the common tilt, the mounting height if fixed, "
                    "the webcam model (for HFOV), and which device is left. Put them in a JSON file "
                    "(<font face='%s'>python -m detect_object --write-config rig.json</font>) and pass "
                    "<font face='%s'>--config rig.json</font>." % (MONO, MONO), P)]

    s += [Paragraph("3. The focus region", H2),
          Paragraph("The focus region is a cone in rig bearings plus a distance band. An object is inside it when", P),
          Paragraph("yaw ∈ [yaw_min, yaw_max] ∧ pitch ∈ [pitch_min, pitch_max] ∧ (distance unknown ∨ distance ∈ [near, far])", EQ),
          Paragraph("Bearings are measured from the midpoint between the cameras: yaw positive to the right, "
                    "pitch positive up, zero along the bisector of the two optical axes. With "
                    "<font face='%s'>clip_to_overlap</font> (default on) the window is intersected with the "
                    "space both cameras see, and <font face='%s'>near</font> is raised to where the two fields "
                    "of view start to overlap." % (MONO, MONO), P),
          Paragraph("Why this default", H3),
          table([["Choice", "Reason (numbers for the default rig: b = 0.12 m, 70° HFOV, parallel)"],
                 ["Clip to the stereo overlap",
                  f"Only where both cameras see can an object be triangulated and de-duplicated. "
                  f"For the default rig the overlap is yaw {y0:.0f}° to {y1:+.0f}°, pitch {p0:.1f}° to {p1:+.1f}°, "
                  f"starting {g.overlap_start_m() * 100:.1f} cm in front of the rig."],
                 ["yaw ±30°, pitch ±25°",
                  "A few degrees inside the overlap on every side. Image edges have the most lens distortion "
                  "and the most objects cut in half by the frame, which give wrong classes and wrong distances."],
                 ["near 0.3 m",
                  "Closer than this, fixed-focus webcams blur and objects overflow the frame."],
                 ["far 10 m",
                  f"Stereo error grows with Z²: about {dz[1] * 100:.0f} cm at 1 m, {dz[3] * 100:.0f} cm at 3 m, "
                  f"{dz[5] * 100:.0f} cm at 5 m and {dz[10]:.1f} m at 10 m (1 px disparity error). Beyond 10 m "
                  "a distance is no longer useful. Objects too far to triangulate are still kept, with distance = None."]],
                [38, 136]),
          Spacer(1, 3),
          Paragraph("Changing it", H3),
          Preformatted("algo.set_focus(FocusRegion(yaw_min_deg=-10, yaw_max_deg=10, far_m=4))   # narrow, near\n"
                       "algo.set_focus(FocusRegion(require_stereo=True))   # only objects with a distance\n"
                       '# or in rig.json:  "focus": {"yaw_min_deg": -10, "yaw_max_deg": 10, ...}', CODE)]

    s += [Paragraph("4. The detail model", H2),
          Paragraph("The detail parameter is a map from λ to two things: what is computed (a processing plan) "
                    "and what is reported (a set of facts). Both are monotone in λ, and the reported set has a "
                    "strict nesting property that downstream algorithms can rely on.", P),
          Paragraph("4.1 Candidate facts", H3),
          Paragraph("Each frame pair produces a candidate set F. Every fact f has a <b>rank</b> r(f) ∈ [0, 1] "
                    "(the smallest λ at which it may be reported), a <b>salience</b> s(f) ∈ [0, 1] and a "
                    "<b>confidence</b> c(f) ∈ [0, 1].", P),
          Paragraph("scene              r = 0<br/>"
                    "count of class c   s<sub>c</sub> = 0.35·min(1, ln(1+n)/ln 21) + 0.25·min(1, √A<sub>c</sub>) + 0.40·I(c)<br/>"
                    "                   r = 0.05 + 0.70·(1 − s<sub>c</sub>)<br/>"
                    "trip hazard        r = 0.60<br/>"
                    "lighting           r = 0.65<br/>"
                    "object location    s<sub>o</sub> = 0.5·√A<sub>o</sub> + 0.25·I + 0.25/(1+d),  r = 0.85 + 0.15·(1 − s<sub>o</sub>)",
                    EQ),
          Paragraph("n is the smoothed count, A the fraction of the image the class covers, I(c) a fixed "
                    "importance table (person 1.0, screen 0.7, seat 0.6, default 0.3), d the distance. A class "
                    "that is numerous, large or important gets a low rank and appears early; a single small, "
                    "minor object appears only near λ = 0.75.", P),
          Paragraph("4.2 Selection", H3),
          Paragraph("D(λ) = first N(λ) of  sort<sub>(r, −s, subject)</sub> { f ∈ F : r(f) ≤ λ ∧ (c(f) ≥ 0.30 ∨ f = scene) }<br/>"
                    "N(λ) = ⌊1 + 39·λ⌋", EQ),
          Paragraph("<b>Nesting theorem.</b> If λ<sub>1</sub> ≤ λ<sub>2</sub> then D(λ<sub>1</sub>) is a prefix "
                    "of D(λ<sub>2</sub>). <i>Proof.</i> The eligible set at λ<sub>2</sub> contains the one at "
                    "λ<sub>1</sub>; every fact added has rank > λ<sub>1</sub>, so it sorts after all of them, "
                    "because the sort key starts with r. Truncating to N(λ<sub>2</sub>) ≥ N(λ<sub>1</sub>) "
                    "therefore keeps the first N(λ<sub>1</sub>) items, which are exactly D(λ<sub>1</sub>). ∎ "
                    "In practice: a consumer can always cut a high-detail report down to a lower detail by "
                    "keeping facts with rank ≤ λ, without re-running anything. This is tested on 200 random "
                    "fact sets and end to end on the simulated room.", P),
          Paragraph("4.3 Processing plan", H3),
          Paragraph("imgsz(λ)       = 32·round((320 + 640·λ)/32)     → 320 … 960 px detector input<br/>"
                    "run_hazards    ⇔ λ ≥ 0.60<br/>"
                    "run_lighting   ⇔ λ ≥ 0.65<br/>"
                    "run_locations  ⇔ λ ≥ 0.85", EQ),
          Paragraph("A stage runs exactly when at least one fact it can produce is reportable, so nothing "
                    "computed is thrown away. A larger detector input finds smaller and farther objects, which "
                    "is what 'more detail' means physically. Measured on this laptop's CPU for two 640×480 "
                    "frames: ≈ 60 ms at λ = 0, 180 ms at λ = 0.5, 380 ms at λ = 1. The nesting theorem holds "
                    "for a fixed candidate set; since the plan changes the detector resolution, a higher λ can "
                    "also <i>find</i> objects a lower λ missed.", P),
          Paragraph("4.4 What it looks like", H3),
          table(example_levels(), [12, 12, 13, 137]),
          Spacer(1, 3),
          Paragraph("All ranks, the fact budget, the confidence floor and the resolution range are fields of "
                    "<font face='%s'>DetailModel</font>, so the model can be retuned without touching code." % MONO, P)]

    s += [Paragraph("5. Outputs", H2),
          Paragraph("One <font face='%s'>DetectionReport</font> per processed frame pair, as a Python object or "
                    "as JSON (<font face='%s'>report.to_dict()</font>, or <font face='%s'>--json</font> on the "
                    "command line, one line per report)." % (MONO, MONO, MONO), P),
          table([["Field", "Type", "Why it is in the output"],
                 ["facts", "list of Fact", "The main output. Each fact is typed (kind, subject, value, unit) so a "
                  "program can use it without parsing text, and carries rank, salience and confidence so the "
                  "consumer can re-filter (nesting) or weigh it."],
                 ["Fact.kind", "scene | count | hazard | attribute | location",
                  "The level of abstraction, matching the three tiers in the brief: what kind of place, what "
                  "is in it, and the details (light, hazards, where each thing is)."],
                 ["Fact.text", "string", "Ready to speak or print; also joined into summary."],
                 ["Fact.object_ids", "ints", "Links a fact to the objects behind it, for highlighting or follow-up queries."],
                 ["objects", "list of SceneObject", "Only the objects some selected fact refers to, so the payload "
                  "grows with λ. Each has label, confidence, yaw/pitch, distance and 3D position (None when only "
                  "one camera saw it), metric width/height, seen_by, and the box in each image."],
                 ["scene, scene_confidence", "string, 0–1", "The λ = 0 answer, duplicated at the top level for "
                  "consumers that need only that."],
                 ["summary", "string", "Human-readable sentence(s), most important first."],
                 ["plan", "ProcessingPlan", "What was actually computed (λ, detector size, which analyzers ran), "
                  "so a consumer can tell 'not looked for' from 'not found'."],
                 ["t_ns, latency_ms, skew_ms", "ints / floats", "Timing: when the frames were taken, how long "
                  "processing took, how far apart the two frames were. Needed to fuse with other sensors."],
                 ["warnings", "list of strings", "Degraded input is always stated, never silent: low scene "
                  "confidence, camera skew > 40 ms, frame size not matching the rig."]],
                [32, 36, 106]),
          Paragraph("Example (λ = 0.5, simulated room; object ids shortened)", H3),
          Preformatted('{"detail": 0.5, "scene": "conference room", "scene_confidence": 0.61,\n'
                       ' "facts": [\n'
                       '  {"kind": "scene", "subject": "scene", "value": "conference room",\n'
                       '   "rank": 0.0, "salience": 1.0, "confidence": 0.61},\n'
                       '  {"kind": "count", "subject": "seat", "value": 36, "unit": "count",\n'
                       '   "rank": 0.20, "salience": 0.79, "confidence": 0.96,\n'
                       '   "text": "36 seats", "object_ids": [3, 4, 5, ...]},\n'
                       '  {"kind": "count", "subject": "screen", "value": 1, "unit": "count",\n'
                       '   "rank": 0.48, "salience": 0.39, "confidence": 0.99,\n'
                       '   "text": "one screen", "object_ids": [62]}],\n'
                       ' "summary": "Conference room. 36 seats, one screen.",\n'
                       ' "plan": {"detail": 0.5, "imgsz": 640, "run_lighting": false,\n'
                       '          "run_hazards": false, "run_locations": false},\n'
                       ' "latency_ms": 3.1, "skew_ms": 0.0, "warnings": []}', CODE)]

    s += [KeepTogether([
        Paragraph("6. Limits to know about", H2),
        table([["Limit", "Effect", "Remedy"],
               ["COCO-80 vocabulary", "No 'projector' or 'speaker' class; screens and TVs are 'screen'.",
                "YOLO-World weights + vocabulary (about 3× slower)."],
               ["Rule-based scene names", "10 categories from object counts; unusual rooms are 'unidentified scene'.",
                "Swap S1.7 for a CLIP or VLM classifier (same signature)."],
               ["Lighting from webcam colour", "Auto white balance pulls the estimate toward daylight; confidence ≤ 0.5.",
                "Lock white balance, or use a lux sensor."],
               ["No tracking across frames", "Counts are per frame, median over 5 frames; a monocular object in the "
                "overlap may be counted twice.", "Add a tracker between S1.5 and S1.7."],
               ["Trip hazards", "Only detected low objects, not holes, cables or steps.",
                "Set height_m; add a depth-based floor check."],
               ["Unsynchronised cameras", "Up to 40 ms between views; fast motion can break matches.",
                "Cameras with a hardware sync input."]],
              [38, 78, 58]),
        Spacer(1, 4),
        Paragraph("<b>Linux and macOS.</b> The only platform-specific line chooses the capture backend "
                  "(V4L2 on Linux, AVFoundation on macOS). Cameras are opened on the main thread and the "
                  "optional preview window is drawn on the main thread, as macOS requires. The detector uses "
                  "CUDA, Apple MPS or the CPU, whichever is available. On macOS, give the terminal camera "
                  "permission and find the indices with <font face='%s'>python -m detect_object --list</font>." % MONO, P)])]

    doc = SimpleDocTemplate(str(out), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=16 * mm, bottomMargin=16 * mm,
                            title="detectObject: inputs and outputs", author="ringSensor project")
    doc.build(s, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    target = ROOT / "docs" / "detectObject_IO.pdf"
    build(target)
    print(target)
