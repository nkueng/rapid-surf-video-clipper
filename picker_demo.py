"""
Minimal picker demo — no YOLO, no scanning.
Tests: server starts, browser opens, WebSocket connects,
native file picker works, video metadata reads back.

Run: .venv/bin/python picker_demo.py
"""

import asyncio
import json
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import cv2
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse

app = FastAPI()

HTML = """
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>rapid-surf-video-clipper — file picker demo</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f1117; color: #e5e7eb;
         display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #1a1d27; border: 1px solid #2e3150; border-radius: 10px;
          padding: 36px; width: 480px; display: flex; flex-direction: column; gap: 16px; }
  h2 { font-size: 1.4rem; margin: 0; }
  .row { display: flex; gap: 8px; }
  input { flex: 1; background: #23263a; border: 1px solid #2e3150; border-radius: 5px;
          padding: 9px 12px; color: #e5e7eb; font-family: monospace; font-size: 13px; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { background: #3b82f6; color: #fff; border: none; border-radius: 5px;
           padding: 9px 18px; cursor: pointer; font-size: 14px; font-weight: 500; }
  button.sec { background: #23263a; border: 1px solid #2e3150; color: #e5e7eb; }
  button:hover { opacity: .85; }
  .status { font-size: 13px; color: #6b7280; min-height: 1.2em; }
  .info-box { background: #0f1117; border: 1px solid #2e3150; border-radius: 6px;
              padding: 14px; font-size: 13px; display: none; }
  .info-box.show { display: block; }
  .info-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .info-label { color: #6b7280; }
  .ok { color: #22c55e; font-weight: 600; }
  .err { color: #ef4444; }
  .ws-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
             background: #6b7280; margin-right: 6px; }
  .ws-dot.connected { background: #22c55e; }
</style>
</head>
<body>
<div class="card">
  <h2>rapid-surf-video-clipper &mdash; file picker demo</h2>
  <p class="status"><span class="ws-dot" id="ws-dot"></span><span id="ws-status">Connecting…</span></p>

  <div class="row">
    <input id="path-input" type="text" placeholder="/path/to/video.mp4" spellcheck="false" />
    <button class="sec" id="btn-browse">Browse…</button>
  </div>
  <button id="btn-validate">Validate video →</button>

  <div class="info-box" id="info-box">
    <div class="info-row"><span class="info-label">Path</span><span id="info-path">—</span></div>
    <div class="info-row"><span class="info-label">Resolution</span><span id="info-res">—</span></div>
    <div class="info-row"><span class="info-label">FPS</span><span id="info-fps">—</span></div>
    <div class="info-row"><span class="info-label">Duration</span><span id="info-dur">—</span></div>
    <div class="info-row"><span class="info-label">Frames</span><span id="info-frames">—</span></div>
    <p id="info-ok" class="ok" style="margin:8px 0 0; display:none">✓ Ready to scan</p>
    <p id="info-err" class="err" style="margin:8px 0 0; display:none"></p>
  </div>

  <p class="status" id="bottom-status"></p>
</div>

<script>
let ws;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    document.getElementById('ws-dot').className = 'ws-dot connected';
    document.getElementById('ws-status').textContent = 'Connected';
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'video_info') showInfo(msg);
    if (msg.type === 'error')     showErr(msg.message);
  };
  ws.onclose = () => {
    document.getElementById('ws-dot').className = 'ws-dot';
    document.getElementById('ws-status').textContent = 'Reconnecting…';
    setTimeout(connect, 1500);
  };
}

document.getElementById('btn-browse').addEventListener('click', async () => {
  const res = await fetch('/pick-file');
  if (res.ok) {
    const d = await res.json();
    if (d.path) document.getElementById('path-input').value = d.path;
  }
});

document.getElementById('btn-validate').addEventListener('click', () => {
  const path = document.getElementById('path-input').value.trim();
  if (!path) return;
  document.getElementById('bottom-status').textContent = 'Validating…';
  ws.send(JSON.stringify({ type: 'validate', path }));
});

document.getElementById('path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-validate').click();
});

function showInfo(msg) {
  document.getElementById('bottom-status').textContent = '';
  document.getElementById('info-box').className = 'info-box show';
  document.getElementById('info-path').textContent = msg.path;
  document.getElementById('info-res').textContent = `${msg.width} × ${msg.height}`;
  document.getElementById('info-fps').textContent = `${msg.fps.toFixed(2)}`;
  const m = Math.floor(msg.duration / 60);
  const s = (msg.duration % 60).toFixed(1);
  document.getElementById('info-dur').textContent = `${m}m ${s}s (${msg.duration.toFixed(1)}s)`;
  document.getElementById('info-frames').textContent = msg.total_frames.toLocaleString();
  document.getElementById('info-ok').style.display = 'block';
  document.getElementById('info-err').style.display = 'none';
}

function showErr(message) {
  document.getElementById('bottom-status').textContent = '';
  document.getElementById('info-box').className = 'info-box show';
  document.getElementById('info-ok').style.display = 'none';
  const err = document.getElementById('info-err');
  err.textContent = message;
  err.style.display = 'block';
}

connect();
</script>
</body>
</html>
"""


@app.get("/")
async def index():
    return HTMLResponse(HTML)


@app.get("/pick-file")
async def pick_file():
    script = (
        'POSIX path of (choose file with prompt "Select video file" '
        'of type {"public.movie", "com.apple.quicktime-movie"})'
    )
    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        return JSONResponse({"error": "cancelled"}, status_code=400)
    return JSONResponse({"path": result.stdout.strip()})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            if msg.get("type") == "validate":
                path = msg.get("path", "").strip()
                await _validate_video(ws, path)
    except WebSocketDisconnect:
        pass


async def _validate_video(ws: WebSocket, path: str):
    p = Path(path)
    if not p.exists():
        await ws.send_text(json.dumps({"type": "error", "message": f"File not found: {path}"}))
        return
    if not p.is_file():
        await ws.send_text(json.dumps({"type": "error", "message": "Path is not a file"}))
        return

    loop = asyncio.get_running_loop()

    def read_meta():
        cap = cv2.VideoCapture(str(p))
        if not cap.isOpened():
            return None
        fps = cap.get(cv2.CAP_PROP_FPS)
        w   = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h   = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        n   = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()
        return dict(fps=fps, width=w, height=h, total_frames=n,
                    duration=round(n / fps if fps else 0, 2))

    meta = await loop.run_in_executor(None, read_meta)
    if meta is None:
        await ws.send_text(json.dumps({"type": "error", "message": "OpenCV could not open this file"}))
        return

    await ws.send_text(json.dumps({"type": "video_info", "path": str(p), **meta}))


if __name__ == "__main__":
    port = 8765

    def open_browser():
        time.sleep(0.8)
        webbrowser.open(f"http://localhost:{port}")

    threading.Thread(target=open_browser, daemon=True).start()
    print(f"Picker demo: http://localhost:{port}")
    uvicorn.run(app, host="localhost", port=port, log_level="warning")
