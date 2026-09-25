/* rapid-surf-video-clipper frontend — vanilla JS state machine */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────
const S = {
  phase: 'file-picker',
  clips: [],            // [{id, start, end, duration, avg_conf, confidence, keep}]
  rawDetectionCount: 0,
  videoDuration: 0,
  videoFps: 30,
  roi: null,            // [[x,y],...] normalized 0-1, or null
  // scanning
  detections: [],          // {ts, progress} for each detected frame (used in review timeline)
  scanTiles: [],           // null=unscanned | false=no-hit | true=hit, one per analyzed frame
  scanTotalTiles: 0,
  // export settings
  resolution: 'original',
  crf: 30,              // SVT-AV1 CRF scale is 0-63 (default 30)
  crop: null,           // {x,y,w,h} normalized 0-1, or null for full frame
  cropDraft: null,      // working crop while the editor modal is open
  cropLockAspect: false, // when true, drawing/resizing the crop keeps its ratio
  outputDir: '',
  videoWidth: 0,
  videoHeight: 0,
  selectedExportCards: new Set(),
  folderGroups: {},     // clipId -> folderName
  // timeline
  selectedClip: null,
  dragState: null,      // {clipId, handle:'start'|'end'|'body', startX, origVal}
  // ROI editor
  roiPoints: [],
  roiClosed: false,
  roiPreviewFrames: [], // [{img, dets:[[x1,y1,x2,y2,conf],...]}] streamed sample, looped behind the polygon
  roiPreviewReq: 0,
  roiPreviewLoading: false,
  roiImgNaturalW: 1,
  roiImgNaturalH: 1,
  roiCanvasW: 1,
  roiCanvasH: 1,
  // gap fill / padding
  gapFill: 2.0,
  padding: 1.0,
  // session
  sessionName: '',
  // export screen — clip shown in the top preview player
  exportFocusClipId: null,
  // export size estimate — bytes/sec of output for the current settings, so
  // each card can show rate × its own duration
  sizeRate: 0,
  sizeMode: null,       // 'copy' (exact slice) | 'encode' (sampled) | null
  sizeEstimating: false,
  sizeError: null,
  sizeReqId: 0,
};

// ── WebSocket ─────────────────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;

function wsConnect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { clearTimeout(wsReconnectTimer); };
  ws.onmessage = e => handleMessage(JSON.parse(e.data));
  ws.onclose = () => {
    wsReconnectTimer = setTimeout(wsConnect, 1500);
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// clip.id is just a sequential index reassigned on every scan/reanalyse, so a
// new video (or a reanalyse with different gap-fill/padding) can reuse the
// exact same /thumbnail/<id> URL for a completely different frame. Browsers
// cache <img> requests by URL regardless of Cache-Control in some cases, so
// tie the URL to the clip's actual timing to force a fresh fetch whenever the
// underlying frame changes.
function thumbnailUrl(clip) {
  return `/thumbnail/${clip.id}?t=${clip.start.toFixed(2)}-${clip.end.toFixed(2)}`;
}

// ── Message handling ───────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'state':        handleStateSnapshot(msg);    break;
    case 'video_selected': handleVideoSelected(msg);  break;
    // Ignore stray init messages from a scan the user has since aborted.
    case 'init_start':   if (inScanFlow()) showPhase('initializing'); break;
    case 'init_done':    if (inScanFlow()) showPhase('scanning');     break;
    case 'frame':        handleFrame(msg);             break;
    case 'scan_done':    handleScanDone(msg);          break;
    case 'clips_updated': handleClipsUpdated(msg);    break;
    case 'export_progress': handleExportProgress(msg); break;
    case 'export_done':  handleExportDone(msg);        break;
    case 'size_estimate': handleSizeEstimate(msg);     break;
    case 'roi_preview_frame': handleRoiPreviewFrame(msg);  break;
    case 'roi_preview_done':  handleRoiPreviewDone(msg);   break;
    case 'error':        showError(msg.message);       break;
  }
}

function handleStateSnapshot(msg) {
  S.phase = msg.phase;
  if ('session_name' in msg) S.sessionName = msg.session_name || '';
  if ('folder_groups' in msg) S.folderGroups = msg.folder_groups || {};
  if ('roi' in msg) S.roi = msg.roi || null;
  if (msg.clips)          { S.clips = msg.clips; S.videoDuration = msg.video_duration; S.videoFps = msg.video_fps; S.roi = msg.roi || null; }
  if (msg.video_width)  S.videoWidth = msg.video_width;
  if (msg.video_height) S.videoHeight = msg.video_height;
  if (msg.detection_timestamps) {
    const dur = msg.video_duration || S.videoDuration || 1;
    S.detections = msg.detection_timestamps.map(ts => ({ ts, progress: ts / dur }));
  }
  if (msg.progress != null) {
    const frameNum = msg.total_frames ? Math.round(msg.progress * msg.total_frames) : 0;
    updateScanProgress(msg.progress, frameNum, msg.total_frames || 0);

    if (msg.total_frames && msg.frame_step) {
      S.scanTotalTiles = Math.ceil(msg.total_frames / msg.frame_step);
      S.scanTiles = new Array(S.scanTotalTiles).fill(null);
      const scannedCount = Math.round(msg.progress * S.scanTotalTiles);
      for (let i = 0; i < scannedCount; i++) S.scanTiles[i] = false;
      if (msg.detection_tiles) {
        for (const idx of msg.detection_tiles) {
          if (idx < S.scanTotalTiles) S.scanTiles[idx] = true;
        }
      }
      drawScanTiles();
    }
  }

  if (msg.phase === 'session-prompt') {
    // Seed the field from server state, but never overwrite what the user is
    // currently typing — a late or reconnect snapshot must not wipe it.
    const nameInput = document.getElementById('session-name-input');
    if (document.activeElement !== nameInput && !nameInput.value.trim()) {
      nameInput.value = S.sessionName || '';
    }
    syncSessionContinueEnabled();
    showPhase('session-prompt');
  }
  else if (msg.phase === 'file-picker') { showPhase('file-picker'); }
  else if (msg.phase === 'roi-prompt') {
    S.videoDuration = msg.video_duration || S.videoDuration;
    S.videoFps = msg.video_fps || S.videoFps;
    showPhase('roi-prompt');
    if (msg.roi_first) openRoiEditor('pre-scan');
  }
  else if (msg.phase === 'scanning') { showPhase('scanning'); }
  else if (msg.phase === 'review') { showPhase('review'); renderReview(); }
  else if (msg.phase === 'export-settings') { showPhase('export-settings'); renderExportSettings(); }
  else if (msg.phase === 'exporting') { showPhase('exporting'); }
  else if (msg.phase === 'done') { showPhase('done'); }
}

// ── Phase rendering ────────────────────────────────────────────────────────
const phases = ['session-prompt','file-picker','roi-prompt','initializing','scanning','review','export-settings','exporting','done'];

// Shared, browser-visible name for every view (shown in the corner badge and
// the page/tab title). Keep these labels stable so screens can be referred to
// by name. Modals reuse the same mechanism via setModalView().
const VIEW_NAMES = {
  'session-prompt':  'Session name',
  'file-picker':     'Select video',
  'roi-prompt':      'Detection zone',
  'initializing':    'Loading model',
  'scanning':        'Scanning',
  'review':          'Review clips',
  'export-settings': 'Export settings',
  'exporting':       'Exporting',
  'done':            'Done',
};
// Step numbers for the main linear flow (transient states stay unnumbered).
const VIEW_STEPS = {
  'session-prompt': 1, 'file-picker': 2, 'roi-prompt': 3,
  'scanning': 4, 'review': 5, 'export-settings': 6,
};

let baseView = { step: null, label: '' };  // current phase, restored when a modal closes

function renderBadge({ step, label }) {
  const badge = document.getElementById('view-badge');
  if (badge) {
    badge.innerHTML = '';
    badge.classList.toggle('is-empty', !step && !label);
    badge.classList.toggle('has-step', !!step);
    if (step) {
      const s = document.createElement('span');
      s.className = 'view-badge-step';
      s.textContent = step;
      badge.appendChild(s);
    }
    if (label) {
      const l = document.createElement('span');
      l.className = 'view-badge-label';
      l.textContent = label;
      badge.appendChild(l);
    }
  }
  document.title = label ? `${label} — rapid-surf-video-clipper` : 'rapid-surf-video-clipper';
}
function setPhaseView(name) {
  baseView = { step: VIEW_STEPS[name] || null, label: VIEW_NAMES[name] || name };
  renderBadge(baseView);
}
function setModalView(text) { renderBadge({ step: null, label: text }); }
function clearModalView() { renderBadge(baseView); }

function handleVideoSelected(msg) {
  S.videoDuration = msg.video_duration || 0;
  S.videoFps = msg.video_fps || 30;
  S.roi = null;
  showPhase('roi-prompt');
  if (msg.roi_first) openRoiEditor('pre-scan');
}

function showPhase(name) {
  S.phase = name;
  phases.forEach(p => {
    const el = document.getElementById(`phase-${p}`);
    if (el) el.hidden = (p !== name);
  });
  setPhaseView(name);
  if (name !== 'export-settings') {
    const ep = document.getElementById('export-preview');
    if (ep) ep.pause();
  }
  if (name === 'review') renderReview();
  if (name === 'export-settings') renderExportSettings();
}

// ── Scan frame display ─────────────────────────────────────────────────────
const scanCanvas = document.getElementById('scan-canvas');
const scanCtx = scanCanvas.getContext('2d');

