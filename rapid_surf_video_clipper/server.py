"""FastAPI server — serves the UI and runs detection/export tasks."""

from __future__ import annotations

import asyncio
import base64
import json
import subprocess
import threading
from pathlib import Path
from typing import Any

import cv2
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from rapid_surf_video_clipper.clipper import build_clips, point_in_polygon
from rapid_surf_video_clipper.exporter import estimate_encode_rate, export_clips, safe_name

# ---------------------------------------------------------------------------
# Global application state
# ---------------------------------------------------------------------------

app_state: dict[str, Any] = {
    "phase": "file-picker",
    "video_path": None,
    "frame_step": 10,
    "skip_review": False,
    "roi": None,
    "roi_first": False,
    "model_name": "yolov8n.pt",
    # session grouping — all videos processed under one session name export
    # into the same folder; "another video" keeps it, "new session" clears it.
    "session_name": None,
    "_post_session_phase": None,
    # populated during / after scan
    "raw_detections": [],
    "clips": [],
    # clip id -> surfer folder name, assigned on the export screen. Kept here
    # so a page reload during export setup doesn't lose the grouping.
    "folder_groups": {},
    "video_fps": 30.0,
    "video_duration": 0.0,
    "video_width": 1920,
    "video_height": 1080,
    "total_frames": 0,
    "scan_progress": 0.0,
    # Bumped whenever a scan is aborted; the scan thread carries the value it
    # started with and bails the moment it no longer matches.
    "_scan_gen": 0,
    # Latest ROI-editor preview-detection request; stale runs drop their result.
    "_roi_preview_req": 0,
    # connected websockets
    "clients": [],
}

_scan_lock = threading.Lock()
_model = None  # YOLO model — warmed up at startup, see load_model()
_model_lock = threading.Lock()


def load_model():
    """Load the detection model, downloading the weights on the first ever run
    if the bundled file is missing. Safe to call repeatedly and from any
    thread; the tool warms this up at startup so scanning and the ROI preview
    don't each wait on it."""
    global _model
    with _model_lock:
        if _model is None:
            from ultralytics import YOLO  # type: ignore

            _model = YOLO(app_state["model_name"])
    return _model

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI()

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


# These endpoints all serve whatever video is currently loaded. Within one
# session the loaded video changes ("Process another video"), so the browser
# must not reuse a cached response from the previous video.
_NO_CACHE = {"Cache-Control": "no-store"}


@app.get("/thumbnail/{clip_id}")
async def thumbnail(clip_id: int):
    clip = next((c for c in app_state["clips"] if c["id"] == clip_id), None)
    if clip is None or not app_state["video_path"]:
        return Response(status_code=404)
    mid = (clip["start"] + clip["end"]) / 2
    jpeg = _extract_frame_jpeg(app_state["video_path"], mid, width=240)
    return Response(content=jpeg, media_type="image/jpeg", headers=_NO_CACHE)


@app.get("/video")
async def serve_video():
    if not app_state["video_path"]:
        return Response(status_code=404)
    import mimetypes
    media_type, _ = mimetypes.guess_type(app_state["video_path"])
    return FileResponse(
        app_state["video_path"], media_type=media_type or "video/mp4", headers=_NO_CACHE
    )


@app.get("/frame")
async def frame_at(t: float = 0.0):
    if not app_state["video_path"]:
        return Response(status_code=404)
    jpeg = _extract_frame_jpeg(app_state["video_path"], t, width=960)
    return Response(content=jpeg, media_type="image/jpeg", headers=_NO_CACHE)


