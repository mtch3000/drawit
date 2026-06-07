// ================================================================
//  DRAW TOGETHER — app.js
//  Main drawing logic + real-time sync with Firebase
// ================================================================


// ── 1. GET / CREATE A UNIQUE ID FOR THIS VISITOR ─────────────────
//
//   Each person who opens the site gets a random ID stored in their
//   browser. This ID is used to track which strokes belong to them
//   (so Undo only undoes THEIR strokes, not anyone else's).
//
function getOrCreateUserId() {
  let uid = localStorage.getItem('drawtogether_uid');
  if (!uid) {
    // Generate a random ID and remember it in the browser
    uid = 'u_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now();
    localStorage.setItem('drawtogether_uid', uid);
  }
  return uid;
}
const MY_USER_ID = getOrCreateUserId();


// ── 2. CANVAS SETUP ───────────────────────────────────────────────

const canvas  = document.getElementById('canvas');
const ctx     = canvas.getContext('2d');

// Make canvas fill the screen below the toolbar.
// Called on start AND whenever the window is resized / rotated.
function resizeCanvas() {
  const toolbarEl  = document.getElementById('toolbar');
  const toolbarH   = toolbarEl ? toolbarEl.offsetHeight : 52;

  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight - toolbarH;

  // After resize, redraw everything from our saved stroke data
  redrawAll();
}

window.addEventListener('resize', resizeCanvas);

// On mobile, when you rotate the device, orientation changes fire before
// the browser finishes recalculating dimensions, so we wait 150 ms.
window.addEventListener('orientationchange', () => {
  setTimeout(resizeCanvas, 150);
});


// ── 3. DRAWING STATE VARIABLES ────────────────────────────────────

let isDrawing     = false;  // true while the mouse/finger is pressed
let currentTool   = 'pen';  // which tool is selected
let currentColor  = '#1a1a1a';
let currentSize   = 5;

// The stroke the user is CURRENTLY drawing (not yet saved to Firebase)
let liveStroke    = null;

// IDs of THIS user's strokes in Firebase (max 5 – for Undo)
let myStrokeIds   = [];

// All strokes currently in Firebase, keyed by strokeId
let allStrokes    = {};

// Reference to Firebase database path
let dbRef         = null;


// ── 4. TOOL APPEARANCE SETTINGS ───────────────────────────────────
//
//   widthFactor  – multiplied by the user's chosen size
//   alpha        – opacity (1 = fully opaque, 0.5 = semi-transparent)
//
const TOOL_SETTINGS = {
  pen:    { widthFactor: 0.35,  alpha: 1.0 },
  pencil: { widthFactor: 0.25,  alpha: 0.60 },
  brush:  { widthFactor: 2.2,   alpha: 0.40 },
  eraser: { widthFactor: 2.0,   alpha: 1.0 }
};


