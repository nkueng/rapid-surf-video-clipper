"""Export clip segments to MP4 using ffmpeg."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Callable


RESOLUTION_MAP = {
    "1080p": 1080,
    "720p": 720,
    "540p": 540,
}


def safe_name(text: str) -> str:
    """Turn an arbitrary label (session name, surfer name) into a safe path segment.

    Accented Latin letters are transliterated (Müller → Muller) rather than
    dropped; everything else outside [A-Za-z0-9_-] collapses to a single "_".
    """
    ascii_text = (
        unicodedata.normalize("NFKD", (text or "").strip())
        .encode("ascii", "ignore")
        .decode("ascii")
    )
    cleaned = re.sub(r"[^A-Za-z0-9_\-]+", "_", ascii_text).strip("_")
    return cleaned or "unnamed"


def _next_index(dest_dir: Path, prefix: str) -> int:
    """Next free NNN for ``{prefix}_NNN_*.mp4`` in dest_dir.

    Derived from the files already on disk so numbering keeps climbing across
    several source videos in the same session instead of restarting at 001 and
    overwriting earlier clips.
    """
    pat = re.compile(rf"^{re.escape(prefix)}_(\d+)(?:_|\.)")
    highest = 0
    for existing in dest_dir.glob(f"{prefix}_*.mp4"):
        m = pat.match(existing.name)
        if m:
            highest = max(highest, int(m.group(1)))
    return highest + 1


def _format_ts(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def _encode_filters(
    resolution: str, crop: tuple[int, int, int, int] | None
) -> list[str]:
    filters = []
    if crop:
        cw, ch, cx, cy = crop
        filters.append(f"crop={cw}:{ch}:{cx}:{cy}")
    if resolution != "original":
        height = RESOLUTION_MAP.get(resolution, 720)
        # lanczos keeps water/spray detail sharp on the way down, which also
        # gives the encoder a cleaner signal to work with.
        filters.append(f"scale=-2:{height}:flags=lanczos")
    return filters


def _cut_cmd(
    video_path: str,
    start: float,
    end: float,
    dest: Path,
    *,
    resolution: str,
    crf: int,
    crop: tuple[int, int, int, int] | None,
) -> list[str]:
    """ffmpeg command to cut ``[start, end)`` from ``video_path`` into ``dest``.

    Stream-copies when no filter is needed (original resolution, no crop),
    otherwise re-encodes to AV1 (SVT-AV1) at ``crf``. Shared by
    :func:`export_clips` and :func:`estimate_encode_rate` so a size estimate
    reflects exactly what the real export will do.

    AV1 is a big efficiency win over H.264/H.265 on high-detail, high-motion
    footage. Film-grain synthesis is the key part for surf clips: the encoder
    denoises the spray/foam/glitter before encoding (large bitrate saving) and
    re-synthesises that texture on playback, so the water keeps its life
    instead of turning to plastic. 10-bit output curbs banding on wave faces
    and sky. Note the CRF scale is 0-63 here, not H.26x's 0-51.
    """
    filters = _encode_filters(resolution, crop)
    if not filters:
        return [
            "ffmpeg", "-y",
            "-ss", str(start), "-to", str(end),
            "-i", video_path,
            "-c", "copy",
            str(dest),
        ]
    return [
        "ffmpeg", "-y",
        "-ss", str(start), "-to", str(end),
        "-i", video_path,
        "-vf", ",".join(filters),
        "-c:v", "libsvtav1",
        "-crf", str(crf),
        "-preset", "6",
        "-pix_fmt", "yuv420p10le",
        "-svtav1-params", "tune=0:film-grain=10:film-grain-denoise=1",
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        str(dest),
    ]


def _probe_duration(path: Path) -> float:
    """Actual container duration of ``path`` in seconds (0.0 if unknown)."""
    proc = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1",
            str(path),
        ],
        capture_output=True, text=True,
    )
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return 0.0


def estimate_encode_rate(
    video_path: str,
    *,
    resolution: str = "original",
    crf: int = 30,
    crop: tuple[int, int, int, int] | None = None,
    sample_start: float = 0.0,
    sample_duration: float = 2.5,
) -> float:
    """Output bytes per second for the given export settings.

    Encodes one short representative window with the exact filter chain and CRF
    the real export uses, then divides its size by its measured duration. The
    figure therefore reflects this footage's actual complexity rather than a
    rule-of-thumb CRF table. Callers multiply the result by each clip's
    duration to get a per-clip size estimate.
    """
    sample_start = max(0.0, float(sample_start))
    sample_duration = max(0.5, float(sample_duration))
    with tempfile.TemporaryDirectory() as td:
        dest = Path(td) / "sample.mp4"
        cmd = _cut_cmd(
            video_path,
            sample_start,
            sample_start + sample_duration,
            dest,
            resolution=resolution,
            crf=crf,
            crop=crop,
        )
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not dest.exists():
            tail = (proc.stderr or "").strip().splitlines()
            raise RuntimeError(tail[-1] if tail else "sample encode failed")
        size = dest.stat().st_size
        actual = _probe_duration(dest) or sample_duration
    return size / actual


def export_clips(
    video_path: str,
    clips: list[dict[str, Any]],
    *,
    output_dir: str,
    resolution: str = "original",
    crf: int = 30,
    crop: tuple[int, int, int, int] | None = None,
    folder_groups: dict[int, str] | None = None,
    on_progress: Callable[[int, int, str], None] | None = None,
) -> list[dict[str, Any]]:
    """Export clips to output_dir and return a summary list.

    output_dir is the session folder — every clip lands under it, in a
    per-surfer subfolder from folder_groups (clip id → surfer name). Clip
    numbering is read back from the files already in each subfolder, so
    repeated runs for the same session keep incrementing instead of
    overwriting earlier videos' clips.

    crop is an even (width, height, x, y) pixel box applied to every clip; it
    forces a re-encode even when resolution is "original".
    """
    out_root = Path(output_dir).expanduser()
    out_root.mkdir(parents=True, exist_ok=True)
    results = []
    approved = [c for c in clips if c.get("keep", True)]

    # Source video name, so a clip can be traced back to the footage it came
    # from even after several videos export into the same session folder.
    source_tag = safe_name(Path(video_path).stem)

    for i, clip in enumerate(approved):
        clip_id = clip["id"]
        raw_folder = (folder_groups.get(clip_id, "") if folder_groups else "")
        folder = safe_name(raw_folder) if raw_folder else ""
        dest_dir = out_root / folder if folder else out_root
        dest_dir.mkdir(parents=True, exist_ok=True)

        start = clip["start"]
        end = clip["end"]
        duration = end - start
        prefix = folder or "clip"
        # Only tag the name when the export actually changed the frame — a plain
        # cut needs no "_original" noise.
        res_tag = "" if resolution == "original" else f"_{resolution}"
        crop_tag = "_crop" if crop else ""
        filename = (
            f"{prefix}_{_next_index(dest_dir, prefix):03d}"
            f"_{source_tag}{res_tag}{crop_tag}.mp4"
        )
        dest = dest_dir / filename

        if on_progress:
            on_progress(i, len(approved), filename)

        cmd = _cut_cmd(
            video_path, start, end, dest,
            resolution=resolution, crf=crf, crop=crop,
        )

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"ffmpeg error for clip {clip_id}:\n{proc.stderr}", file=sys.stderr)
            continue

        file_size = dest.stat().st_size if dest.exists() else 0
        results.append(
            {
                "clip_id": clip_id,
                "filename": str(dest),
                "start": start,
                "end": end,
                "duration": round(duration, 2),
                "size_bytes": file_size,
                "size_mb": round(file_size / 1_048_576, 2),
            }
        )

    return results