@app.get("/api/pick-file")
async def pick_file(type: str = "file"):
    """Use osascript on macOS to show a native file/folder picker."""
    if type == "folder":
        script = 'POSIX path of (choose folder with prompt "Select output folder")'
    else:
        script = (
            'POSIX path of (choose file with prompt "Select video file" '
            'of type {"public.movie", "com.apple.quicktime-movie"})'
        )
    # Run off the event loop — this blocks for as long as the dialog is open.
    result = await asyncio.to_thread(
        subprocess.run, ["osascript", "-e", script], capture_output=True, text=True
    )
    if result.returncode != 0:
        stderr = result.stderr.strip()
        if "User canceled" in stderr or "-128" in stderr:
            # User dismissed the dialog — not an error, nothing to report.
            return JSONResponse({"error": "cancelled"}, status_code=400)
        # Something actually went wrong (e.g. "No user interaction allowed (-1713)",
        # usually meaning this process has no WindowServer/Automation access).
        return JSONResponse({"error": stderr or "unknown osascript error"}, status_code=500)
    path = result.stdout.strip()
    return JSONResponse({"path": path})


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    app_state["clients"].append(ws)
    try:
        # Send current state to newly connected client
        await _send_state_snapshot(ws)

        # If a video was provided at CLI launch and we're in scanning phase,
        # kick off the scan automatically once the first client connects.
        if (
            app_state["phase"] == "scanning"
            and app_state["video_path"]
            and not app_state["raw_detections"]
            and not app_state.get("_scan_started")
        ):
            app_state["_scan_started"] = True
            asyncio.create_task(_run_scan())

        # If a video was provided at CLI launch without a pre-set ROI, probe
        # its duration so the ROI-prompt screen (and its editor) can use it.
        if (
            app_state["phase"] == "roi-prompt"
            and app_state["video_path"]
            and not app_state.get("_roi_prompt_probed")
        ):
            app_state["_roi_prompt_probed"] = True
            meta = await asyncio.to_thread(_probe_video, app_state["video_path"])
            app_state["video_duration"] = meta["duration"]
            app_state["video_fps"] = meta["fps"]
            app_state["total_frames"] = meta["total_frames"]
            await _broadcast(
                {
                    "type": "video_selected",
                    "video_duration": meta["duration"],
                    "video_fps": meta["fps"],
                    "roi_first": app_state.get("roi_first", False),
                }
            )

        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            await _handle_client_message(msg)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            app_state["clients"].remove(ws)
        except ValueError:
            pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _send_state_snapshot(ws: WebSocket):
    phase = app_state["phase"]
    base = {"type": "state", "phase": phase, "session_name": app_state.get("session_name")}
    # Only detections whose bbox centre falls inside the ROI count towards the
    # timeline — same rule build_clips() uses — so the strip matches the clips.
    roi = app_state.get("roi")
    roi = roi if roi and len(roi) >= 3 else None
    dets = app_state["raw_detections"]
    if roi:
        dets = [d for d in dets if point_in_polygon(d["cx"], d["cy"], roi)]
    if phase in ("review", "export-settings", "exporting", "done"):
        base["clips"] = app_state["clips"]
        base["video_duration"] = app_state["video_duration"]
        base["video_fps"] = app_state["video_fps"]
        base["video_width"] = app_state["video_width"]
        base["video_height"] = app_state["video_height"]
        base["roi"] = app_state["roi"]
        base["folder_groups"] = app_state.get("folder_groups", {})
        if dets:
            base["detection_timestamps"] = sorted({d["timestamp"] for d in dets})
    elif phase == "roi-prompt":
        base["video_duration"] = app_state.get("video_duration", 0)
        base["roi_first"] = app_state.get("roi_first", False)
    elif phase == "scanning":
        base["progress"] = app_state["scan_progress"]
        base["total_frames"] = app_state["total_frames"]
        base["frame_step"] = app_state["frame_step"]
        base["roi"] = app_state["roi"]
        # Compact: just the tile indices that had an in-ROI detection
        frame_step = app_state["frame_step"]
        base["detection_tiles"] = list({d["frame"] // frame_step for d in dets})
    await ws.send_text(json.dumps(base))


async def _broadcast(msg: dict):
    dead = []
    for ws in list(app_state["clients"]):
        try:
            await ws.send_text(json.dumps(msg))
        except Exception:
            dead.append(ws)
    for ws in dead:
        try:
            app_state["clients"].remove(ws)
        except ValueError:
            pass


def _reset_video_state():
    """Clear everything tied to one source video, keeping the session."""
    app_state.update(
        {
            "video_path": None,
            "raw_detections": [],
            "clips": [],
            "folder_groups": {},
            "roi": None,
            "scan_progress": 0.0,
            "total_frames": 0,
            "_scan_started": False,
            "_roi_prompt_probed": False,
        }
    )


async def _enter_after_session():
    """Move on from the session-name prompt to wherever the flow was headed."""
    nxt = app_state.get("_post_session_phase") or "file-picker"
    app_state["_post_session_phase"] = None
    app_state["phase"] = nxt

    if nxt == "scanning" and app_state["video_path"] and not app_state.get("_scan_started"):
        app_state["_scan_started"] = True
        asyncio.create_task(_run_scan())
    elif nxt == "roi-prompt" and app_state["video_path"]:
        app_state["_roi_prompt_probed"] = True
        meta = await asyncio.to_thread(_probe_video, app_state["video_path"])
        app_state["video_duration"] = meta["duration"]
        app_state["video_fps"] = meta["fps"]
        app_state["total_frames"] = meta["total_frames"]
        await _broadcast(
            {
                "type": "video_selected",
                "video_duration": meta["duration"],
                "video_fps": meta["fps"],
                "roi_first": app_state.get("roi_first", False),
            }
        )
    else:
        await _broadcast(
            {"type": "state", "phase": "file-picker", "session_name": app_state.get("session_name")}
        )


async def _handle_client_message(msg: dict):
    t = msg.get("type")

    if t == "set_folder_groups":
        # Mirror the export screen's clip → folder assignment so a reload
        # doesn't drop it.
        groups = msg.get("folder_groups")
        if isinstance(groups, dict):
            app_state["folder_groups"] = groups
        return

    if t == "set_phase":
        # Pure client-side navigation between already-reachable views. Recorded
        # so a page reload restores the view the user was on instead of snapping
        # back. Two cases:
        #   • Review ⇄ Export settings — only once a scan has produced clips.
        #   • Stepping back through the pre-scan wizard (Export settings' own
        #     "← Back" aside): Detection zone → Select video → Session name.
        #     State (session name, selected video path) is left intact so the
        #     user can adjust one thing and walk forward again.
        phase = msg.get("phase")
        if phase in ("session-prompt", "file-picker"):
            app_state["phase"] = phase
        elif phase in ("review", "export-settings") and app_state["clips"]:
            app_state["phase"] = phase
        return

    if t == "set_session":
        name = (msg.get("name") or "").strip()
        app_state["session_name"] = name or None
        await _enter_after_session()
        return

    if t == "another_video":
        # Same session — keep session_name so exports stack in the same folder
        # and clip numbering (read from disk) keeps climbing.
        _reset_video_state()
        app_state["phase"] = "file-picker"
        await _broadcast(
            {"type": "state", "phase": "file-picker", "session_name": app_state.get("session_name")}
        )
        return

    if t == "new_session":
        _reset_video_state()
        app_state["session_name"] = None
        app_state["_post_session_phase"] = "file-picker"
        app_state["phase"] = "session-prompt"
        await _broadcast({"type": "state", "phase": "session-prompt", "session_name": None})
        return

    if t == "set_video":
        path = msg.get("path", "").strip()
        if not path or not Path(path).exists():
            await _broadcast({"type": "error", "message": f"File not found: {path}"})
            return
        app_state["video_path"] = path

        if app_state.get("roi"):
            # A detection zone was already supplied on the command line —
            # no need to ask again, go straight to scanning.
            app_state["phase"] = "scanning"
            app_state["_scan_started"] = True
            asyncio.create_task(_run_scan())
        else:
            meta = await asyncio.to_thread(_probe_video, path)
            app_state["video_duration"] = meta["duration"]
            app_state["video_fps"] = meta["fps"]
            app_state["total_frames"] = meta["total_frames"]
            app_state["phase"] = "roi-prompt"
            await _broadcast(
                {
                    "type": "video_selected",
                    "video_duration": meta["duration"],
                    "video_fps": meta["fps"],
                    "roi_first": app_state.get("roi_first", False),
                }
            )

    elif t == "begin_scan":
        roi = msg.get("roi")
        app_state["roi"] = roi if roi and len(roi) >= 3 else None
        app_state["phase"] = "scanning"
        app_state["_scan_started"] = True
        asyncio.create_task(_run_scan())

    elif t == "abort_scan":
        # Stop the running scan (or model load) and step back to the
        # detection-zone prompt. The scan thread notices the generation bump
        # and exits without building clips; partial detections are dropped.
        app_state["_scan_gen"] = app_state.get("_scan_gen", 0) + 1
        app_state["_scan_started"] = False
        app_state["raw_detections"] = []
        app_state["scan_progress"] = 0.0
        app_state["phase"] = "roi-prompt"
        await _broadcast(
            {
                "type": "state",
                "phase": "roi-prompt",
                "session_name": app_state.get("session_name"),
                "video_duration": app_state.get("video_duration", 0),
                "video_fps": app_state.get("video_fps", 30),
                "roi_first": False,
            }
        )

    elif t == "reanalyse":
        gap_fill = float(msg.get("gap_fill", 2.0))
        padding = float(msg.get("padding", 1.0))
        roi = msg.get("roi", app_state.get("roi"))
        app_state["roi"] = roi
        clips = build_clips(
            app_state["raw_detections"],
            gap_fill=gap_fill,
            padding=padding,
            roi=roi,
            video_duration=app_state["video_duration"],
        )
        # Preserve keep/reject decisions where possible
        old_keeps = {c["id"]: c.get("keep", False) for c in app_state["clips"]}
        for c in clips:
            c["keep"] = old_keeps.get(c["id"], False)
        app_state["clips"] = clips
        await _broadcast({"type": "clips_updated", "clips": clips})

    elif t == "update_clip":
        clip_id = msg["id"]
        for c in app_state["clips"]:
            if c["id"] == clip_id:
                if "start" in msg:
                    c["start"] = round(float(msg["start"]), 3)
                if "end" in msg:
                    c["end"] = round(float(msg["end"]), 3)
                if "keep" in msg:
                    c["keep"] = bool(msg["keep"])
                c["duration"] = round(c["end"] - c["start"], 3)
                break

    elif t == "export":
        clips = msg.get("clips", app_state["clips"])
        settings = msg.get("settings", {})
        app_state["clips"] = clips
        app_state["phase"] = "exporting"
        asyncio.create_task(_run_export(clips, settings))

    elif t == "estimate_size":
        # Record which request is current so a stale sample encode (the user
        # kept dragging the CRF slider) resolves without clobbering the UI.
        app_state["_size_req_id"] = msg.get("req_id")
        asyncio.create_task(_run_size_estimate(msg))

    elif t == "roi_preview_detect":
        # The ROI editor opened — stream it an annotated sample for its
        # backdrop. Bumping the id stops any stream still running.
        app_state["_roi_preview_req"] = msg.get("req_id")
        asyncio.create_task(_run_roi_preview_detect(msg))

    elif t == "roi_preview_cancel":
        # Editor closed — let any in-flight stream notice and stop.
        app_state["_roi_preview_req"] = -1


# ---------------------------------------------------------------------------
# Scan task
# ---------------------------------------------------------------------------


async def _run_scan():
    loop = asyncio.get_running_loop()

    # Snapshot the scan generation; an abort bumps it and this thread stops.
    my_gen = app_state.get("_scan_gen", 0)

    def aborted() -> bool:
        return app_state.get("_scan_gen", 0) != my_gen

    def scan_thread():
        global _model
        try:
            # Signal model initialisation
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(
                    _broadcast({"type": "init_start"})
                )
            )
            load_model()

            # Model load can't be interrupted, but if the user backed out while
            # it ran, stop here instead of scanning the whole video.
            if aborted():
                return

            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(
                    _broadcast({"type": "init_done"})
                )
            )

            video_path = app_state["video_path"]
            frame_step = app_state["frame_step"]
            cap = cv2.VideoCapture(video_path)
            if not cap.isOpened():
                loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(
                        _broadcast({"type": "error", "message": f"Cannot open: {video_path}"})
                    )
                )
                return

            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            duration = total_frames / fps

            app_state["video_fps"] = fps
            app_state["video_duration"] = duration
            app_state["video_width"] = vid_w
            app_state["video_height"] = vid_h
            app_state["total_frames"] = total_frames

            app_state["raw_detections"] = []
            roi = app_state.get("roi")
            roi = roi if roi and len(roi) >= 3 else None
            frame_idx = 0

            while True:
                if aborted():
                    cap.release()
                    return

                ret, frame = cap.read()
                if not ret:
                    break

                if frame_idx % frame_step == 0:
                    timestamp = frame_idx / fps
                    progress = frame_idx / max(total_frames, 1)
                    app_state["scan_progress"] = progress

                    # Run YOLO — class 0 = person
                    results = _model.predict(
                        frame, classes=[0], verbose=False, conf=0.30
                    )
                    # Scale factor for 640-wide display frame
                    dw = 640
                    dh = int(dw * vid_h / vid_w)
                    frame_dets = []

                    for r in results:
                        for box in r.boxes:
                            x1, y1, x2, y2 = box.xyxy[0].tolist()
                            conf = float(box.conf[0])
                            nx1, ny1 = x1 / vid_w, y1 / vid_h
                            nx2, ny2 = x2 / vid_w, y2 / vid_h
                            in_roi = roi is None or point_in_polygon(
                                (nx1 + nx2) / 2, (ny1 + ny2) / 2, roi
                            )
                            app_state["raw_detections"].append(
                                {
                                    "frame": frame_idx,
                                    "timestamp": round(timestamp, 3),
                                    "conf": round(conf, 3),
                                    "bbox": [
                                        round(nx1, 4),
                                        round(ny1, 4),
                                        round(nx2, 4),
                                        round(ny2, 4),
                                    ],
                                    "cx": round((nx1 + nx2) / 2, 4),
                                    "cy": round((ny1 + ny2) / 2, 4),
                                }
                            )
                            frame_dets.append(
                                {
                                    "x1": round(x1 * dw / vid_w),
                                    "y1": round(y1 * dh / vid_h),
                                    "x2": round(x2 * dw / vid_w),
                                    "y2": round(y2 * dh / vid_h),
                                    "conf": round(conf, 2),
                                    "in_roi": in_roi,
                                }
                            )

                    # Encode display frame
                    dw = 640
                    dh = int(dw * vid_h / vid_w)
                    small = cv2.resize(frame, (dw, dh))
                    _, buf = cv2.imencode(
                        ".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 65]
                    )
                    frame_b64 = base64.b64encode(buf).decode()

                    update = {
                        "type": "frame",
                        "frame_b64": frame_b64,
                        "frame_num": frame_idx,
                        "total_frames": total_frames,
                        "frame_step": frame_step,
                        "progress": round(progress, 4),
                        "timestamp": round(timestamp, 2),
                        "detections": frame_dets,
                        "frame_w": dw,
                        "frame_h": dh,
                    }
                    loop.call_soon_threadsafe(
                        lambda u=update: asyncio.ensure_future(_broadcast(u))
                    )

                frame_idx += 1

            cap.release()

            # Aborted on the final iteration (loop exited via `break` on EOF is
            # fine; a generation bump means the user backed out).
            if aborted():
                return

            clips = build_clips(
                app_state["raw_detections"],
                gap_fill=2.0,
                padding=1.0,
                roi=app_state.get("roi"),
                video_duration=duration,
            )
            app_state["clips"] = clips
            app_state["phase"] = "review" if not app_state["skip_review"] else "exporting"

            done_msg = {
                "type": "scan_done",
                "clips": clips,
                "raw_detection_count": len(app_state["raw_detections"]),
                "video_duration": duration,
                "video_fps": fps,
                "video_width": vid_w,
                "video_height": vid_h,
                "roi": app_state.get("roi"),
                "phase": app_state["phase"],
                "session_name": app_state.get("session_name"),
                "default_output_dir": str(Path(__file__).parent.parent / "exports"),
            }
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(_broadcast(done_msg))
            )

            if app_state["skip_review"]:
                loop.call_soon_threadsafe(
                    lambda: asyncio.ensure_future(
                        _run_export(clips, {})
                    )
                )

        except Exception as exc:
            import traceback

            tb = traceback.format_exc()
            msg = str(exc)
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(
                    _broadcast({"type": "error", "message": msg, "traceback": tb})
                )
            )

    thread = threading.Thread(target=scan_thread, daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Export task
# ---------------------------------------------------------------------------


async def _run_export(clips: list[dict], settings: dict):
    loop = asyncio.get_running_loop()

    def export_thread():
        video_path = app_state["video_path"]
        base_dir = settings.get(
            "output_dir",
            str(Path(__file__).parent.parent / "exports"),
        )
        # Every video in a session exports into one folder named after it.
        session = (settings.get("session") or app_state.get("session_name") or "").strip()
        output_dir = (
            str(Path(base_dir).expanduser() / safe_name(session)) if session else base_dir
        )
        resolution = settings.get("resolution", "original")
        crf = int(settings.get("crf", 30))
        crop = _crop_to_pixels(settings.get("crop"))
        folder_groups = settings.get("folder_groups") or app_state.get("folder_groups") or {}
        # Keys may come as strings from JSON
        folder_groups = {int(k): v for k, v in folder_groups.items()}

        total = len([c for c in clips if c.get("keep", False)])

        def on_progress(i, n, filename):
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(
                    _broadcast(
                        {
                            "type": "export_progress",
                            "current": i + 1,
                            "total": n,
                            "filename": filename,
                        }
                    )
                )
            )

        try:
            results = export_clips(
                video_path,
                clips,
                output_dir=output_dir,
                resolution=resolution,
                crf=crf,
                crop=crop,
                folder_groups=folder_groups,
                on_progress=on_progress,
            )
            app_state["phase"] = "done"

            # Print summary to terminal
            print(f"\nExported {len(results)} clip(s) to {output_dir}")
            for r in results:
                print(
                    f"  clip {r['clip_id']:03d}  "
                    f"{r['start']:.1f}s–{r['end']:.1f}s  "
                    f"({r['duration']:.1f}s)  "
                    f"{r['size_mb']:.1f} MB"
                )

            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(
                    _broadcast(
                        {
                            "type": "export_done",
                            "results": results,
                            "output_dir": output_dir,
                        }
                    )
                )
            )
        except Exception as exc:
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(
                    _broadcast({"type": "error", "message": str(exc)})
                )
            )

    thread = threading.Thread(target=export_thread, daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Export size estimate
# ---------------------------------------------------------------------------


_size_estimate_lock = threading.Lock()


async def _run_size_estimate(msg: dict):
    """Reply with output bytes-per-second for the requested export settings.

    Stream-copy exports (original resolution, no crop) are exact — just the
    source's own average bitrate. Anything that re-encodes gets one short
    sample encode with the real filter chain + CRF, measured on this footage.
    The client multiplies the rate by each clip's duration.
    """
    req_id = msg.get("req_id")
    settings = msg.get("settings", {})
    resolution = settings.get("resolution", "original")
    crf = int(settings.get("crf", 30))
    crop = _crop_to_pixels(settings.get("crop"))

    video_path = app_state.get("video_path")
    duration = app_state.get("video_duration") or 0.0

    def reply(mode: str, bps: float, error: str | None = None):
        # Drop the answer if a newer request has since arrived.
        if app_state.get("_size_req_id") != req_id:
            return None
        return _broadcast(
            {
                "type": "size_estimate",
                "req_id": req_id,
                "mode": mode,
                "bytes_per_second": max(0.0, bps),
                "error": error,
            }
        )

    if not video_path or not Path(video_path).exists() or duration <= 0:
        coro = reply("encode", 0.0, "source video unavailable")
        if coro:
            await coro
        return

    if resolution == "original" and not crop:
        try:
            src_bytes = Path(video_path).stat().st_size
        except OSError:
            src_bytes = 0
        coro = reply("copy", src_bytes / duration if duration else 0.0)
        if coro:
            await coro
        return

    sample = msg.get("sample") or {}
    s_dur = float(sample.get("duration") or 2.5)
    s_dur = max(1.0, min(s_dur, max(1.0, duration - 0.2)))
    default_start = max(0.0, duration / 2 - s_dur / 2)
    s_start = float(sample.get("start", default_start))
    s_start = max(0.0, min(s_start, max(0.0, duration - s_dur)))

    def work() -> float:
        with _size_estimate_lock:
            # A newer request landed while this one waited for the lock — skip
            # the wasted encode; the newer task will answer.
            if app_state.get("_size_req_id") != req_id:
                return -1.0
            return estimate_encode_rate(
                video_path,
                resolution=resolution,
                crf=crf,
                crop=crop,
                sample_start=s_start,
                sample_duration=s_dur,
            )

    try:
        bps = await asyncio.to_thread(work)
        if bps < 0:
            return  # superseded; the newer request will reply
        coro = reply("encode", bps)
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI as text
        coro = reply("encode", 0.0, str(exc))
    if coro:
        await coro


# ---------------------------------------------------------------------------
# ROI editor preview stream
# ---------------------------------------------------------------------------


_roi_preview_lock = threading.Lock()
ROI_PREVIEW_FPS = 4          # frames per second sampled from the window
ROI_PREVIEW_WINDOW = 20.0    # seconds of footage to sample
ROI_PREVIEW_WIDTH = 640      # display-frame width; detection also runs at this size


async def _run_roi_preview_detect(msg: dict):
    """Stream a short annotated sample for the ROI editor background.

    Same frame-by-frame person detection shown while scanning, over a ~20 s
    window, streamed as JPEG frames + normalised detection boxes. The client
    loops them behind the zone-drawing canvas.

    Per-frame message: {"type": "roi_preview_frame", "req_id", "b64",
    "detections": [[x1,y1,x2,y2,conf], ...], "frame_w", "frame_h"}; a final
    {"type": "roi_preview_done", "req_id"} closes the stream.
    """
    req_id = msg.get("req_id")
    video_path = app_state.get("video_path")
    if not video_path or not Path(video_path).exists():
        return

    start = max(0.0, float(msg.get("start") or 0.0))
    end_raw = msg.get("end")
    end = float(end_raw) if end_raw is not None else start + ROI_PREVIEW_WINDOW

    loop = asyncio.get_running_loop()

    def current() -> bool:
        return app_state.get("_roi_preview_req") == req_id

    def emit(payload: dict):
        loop.call_soon_threadsafe(
            lambda p=payload: asyncio.ensure_future(_broadcast(p))
        )

    def work():
        with _roi_preview_lock:
            if not current():
                return
            load_model()
            if not current():
                return

            cap = cv2.VideoCapture(video_path)
            if not cap.isOpened():
                cap.release()
                return
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
            vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            dur = total / fps if fps else 0.0

            hi = min(end, start + ROI_PREVIEW_WINDOW)
            if dur:
                hi = min(hi, dur)
            step = max(1, round(fps / ROI_PREVIEW_FPS))
            dw = ROI_PREVIEW_WIDTH
            dh = int(dw * vid_h / vid_w)

            start_frame = int(start * fps)
            end_frame = int(hi * fps)
            cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

            frame_idx = start_frame
            emitted = 0
            while frame_idx <= end_frame:
                if not current():
                    break
                sample = (frame_idx - start_frame) % step == 0
                if not sample:
                    # Skip the decode for frames we won't use — just advance.
                    if not cap.grab():
                        break
                    frame_idx += 1
                    continue
                ok, frame = cap.read()
                if not ok:
                    break

                # Detect on the same small frame that's sent to the client — the
                # model letterboxes to 640 anyway, so this costs far less with no
                # meaningful loss for a preview backdrop.
                small = cv2.resize(frame, (dw, dh))
                results = _model.predict(small, classes=[0], verbose=False, conf=0.30)
                dets: list[list[float]] = []
                for r in results:
                    for box in r.boxes:
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        dets.append(
                            [
                                round(x1 / dw, 4),
                                round(y1 / dh, 4),
                                round(x2 / dw, 4),
                                round(y2 / dh, 4),
                                round(float(box.conf[0]), 2),
                            ]
                        )
                ok2, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 65])
                if ok2:
                    emit(
                        {
                            "type": "roi_preview_frame",
                            "req_id": req_id,
                            "b64": base64.b64encode(buf).decode(),
                            "detections": dets,
                            "frame_w": dw,
                            "frame_h": dh,
                        }
                    )
                    emitted += 1
                frame_idx += 1
            cap.release()
            if current():
                emit({"type": "roi_preview_done", "req_id": req_id, "count": emitted})

    try:
        await asyncio.to_thread(work)
    except Exception:  # noqa: BLE001 - a preview failure just means no backdrop
        pass


