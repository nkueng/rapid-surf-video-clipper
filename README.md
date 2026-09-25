# rapid-surf-video-clipper

A local desktop tool that scans a long GoPro recording of a rapid/river surf
session — a fixed camera on a static standing wave — detects the segments
where someone is actually surfing (via person detection), and lets you
review and export those segments as trimmed MP4 clips — without ever
loading the full video into memory or leaving your machine.

It runs as a small local web app: a Python/FastAPI backend does the video
processing, and a plain HTML/JS frontend (opened automatically in your
browser) drives the scan → review → export workflow.

---

## How to run it

### Prerequisites

- **macOS** (developed and tuned for Apple Silicon / M-series)
- **Python 3.10+**
- **ffmpeg** — used for clip export

  ```bash
  brew install ffmpeg
  ```

### Install

From the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

This installs the `rapid-surf-video-clipper` package in editable mode and registers the
`rapid-surf-video-clipper` console script (see `pyproject.toml`). It pulls in FastAPI,
uvicorn, OpenCV, Ultralytics (YOLOv8), and NumPy.

The YOLOv8n weights (`yolov8n.pt`, ~6 MB) are **not** included in this
repo. On first run Ultralytics downloads them automatically into the
working directory; every run after that is fully offline. To pre-fetch
for a machine with no internet, drop a `yolov8n.pt` into the repo root
(or point `--model` at one elsewhere).

### Run

```bash
rapid-surf-video-clipper /path/to/gopro_session.mp4
```

or, without installing the script entry point:

```bash
python -m rapid_surf_video_clipper /path/to/gopro_session.mp4
```

This starts a local server (default `http://localhost:8765`) and opens it
in your default browser. If you omit the video path, the app opens to a
file-picker screen (with a native macOS "choose file" dialog) instead of
scanning immediately.

From there the on-screen flow is: **name the session → scan → review
clips → export settings → export**. After an export you can either
**process another video** (kept in the same session) or **start a new
session**.

Every screen shows its name in a badge in the top-left corner (and in the
browser tab title) so they can be referred to unambiguously:

| # | View | What it's for |
|---|---|---|
| 1 | **Session name** | Name the session all following exports are grouped under. |
| 2 | **Select video** | Pick / drop the source video file. |
| 3 | **Detection zone** | Optionally restrict detection to a drawn area. |
| — | **Loading model** | One-off YOLOv8 weights load. |
| 4 | **Scanning** | Per-frame person detection with a live preview. The progress strip turns green only for frames with a detection whose bbox centre is inside the detection zone (same rule that builds the clips); detections outside it are drawn dimmed. |
| 5 | **Review clips** | Trim, keep/reject and re-analyse the detected clips. |
| 6 | **Export settings** | Resolution, quality, crop, output folder, per-surfer grouping; hovering a clip autoplays it up top, click is for multi-select. |
| — | **Exporting** | ffmpeg progress. |
| — | **Done** | Summary + "another video" / "new session". |

The two editors that open on top of a screen are **Detection zone editor**
and **Crop editor**; the badge shows those names while they're open.

Exports are organised as `<output dir>/<session>/<surfer>/<surfer>_NNN_…mp4`
— the output dir defaults to `./exports/` and is configurable in the
export-settings screen; the session name is asked for up front; the
per-surfer sub-folders come from the folder names you assign on the
export screen. Clip numbers (`NNN`) are read back from the files already
on disk, so processing several videos into the same session keeps
incrementing instead of overwriting earlier clips.

### CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `video` (positional) | — | Path to the source video. If omitted, shows the file-picker screen. |
| `--port` | `8765` | Local web server port. |
| `--frame-step` | `10` | Analyse every Nth frame. Lower = more accurate but slower. |
| `--skip-review` | off | Export all detected clips immediately after scanning, no manual approval step. For batch/trusted runs. |
| `--roi PATH` | — | Load a previously saved ROI (detection zone) JSON file and apply it automatically, skipping the ROI editor. |
| `--roi-first` | off | Open the ROI editor *before* scanning starts, so the zone is applied during the scan itself. |
| `--model` | `yolov8n.pt` | Path/name of the YOLOv8 weights file to use for person detection. |
| `--session NAME` | — | Session name. Skips the session-name prompt; all exports for this run land in `<output dir>/NAME/`. |

Examples:

```bash
# Batch-process a session, trusting the detector, skip manual review
rapid-surf-video-clipper session.mp4 --skip-review --frame-step 15

# Reuse a saved detection zone from a previous session
rapid-surf-video-clipper session.mp4 --roi zones/lineup.json
```

---

## Design choices

**Local-first, single-user desktop tool, not a hosted service.**
The backend runs on `localhost` only, does no network calls during scanning
or export, and holds all state in an in-process Python dict
(`server.app_state`). There's no database, no auth, and no multi-user
concept — the browser tab *is* the UI for one person doing one task at a
time. This matches the actual use case (a surfer processing their own
footage) and keeps the whole thing runnable with `pip install -e .` and one
command.

**Browser UI + Python backend, connected over a single WebSocket.**
A native desktop UI (e.g. a Qt/Tk app) would avoid the browser dependency,
but HTML/CSS/canvas gives a much faster path to a good timeline editor,
draggable clip handles, and an ROI polygon drawer than any native
toolkit would, while still letting the actual video/ML work stay in
Python where OpenCV and Ultralytics live. A single persistent WebSocket
(`/ws`) carries all state transitions (scan progress, live detection
frames, clip updates, export progress) as small JSON messages, rather than
polling or using separate endpoints per event — this keeps the frontend a
thin reactive renderer over a `type`-tagged message stream, and lets the
scan/export screens update in near-real-time.

