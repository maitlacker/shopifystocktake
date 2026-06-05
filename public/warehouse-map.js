'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const SHELF_W = 1.5;    // metres (length of each shelf unit)
const SHELF_D = 0.545;  // metres (depth of each shelf unit)
const SNAP    = 0.15;   // snap grid 150mm
const AISLE_COLORS = [
  '#6366f1', '#22c55e', '#f97316', '#ef4444',
  '#0ea5e9', '#8b5cf6', '#14b8a6', '#f59e0b',
];

// ── Default room polygon (from RoomScan Pro PDF, converted to metres) ─────
// Origin = NW corner of building. X = east, Y = south.
// Scale: X uses 38.74 pts/m (calibrated to 14.13m width annotation)
//        Y uses 49.09 pts/m (calibrated to 19.61m right-wall annotation)
const DEFAULT_WALLS = [
  {x:14.13, y:19.62},   // BR corner
  {x:11.18, y:19.62},   // bottom – inner wall meets outer bottom
  {x:8.69,  y:19.62},   // bottom step
  {x:8.69,  y:16.01},   // inner corner (lower-right rooms)
  {x:4.32,  y:16.01},   // inner horizontal wall
  {x:4.32,  y:12.28},   // inner corner
  {x:3.84,  y:12.28},   // wall thickness step
  {x:3.83,  y:9.74},    // inner left corner
  {x:3.09,  y:9.73},    // wall thickness step
  {x:0.07,  y:9.74},    // left outer wall (production area end)
  {x:0.07,  y:8.48},    // left outer wall going up
  // Rounded top-left corner (LiDAR arc points)
  {x:0.03,  y:8.18},
  {x:0.03,  y:7.88},
  {x:0.04,  y:7.57},
  {x:0.04,  y:5.08},
  {x:0.04,  y:3.58},
  {x:0.01,  y:3.43},
  {x:0.01,  y:3.29},
  {x:0.0,   y:3.14},    // leftmost curve point
  {x:0.0,   y:3.0},
  {x:0.01,  y:2.86},
  {x:0.04,  y:2.72},
  {x:0.08,  y:2.57},
  {x:0.12,  y:2.43},
  {x:0.17,  y:2.29},
  {x:0.23,  y:2.16},
  {x:0.3,   y:2.02},
  {x:0.39,  y:1.89},    // end of rounded corner
  {x:0.39,  y:0.0},     // TL corner
  {x:2.21,  y:0.0},     // top wall – production dividing wall junction
  {x:14.0,  y:0.01},    // TR corner
  {x:14.14, y:15.39},   // right wall minor step
];

const DEFAULT_INTERIOR_WALLS = [
  // Production area dividing wall (separates left production strip from main warehouse)
  [{x:2.21, y:0.0}, {x:2.21, y:9.74}],
];

const DEFAULT_ZONES = [
  {id:'warehouse',  label:'WAREHOUSE',      color:'#6366f1', x:7.0,  y:6.5},
  {id:'production', label:'PRODUCTION',     color:'#f59e0b', x:1.0,  y:4.5},
  {id:'kitchen',    label:'KITCHEN',        color:'#ec4899', x:1.5,  y:17.5},
  {id:'understair', label:'UNDER-STAIRS',   color:'#0ea5e9', x:5.0,  y:17.5},
  {id:'office',     label:'OFFICE',         color:'#22c55e', x:10.5, y:17.5},
];

// ── State ─────────────────────────────────────────────────────────────────
let layout = buildDefaultLayout();
let mode    = 'select';
let zoom    = 40;
let panX    = 40, panY = 40;
let selId   = null;
let selType = null;
let drag    = null;
let ghostRot = 0;
let mouseW  = {x: 0, y: 0};
let canvas, ctx;

function buildDefaultLayout() {
  return {
    walls:         DEFAULT_WALLS.map(v => ({...v})),
    interiorWalls: DEFAULT_INTERIOR_WALLS.map(w => w.map(p => ({...p}))),
    zones:         DEFAULT_ZONES.map(z => ({...z})),
    shelves:       [],
  };
}

// ── Initialise ────────────────────────────────────────────────────────────
window.addEventListener('load', async () => {
  canvas = document.getElementById('wm-canvas');
  ctx    = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  await loadLayout();
  autoFit();
  setupEvents();
  populateLegend();
  draw();
  updateUI();
});

// ── Canvas resize ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const wrap  = canvas.parentElement;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}

