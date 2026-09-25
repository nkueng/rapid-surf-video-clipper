# rapid-surf-video-clipper — Product Workflow Description

## Purpose

rapid-surf-video-clipper is a desktop tool that takes a long GoPro surf session recording and automatically extracts short clips of active surfing. The user should be able to go from a raw 10-minute video to a folder of trimmed, exported clips in a few minutes of interaction, with the heavy lifting done by the tool.

---

## End-to-End Workflow

### Phase 1 — Launch

The user launches the tool from the terminal, optionally passing a video file path as an argument. A browser window opens immediately showing the tool's interface. If a video path was given, the tool goes directly to Phase 3 (scanning). If no path was given, the tool shows a native file picker screen first.

The terminal simultaneously shows the local URL so the user can open it manually if the browser does not launch automatically.

---

### Phase 3 — Scanning

The browser switches to a full-screen scan view showing a live feed of the video frames being processed:

- A video frame from the current scan position is shown, updated in near-real-time as the tool works through the video. When a person (surfer) is detected in a frame, a bounding box and confidence score are drawn on that frame.
- A progress bar at the bottom fills left-to-right as the scan progresses, with a detection overlay showing which parts of the video had detections (coloured segments).
- A status line shows the current frame count and percentage complete.

The user watches this screen passively. No interaction is needed during scanning. The tool works through the entire video, noting where a surfer appears, and reports back when done.

If the tool is initialising its detection model (which can take up to 30 seconds on first run), the screen shows an animated "Initialising…" message so the user knows it is loading and not frozen.

When scanning finishes, the tool automatically transitions to Phase 4.

---

### Phase 4 — Review

The browser shows a review screen with two main areas:

**Timeline (top)**
A horizontal canvas spanning the full video duration. Each detected clip is drawn as a coloured band on the timeline. The user can click a clip band to select it. Drag handles on the left and right edges of each band let the user adjust the clip's start and end times by dragging.

**Clip list (below timeline)**
A scrollable list of detected clips, each showing:
- A thumbnail from the middle of the clip
- Start time, end time, and duration
- A colour-coded confidence badge (green = high confidence, yellow = medium, red = low)
- Fine-tune buttons to nudge start/end times by ±0.5s or ±1s
- A **Keep / Reject** toggle

Clips marked as rejected are faded and excluded from export. All clips start as approved.

**Analysis settings (collapsible panel)**
Accessible via a toggle, this panel lets the user adjust the parameters that were used to build the clips from raw detections:
- **Smooth gaps** — a slider controlling how large a gap in detections is bridged before splitting into separate clips. Increasing this merges nearby clips.
- **Padding** — extra seconds added before and after each detected segment.
- **Detection zone (ROI)** — a button to open the ROI editor (described below). When an ROI is set, only detections inside that zone count (as long as the bounding box of the surfer has overlap with the ROI). An indicator shows whether an ROI is currently active.
- A **Re-analyse** button that reruns the clip-building logic on the existing raw detections using the new settings, instantly updating the timeline and clip list without rescanning the video.

**Footer**
- A count of approved clips.
- A **Next: Export →** button to proceed.
- A **Cancel** button to quit without exporting.

---

### Phase 4a — ROI Editor (optional, from within Review)

Opened via the "Edit" button in the analysis settings panel. A modal appears showing a representative still frame from the video. The user draws a polygon over the region of the frame that should be considered the "active zone" (e.g. just the wave, excluding the bank where surfers wait).

- Clicking adds polygon vertices connected by lines.
- Clicking near the first vertex closes the polygon.
- The completed polygon is filled with a semi-transparent green overlay.
- `r` resets the polygon.
- **Apply zone** confirms and closes the modal. The detection zone label in the analysis settings updates to show it is active.
- **Cancel** discards the drawing.

Once an ROI is set, pressing **Re-analyse** filters the raw detections to only those whose centre point falls within the polygon, and rebuilds the clip list accordingly.

---

### Phase 5 — Export Settings

Clicking **Next: Export →** transitions to the export screen. A settings bar at the top of the screen shows:

- **Resolution** — four buttons: Original, 1080p, 720p, 540p. Original is the default and uses lossless stream-copy (fastest, no re-encoding). The others re-encode at the selected height.
- **Quality (CRF)** — a slider on SVT-AV1's 0–63 scale (0 = best quality, largest file; 63 = worst), defaulting to 30. Re-encodes use `libsvtav1` 10-bit with film-grain synthesis, which handles high-motion water detail far better than H.26x at a given size. This control is greyed out when Original is selected since stream-copy ignores it.
- **Output directory** — a text field showing the destination folder, editable.

Below the settings bar is a preview grid showing one card per approved clip: thumbnail, clip number, start–end times, and duration.

Within this preview grid, the user can select N clips and type the name of the destination folder. This function is useful to distinguish several people surfing in the same clip that should each get their own folder in the output.

The footer has:
- **← Back** to return to review without exporting.
- **Cancel** to quit.
- **Export N clips →** which starts the export.

---

### Phase 6 — Export

When the user clicks **Export N clips →**, the screen shows a full-screen overlay: "Exporting clips…" with a note that they can close the window when done.

The tool writes each approved clip to the output directory as an MP4 file. File names encode the source video name, clip number, and time range.

When complete, a summary is printed to the terminal:
- How many clips were exported and where
- Each clip's time range, duration, and file size

---

## Secondary Launch Modes

**Reuse a saved detection zone**
The user can pass a previously saved ROI file on the command line. The tool loads the ROI automatically and applies it during scanning without showing the ROI editor first.

**Skip review**
The user can pass a flag to skip the review screen entirely. All detected clips are exported immediately after scanning with no manual approval step. Useful for batch processing a session where the user trusts the detection quality.

**ROI editor before scanning**
The user can pass a flag to open the ROI editor before scanning begins. The editor shows a representative frame from the video, the user draws the zone, and then scanning proceeds with the zone already applied.

---

## Key Behavioural Constraints

- The tool must never load the entire video into memory. It streams frames as needed.
- Export of original-resolution clips must be lossless and near-instantaneous (no re-encoding).
- The detection model focuses only on people; water motion must not produce false positives.
- All processing runs locally on the machine — no network calls during scanning or export.
- If ffmpeg is not installed, the tool must fail immediately with a clear installation instruction.
- If the detection model is not cached locally and cannot be downloaded (no internet), the tool must fail with a clear recovery instruction.

## Implementation notes

- the tool should be optimized for macOS, running on M4 architecture 
- YOLOv8 should be used for person detection
- it should be sufficient to scan every 10th frame, but this should be a flag that can be passed via CLI