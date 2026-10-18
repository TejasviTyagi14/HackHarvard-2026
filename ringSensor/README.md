# Ring Sensor: detectObject

Python algorithm that reports which objects are in a focus region seen by two webcams, with
a detail level λ (0 to 1) that sets how much it reports and computes. Design:
[ARCHITECTURE.md](ARCHITECTURE.md), [docs/design/DETECT_OBJECT_DESIGN.md](docs/design/DETECT_OBJECT_DESIGN.md),
inputs and outputs: [docs/detectObject_IO.pdf](docs/detectObject_IO.pdf).

## Folder layout

```
ARCHITECTURE.md        the whole Ring Sensor system as black boxes
detect_object/         the algorithm (package), its web viewer (web/) and Droid control (droid.py)
interfaces/            shared data contracts for the whole system
models/                bundled YOLO weights (yolo11n.pt)
tests/                 pytest suites (no cameras or network needed)
docs/
  detectObject_IO.pdf  inputs and outputs, and why (rebuild: .venv/bin/python docs/build_io_pdf.py)
  design/              black-box designs: detectObject, and the full ring system
  prompts/             the original prompts the designs were built from
  examples/            a worked example of the black-box format
start_viewer.py/.sh    one-step launcher for the viewer
requirements.txt
```

## Setup (Linux and macOS)

```bash
cd ringSensor
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Run

```bash
./start_viewer.sh                          # web viewer at http://127.0.0.1:8770
.venv/bin/python -m detect_object --left 0 --right 2 --detail 0.5
.venv/bin/python -m pytest tests           # tests (no cameras or network needed)
```

From Files: open this folder, right-click `start_viewer.sh` and choose **Run as a Program**.
A terminal window opens and the viewer opens in the browser. Keep that window open while you use
the viewer; closing it stops the viewer. Running it again while it runs just reopens the page.
If it cannot start, the window stays open with the error and a desktop notification says why.

## Droid sets the detail level

Droid (Factory's agent) can choose λ while the algorithm runs, from requests like "more detail",
"just the basics" or "warn me about obstacles":

- **Viewer:** type the request in the **Ask Droid** box under the λ slider. The slider moves to
  Droid's choice (in its 0.05 steps), and the worker applies it from the next frame pair on.
- **Command line:** add `--droid`, then type requests and press Enter while it runs.
- **From code:** `DroidDetail().propose(text, current_level)` returns a checked `DetailDecision`
  (`ok`, `level`, `changed`, `reply`). Call `algo.set_detail(decision.level)` when `changed`.

Setup: install the CLI (`curl -fsSL https://app.factory.ai/cli | sh`), then log in once per
computer. In the viewer, press **Log in to Droid** under the Ask Droid box: a terminal window opens
on Factory's login. Press Enter on **Login**, approve it in the browser, then close that window.
The viewer notices by itself. Instead of logging in, you can run `droid` in a terminal, or
create a key at https://app.factory.ai/settings/api-keys and `export FACTORY_API_KEY=fk-...`.

Droid runs as `droid exec` in read-only mode, with every tool removed except TodoWrite, from an empty
temporary folder, so it can only read the request and answer. Its answer is checked
(`parse_level`, clamped to 0..1) before use. If anything fails (no CLI, no key, timeout, a bad
reply), λ stays as it was, and the slider, `--detail` and `set_detail` work exactly as before.
Optional environment variables: `DROID_MODEL` (default `anthropic-latest-fast`), `DROID_TIMEOUT`
(default 40 s), `DROID_REASONING`, `DROID_BIN`.