function autoFit() {
  const pad = 50;
  const bw  = 14.6, bh = 20.2;
  zoom = Math.min(
    (canvas.width  - pad * 2) / bw,
    (canvas.height - pad * 2) / bh,
    55
  );
  panX = Math.round((canvas.width  - 14.13 * zoom) / 2);
  panY = pad;
  draw();
}

// ── Coordinate helpers ────────────────────────────────────────────────────
function w2c(x, y)  { return {x: panX + x * zoom, y: panY + y * zoom}; }
function c2w(cx,cy) { return {x: (cx - panX) / zoom, y: (cy - panY) / zoom}; }
function snapV(v)   { return Math.round(v / SNAP) * SNAP; }

// ── Persistence ───────────────────────────────────────────────────────────
async function loadLayout() {
  try {
    const r = await fetch('/api/warehouse/layout');
    if (!r.ok) return;
    const d = await r.json();
    if (d && d.walls && d.walls.length > 3) layout = d;
  } catch (_) {}
}

async function saveLayout() {
  const btn = document.getElementById('wm-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const r = await fetch('/api/warehouse/layout', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(layout),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = '💾 Save Layout'; btn.disabled = false; }, 2000);
  } catch (err) {
    alert('Save failed: ' + err.message);
    btn.textContent = '💾 Save Layout';
    btn.disabled = false;
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────
function draw() {
  if (!ctx) return;

  // Background
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawGrid();
  drawRoom();
  drawInteriorWalls();
  drawZoneLabels();
  drawShelves();
  if (mode === 'editWalls') drawWallHandles();
  if (mode === 'place')     drawGhost();
  drawScaleBar();
}

function drawGrid() {
  const minM = Math.floor((0 - Math.max(panX, panY)) / zoom) - 2;
  const maxM = Math.ceil(Math.max(canvas.width, canvas.height) / zoom) + 2;

  for (let m = minM; m <= maxM; m++) {
    const isMajor = m % 5 === 0;
    ctx.strokeStyle = isMajor ? '#d1d5db' : '#e5e7eb';
    ctx.lineWidth   = isMajor ? 0.8 : 0.4;

    const cx = panX + m * zoom;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, canvas.height); ctx.stroke();

    const cy = panY + m * zoom;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(canvas.width, cy); ctx.stroke();
  }
}

function drawRoom() {
  const walls = layout.walls;
  if (!walls.length) return;

  ctx.beginPath();
  const f = w2c(walls[0].x, walls[0].y);
  ctx.moveTo(f.x, f.y);
  for (let i = 1; i < walls.length; i++) {
    const p = w2c(walls[i].x, walls[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();

  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth   = 3;
  ctx.stroke();
}

function drawInteriorWalls() {
  ctx.strokeStyle = '#475569';
  ctx.lineWidth   = 2;
  for (const wall of layout.interiorWalls) {
    if (wall.length < 2) continue;
    ctx.beginPath();
    const s = w2c(wall[0].x, wall[0].y);
    ctx.moveTo(s.x, s.y);
    for (let i = 1; i < wall.length; i++) {
      const p = w2c(wall[i].x, wall[i].y);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
}

function drawZoneLabels() {
  for (const z of layout.zones) {
    const {x: cx, y: cy} = w2c(z.x, z.y);
    const fs = Math.max(8, Math.min(zoom * 0.4, 13));
    ctx.font        = `700 ${fs}px sans-serif`;
    ctx.textAlign   = 'center';
    ctx.fillStyle   = z.color || '#94a3b8';
    ctx.globalAlpha = 0.5;
    ctx.fillText(z.label, cx, cy);
    ctx.globalAlpha = 1;
  }
}

function drawShelves() {
  for (const s of layout.shelves) drawShelf(s, s.id === selId);
}

function drawShelf(s, selected) {
  const vert = s.rot === 90;
  const sw = (vert ? SHELF_D : SHELF_W) * zoom;
  const sh = (vert ? SHELF_W : SHELF_D) * zoom;
  const {x: cx, y: cy} = w2c(s.x, s.y);

  const col = s.aisle != null
    ? AISLE_COLORS[s.aisle % AISLE_COLORS.length]
    : '#94a3b8';

  ctx.fillStyle   = col + (selected ? 'ee' : '99');
  ctx.strokeStyle = selected ? '#1e293b' : col + 'bb';
  ctx.lineWidth   = selected ? 2 : 1;
  ctx.fillRect(cx, cy, sw, sh);
  ctx.strokeRect(cx, cy, sw, sh);

  // Label (only when zoomed in enough)
  if (s.label && zoom >= 32) {
    ctx.save();
    ctx.fillStyle     = '#fff';
    ctx.font          = `600 ${Math.max(7, zoom * 0.21)}px sans-serif`;
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.shadowColor   = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur    = 2;
    ctx.fillText(s.label.slice(0, 9), cx + sw / 2, cy + sh / 2);
    ctx.restore();
  }

  // Selection handles
  if (selected) {
    ctx.fillStyle   = '#fff';
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth   = 1.5;
    [[cx, cy], [cx + sw, cy], [cx + sw, cy + sh], [cx, cy + sh]].forEach(([hx, hy]) => {
      ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  }
}

function drawWallHandles() {
  // Outer wall vertices — red
  layout.walls.forEach((v, i) => {
    const {x: cx, y: cy} = w2c(v.x, v.y);
    const active = drag?.type === 'wallVtx' && drag.idx === i;
    ctx.fillStyle   = active ? '#dc2626' : '#ef4444';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.arc(cx, cy, active ? 8 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  });

  // Interior wall vertices — orange
  layout.interiorWalls.forEach((wall, wi) => {
    wall.forEach((v, vi) => {
      const {x: cx, y: cy} = w2c(v.x, v.y);
      const active = drag?.type === 'iWallVtx' && drag.wi === wi && drag.vi === vi;
      ctx.fillStyle   = active ? '#ea580c' : '#f97316';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 2;
      ctx.beginPath(); ctx.arc(cx, cy, active ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    });
  });
}

function drawGhost() {
  const vert = ghostRot === 90;
  const sx   = snapV(mouseW.x) - (vert ? SHELF_D : SHELF_W) / 2;
  const sy   = snapV(mouseW.y) - (vert ? SHELF_W : SHELF_D) / 2;
  const sw   = (vert ? SHELF_D : SHELF_W) * zoom;
  const sh   = (vert ? SHELF_W : SHELF_D) * zoom;
  const {x: cx, y: cy} = w2c(sx, sy);

  ctx.globalAlpha = 0.55;
  ctx.fillStyle   = '#6366f1';
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth   = 1.5;
  ctx.fillRect(cx, cy, sw, sh);
  ctx.strokeRect(cx, cy, sw, sh);
  ctx.globalAlpha = 1;

  // Rotation hint
  const hint = `${vert ? '↕ 1.5m tall' : '⟷ 1.5m wide'}  R = rotate`;
  ctx.fillStyle   = '#1e293b';
  ctx.font        = '11px sans-serif';
  ctx.textAlign   = 'left';
  ctx.fillText(hint, cx + sw + 6, cy + sh / 2 + 4);
}

function drawScaleBar() {
  const bars  = 5;
  const barPx = bars * zoom;
  const x     = canvas.width - barPx - 16;
  const y     = canvas.height - 16;

  ctx.strokeStyle = '#475569';
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + barPx, y);
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5);
  ctx.moveTo(x + barPx, y - 5); ctx.lineTo(x + barPx, y + 5);
  ctx.stroke();

  ctx.fillStyle  = '#475569';
  ctx.font       = '11px sans-serif';
  ctx.textAlign  = 'center';
  ctx.fillText(`${bars}m`, x + barPx / 2, y - 8);
}

// ── Events ────────────────────────────────────────────────────────────────
function setupEvents() {
  canvas.addEventListener('mousedown',   onDown);
  canvas.addEventListener('mousemove',   onMove);
  canvas.addEventListener('mouseup',     onUp);
  canvas.addEventListener('mouseleave',  onUp);
  canvas.addEventListener('wheel',       onWheel, {passive: false});
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (mode === 'place') { ghostRot = ghostRot === 0 ? 90 : 0; draw(); }
  });
  document.addEventListener('keydown', onKey);
}

function evtWorld(e) {
  const r = canvas.getBoundingClientRect();
  return c2w(e.clientX - r.left, e.clientY - r.top);
}

function onDown(e) {
  const w  = evtWorld(e);
  const cx = e.clientX - canvas.getBoundingClientRect().left;
  const cy = e.clientY - canvas.getBoundingClientRect().top;

  // Middle mouse — pan
  if (e.button === 1) {
    drag = {type: 'pan', sx: e.clientX, sy: e.clientY, opx: panX, opy: panY};
    return;
  }

  // Place mode
  if (mode === 'place' && e.button === 0) {
    placeShelf(w.x, w.y);
    return;
  }

  // Edit-walls mode — hit test vertices
  if (mode === 'editWalls' && e.button === 0) {
    for (let i = 0; i < layout.walls.length; i++) {
      const p = w2c(layout.walls[i].x, layout.walls[i].y);
      if (Math.hypot(cx - p.x, cy - p.y) < 12) {
        drag = {type:'wallVtx', idx:i, sx:e.clientX, sy:e.clientY,
                ox:layout.walls[i].x, oy:layout.walls[i].y};
        return;
      }
    }
    for (let wi = 0; wi < layout.interiorWalls.length; wi++) {
      for (let vi = 0; vi < layout.interiorWalls[wi].length; vi++) {
        const p = w2c(layout.interiorWalls[wi][vi].x, layout.interiorWalls[wi][vi].y);
        if (Math.hypot(cx - p.x, cy - p.y) < 12) {
          drag = {type:'iWallVtx', wi, vi, sx:e.clientX, sy:e.clientY,
                  ox:layout.interiorWalls[wi][vi].x, oy:layout.interiorWalls[wi][vi].y};
          return;
        }
      }
    }
    return;
  }

  // Select mode — hit test shelves
  if (e.button === 0) {
    const hit = hitShelf(w.x, w.y);
    selId   = hit;
    selType = hit ? 'shelf' : null;
    if (hit) {
      const s = layout.shelves.find(s => s.id === hit);
      drag = {type:'shelf', id:hit, sx:e.clientX, sy:e.clientY, ox:s.x, oy:s.y};
    }
    updateSidebar();
    draw();
  }
}

function onMove(e) {
  mouseW = evtWorld(e);

  if (!drag) {
    if (mode === 'place') draw();
    return;
  }

  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;

  if (drag.type === 'pan') {
    panX = drag.opx + dx;
    panY = drag.opy + dy;
    draw();
    return;
  }

  if (drag.type === 'shelf') {
    const s = layout.shelves.find(s => s.id === drag.id);
    if (s) {
      s.x = snapV(drag.ox + dx / zoom);
      s.y = snapV(drag.oy + dy / zoom);
      draw();
    }
    return;
  }

  if (drag.type === 'wallVtx') {
    layout.walls[drag.idx].x = snapV(mouseW.x);
    layout.walls[drag.idx].y = snapV(mouseW.y);
    draw();
    return;
  }

  if (drag.type === 'iWallVtx') {
    layout.interiorWalls[drag.wi][drag.vi].x = snapV(mouseW.x);
    layout.interiorWalls[drag.wi][drag.vi].y = snapV(mouseW.y);
    draw();
    return;
  }
}

function onUp() { drag = null; }

function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const r      = canvas.getBoundingClientRect();
  const cx     = e.clientX - r.left;
  const cy     = e.clientY - r.top;
  panX = cx - (cx - panX) * factor;
  panY = cy - (cy - panY) * factor;
  zoom = Math.max(8, Math.min(300, zoom * factor));
  draw();
}

function onKey(e) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

  if (e.key === 'Escape')  { setMode('select'); return; }

  if (e.key === 'r' || e.key === 'R') {
    if (mode === 'place') { ghostRot = ghostRot === 0 ? 90 : 0; draw(); return; }
    if (selId && selType === 'shelf') rotateSelected();
  }

  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selId && selType === 'shelf') deleteSelected();
  }
}

// ── Hit testing ───────────────────────────────────────────────────────────
function hitShelf(wx, wy) {
  for (const s of [...layout.shelves].reverse()) {
    const vert = s.rot === 90;
    const sw = vert ? SHELF_D : SHELF_W;
    const sh = vert ? SHELF_W : SHELF_D;
    if (wx >= s.x && wx <= s.x + sw && wy >= s.y && wy <= s.y + sh) return s.id;
  }
  return null;
}

// ── Shelf operations ──────────────────────────────────────────────────────
function placeShelf(wx, wy) {
  const vert = ghostRot === 90;
  const sx   = snapV(wx) - (vert ? SHELF_D : SHELF_W) / 2;
  const sy   = snapV(wy) - (vert ? SHELF_W : SHELF_D) / 2;
  const id   = 'sh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

  layout.shelves.push({id, x: sx, y: sy, rot: ghostRot, label: '', aisle: null});
  selId   = id;
  selType = 'shelf';
  updateSidebar();
  updateUI();
  draw();
}

function rotateSelected() {
  const s = layout.shelves.find(s => s.id === selId);
  if (s) { s.rot = s.rot === 0 ? 90 : 0; updateSidebar(); draw(); }
}

function deleteSelected() {
  layout.shelves = layout.shelves.filter(s => s.id !== selId);
  selId   = null;
  selType = null;
  updateSidebar();
  updateUI();
  draw();
}

function clearShelves() {
  if (layout.shelves.length === 0) return;
  if (!confirm('Remove all placed shelves from the map?')) return;
  layout.shelves = [];
  selId = null; selType = null;
  updateSidebar(); updateUI(); draw();
}

function resetToDefaults() {
  if (!confirm('Reset all walls to the original RoomScan layout? This will also clear shelves.')) return;
  layout = buildDefaultLayout();
  selId = null; selType = null;
  updateSidebar(); updateUI(); autoFit();
}

// ── Mode / UI ─────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.querySelectorAll('.wm-mode-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('wm-mode-' + m)?.classList.add('active');
  canvas.style.cursor = m === 'place' ? 'crosshair' : m === 'editWalls' ? 'cell' : 'default';
  document.getElementById('wm-tip-place').style.display = m === 'place'     ? 'block' : 'none';
  document.getElementById('wm-tip-walls').style.display = m === 'editWalls' ? 'block' : 'none';
  draw();
}

function updateUI() {
  const n  = layout.shelves.length;
  const el = document.getElementById('wm-shelf-count');
  if (el) el.textContent = `${n} shelf${n !== 1 ? 's' : ''} placed`;
}

function updateSidebar() {
  const info = document.getElementById('wm-sel-info');
  if (!info) return;

  if (!selId || selType !== 'shelf') {
    info.innerHTML = `<p class="wm-hint">Click a shelf to edit it</p>`;
    return;
  }
  const s = layout.shelves.find(s => s.id === selId);
  if (!s) return;

  const aisleOpts = [
    `<option value="" ${s.aisle == null ? 'selected' : ''}>— Unassigned —</option>`,
    ...AISLE_COLORS.map((_, i) =>
      `<option value="${i}" ${s.aisle === i ? 'selected' : ''}>Aisle ${i + 1}</option>`
    ),
  ].join('');

  info.innerHTML = `
    <div class="wm-field">
      <label>Location Code</label>
      <input type="text" value="${esc(s.label)}"
             oninput="patchShelf('${s.id}', 'label', this.value)"
             placeholder="e.g. 1-4-L" />
    </div>
    <div class="wm-field">
      <label>Aisle</label>
      <select onchange="patchShelf('${s.id}', 'aisle', this.value===''?null:+this.value)">
        ${aisleOpts}
      </select>
    </div>
    <div class="wm-field">
      <button class="btn btn-secondary" style="width:100%;font-size:0.82rem"
              onclick="rotateSelected()">
        ↺ ${s.rot === 0 ? '⟷ Horizontal (1.5m wide)' : '↕ Vertical (1.5m tall)'}
      </button>
    </div>
    <button onclick="deleteSelected()"
            style="width:100%;padding:7px;background:#fee2e2;color:#b91c1c;
                   border:1px solid #fca5a5;border-radius:7px;font-weight:600;
                   cursor:pointer;font-size:0.82rem">
      🗑 Delete Shelf
    </button>
  `;
}

function patchShelf(id, key, val) {
  const s = layout.shelves.find(s => s.id === id);
  if (s) { s[key] = val; draw(); }
}

function populateLegend() {
  const el = document.getElementById('wm-aisle-legend');
  if (!el) return;
  el.innerHTML = AISLE_COLORS.slice(0, 5).map((c, i) =>
    `<div class="wm-legend-item">
      <div class="wm-legend-swatch" style="background:${c}"></div>
      <span>Aisle ${i + 1}</span>
    </div>`
  ).join('') + `
    <div class="wm-legend-item">
      <div class="wm-legend-swatch" style="background:#94a3b8"></div>
      <span>Unassigned</span>
    </div>`;
}

function zoomIn()  { zoom = Math.min(zoom * 1.2, 300); draw(); }
function zoomOut() { zoom = Math.max(zoom / 1.2,   8); draw(); }

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
