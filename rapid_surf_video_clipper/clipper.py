"""Build clip segments from raw per-frame detections."""

from __future__ import annotations

import math
from typing import Any


def point_in_polygon(x: float, y: float, polygon: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test. Coordinates are normalized 0-1."""
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def bbox_overlaps_polygon(
    bbox: list[float], polygon: list[list[float]]
) -> bool:
    """Return True if the bounding-box centre is inside the polygon.

    bbox is [x1,y1,x2,y2] normalized 0-1.
    """
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    return point_in_polygon(cx, cy, polygon)


def confidence_label(avg_conf: float) -> str:
    if avg_conf >= 0.65:
        return "high"
    if avg_conf >= 0.40:
        return "medium"
    return "low"


def build_clips(
    raw_detections: list[dict[str, Any]],
    *,
    gap_fill: float = 2.0,
    padding: float = 1.0,
    roi: list[list[float]] | None = None,
    video_duration: float = 0.0,
) -> list[dict[str, Any]]:
    """Convert raw per-frame detections into clip segments.

    Args:
        raw_detections: list of dicts with keys:
            frame, timestamp, conf, bbox ([x1,y1,x2,y2] normalized), cx, cy
        gap_fill: seconds — gaps smaller than this are bridged
        padding: seconds added before/after each segment
        roi: optional polygon [[x,y],...] normalized 0-1
        video_duration: total video length in seconds
    """
    detections = raw_detections

    if roi and len(roi) >= 3:
        detections = [
            d for d in detections if bbox_overlaps_polygon(d["bbox"], roi)
        ]

    if not detections:
        return []

    detections = sorted(detections, key=lambda d: d["timestamp"])

    # Build contiguous segments
    segments: list[dict] = []
    seg_start = detections[0]["timestamp"]
    seg_end = detections[0]["timestamp"]
    seg_confs = [detections[0]["conf"]]

    for d in detections[1:]:
        if d["timestamp"] - seg_end <= gap_fill:
            seg_end = d["timestamp"]
            seg_confs.append(d["conf"])
        else:
            segments.append(
                {"start": seg_start, "end": seg_end, "confs": seg_confs}
            )
            seg_start = d["timestamp"]
            seg_end = d["timestamp"]
            seg_confs = [d["conf"]]

    segments.append({"start": seg_start, "end": seg_end, "confs": seg_confs})

    clips = []
    for i, seg in enumerate(segments):
        avg_conf = sum(seg["confs"]) / len(seg["confs"])
        start = max(0.0, seg["start"] - padding)
        end = seg["end"] + padding
        if video_duration > 0:
            end = min(end, video_duration)
        clips.append(
            {
                "id": i,
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "avg_conf": round(avg_conf, 3),
                "confidence": confidence_label(avg_conf),
                "keep": True,
            }
        )

    return clips