function handleFrame(msg) {
  if (S.phase !== 'scanning') return;

  const dets = msg.detections || [];
  const roiActive = S.roi && S.roi.length >= 3;
  // A frame only counts as a hit (green tile) when a detection's bbox centre
  // is inside the ROI — matching how clips are built.
  const inRoi = d => !roiActive || d.in_roi;
  const hasRoiHit = dets.some(inRoi);

  // Initialise tile array once we know the dimensions
  if (!S.scanTotalTiles && msg.total_frames && msg.frame_step) {
    S.scanTotalTiles = Math.ceil(msg.total_frames / msg.frame_step);
    S.scanTiles = new Array(S.scanTotalTiles).fill(null);
  }
  // Record tile result
  if (S.scanTotalTiles && msg.frame_step) {
    const tileIdx = msg.frame_num / msg.frame_step;
    if (tileIdx < S.scanTotalTiles) S.scanTiles[tileIdx] = hasRoiHit;
  }

  if (hasRoiHit) {
    S.detections.push({ ts: msg.timestamp, progress: msg.progress });
  }

  updateScanProgress(msg.progress, msg.frame_num, msg.total_frames);
  drawScanTiles();

  const img = new Image();
  img.onload = () => {
    scanCanvas.width  = msg.frame_w || img.naturalWidth;
    scanCanvas.height = msg.frame_h || img.naturalHeight;
    scanCtx.drawImage(img, 0, 0);

    drawScanRoi();

    scanCtx.lineWidth = 2;
    scanCtx.font = '12px monospace';
    for (const d of dets) {
      // Detections outside the ROI are drawn dim — they don't produce clips.
      const active = inRoi(d);
      scanCtx.strokeStyle = active ? '#22c55e' : '#6b7280';
      scanCtx.fillStyle   = active ? '#22c55e' : '#6b7280';
      scanCtx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
      scanCtx.fillText(`${Math.round(d.conf * 100)}%`, d.x1 + 2, d.y1 - 4);
    }
  };
  img.src = `data:image/jpeg;base64,${msg.frame_b64}`;
}

// Keep the detection zone visible on the live scan frame so it's clear the
// scan is constrained to it. Points are normalized (0-1) to the frame.
function drawScanRoi() {
  if (!S.roi || S.roi.length < 3) return;
  const W = scanCanvas.width;
  const H = scanCanvas.height;

  scanCtx.save();
  scanCtx.beginPath();
  scanCtx.moveTo(S.roi[0][0] * W, S.roi[0][1] * H);
  for (let i = 1; i < S.roi.length; i++) {
    scanCtx.lineTo(S.roi[i][0] * W, S.roi[i][1] * H);
  }
  scanCtx.closePath();
  scanCtx.fillStyle = 'rgba(34,197,94,0.12)';
  scanCtx.fill();
  scanCtx.strokeStyle = '#22c55e';
  scanCtx.lineWidth = 2;
  scanCtx.setLineDash([6, 4]);
  scanCtx.stroke();
  scanCtx.restore();
}

function updateScanProgress(progress, frameNum, totalFrames) {
  if (totalFrames > 0) {
    document.getElementById('scan-label').textContent = `Frame ${frameNum} / ${totalFrames}`;
  }
  document.getElementById('scan-pct').textContent = `${Math.round(progress * 100)}%`;
}

function drawScanTiles() {
  const canvas = document.getElementById('detection-overlay');
  const track = canvas.parentElement;
  canvas.width = track.clientWidth;
  canvas.height = track.clientHeight;
  const ctx = canvas.getContext('2d');
  const n = S.scanTotalTiles;
  if (!n) return;

  for (let i = 0; i < n; i++) {
    const tile = S.scanTiles[i];
    ctx.fillStyle = tile === null ? '#1a1d27' : (tile ? '#22c55e' : '#3b82f6');
    const x0 = Math.round(i * canvas.width / n);
    const x1 = Math.round((i + 1) * canvas.width / n);
    ctx.fillRect(x0, 0, x1 - x0, canvas.height);
  }
}

// True while the scan pipeline is the expected owner of the screen — used to
// drop late init/frame/done messages after an abort has sent us back.
function inScanFlow() {
  return S.phase === 'initializing' || S.phase === 'scanning';
}

// ── Scan done ─────────────────────────────────────────────────────────────
function handleScanDone(msg) {
  if (!inScanFlow()) return;
  S.clips = msg.clips;
  S.rawDetectionCount = msg.raw_detection_count;
  S.videoDuration = msg.video_duration;
  S.videoFps = msg.video_fps;
  S.roi = msg.roi || null;
  S.videoWidth = msg.video_width || S.videoWidth;
  S.videoHeight = msg.video_height || S.videoHeight;
  if ('session_name' in msg) S.sessionName = msg.session_name || '';
  S.outputDir = msg.default_output_dir || '';
  showPhase(msg.phase || 'review');
}

function handleClipsUpdated(msg) {
  S.clips = msg.clips;
  renderReview();
}

// ── Timeline ──────────────────────────────────────────────────────────────
const tlCanvas = document.getElementById('timeline-canvas');
const tlCtx = tlCanvas.getContext('2d');
const HANDLE_W = 8;
let tlHoverTs = null;
const reviewPreview = document.getElementById('review-preview');
let previewClip = null;

// Loop clip playback when a thumbnail is hovered
reviewPreview.addEventListener('timeupdate', () => {
  if (previewClip && reviewPreview.currentTime >= previewClip.end - 0.05) {
    reviewPreview.currentTime = previewClip.start;
  }
});
const CLIP_COLORS = { high: '#22c55e', medium: '#eab308', low: '#ef4444', default: '#3b82f6' };
const CLIP_ALPHA = 0.55;

function tsToX(ts) {
  return (ts / Math.max(S.videoDuration, 1)) * tlCanvas.width;
}
function xToTs(x) {
  return (x / tlCanvas.width) * S.videoDuration;
}

function drawTimeline() {
  const W = tlCanvas.offsetWidth;
  const H = tlCanvas.offsetHeight;
  tlCanvas.width = W;
  tlCanvas.height = H;
  const ctx = tlCtx;

  // Background
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);

  // Time ticks
  const interval = niceInterval(S.videoDuration);
  ctx.fillStyle = '#374151';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  for (let t = 0; t <= S.videoDuration; t += interval) {
    const x = tsToX(t);
    ctx.fillStyle = '#374151';
    ctx.fillRect(x, 0, 1, H);
    ctx.fillStyle = '#6b7280';
    ctx.fillText(fmtTime(t), x, H - 4);
  }

  // Raw detection density — dominant, spans most of canvas height
  if (S.detections.length) {
    ctx.fillStyle = 'rgba(59,130,246,0.5)';
    for (const d of S.detections) {
      const x = tsToX(d.ts);
      ctx.fillRect(x - 2, 0, 5, H * 0.82);
    }
  }

  // Clip bands — narrow strip at the bottom
  const clipTop = H * 0.55;
  const clipH   = H * 0.30;
  const handleTop = clipTop - 4;
  const handleH   = clipH + 8;

  for (const clip of S.clips) {
    const x1 = tsToX(clip.start);
    const x2 = tsToX(clip.end);
    const color = CLIP_COLORS[clip.confidence] || CLIP_COLORS.default;
    const isSelected = S.selectedClip === clip.id;

    ctx.globalAlpha = clip.keep ? 0.92 : 0.25;
    ctx.fillStyle = color;
    ctx.fillRect(x1, clipTop, x2 - x1, clipH);
    ctx.globalAlpha = 1;

    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, clipTop, x2 - x1, clipH);
    }

    // Drag handles
    ctx.fillStyle = isSelected ? '#fff' : color;
    ctx.globalAlpha = 1;
    ctx.fillRect(x1 - HANDLE_W / 2, handleTop, HANDLE_W, handleH);
    ctx.fillRect(x2 - HANDLE_W / 2, handleTop, HANDLE_W, handleH);

    // Clip number label
    const mid = (x1 + x2) / 2;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.globalAlpha = clip.keep ? 1 : 0.4;
    if (x2 - x1 > 24) ctx.fillText(clip.id + 1, mid, clipTop + clipH * 0.68);
    ctx.globalAlpha = 1;
  }

  // Hover cursor line
  if (tlHoverTs !== null) {
    const cx = tsToX(tlHoverTs);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();
    ctx.restore();
  }
}

function niceInterval(duration) {
  if (duration <= 60)  return 10;
  if (duration <= 300) return 30;
  if (duration <= 600) return 60;
  return 120;
}

// Timeline interaction
tlCanvas.addEventListener('mousedown', e => {
  const rect = tlCanvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (tlCanvas.width / rect.width);
  const ts = xToTs(mx);

  // Check handle hits first
  for (const clip of S.clips) {
    const xs = tsToX(clip.start);
    const xe = tsToX(clip.end);
    if (Math.abs(mx - xs) < HANDLE_W) {
      S.dragState = { clipId: clip.id, handle: 'start', startX: mx, origVal: clip.start };
      selectClip(clip.id);
      return;
    }
    if (Math.abs(mx - xe) < HANDLE_W) {
      S.dragState = { clipId: clip.id, handle: 'end', startX: mx, origVal: clip.end };
      selectClip(clip.id);
      return;
    }
    if (ts >= clip.start && ts <= clip.end) {
      S.dragState = { clipId: clip.id, handle: 'body', startX: mx, origStart: clip.start, origEnd: clip.end, origDur: clip.end - clip.start, moved: false };
      selectClip(clip.id, { scroll: true });
      return;
    }
  }
  selectClip(null);
});