// ── 5. DRAW A SINGLE STROKE ───────────────────────────────────────
//
//   This function is called both for live drawing (as the user moves
//   the mouse) and when redrawing all stored strokes from scratch.
//
function drawStroke(stroke) {
  if (!stroke || !stroke.points || stroke.points.length === 0) return;

  const settings = TOOL_SETTINGS[stroke.tool] || TOOL_SETTINGS.pen;
  const pts      = stroke.points;
  const lineW    = Math.max(1, stroke.size * settings.widthFactor);

  ctx.save();                       // save current drawing state
  ctx.lineCap    = 'round';
  ctx.lineJoin   = 'round';
  ctx.lineWidth  = lineW;
  ctx.globalAlpha = settings.alpha;

  if (stroke.tool === 'eraser') {
    // Eraser removes pixels, revealing the white background
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color || '#1a1a1a';
    ctx.fillStyle   = stroke.color || '#1a1a1a';
  }

  ctx.beginPath();

  if (pts.length === 1) {
    // A single tap/click draws a dot
    ctx.arc(pts[0].x, pts[0].y, lineW / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Smooth curve through all points using quadratic bezier curves
    ctx.moveTo(pts[0].x, pts[0].y);

    for (let i = 1; i < pts.length - 1; i++) {
      const midX = (pts[i].x + pts[i + 1].x) / 2;
      const midY = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
    }

    // Connect to the last point
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    ctx.stroke();
  }

  ctx.restore();                    // restore drawing state
}


// ── 6. REDRAW THE ENTIRE CANVAS FROM SCRATCH ──────────────────────
//
//   Called after:
//   - Page load (draw all existing strokes from Firebase)
//   - Canvas resize / orientation change
//   - Any stroke is removed (undo, admin clear)
//
function redrawAll() {
  // Fill with white first (so Eraser shows white, not transparent)
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fefefe';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw strokes in the order they were created (oldest first)
  const sorted = Object.values(allStrokes).sort((a, b) => a.timestamp - b.timestamp);
  sorted.forEach(stroke => drawStroke(stroke));
}


// ── 7. STROKE LIFECYCLE (start → continue → end) ─────────────────

function startStroke(x, y) {
  liveStroke = {
    userId:    MY_USER_ID,
    tool:      currentTool,
    color:     currentTool === 'eraser' ? '#fefefe' : currentColor,
    size:      currentSize,
    points:    [{ x, y }],
    timestamp: Date.now()
  };
  // Draw the first dot immediately so the user gets instant feedback
  drawStroke(liveStroke);
}

function continueStroke(x, y) {
  if (!liveStroke) return;

  liveStroke.points.push({ x, y });

  // Draw only the newest segment for smooth performance.
  const pts = liveStroke.points;
  const n   = pts.length;

  if (n < 2) return;

  const settings = TOOL_SETTINGS[liveStroke.tool] || TOOL_SETTINGS.pen;
  const lineW    = Math.max(1, liveStroke.size * settings.widthFactor);

  ctx.save();
  ctx.lineCap   = 'round';
  ctx.lineJoin  = 'round';
  ctx.lineWidth = lineW;
  ctx.globalAlpha = settings.alpha;

  if (liveStroke.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = liveStroke.color;
  }

  ctx.beginPath();

  if (n >= 3) {
    const prev  = pts[n - 3];
    const curr  = pts[n - 2];
    const next  = pts[n - 1];
    const midX  = (curr.x + next.x) / 2;
    const midY  = (curr.y + next.y) / 2;
    ctx.moveTo((prev.x + curr.x) / 2, (prev.y + curr.y) / 2);
    ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
  } else {
    ctx.moveTo(pts[n - 2].x, pts[n - 2].y);
    ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
  }

  ctx.stroke();
  ctx.restore();
}

function endStroke() {
  if (!liveStroke || liveStroke.points.length === 0) {
    liveStroke = null;
    return;
  }

  // Generate a unique key for this stroke in Firebase
  const strokeKey = dbRef.push().key;

  // Add to our undo history (remember only up to 5 strokes)
  myStrokeIds.push(strokeKey);
  if (myStrokeIds.length > 5) {
    myStrokeIds.shift();  // drop the oldest (no longer undoable)
  }

  // Update the Undo badge counter in the toolbar
  updateUndoBadge();

  // Save the stroke to Firebase (everyone will see it)
  dbRef.child(strokeKey).set(liveStroke)
    .catch(err => console.error('Failed to save stroke:', err));

  liveStroke = null;
}


// ── 8. MOUSE EVENTS (Desktop) ─────────────────────────────────────

function posFromMouse(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('mousedown', e => {
  isDrawing = true;
  const p = posFromMouse(e);
  startStroke(p.x, p.y);
});

canvas.addEventListener('mousemove', e => {
  if (!isDrawing) return;
  const p = posFromMouse(e);
  continueStroke(p.x, p.y);
});

canvas.addEventListener('mouseup', () => {
  if (!isDrawing) return;
  isDrawing = false;
  endStroke();
});

// If the mouse leaves the canvas while drawing, end the stroke cleanly
canvas.addEventListener('mouseleave', () => {
  if (!isDrawing) return;
  isDrawing = false;
  endStroke();
});


// ── 9. TOUCH EVENTS (Mobile / Tablet) ────────────────────────────
//
//   { passive: false } is required so we can call e.preventDefault()
//   which stops the browser scrolling/zooming while drawing.
//

function posFromTouch(e) {
  const rect  = canvas.getBoundingClientRect();
  const touch = e.touches[0];
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  isDrawing = true;
  const p = posFromTouch(e);
  startStroke(p.x, p.y);
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (!isDrawing) return;
  const p = posFromTouch(e);
  continueStroke(p.x, p.y);
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  if (!isDrawing) return;
  isDrawing = false;
  endStroke();
}, { passive: false });

canvas.addEventListener('touchcancel', e => {
  e.preventDefault();
  isDrawing = false;
  liveStroke = null;
}, { passive: false });


// ── 10. TOOLBAR CONTROLS ──────────────────────────────────────────

// Tool selection
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;

    // Change cursor: crosshair for drawing, cell for eraser
    canvas.style.cursor = (currentTool === 'eraser') ? 'cell' : 'crosshair';
  });
});