**No frontend framework or build step.**
`static/index.html` + `app.js` + `style.css` are plain, unbundled files
served directly by FastAPI's `StaticFiles`. For a UI with five screens and
one data source (the WebSocket), a bundler/framework would add build
tooling for little benefit. This also means the whole frontend can be
edited and reloaded without any compile step.

**Two-stage clip pipeline: raw per-frame detections → derived clip
segments.**
The scanner (`server._run_scan`) only accumulates raw per-frame detections
(timestamp, confidence, bounding box). Turning that stream into clip
segments — bridging gaps, adding padding, applying the ROI filter — is a
pure, stateless function (`clipper.build_clips`) that takes the raw
detections plus parameters and returns clips. This means "Re-analyse" in
the review screen (changing gap-fill, padding, or ROI) never needs to
re-scan the video — it just re-runs a cheap function over data already in
memory. It also makes `build_clips` trivially unit-testable in isolation
from OpenCV/YOLO/the server.

**Region-of-interest (ROI) is a polygon over a bounding-box *centre*, not
full-box overlap.**
`clipper.bbox_overlaps_polygon` tests only the detected person's centre
point against the ROI polygon. This avoids counting someone standing at
the edge of frame with only a sliver of their bounding box in the zone —
centre-point containment is a closer proxy for "the person is standing in
the wave" than any-overlap, and it's cheap (one point-in-polygon test per
detection) with a plain ray-casting implementation, no geometry library
needed.

**Frame-skipping instead of scanning every frame.**
YOLO inference is the bottleneck, and adjacent frames in a 30/60fps video
are nearly identical for the purpose of "is someone surfing right now."
`--frame-step` (default 10) trades detection granularity for scan speed;
gap-filling in `build_clips` (default 2s) absorbs the resulting sparser
detection timeline into contiguous clips anyway, so a coarser scan doesn't
fragment clips.

**Streamed video I/O — never load the whole file into memory.**
Scanning reads frames one at a time via `cv2.VideoCapture` and discards
each after use; thumbnails and single-frame previews (`/thumbnail`,
`/frame`) seek and decode just the one frame needed. This is a hard
constraint given GoPro session files can be several GB — the tool's memory
footprint stays roughly constant regardless of source video length.

**Export via `ffmpeg` subprocess, not a Python video library.**
`exporter.py` shells out to `ffmpeg` rather than re-encoding through
OpenCV/PyAV. For the default "Original" resolution this uses stream-copy
(`-c copy`) — a lossless, near-instant trim with no re-encoding, only
possible because ffmpeg operates on the container/codec directly. Other
resolutions re-encode with SVT-AV1 (`libsvtav1`, 10-bit, `-preset 6`) at a
user-chosen CRF (AV1's 0–63 scale, default 30). AV1 with film-grain
synthesis is markedly more efficient than H.264/H.265 on high-motion,
high-detail surf footage — the encoder denoises spray/foam before encoding
and re-synthesises that texture on playback — and the downscale uses a
lanczos filter to keep water detail crisp. Choosing a crop in the export
screen (drag a rectangle over a sample frame, or pick a Landscape/Portrait
or Instagram 4:5 / 1:1 preset — the largest box of that shape that fits the
source, centred on the current selection) adds an ffmpeg `crop` filter
applied to every clip; because a crop can't be stream-copied, it forces the
same AV1 re-encode path even at "Original" resolution.
This also means clip export doesn't need `ffmpeg`'s functionality
reimplemented in Python — the tool fails fast at startup
(`__main__.check_ffmpeg`) with an install hint if `ffmpeg` isn't on `PATH`,
rather than failing deep inside an export job.

**YOLOv8n (nano) for person detection, class-filtered.**
The nano variant is the smallest/fastest YOLOv8 model, chosen because
inference runs per-scanned-frame on a laptop CPU/GPU with no server-side
acceleration to lean on, and "is there a person in frame" doesn't need a
larger model's accuracy. Detection is filtered to `classes=[0]` (person)
at inference time, which is what keeps whitewash/wave motion from
producing false positives — the model only ever looks for people, never
generic motion or texture.

**Raw detections and derived clips are both plain JSON-serializable
dicts.**
There's no ORM/dataclass layer between the detection loop, `build_clips`,
the WebSocket payloads, and the exporter — a "clip" is just a dict with
`id`/`start`/`end`/`confidence`/`keep`. This keeps the same shape usable
end-to-end (Python state → WebSocket message → JS render → back over the
WebSocket for `update_clip`/`export`) without translation layers, at the
cost of no compile-time schema checking — acceptable for a single-process,
single-user tool where the frontend and backend are developed together.

**Confidence is bucketed (`high`/`medium`/`low`), not shown as a raw
score.**
`clipper.confidence_label` reduces the average per-clip detection
confidence into three bands (≥0.65 / ≥0.40 / below) so the review UI can
use a quick colour-coded badge (green/yellow/red) instead of asking the
user to interpret a raw float — the actual decision a user needs to make
per clip ("keep or reject?") only needs a coarse signal.

**Design choices are recorded separately from behavioural spec.**
[implementation_notes.md](implementation_notes.md) in this repo is the
product/workflow spec (what each screen does, phase-by-phase) that this
implementation was built against — see it for the full intended UX beyond
what's summarized above.

---

## License

[AGPL-3.0](LICENSE). This project uses [Ultralytics
YOLOv8](https://github.com/ultralytics/ultralytics) (also AGPL-3.0) for
person detection; the `yolov8n.pt` weights it downloads at runtime are
distributed by Ultralytics under the same terms.