tlCanvas.addEventListener('mousemove', e => {
  const rect = tlCanvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (tlCanvas.width / rect.width);

  if (S.dragState) {
    const delta = xToTs(mx - S.dragState.startX);
    const clip = S.clips.find(c => c.id === S.dragState.clipId);
    if (!clip) return;

    if (S.dragState.handle === 'start') {
      clip.start = Math.max(0, Math.min(S.dragState.origVal + delta, clip.end - 0.5));
      clip.start = Math.round(clip.start * 10) / 10;
    } else if (S.dragState.handle === 'end') {
      clip.end = Math.min(S.videoDuration, Math.max(S.dragState.origVal + delta, clip.start + 0.5));
      clip.end = Math.round(clip.end * 10) / 10;
    } else if (S.dragState.handle === 'body') {
      // Below a small pixel threshold, treat this as a still-pending click
      // rather than a drag — mouseup will toggle keep/reject instead of
      // moving the clip. Once past it, it's a real drag.
      if (!S.dragState.moved && Math.abs(mx - S.dragState.startX) < 4) return;
      S.dragState.moved = true;
      const newStart = Math.max(0, S.dragState.origStart + delta);
      const newEnd = newStart + S.dragState.origDur;
      if (newEnd <= S.videoDuration) {
        clip.start = Math.round(newStart * 10) / 10;
        clip.end = Math.round(newEnd * 10) / 10;
      }
    }
    clip.duration = Math.round((clip.end - clip.start) * 10) / 10;
    drawTimeline();
    updateClipCard(clip);

    // Skim the preview to the handle being moved
    const skimTs = S.dragState.handle === 'end' ? clip.end : clip.start;
    reviewPreview.pause();
    reviewPreview.currentTime = skimTs;
  } else {
    tlHoverTs = xToTs(mx);
    previewClip = null;
    reviewPreview.pause();
    reviewPreview.currentTime = tlHoverTs;
    drawTimeline();
  }
});

tlCanvas.addEventListener('mouseleave', () => {
  if (!S.dragState) {
    tlHoverTs = null;
    drawTimeline(); // clears cursor line; video keeps last frame
  }
});

tlCanvas.addEventListener('mouseup', () => {
  if (S.dragState) {
    const clip = S.clips.find(c => c.id === S.dragState.clipId);
    if (clip) {
      if (S.dragState.handle === 'body' && !S.dragState.moved) {
        // A plain click on the clip band (no drag) toggles keep/reject.
        toggleClipKeep(clip.id);
      } else {
        wsSend({ type: 'update_clip', id: clip.id, start: clip.start, end: clip.end });
      }
    }
  }
  S.dragState = null;
});

// ── Review rendering ───────────────────────────────────────────────────────
function renderReview() {
  if (!reviewPreview.src || !reviewPreview.src.endsWith('/video')) {
    reviewPreview.src = '/video';
  }
  // requestAnimationFrame ensures the div is visible and laid out before
  // drawTimeline reads offsetWidth, which would be 0 if read synchronously
  // right after removing the `hidden` attribute.
  requestAnimationFrame(drawTimeline);
  renderClipList();
  updateClipCount();
  updateRoiStatus();
}

function renderClipList() {
  const list = document.getElementById('clip-list');
  list.innerHTML = '';
  for (const clip of S.clips) {
    list.appendChild(makeClipCard(clip));
  }
}

function makeClipCard(clip) {
  const card = document.createElement('div');
  card.className = `clip-card${clip.keep ? '' : ' rejected'}${S.selectedClip === clip.id ? ' selected' : ''}`;
  card.dataset.clipId = clip.id;

  // Hovering anywhere on the tile (not just the thumbnail) drives the top
  // preview player. mouseenter/mouseleave don't bubble, so this fires once
  // per tile visit regardless of which child element is under the cursor.
  card.addEventListener('mouseenter', () => {
    previewClip = clip;
    reviewPreview.currentTime = clip.start;
    reviewPreview.play().catch(() => {});
  });
  card.addEventListener('mouseleave', () => {
    previewClip = null;
    reviewPreview.pause();
  });

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  const thumb = document.createElement('img');
  thumb.className = 'clip-thumb';
  thumb.src = thumbnailUrl(clip);
  thumb.alt = '';
  thumbWrap.appendChild(thumb);

  // Same number as the label drawn on this clip's band in the timeline.
  const num = document.createElement('div');
  num.className = 'clip-num';
  num.textContent = clip.id + 1;
  thumbWrap.appendChild(num);

  const badge = document.createElement('span');
  badge.className = `conf-badge conf-${clip.confidence}`;
  badge.textContent = clip.confidence;
  thumbWrap.appendChild(badge);

  // Keep/reject toggle — big, centered over the thumbnail so it reads as
  // the primary action on the tile.
  const keepBtn = document.createElement('button');
  keepBtn.className = `btn-keep ${clip.keep ? 'keep' : 'reject'}`;
  keepBtn.textContent = clip.keep ? 'Keep' : 'Rejected';
  keepBtn.addEventListener('click', ev => {
    ev.stopPropagation();
    toggleClipKeep(clip.id);
  });
  thumbWrap.appendChild(keepBtn);

  const info = document.createElement('div');
  info.className = 'clip-info';

  const times = document.createElement('div');
  times.className = 'clip-times';
  times.textContent = `${fmtTime(clip.start)} – ${fmtTime(clip.end)}`;
  times.dataset.field = 'times';

  const dur = document.createElement('div');
  dur.className = 'clip-duration';
  dur.textContent = `${clip.duration.toFixed(1)}s`;
  dur.dataset.field = 'duration';

  info.append(times, dur);

  const controls = document.createElement('div');
  controls.className = 'clip-controls';

  // Nudge controls — chevrons instead of "-1"/"+0.5" text pills: chevron
  // count signals step size (single = 0.5s, double = 1s), direction signals
  // sign. The exact amount is still available as a tooltip.
  const NUDGE_SYMBOLS = { '-1': '«', '-0.5': '‹', '0.5': '›', '1': '»' };
  for (const [field, label] of [['start','Start'],['end','End']]) {
    const row = document.createElement('div');
    row.className = 'nudge-row';
    const lbl = document.createElement('span');
    lbl.className = 'label';
    lbl.textContent = label;
    row.appendChild(lbl);
    for (const delta of [-1, -0.5, 0.5, 1]) {
      const btn = document.createElement('button');
      btn.className = 'btn-nudge' + (delta === 0.5 ? ' nudge-gap' : '');
      btn.textContent = NUDGE_SYMBOLS[String(delta)];
      const signed = `${delta > 0 ? '+' : ''}${delta}s`;
      btn.title = signed;
      btn.setAttribute('aria-label', `${label} ${signed}`);
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        nudgeClip(clip.id, field, delta);
      });
      row.appendChild(btn);
    }
    controls.appendChild(row);
  }

  card.append(thumbWrap, info, controls);
  card.addEventListener('click', () => selectClip(clip.id));
  return card;
}

// Flips a clip's keep/reject state and patches the DOM in place — shared by
// the tile's own button and a plain (non-drag) click on its timeline band.
function toggleClipKeep(clipId) {
  const clip = S.clips.find(c => c.id === clipId);
  if (!clip) return;
  clip.keep = !clip.keep;
  wsSend({ type: 'update_clip', id: clip.id, keep: clip.keep });
  const card = document.querySelector(`.clip-card[data-clip-id="${clip.id}"]`);
  if (card) {
    card.classList.toggle('rejected', !clip.keep);
    const keepBtn = card.querySelector('.btn-keep');
    if (keepBtn) {
      keepBtn.className = `btn-keep ${clip.keep ? 'keep' : 'reject'}`;
      keepBtn.textContent = clip.keep ? 'Keep' : 'Rejected';
    }
  }
  updateClipCount();
  drawTimeline();
}

// Single source of truth for "which clip is selected", keeping the timeline
// band and its list card highlighted together (click either, both light up).
function selectClip(id, { scroll = false } = {}) {
  S.selectedClip = id;
  document.querySelectorAll('.clip-card').forEach(c =>
    c.classList.toggle('selected', id !== null && +c.dataset.clipId === id));
  drawTimeline();
  if (scroll && id !== null) scrollToClip(id);
}

function updateClipCard(clip) {
  const card = document.querySelector(`.clip-card[data-clip-id="${clip.id}"]`);
  if (!card) return;
  const times = card.querySelector('[data-field="times"]');
  const dur   = card.querySelector('[data-field="duration"]');
  if (times) times.textContent = `${fmtTime(clip.start)} – ${fmtTime(clip.end)}`;
  if (dur)   dur.textContent   = `${clip.duration.toFixed(1)}s`;
}

function nudgeClip(clipId, field, delta) {
  const clip = S.clips.find(c => c.id === clipId);
  if (!clip) return;
  if (field === 'start') {
    clip.start = Math.max(0, Math.round((clip.start + delta) * 10) / 10);
    if (clip.start >= clip.end) clip.start = Math.max(0, clip.end - 0.1);
  } else {
    clip.end = Math.min(S.videoDuration, Math.round((clip.end + delta) * 10) / 10);
    if (clip.end <= clip.start) clip.end = clip.start + 0.1;
  }
  clip.duration = Math.round((clip.end - clip.start) * 10) / 10;
  wsSend({ type: 'update_clip', id: clip.id, start: clip.start, end: clip.end });
  drawTimeline();
  updateClipCard(clip);
}

function updateClipCount() {
  const n = S.clips.filter(c => c.keep).length;
  document.getElementById('clip-count-label').textContent = `${n} clip${n !== 1 ? 's' : ''} approved`;
  const exportBtn = document.getElementById('btn-export');
  if (exportBtn) {
    const countEl = document.getElementById('export-count');
    if (countEl) countEl.textContent = n;
  }
}