// Colour picker
const colorPicker = document.getElementById('color-picker');
const colorSwatch = document.getElementById('color-swatch');

colorPicker.addEventListener('input', e => {
  currentColor = e.target.value;
  colorSwatch.style.background = currentColor;
});
// Set initial swatch colour
colorSwatch.style.background = colorPicker.value;

// Size slider
const sizeSlider = document.getElementById('size-slider');
const sizeDot    = document.getElementById('size-dot');

sizeSlider.addEventListener('input', e => {
  currentSize = parseInt(e.target.value, 10);
  // Visual preview: dot size scales with slider value
  const dotPx = Math.max(4, Math.min(20, currentSize * 0.6));
  sizeDot.style.width  = dotPx + 'px';
  sizeDot.style.height = dotPx + 'px';
});

// Undo button
document.getElementById('undo-btn').addEventListener('click', () => {
  if (myStrokeIds.length === 0) return;
  const lastId = myStrokeIds.pop();
  dbRef.child(lastId).remove()
    .catch(err => console.error('Undo failed:', err));
  updateUndoBadge();
});

function updateUndoBadge() {
  const badge = document.getElementById('undo-count');
  const btn   = document.getElementById('undo-btn');
  if (!badge || !btn) return;
  badge.textContent = myStrokeIds.length;
  btn.disabled = (myStrokeIds.length === 0);
}


// ── 11. FIREBASE REAL-TIME SYNC ───────────────────────────────────

function initSync() {
  // Point to the 'strokes' node in our Firebase database
  dbRef = firebase.database().ref('strokes');

  // Listen for ALL strokes (initial load + any future changes)
  dbRef.on('value', snapshot => {
    allStrokes = snapshot.val() || {};
    redrawAll();

    // If the user was mid-stroke when a sync arrived, redraw their
    // live stroke on top so it doesn't disappear
    if (isDrawing && liveStroke) {
      drawStroke(liveStroke);
    }

    // Hide the loading screen after first data arrives
    const loader = document.getElementById('loading-screen');
    if (loader && !loader.classList.contains('hidden')) {
      loader.classList.add('hidden');
      setTimeout(() => loader.remove(), 500);
    }
  }, err => {
    console.error('Firebase sync error:', err);
    const loader = document.getElementById('loading-screen');
    if (loader) loader.classList.add('hidden');
  });
}


// ── 12. START EVERYTHING ──────────────────────────────────────────

window.addEventListener('load', () => {
  // Size the canvas first
  resizeCanvas();

  // Connect to Firebase
  try {
    initSync();
  } catch (e) {
    console.error('Could not start Firebase. Did you fill in js/config.js?', e);
    const loader = document.getElementById('loading-screen');
    if (loader) {
      loader.querySelector('p').textContent =
        '⚠️ Firebase not configured. See SETUP_GUIDE.md';
    }
  }

  // Initialise undo badge state
  updateUndoBadge();
});