# ---------------------------------------------------------------------------
# Frame extraction helper
# ---------------------------------------------------------------------------


def _crop_to_pixels(crop: dict | None) -> tuple[int, int, int, int] | None:
    """Convert a normalized crop {x,y,w,h} (0-1) to an even (w, h, x, y) pixel box.

    Returns None when there is no crop, the crop covers the whole frame, or the
    video dimensions are unknown.
    """
    if not crop or not all(k in crop for k in ("x", "y", "w", "h")):
        return None

    vw = int(app_state.get("video_width") or 0)
    vh = int(app_state.get("video_height") or 0)
    if vw <= 0 or vh <= 0:
        return None

    def even(v: float) -> int:
        return max(0, int(round(v)) // 2 * 2)

    cw = min(vw // 2 * 2, max(2, even(crop["w"] * vw)))
    ch = min(vh // 2 * 2, max(2, even(crop["h"] * vh)))
    cx = max(0, min(even(crop["x"] * vw), (vw - cw) // 2 * 2))
    cy = max(0, min(even(crop["y"] * vh), (vh - ch) // 2 * 2))

    if cw >= vw - 1 and ch >= vh - 1:
        return None
    return (cw, ch, cx, cy)


def _probe_video(video_path: str) -> dict:
    """Read basic metadata (duration, fps, frame count) without decoding frames."""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return {"fps": fps, "total_frames": total_frames, "duration": total_frames / fps}


def _extract_frame_jpeg(video_path: str, t: float, width: int = 320) -> bytes:
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_num = int(t * fps)
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_num)
    ret, frame = cap.read()
    cap.release()
    if not ret:
        return b""
    h, w = frame.shape[:2]
    new_h = int(width * h / w)
    frame = cv2.resize(frame, (width, new_h))
    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return buf.tobytes()