function scrollToClip(id) {
  const card = document.querySelector(`.clip-card[data-clip-id="${id}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateRoiStatus() {
  const status = document.getElementById('roi-status');
  const clearBtn = document.getElementById('btn-clear-roi');
  if (S.roi && S.roi.length >= 3) {
    status.textContent = 'Active';
    status.className = 'roi-status roi-on';
    clearBtn.hidden = false;
  } else {
    status.textContent = 'None';
    status.className = 'roi-status roi-off';
    clearBtn.hidden = true;
  }
}

// ── Analysis settings events ───────────────────────────────────────────────
document.getElementById('gap-fill').addEventListener('input', e => {
  S.gapFill = +e.target.value;
  document.getElementById('gap-fill-val').textContent = `${S.gapFill.toFixed(1)} s`;
});
document.getElementById('padding').addEventListener('input', e => {
  S.padding = +e.target.value;
  document.getElementById('padding-val').textContent = `${S.padding.toFixed(1)} s`;
});
document.getElementById('btn-reanalyse').addEventListener('click', () => {
  wsSend({ type: 'reanalyse', gap_fill: S.gapFill, padding: S.padding, roi: S.roi });
});
document.getElementById('btn-clear-roi').addEventListener('click', () => {
  S.roi = null;
  updateRoiStatus();
});

// ── ROI editor ─────────────────────────────────────────────────────────────
// The backdrop is a short annotated sample streamed from the server — the same
// frame-by-frame person detection shown while scanning — looped here so people
// are visible while the zone is drawn.
const roiModal    = document.getElementById('roi-modal');
const roiCanvas   = document.getElementById('roi-canvas');
const roiBgCanvas = document.getElementById('roi-bg-canvas');
const roiCtx      = roiCanvas.getContext('2d');
const roiBgCtx    = roiBgCanvas.getContext('2d');
const CLOSE_DIST  = 14;  // px — click this close to the first point to close
const VERTEX_HIT  = 11;  // px — grab radius for dragging an existing vertex
const ROI_PREVIEW_FPS = 4;   // playback rate; matches server ROI_PREVIEW_FPS

let roiRaf = null;       // rAF handle for preview playback + overlay repaint
let roiPlayStart = 0;    // performance.now() when the current loop pass began
let roiDrag = null;      // { index, moved } while a vertex is being dragged
let roiSuppressClick = false;  // true after a drag, to swallow the trailing click

function roiPlaybackTick() {
  if (roiModal.hidden) { roiRaf = null; return; }
  drawRoiBg();
  drawRoi();
  roiRaf = requestAnimationFrame(roiPlaybackTick);
}
function stopRoiOverlay() {
  if (roiRaf) { cancelAnimationFrame(roiRaf); roiRaf = null; }
}
function closeRoiPreview() {
  stopRoiOverlay();
  roiDrag = null;
  roiSuppressClick = false;
  S.roiPreviewReq += 1;            // invalidate frames still in flight
  S.roiPreviewFrames = [];
  S.roiPreviewLoading = false;
  wsSend({ type: 'roi_preview_cancel' });
}

document.getElementById('btn-edit-roi').addEventListener('click', () => openRoiEditor('review'));
document.getElementById('btn-roi-cancel').addEventListener('click', () => {
  roiModal.hidden = true;
  closeRoiPreview();
  clearModalView();
});
document.getElementById('btn-roi-reset').addEventListener('click', resetRoi);
document.getElementById('btn-roi-apply').addEventListener('click', applyRoi);

document.addEventListener('keydown', e => {
  if (!roiModal.hidden && e.key === 'r') resetRoi();
});

function openRoiEditor(context = 'review') {
  S.roiEditorContext = context;
  setModalView('Detection zone editor');

  // Sample a ~20 s window: around the first approved clip after a scan,
  // otherwise 10% into the footage.
  const clip = S.clips.filter(c => c.keep)[0];
  let start;
  if (clip) start = Math.max(0, clip.start - 2);
  else if (S.videoDuration > 0) start = S.videoDuration * 0.1;
  else start = 0;
  const end = S.videoDuration > 0 ? Math.min(S.videoDuration, start + 20) : start + 20;

  // Fresh polygon state each open; sizeRoiOverlayCanvas() seeds it from S.roi.
  S.roiPoints = [];
  S.roiClosed = false;

  S.roiPreviewFrames = [];
  S.roiPreviewLoading = true;
  S.roiPreviewReq += 1;
  const arH = (S.videoWidth && S.videoHeight)
    ? Math.round(640 * S.videoHeight / S.videoWidth) : 360;
  roiBgCanvas.width = 640;
  roiBgCanvas.height = arH;
  wsSend({ type: 'roi_preview_detect', req_id: S.roiPreviewReq, start, end });

  roiModal.hidden = false;
  roiPlayStart = performance.now();
  sizeRoiOverlayCanvas();
  stopRoiOverlay();
  roiRaf = requestAnimationFrame(roiPlaybackTick);
}

// Keep the transparent polygon canvas the same rendered size as the backdrop.
function sizeRoiOverlayCanvas() {
  if (roiModal.hidden) return;
  const w = roiBgCanvas.clientWidth;
  const h = roiBgCanvas.clientHeight;
  if (!w || !h) { requestAnimationFrame(sizeRoiOverlayCanvas); return; }
  const hadPoints = S.roiPoints && S.roiPoints.length > 0;
  roiCanvas.width = w;
  roiCanvas.height = h;
  roiCanvas.style.width = w + 'px';
  roiCanvas.style.height = h + 'px';
  // Seed from an existing zone (stored normalised), but never clobber points
  // the user is already placing — a late resize must not wipe them.
  if (!hadPoints) {
    S.roiPoints = S.roi ? S.roi.map(([x, y]) => [x * w, y * h]) : [];
    S.roiClosed = S.roiPoints.length >= 3;
  }
}

function handleRoiPreviewFrame(msg) {
  if (msg.req_id !== S.roiPreviewReq) return;
  if (!S.roiPreviewFrames) S.roiPreviewFrames = [];
  const img = new Image();
  img.src = `data:image/jpeg;base64,${msg.b64}`;
  S.roiPreviewFrames.push({ img, dets: msg.detections || [] });
  if (S.roiPreviewFrames.length === 1) {
    roiBgCanvas.width = msg.frame_w;
    roiBgCanvas.height = msg.frame_h;
    sizeRoiOverlayCanvas();
    roiPlayStart = performance.now();
  }
}
function handleRoiPreviewDone(msg) {
  if (msg.req_id !== S.roiPreviewReq) return;
  S.roiPreviewLoading = false;
}

// Current sample frame + its detection boxes on the backdrop. Box colour
// matches the scan view: green inside the closed zone, grey outside.
function drawRoiBg() {
  const W = roiBgCanvas.width, H = roiBgCanvas.height;
  const frames = S.roiPreviewFrames;

  roiBgCtx.fillStyle = '#000';
  roiBgCtx.fillRect(0, 0, W, H);

  if (!frames || !frames.length) {
    if (S.roiPreviewLoading) {
      roiBgCtx.fillStyle = '#e5e7eb';
      roiBgCtx.font = '13px sans-serif';
      roiBgCtx.fillText('Loading preview…', 16, 28);
    }
    return;
  }

  const elapsed = (performance.now() - roiPlayStart) / 1000;
  let idx = Math.floor(elapsed * ROI_PREVIEW_FPS);
  if (idx >= frames.length) { roiPlayStart = performance.now(); idx = 0; }
  const f = frames[idx];
  if (f.img.complete && f.img.naturalWidth) {
    roiBgCtx.drawImage(f.img, 0, 0, W, H);
  }

  const poly = (S.roiClosed && S.roiPoints.length >= 3)
    ? S.roiPoints.map(([x, y]) => [x / roiCanvas.width, y / roiCanvas.height])
    : null;
  roiBgCtx.lineWidth = 2;
  roiBgCtx.font = '12px monospace';
  for (const d of f.dets) {
    const cx = (d[0] + d[2]) / 2, cy = (d[1] + d[3]) / 2;
    const inside = !poly || pointInPoly(cx, cy, poly);
    roiBgCtx.strokeStyle = roiBgCtx.fillStyle = inside ? '#22c55e' : '#6b7280';
    roiBgCtx.strokeRect(d[0] * W, d[1] * H, (d[2] - d[0]) * W, (d[3] - d[1]) * H);
    roiBgCtx.fillText(`${Math.round(d[4] * 100)}%`, d[0] * W + 2, d[1] * H - 4);
  }
}

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function resetRoi() {
  S.roiPoints = [];
  S.roiClosed = false;
  roiDrag = null;
  drawRoi();
}

function applyRoi() {
  if (S.roiPoints.length >= 3) {
    const w = roiCanvas.width;
    const h = roiCanvas.height;
    S.roi = S.roiPoints.map(([x,y]) => [x / w, y / h]);
  }
  roiModal.hidden = true;
  closeRoiPreview();
  clearModalView();
  if (S.roiEditorContext === 'pre-scan') {
    showPhase('initializing');
    wsSend({ type: 'begin_scan', roi: S.roi });
  } else {
    updateRoiStatus();
  }
}

function roiEventXY(e) {
  const rect = roiCanvas.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

// Index of the vertex under (x, y), or -1.
function roiVertexAt(x, y) {
  for (let i = 0; i < S.roiPoints.length; i++) {
    const [vx, vy] = S.roiPoints[i];
    if (Math.hypot(x - vx, y - vy) <= VERTEX_HIT) return i;
  }
  return -1;
}

roiCanvas.addEventListener('click', e => {
  if (roiSuppressClick) { roiSuppressClick = false; return; }
  if (S.roiClosed) return;
  const [x, y] = roiEventXY(e);

  if (S.roiPoints.length >= 3) {
    const [fx, fy] = S.roiPoints[0];
    if (Math.hypot(x - fx, y - fy) < CLOSE_DIST) {
      S.roiClosed = true;
      drawRoi();
      return;
    }
  }
  S.roiPoints.push([x, y]);
  drawRoi();
});

// Vertices stay draggable after the polygon is closed (and while drawing it).
roiCanvas.addEventListener('mousedown', e => {
  roiSuppressClick = false;
  const [x, y] = roiEventXY(e);
  const idx = roiVertexAt(x, y);
  if (idx !== -1) {
    roiDrag = { index: idx, moved: false };
    e.preventDefault();
  }
});

roiCanvas.addEventListener('mousemove', e => {
  if (roiDrag) return;
  const [x, y] = roiEventXY(e);
  roiCanvas.style.cursor = roiVertexAt(x, y) !== -1 ? 'move' : 'crosshair';
});

window.addEventListener('mousemove', e => {
  if (!roiDrag) return;
  const [px, py] = roiEventXY(e);
  const x = Math.max(0, Math.min(roiCanvas.width, px));
  const y = Math.max(0, Math.min(roiCanvas.height, py));
  S.roiPoints[roiDrag.index] = [x, y];
  roiDrag.moved = true;
  drawRoi();
});

window.addEventListener('mouseup', () => {
  if (!roiDrag) return;
  if (roiDrag.moved) roiSuppressClick = true;   // don't add a point on release
  roiDrag = null;
});

function drawRoi() {
  const W = roiCanvas.width;
  const H = roiCanvas.height;
  roiCtx.clearRect(0, 0, W, H);
  if (!S.roiPoints.length) return;

  roiCtx.beginPath();
  roiCtx.moveTo(S.roiPoints[0][0], S.roiPoints[0][1]);
  for (let i = 1; i < S.roiPoints.length; i++) {
    roiCtx.lineTo(S.roiPoints[i][0], S.roiPoints[i][1]);
  }
  if (S.roiClosed) {
    roiCtx.closePath();
    roiCtx.fillStyle = 'rgba(34,197,94,0.25)';
    roiCtx.fill();
  }
  roiCtx.strokeStyle = '#22c55e';
  roiCtx.lineWidth = 2;
  roiCtx.stroke();

  // Vertices — drawn as grab handles; a touch larger once the polygon is
  // closed so they're easy to pick up and drag.
  const r = S.roiClosed ? 6 : 4;
  for (let i = 0; i < S.roiPoints.length; i++) {
    const [x, y] = S.roiPoints[i];
    roiCtx.beginPath();
    roiCtx.arc(x, y, i === 0 && !S.roiClosed ? r + 2 : r, 0, Math.PI * 2);
    roiCtx.fillStyle = (i === 0 && !S.roiClosed) ? '#22c55e' : '#fff';
    roiCtx.strokeStyle = '#0f1117';
    roiCtx.lineWidth = 2;
    roiCtx.fill();
    roiCtx.stroke();
  }
}

// ── Crop editor ────────────────────────────────────────────────────────────
const cropModal   = document.getElementById('crop-modal');
const cropCanvas  = document.getElementById('crop-canvas');
const cropBgVideo = document.getElementById('crop-bg-video');
const cropCtx     = cropCanvas.getContext('2d');
const CROP_HANDLE = 5;      // half-size of a drawn handle square, px
const CROP_HIT    = 12;     // handle hit radius, px
const CROP_MIN    = 0.02;   // ignore crops smaller than 2% of a side
let cropDrag = null;        // {mode:'new'|'move'|'resize', handle, startX, startY, orig}
let cropClip = null;        // approved clip looping behind the crop selection

function cropIsActive(c) {
  return !!c && c.w > 0 && c.h > 0 &&
    (c.x > 0.001 || c.y > 0.001 || c.w < 0.999 || c.h < 0.999);
}

document.getElementById('btn-edit-crop').addEventListener('click', openCropEditor);
document.getElementById('btn-clear-crop').addEventListener('click', () => {
  S.crop = null;
  updateCropStatus();
  updateCrfEnabled();
  updateExportGrid();
  scheduleSizeEstimate();
});
document.getElementById('btn-crop-cancel').addEventListener('click', () => {
  cropModal.hidden = true;
  cropBgVideo.pause();
  clearModalView();
});
document.getElementById('btn-crop-reset').addEventListener('click', () => {
  S.cropDraft = null;
  drawCrop();
  updateCropDims();
});
document.getElementById('crop-lock-aspect').addEventListener('change', e => {
  S.cropLockAspect = e.target.checked;
});

// Quick crop sizes: largest box of the preset's aspect ratio that fits the
// source (never upscaled, capped at the preset's own pixel size), centred on
// the current selection.
document.getElementById('crop-presets').addEventListener('click', e => {
  const btn = e.target.closest('.btn-toggle');
  if (!btn) return;
  applyCropPreset(+btn.dataset.cw, +btn.dataset.ch);
});

function cropSourceDims() {
  return [S.videoWidth || 1920, S.videoHeight || 1080];
}

function presetCropPx(pw, ph) {
  const [vw, vh] = cropSourceDims();
  const scale = Math.min(1, vw / pw, vh / ph);
  return [Math.round(pw * scale / 2) * 2, Math.round(ph * scale / 2) * 2];
}

function applyCropPreset(pw, ph) {
  const [vw, vh] = cropSourceDims();
  const [ewPx, ehPx] = presetCropPx(pw, ph);
  const w = ewPx / vw;
  const h = ehPx / vh;
  const cur = cropIsActive(S.cropDraft) ? S.cropDraft : null;
  const cx = cur ? cur.x + cur.w / 2 : 0.5;
  const cy = cur ? cur.y + cur.h / 2 : 0.5;
  S.cropDraft = {
    x: Math.max(0, Math.min(cx - w / 2, 1 - w)),
    y: Math.max(0, Math.min(cy - h / 2, 1 - h)),
    w,
    h,
  };
  drawCrop();
  updateCropDims();
}

function markActiveCropPreset() {
  let cur = null;
  if (cropIsActive(S.cropDraft)) {
    const [vw, vh] = cropSourceDims();
    cur = [Math.round(S.cropDraft.w * vw / 2) * 2, Math.round(S.cropDraft.h * vh / 2) * 2];
  }
  document.querySelectorAll('#crop-presets .btn-toggle').forEach(b => {
    const [ew, eh] = presetCropPx(+b.dataset.cw, +b.dataset.ch);
    const match = cur && Math.abs(cur[0] - ew) <= 2 && Math.abs(cur[1] - eh) <= 2;
    b.classList.toggle('active', !!match);
  });
}
document.getElementById('btn-crop-apply').addEventListener('click', () => {
  S.crop = cropIsActive(S.cropDraft) ? { ...S.cropDraft } : null;
  cropModal.hidden = true;
  cropBgVideo.pause();
  clearModalView();
  updateCropStatus();
  updateCrfEnabled();
  updateExportGrid();
  scheduleSizeEstimate();
});

function openCropEditor() {
  setModalView('Crop editor');
  cropClip = S.clips.filter(c => c.keep)[0] || null;
  cropBgVideo.muted = true;
  document.getElementById('crop-lock-aspect').checked = S.cropLockAspect;

  // Match the overlay canvas to the video's rendered box once layout settles.
  const sizeCanvasToBg = () => {
    const w = cropBgVideo.clientWidth;
    const h = cropBgVideo.clientHeight;
    if (!w || !h) { requestAnimationFrame(sizeCanvasToBg); return; }
    cropCanvas.width = w;
    cropCanvas.height = h;
    cropCanvas.style.width = w + 'px';
    cropCanvas.style.height = h + 'px';
    S.cropDraft = S.crop ? { ...S.crop } : null;
    drawCrop();
    updateCropDims();
  };

  if (!cropBgVideo.src || !cropBgVideo.src.endsWith('/video')) {
    cropBgVideo.src = '/video';
  }
  const startAt = cropClip ? cropClip.start : S.videoDuration * 0.1;
  const begin = () => {
    try { cropBgVideo.currentTime = startAt; } catch (_) {}
    if (cropClip) cropBgVideo.play().catch(() => {});
    sizeCanvasToBg();
  };
  if (cropBgVideo.readyState >= 1) begin();
  else cropBgVideo.addEventListener('loadedmetadata', begin, { once: true });

  cropModal.hidden = false;
}

// Loop the background playback within the approved clip's bounds.
cropBgVideo.addEventListener('timeupdate', () => {
  if (!cropClip || cropModal.hidden) return;
  const t = cropBgVideo.currentTime;
  if (t >= cropClip.end - 0.05 || t < cropClip.start - 0.05) {
    cropBgVideo.currentTime = cropClip.start;
  }
});

function cropMouse(e) {
  const rect = cropCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (cropCanvas.width / rect.width),
    y: (e.clientY - rect.top) * (cropCanvas.height / rect.height),
  };
}

function cropToPx(r) {
  return { x: r.x * cropCanvas.width, y: r.y * cropCanvas.height,
           w: r.w * cropCanvas.width, h: r.h * cropCanvas.height };
}

function cropHandles(r) {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return {
    nw: [r.x, r.y],        n: [cx, r.y],          ne: [r.x + r.w, r.y],
    w:  [r.x, cy],                                e:  [r.x + r.w, cy],
    sw: [r.x, r.y + r.h],  s: [cx, r.y + r.h],    se: [r.x + r.w, r.y + r.h],
  };
}

cropCanvas.addEventListener('mousedown', e => {
  const { x, y } = cropMouse(e);
  const W = cropCanvas.width;
  const H = cropCanvas.height;
  const lock = S.cropLockAspect;

  if (S.cropDraft) {
    const r = cropToPx(S.cropDraft);
    const hs = cropHandles(r);
    for (const k in hs) {
      if (Math.hypot(x - hs[k][0], y - hs[k][1]) < CROP_HIT) {
        cropDrag = {
          mode: 'resize', handle: k, orig: r, lock,
          cx: r.x + r.w / 2, cy: r.y + r.h / 2,
          aspect: r.h > 0 ? r.w / r.h : W / H,
        };
        return;
      }
    }
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      cropDrag = { mode: 'move', startX: x, startY: y, orig: r };
      return;
    }
  }
  // A fresh box: locked to the current box's ratio if one exists, else the
  // frame's own ratio.
  const dr = cropIsActive(S.cropDraft) ? cropToPx(S.cropDraft) : null;
  cropDrag = {
    mode: 'new', startX: x, startY: y, lock,
    aspect: dr && dr.h > 0 ? dr.w / dr.h : W / H,
  };
  S.cropDraft = { x: x / W, y: y / H, w: 0, h: 0 };
  drawCrop();
});

window.addEventListener('mousemove', e => {
  if (!cropDrag) return;
  const { x, y } = cropMouse(e);
  const W = cropCanvas.width;
  const H = cropCanvas.height;
  const cx = v => Math.max(0, Math.min(W, v));
  const cy = v => Math.max(0, Math.min(H, v));

  if (cropDrag.mode === 'new') {
    const x0 = cropDrag.startX;
    const y0 = cropDrag.startY;
    if (cropDrag.lock) {
      // Grow a fixed-ratio box from the anchor toward the pointer, capped by
      // the room available in each direction so the ratio is never broken.
      const a = cropDrag.aspect;
      const dirX = x >= x0 ? 1 : -1;
      const dirY = y >= y0 ? 1 : -1;
      let bw = Math.max(Math.abs(x - x0), Math.abs(y - y0) * a);
      bw = Math.min(bw, dirX > 0 ? W - x0 : x0, (dirY > 0 ? H - y0 : y0) * a);
      const bh = bw / a;
      const nx = dirX > 0 ? x0 : x0 - bw;
      const ny = dirY > 0 ? y0 : y0 - bh;
      S.cropDraft = { x: nx / W, y: ny / H, w: bw / W, h: bh / H };
    } else {
      const nx = Math.min(x0, cx(x));
      const ny = Math.min(y0, cy(y));
      S.cropDraft = { x: nx / W, y: ny / H,
                      w: Math.abs(cx(x) - x0) / W, h: Math.abs(cy(y) - y0) / H };
    }
  } else if (cropDrag.mode === 'move') {
    const o = cropDrag.orig;
    let nx = Math.max(0, Math.min(o.x + (x - cropDrag.startX), W - o.w));
    let ny = Math.max(0, Math.min(o.y + (y - cropDrag.startY), H - o.h));
    S.cropDraft = { x: nx / W, y: ny / H, w: o.w / W, h: o.h / H };
  } else if (cropDrag.lock) { // resize, ratio locked → scale about the centre
    const a = cropDrag.aspect;
    const { cx: cx0, cy: cy0, handle: hk } = cropDrag;
    let halfW;
    if (hk === 'n' || hk === 's')      halfW = Math.abs(y - cy0) * a;
    else if (hk === 'e' || hk === 'w') halfW = Math.abs(x - cx0);
    else                               halfW = Math.max(Math.abs(x - cx0), Math.abs(y - cy0) * a);
    halfW = Math.max(halfW, 4);
    let halfH = halfW / a;
    const s = Math.min(1, cx0 / halfW, (W - cx0) / halfW, cy0 / halfH, (H - cy0) / halfH);
    halfW *= s; halfH *= s;
    S.cropDraft = {
      x: (cx0 - halfW) / W, y: (cy0 - halfH) / H,
      w: (halfW * 2) / W,   h: (halfH * 2) / H,
    };
  } else { // resize, free
    const o = cropDrag.orig;
    let left = o.x, top = o.y, right = o.x + o.w, bottom = o.y + o.h;
    const h = cropDrag.handle;
    if (h.includes('w')) left = cx(x);
    if (h.includes('e')) right = cx(x);
    if (h.includes('n')) top = cy(y);
    if (h.includes('s')) bottom = cy(y);
    if (right < left) [left, right] = [right, left];
    if (bottom < top) [top, bottom] = [bottom, top];
    S.cropDraft = { x: left / W, y: top / H, w: (right - left) / W, h: (bottom - top) / H };
  }
  drawCrop();
  updateCropDims();
});

window.addEventListener('mouseup', () => {
  if (!cropDrag) return;
  if (!cropIsActive(S.cropDraft) ||
      S.cropDraft.w < CROP_MIN || S.cropDraft.h < CROP_MIN) {
    S.cropDraft = cropDrag.mode === 'new' ? null : S.cropDraft;
  }
  cropDrag = null;
  drawCrop();
  updateCropDims();
});

function drawCrop() {
  const W = cropCanvas.width;
  const H = cropCanvas.height;
  cropCtx.clearRect(0, 0, W, H);
  if (!S.cropDraft || !S.cropDraft.w || !S.cropDraft.h) return;

  const r = cropToPx(S.cropDraft);

  // Dim everything outside the crop rectangle
  cropCtx.fillStyle = 'rgba(0,0,0,0.55)';
  cropCtx.fillRect(0, 0, W, r.y);
  cropCtx.fillRect(0, r.y + r.h, W, H - (r.y + r.h));
  cropCtx.fillRect(0, r.y, r.x, r.h);
  cropCtx.fillRect(r.x + r.w, r.y, W - (r.x + r.w), r.h);

  cropCtx.strokeStyle = '#3b82f6';
  cropCtx.lineWidth = 2;
  cropCtx.strokeRect(r.x, r.y, r.w, r.h);

  const hs = cropHandles(r);
  cropCtx.fillStyle = '#fff';
  for (const k in hs) {
    cropCtx.fillRect(hs[k][0] - CROP_HANDLE, hs[k][1] - CROP_HANDLE,
                     CROP_HANDLE * 2, CROP_HANDLE * 2);
  }
}

function updateCropDims() {
  markActiveCropPreset();
  const el = document.getElementById('crop-dims');
  if (!cropIsActive(S.cropDraft)) {
    el.textContent = 'Full frame';
    return;
  }
  const pct = `${Math.round(S.cropDraft.w * 100)}% × ${Math.round(S.cropDraft.h * 100)}%`;
  if (S.videoWidth && S.videoHeight) {
    const pw = Math.round(S.cropDraft.w * S.videoWidth / 2) * 2;
    const ph = Math.round(S.cropDraft.h * S.videoHeight / 2) * 2;
    el.textContent = `${pw} × ${ph} px  (${pct})`;
  } else {
    el.textContent = pct;
  }
}

function updateCropStatus() {
  const status = document.getElementById('crop-status');
  const clearBtn = document.getElementById('btn-clear-crop');
  if (cropIsActive(S.crop)) {
    status.textContent = `${Math.round(S.crop.w * 100)}% × ${Math.round(S.crop.h * 100)}%`;
    status.className = 'roi-status roi-on';
    clearBtn.hidden = false;
  } else {
    status.textContent = 'Full frame';
    status.className = 'roi-status roi-off';
    clearBtn.hidden = true;
  }
}

// ── Export settings ────────────────────────────────────────────────────────
function renderExportSettings() {
  updateClipCount();
  updateExportGrid();
  updateCropStatus();
  updateCrfEnabled();
  updateGroupAssignState();
  const sessionLabel = document.getElementById('session-label');
  if (sessionLabel) sessionLabel.textContent = S.sessionName || 'unnamed';
  const outInput = document.getElementById('output-dir-input');
  if (!outInput.value) {
    outInput.value = S.outputDir || 'exports';
  }
  scheduleSizeEstimate();
}

// ── Export size estimate ─────────────────────────────────────────────────────
// The server returns output bytes/sec for the current settings — exact for
// stream-copy exports, sampled with one short real encode otherwise. Each card
// then shows rate × its own duration.
let sizeEstimateTimer = null;

function scheduleSizeEstimate() {
  clearTimeout(sizeEstimateTimer);
  sizeEstimateTimer = setTimeout(requestSizeEstimate, 300);
}

function requestSizeEstimate() {
  const approved = S.clips.filter(c => c.keep);
  if (!approved.length) return;
  const isCopy = S.resolution === 'original' && !cropIsActive(S.crop);
  S.sizeReqId += 1;
  S.sizeError = null;
  S.sizeEstimating = !isCopy;   // copy answers instantly, no "estimating…" flash
  if (!isCopy) { S.sizeRate = 0; S.sizeMode = null; }
  updateSizeLabels();

  // Sample the middle of the longest kept clip — representative of the
  // wave-riding footage actually being exported.
  const longest = approved.reduce((a, b) => (b.duration > a.duration ? b : a));
  const sampleDur = Math.min(2.5, Math.max(1.0, longest.duration));
  const sampleStart = Math.max(0, (longest.start + longest.end) / 2 - sampleDur / 2);

  wsSend({
    type: 'estimate_size',
    req_id: S.sizeReqId,
    settings: {
      resolution: S.resolution,
      crf: S.crf,
      crop: cropIsActive(S.crop) ? S.crop : null,
    },
    sample: { start: sampleStart, duration: sampleDur },
  });
}

function handleSizeEstimate(msg) {
  if (msg.req_id !== S.sizeReqId) return;   // a newer request is in flight
  S.sizeEstimating = false;
  S.sizeError = msg.error || null;
  S.sizeRate = msg.error ? 0 : (msg.bytes_per_second || 0);
  S.sizeMode = msg.error ? null : msg.mode;
  updateSizeLabels();
}

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '—';
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 100) return mb.toFixed(0) + ' MB';
  return mb.toFixed(1) + ' MB';
}

function updateSizeLabels() {
  const prefix = S.sizeMode === 'encode' ? '≈ ' : (S.sizeMode === 'copy' ? '~ ' : '');
  const rate = S.sizeRate || 0;

  document.querySelectorAll('.export-card').forEach(card => {
    const el = card.querySelector('.card-size');
    if (!el) return;
    const clip = S.clips.find(c => c.id === +card.dataset.clipId);
    if (S.sizeEstimating) { el.textContent = 'estimating…'; el.classList.add('pending'); return; }
    el.classList.remove('pending');
    el.textContent = (!S.sizeError && rate && clip) ? prefix + fmtSize(rate * clip.duration) : '';
  });

  const totalEl = document.getElementById('export-size-total');
  if (totalEl) {
    if (S.sizeEstimating) {
      totalEl.textContent = 'estimating size…';
    } else if (S.sizeError || !rate) {
      totalEl.textContent = '';
      totalEl.title = S.sizeError || '';
    } else {
      const secs = S.clips.filter(c => c.keep).reduce((s, c) => s + c.duration, 0);
      totalEl.textContent = `${prefix}${fmtSize(rate * secs)} total`;
      totalEl.title = S.sizeMode === 'encode'
        ? 'Estimated from a short sample encode of this footage — actual size varies with motion.'
        : 'Stream copy — size is an exact slice of the source.';
    }
  }
}

// ── Export preview player ─────────────────────────────────────────────────
// The clip that's currently clicked in the grid autoplays (looping) in the big
// player at the top, so the surfer is easy to recognise before assigning them
// to a folder.
const exportPreview = document.getElementById('export-preview');
let exportFocusClip = null;

exportPreview.addEventListener('timeupdate', () => {
  if (!exportFocusClip) return;
  const t = exportPreview.currentTime;
  if (t >= exportFocusClip.end - 0.05 || t < exportFocusClip.start - 0.05) {
    exportPreview.currentTime = exportFocusClip.start;
  }
});

function playExportClip(clip) {
  if (!clip) return;
  exportFocusClip = clip;
  S.exportFocusClipId = clip.id;
  if (!exportPreview.src || !exportPreview.src.endsWith('/video')) {
    exportPreview.src = '/video';
  }
  const seek = () => {
    try { exportPreview.currentTime = clip.start; } catch (_) {}
    exportPreview.play().catch(() => {});
  };
  if (exportPreview.readyState >= 1) seek();
  else exportPreview.addEventListener('loadedmetadata', seek, { once: true });
  markPreviewingCard(clip.id);
  updateExportPreviewCaption();
}

function markPreviewingCard(clipId) {
  document.querySelectorAll('.export-card').forEach(c =>
    c.classList.toggle('previewing', +c.dataset.clipId === clipId));
}

function updateExportPreviewCaption() {
  const cap = document.getElementById('export-preview-caption');
  if (!cap) return;
  if (!exportFocusClip) { cap.textContent = ''; return; }
  const folder = S.folderGroups[exportFocusClip.id];
  cap.textContent =
    `Clip ${exportFocusClip.id + 1} · ${fmtTime(exportFocusClip.start)}–${fmtTime(exportFocusClip.end)}` +
    (folder ? ` · ${folder}` : '');
}

// Keep a clip playing in the top preview across grid rebuilds without
// restarting playback when the focused clip hasn't changed.
function syncExportPreview() {
  const approved = S.clips.filter(c => c.keep);
  const focus = approved.find(c => c.id === S.exportFocusClipId) || approved[0] || null;
  if (!focus) {
    exportFocusClip = null;
    S.exportFocusClipId = null;
    exportPreview.pause();
    updateExportPreviewCaption();
    return;
  }
  if (focus.id !== S.exportFocusClipId || exportFocusClip === null) {
    playExportClip(focus);
  } else {
    exportFocusClip = focus; // refresh reference after clip list rebuild
    markPreviewingCard(focus.id);
    updateExportPreviewCaption();
  }
}

function updateExportGrid() {
  const grid = document.getElementById('export-grid');
  grid.innerHTML = '';
  const approved = S.clips.filter(c => c.keep);
  const countEl = document.getElementById('export-count');
  if (countEl) countEl.textContent = approved.length;

  const unassigned = approved.filter(c => !S.folderGroups[c.id]);

  // Collect folder groups preserving first-assignment order
  const groupMap = new Map();
  for (const clip of approved) {
    const folder = S.folderGroups[clip.id];
    if (folder) {
      if (!groupMap.has(folder)) groupMap.set(folder, []);
      groupMap.get(folder).push(clip);
    }
  }

  // Unassigned clips first, under a clear header so it's obvious they are
  // not in any surfer folder and will land in the session folder as-is.
  if (unassigned.length > 0) {
    grid.appendChild(makeGroup(
      `Not assigned — ${unassigned.length} clip${unassigned.length !== 1 ? 's' : ''} export into the session folder`,
      unassigned,
      { ungrouped: true },
    ));
  }

  // Each folder group stacks below
  for (const [folderName, clips] of groupMap) {
    grid.appendChild(makeGroup(folderName, clips));
  }

  syncExportPreview();
  updateSizeLabels();   // repaint estimates onto the freshly built cards
}

function makeGroup(name, clips, { ungrouped = false } = {}) {
  const section = document.createElement('div');
  section.className = 'export-group' + (ungrouped ? ' ungrouped' : '');
  const header = document.createElement('div');
  header.className = 'export-group-header';
  header.textContent = name;
  section.appendChild(header);
  const row = document.createElement('div');
  row.className = 'export-group-cards';
  for (const clip of clips) row.appendChild(makeExportCard(clip));
  section.appendChild(row);
  return section;
}

function makeExportCard(clip) {
  const card = document.createElement('div');
  card.className = `export-card${S.selectedExportCards.has(clip.id) ? ' selected' : ''}`
    + (S.exportFocusClipId === clip.id ? ' previewing' : '');
  card.dataset.clipId = clip.id;

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  const thumb = document.createElement('img');
  thumb.className = 'clip-thumb';
  thumb.src = thumbnailUrl(clip);
  thumb.alt = '';
  thumbWrap.appendChild(thumb);

  if (cropIsActive(S.crop)) {
    const ov = document.createElement('div');
    ov.className = 'crop-overlay';
    ov.style.left   = `${S.crop.x * 100}%`;
    ov.style.top    = `${S.crop.y * 100}%`;
    ov.style.width  = `${S.crop.w * 100}%`;
    ov.style.height = `${S.crop.h * 100}%`;
    thumbWrap.appendChild(ov);
  }

  const label = document.createElement('div');
  label.className = 'card-label';
  label.textContent = `Clip ${clip.id + 1}`;

  const times = document.createElement('div');
  times.className = 'card-times';
  times.textContent = `${fmtTime(clip.start)} – ${fmtTime(clip.end)}  (${clip.duration.toFixed(1)}s)`;

  const size = document.createElement('div');
  size.className = 'card-size';

  card.append(thumbWrap, label, times, size);

  const folder = S.folderGroups[clip.id];
  const folderEl = document.createElement('div');
  folderEl.className = 'card-folder' + (folder ? '' : ' none');
  folderEl.textContent = folder ? `📁 ${folder}` : 'no folder';
  card.append(folderEl);

  // Hover drives the top preview player; the last-hovered clip stays playing.
  // Click is left purely for the multi-select used to group clips into folders.
  card.addEventListener('mouseenter', () => {
    if (S.exportFocusClipId !== clip.id) playExportClip(clip);
  });
  card.addEventListener('click', () => {
    if (S.selectedExportCards.has(clip.id)) {
      S.selectedExportCards.delete(clip.id);
      card.classList.remove('selected');
    } else {
      S.selectedExportCards.add(clip.id);
      card.classList.add('selected');
    }
    updateGroupAssignState();
  });
  return card;
}

// The folder-name field only makes sense once at least one clip is selected.
function updateGroupAssignState() {
  const row = document.getElementById('group-assign-row');
  const input = document.getElementById('group-name-input');
  const btn = document.getElementById('btn-assign-group');
  const active = S.selectedExportCards.size > 0;
  row.classList.toggle('disabled', !active);
  input.disabled = !active;
  btn.disabled = !active;
  if (!active) input.value = '';
}

// Resolution toggle
document.getElementById('res-group').addEventListener('click', e => {
  const btn = e.target.closest('.btn-toggle');
  if (!btn) return;
  document.querySelectorAll('#res-group .btn-toggle').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  S.resolution = btn.dataset.res;
  updateCrfEnabled();
  scheduleSizeEstimate();
});

// CRF applies whenever ffmpeg re-encodes — i.e. any non-original resolution,
// or an original-resolution export that still has to re-encode to apply a crop.
function updateCrfEnabled() {
  const crfSlider = document.getElementById('crf-slider');
  const disabled = S.resolution === 'original' && !cropIsActive(S.crop);
  crfSlider.disabled = disabled;
  crfSlider.parentElement.style.opacity = disabled ? '0.4' : '1';
}

document.getElementById('crf-slider').addEventListener('input', e => {
  S.crf = +e.target.value;
  document.getElementById('crf-val').textContent = S.crf;
  scheduleSizeEstimate();
});

document.getElementById('btn-browse-dir').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/pick-file?type=folder');
    if (res.ok) {
      const data = await res.json();
      if (data.path) document.getElementById('output-dir-input').value = data.path;
    }
  } catch (_) {}
});

document.getElementById('btn-assign-group').addEventListener('click', () => {
  const input = document.getElementById('group-name-input');
  const name = input.value.trim();
  if (!S.selectedExportCards.size) {
    showError('Select one or more clips first — click a clip to select it.');
    return;
  }
  if (!name) {
    showError('Type a folder name before assigning.');
    input.focus();
    return;
  }
  for (const id of S.selectedExportCards) {
    S.folderGroups[id] = name;
  }
  S.selectedExportCards.clear();
  input.value = '';
  updateGroupAssignState();
  updateExportGrid();          // the cards visibly move into the folder group
  wsSend({ type: 'set_folder_groups', folder_groups: S.folderGroups });
});

document.getElementById('btn-export').addEventListener('click', () => {
  const approved = S.clips.filter(c => c.keep);
  const ungrouped = approved.filter(c => !S.folderGroups[c.id]);
  if (ungrouped.length && !confirm(
    `${ungrouped.length} of ${approved.length} approved clip${approved.length !== 1 ? 's' : ''} ` +
    `${ungrouped.length === 1 ? "isn't" : "aren't"} assigned to a folder and will be exported ` +
    `straight into the session folder. Export anyway?`)) {
    return;
  }
  const outputDir = document.getElementById('output-dir-input').value.trim() || '~/Desktop/surf-clips';
  S.outputDir = outputDir;
  showPhase('exporting');
  wsSend({
    type: 'export',
    clips: S.clips.filter(c => c.keep),
    settings: {
      resolution: S.resolution,
      crf: S.crf,
      output_dir: outputDir,
      folder_groups: S.folderGroups,
      crop: cropIsActive(S.crop) ? S.crop : null,
      session: S.sessionName || null,
    },
  });
});

document.getElementById('btn-back').addEventListener('click', () => {
  showPhase('review');
  wsSend({ type: 'set_phase', phase: 'review' });
});

// ── Export progress ────────────────────────────────────────────────────────
function handleExportProgress(msg) {
  const pct = msg.total > 0 ? (msg.current / msg.total) * 100 : 0;
  document.getElementById('export-progress-fill').style.width = `${pct}%`;
  document.getElementById('export-status-label').textContent = `Exporting clips… (${msg.current}/${msg.total})`;
  document.getElementById('export-file-label').textContent = msg.filename || '';
}

function handleExportDone(msg) {
  showPhase('done');
  const n = msg.results ? msg.results.length : 0;
  document.getElementById('done-summary').textContent =
    `${n} clip${n !== 1 ? 's' : ''} exported to ${msg.output_dir}`;
}

// ── Session prompt ────────────────────────────────────────────────────────
const sessionNameInput = document.getElementById('session-name-input');
// "Continue" stays disabled until a session name has been entered. Resolve the
// elements by id each call so it is safe to invoke before the consts below.
function syncSessionContinueEnabled() {
  const input = document.getElementById('session-name-input');
  document.getElementById('btn-session-continue').disabled = !input.value.trim();
}
document.getElementById('btn-session-continue').addEventListener('click', () => {
  const name = sessionNameInput.value.trim();
  if (!name) { sessionNameInput.focus(); return; }
  S.sessionName = name;
  wsSend({ type: 'set_session', name });
});
sessionNameInput.addEventListener('input', syncSessionContinueEnabled);
sessionNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-session-continue').click();
});
syncSessionContinueEnabled();

// ── File picker ────────────────────────────────────────────────────────────
// "Start scanning" stays disabled until a video path has been entered.
function syncStartScanEnabled() {
  const path = document.getElementById('video-path-input').value.trim();
  document.getElementById('btn-start-scan').disabled = !path;
}

document.getElementById('btn-browse').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/pick-file');
    const data = await res.json();
    if (res.ok) {
      if (data.path) {
        document.getElementById('video-path-input').value = data.path;
        syncStartScanEnabled();
      }
    } else if (data.error && data.error !== 'cancelled') {
      showError(`Couldn't open file picker — ${data.error}`);
    }
  } catch (err) {
    showError(`Couldn't reach the server: ${err.message}`);
  }
});

