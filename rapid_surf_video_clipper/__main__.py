import argparse
import json
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn


def check_ffmpeg():
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(
            "Error: ffmpeg is not installed.\n"
            "Install it with: brew install ffmpeg",
            file=sys.stderr,
        )
        sys.exit(1)

    # Re-encoded exports (any non-original resolution, or a crop) use SVT-AV1.
    encoders = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True
    )
    if "libsvtav1" not in encoders.stdout:
        print(
            "Error: this ffmpeg build has no libsvtav1 (AV1) encoder, which "
            "clip export needs.\nInstall a full build with: brew install ffmpeg",
            file=sys.stderr,
        )
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        prog="rapid-surf-video-clipper",
        description="Extract surfing clips from GoPro footage using YOLOv8",
    )
    parser.add_argument("video", nargs="?", help="Path to video file")
    parser.add_argument("--port", type=int, default=8765, help="Web server port")
    parser.add_argument(
        "--frame-step",
        type=int,
        default=10,
        help="Analyse every Nth frame (default: 10)",
    )
    parser.add_argument(
        "--skip-review",
        action="store_true",
        help="Export all clips immediately after scanning",
    )
    parser.add_argument(
        "--roi",
        type=Path,
        help="Path to a saved ROI JSON file to apply automatically",
    )
    parser.add_argument(
        "--roi-first",
        action="store_true",
        help="Open the ROI editor before scanning begins",
    )
    parser.add_argument(
        "--model",
        default="yolov8n.pt",
        help="YOLOv8 model file (default: yolov8n.pt)",
    )
    parser.add_argument(
        "--session",
        help="Session name (skips the session-name prompt); exports are grouped "
        "into a folder with this name",
    )
    args = parser.parse_args()

    check_ffmpeg()

    roi = None
    if args.roi:
        try:
            roi = json.loads(args.roi.read_text())
        except Exception as e:
            print(f"Error reading ROI file: {e}", file=sys.stderr)
            sys.exit(1)

    if args.video:
        target_phase = "scanning" if roi else "roi-prompt"
    else:
        target_phase = "file-picker"

    # Always ask for a session name first, unless one was passed on the CLI.
    session_name = args.session.strip() if args.session else None
    phase = target_phase if session_name else "session-prompt"

    # Import here so server module can reference args
    from rapid_surf_video_clipper import server

    server.app_state.update(
        {
            "video_path": str(args.video) if args.video else None,
            "frame_step": args.frame_step,
            "skip_review": args.skip_review,
            "roi": roi,
            "roi_first": args.roi_first,
            "model_name": args.model,
            "session_name": session_name,
            "_post_session_phase": None if session_name else target_phase,
            "phase": phase,
        }
    )

    # Warm up (and, on a fresh machine, download) the detection model now so the
    # first scan and the ROI preview don't each wait on it.
    def _warm_model():
        try:
            server.load_model()
            print("Detection model ready.")
        except Exception as e:  # noqa: BLE001 - scan will surface the real error
            print(f"Warning: could not preload detection model: {e}", file=sys.stderr)

    print("Loading detection model…")
    threading.Thread(target=_warm_model, daemon=True).start()

    url = f"http://localhost:{args.port}"
    print(f"rapid-surf-video-clipper running at {url}")
    if args.video:
        print(f"Video: {args.video}")

    def open_browser():
        time.sleep(0.8)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()

    uvicorn.run(server.app, host="localhost", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