// Drag & drop a video file straight onto the file-picker card.
// Note: no regular browser (Chrome included) exposes a dropped File's
// absolute filesystem path — that's a deliberate security restriction.
// `file.path` only ever worked inside Electron's embedded Chromium, not
// in a normal browser tab like this app runs in.
const dropTarget = document.getElementById('phase-file-picker');
const videoPathInput = document.getElementById('video-path-input');

['dragenter', 'dragover'].forEach(evt => {
  dropTarget.addEventListener(evt, e => {
    e.preventDefault();
    dropTarget.classList.add('drag-over');
  });
});
['dragleave', 'dragend'].forEach(evt => {
  dropTarget.addEventListener(evt, e => {
    e.preventDefault();
    dropTarget.classList.remove('drag-over');
  });
});
dropTarget.addEventListener('drop', e => {
  e.preventDefault();
  dropTarget.classList.remove('drag-over');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (file.path) {
    videoPathInput.value = file.path;
    syncStartScanEnabled();
  } else {
    showError('Browsers don\'t expose a dropped file\'s full path for security reasons. Use Browse… or paste the path instead.');
  }
});

document.getElementById('btn-start-scan').addEventListener('click', () => {
  const path = document.getElementById('video-path-input').value.trim();
  if (!path) return;
  showPhase('initializing');
  wsSend({ type: 'set_video', path });
});

document.getElementById('video-path-input').addEventListener('input', syncStartScanEnabled);
document.getElementById('video-path-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-start-scan').click();
});
syncStartScanEnabled();

// Step back to the session-name prompt to rename the session. The typed video
// path is left untouched so walking forward again is a no-op.
document.getElementById('btn-picker-back').addEventListener('click', () => {
  const nameInput = document.getElementById('session-name-input');
  if (!nameInput.value.trim() && S.sessionName) nameInput.value = S.sessionName;
  syncSessionContinueEnabled();
  showPhase('session-prompt');
  wsSend({ type: 'set_phase', phase: 'session-prompt' });
});

// ── ROI prompt (pre-scan) ──────────────────────────────────────────────────
document.getElementById('btn-draw-roi').addEventListener('click', () => openRoiEditor('pre-scan'));
document.getElementById('btn-skip-roi').addEventListener('click', () => {
  showPhase('initializing');
  wsSend({ type: 'begin_scan', roi: null });
});
// Step back to the file picker to choose a different video. The current path
// stays in the input as the default; picking again re-probes it.
document.getElementById('btn-roi-back').addEventListener('click', () => {
  syncStartScanEnabled();
  showPhase('file-picker');
  wsSend({ type: 'set_phase', phase: 'file-picker' });
});

// ── Abort scan / model load ────────────────────────────────────────────────
// Stop the running scan on the server and step back to the detection-zone
// prompt. Detections gathered so far are discarded; the zone is kept so the
// user can tweak it and rescan.
function abortScan(confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  showPhase('roi-prompt');
  wsSend({ type: 'abort_scan' });
}
document.getElementById('btn-scan-abort').addEventListener('click', () =>
  abortScan('Stop scanning and go back? Detections found so far will be discarded.'));
document.getElementById('btn-init-abort').addEventListener('click', () =>
  abortScan(null));

// ── Review footer ──────────────────────────────────────────────────────────
document.getElementById('btn-next-export').addEventListener('click', () => {
  showPhase('export-settings');
  wsSend({ type: 'set_phase', phase: 'export-settings' });
});
// A tab the tool opened itself can't reliably be closed by script, so "Cancel"
// discards this video's scan and returns to the picker rather than trying (and
// silently failing) to quit. To fully exit, close the tab and stop the server.
document.getElementById('btn-cancel').addEventListener('click', () => {
  if (!confirm('Discard these clips and choose another video?')) return;
  resetForNextVideo();
  wsSend({ type: 'another_video' });
});

// ── Done screen ───────────────────────────────────────────────────────────
function resetForNextVideo() {
  S.clips = [];
  S.detections = [];
  S.scanTiles = [];
  S.scanTotalTiles = 0;
  S.rawDetectionCount = 0;
  S.roi = null;
  S.selectedClip = null;
  S.selectedExportCards.clear();
  S.folderGroups = {};
  S.crop = null;
  S.cropDraft = null;
  S.videoDuration = 0;
  S.exportFocusClipId = null;
  S.sizeRate = 0;
  S.sizeMode = null;
  S.sizeEstimating = false;
  S.sizeError = null;
  exportFocusClip = null;
  document.getElementById('video-path-input').value = '';
  syncStartScanEnabled();
  const groupInput = document.getElementById('group-name-input');
  if (groupInput) groupInput.value = '';
  reviewPreview.removeAttribute('src');
  exportPreview.pause();
  exportPreview.removeAttribute('src');
  exportPreview.load();
  updateExportPreviewCaption();
}

document.getElementById('btn-another-video').addEventListener('click', () => {
  resetForNextVideo();
  wsSend({ type: 'another_video' });
});
document.getElementById('btn-new-session').addEventListener('click', () => {
  resetForNextVideo();
  S.sessionName = '';
  document.getElementById('output-dir-input').value = '';
  wsSend({ type: 'new_session' });
});

// ── Toasts ─────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, kind = 'info') {
  const toast = document.getElementById('error-toast');
  toast.textContent = kind === 'error' ? `Error: ${msg}` : msg;
  toast.classList.toggle('toast-info', kind !== 'error');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}
function showError(msg) { showToast(msg, 'error'); }

// ── Utilities ──────────────────────────────────────────────────────────────
function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = (secs % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// ── Init ───────────────────────────────────────────────────────────────────
wsConnect();

// Redraw timeline on window resize
window.addEventListener('resize', () => {
  if (S.phase === 'review') requestAnimationFrame(drawTimeline);
});
