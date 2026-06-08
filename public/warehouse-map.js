'use strict';

// ── Constants ─────────────────────────────────────────────────────────────
const SHELF_W = 1.5;
const SHELF_D = 0.545;
const SNAP    = 0.15;
const AISLE_COLORS = [
  '#6366f1','#22c55e','#f97316','#ef4444',
  '#0ea5e9','#8b5cf6','#14b8a6','#f59e0b',
];

// ── Default room polygon (from RoomScan Pro, metres) ──────────────────────
const DEFAULT_WALLS = [
  {x:14.13,y:19.62},{x:11.18,y:19.62},{x:8.69,y:19.62},
  {x:8.69,y:16.01},{x:4.32,y:16.01},{x:4.32,y:12.28},
  {x:3.84,y:12.28},{x:3.83,y:9.74},{x:3.09,y:9.73},
  {x:0.07,y:9.74},{x:0.07,y:8.48},{x:0.03,y:8.18},
  {x:0.03,y:7.88},{x:0.04,y:7.57},{x:0.04,y:5.08},
  {x:0.04,y:3.58},{x:0.01,y:3.43},{x:0.01,y:3.29},
  {x:0.0,y:3.14},{x:0.0,y:3.0},{x:0.01,y:2.86},
  {x:0.04,y:2.72},{x:0.08,y:2.57},{x:0.12,y:2.43},
  {x:0.17,y:2.29},{x:0.23,y:2.16},{x:0.3,y:2.02},
  {x:0.39,y:1.89},{x:0.39,y:0.0},{x:2.21,y:0.0},
  {x:14.0,y:0.01},{x:14.14,y:15.39},
];
const DEFAULT_INTERIOR_WALLS = [
  [{x:2.21,y:0.0},{x:2.21,y:9.74}],
];
const DEFAULT_ZONES = [
  {id:'warehouse', label:'WAREHOUSE',    color:'#6366f1', x:7.0,  y:6.5},
  {id:'production',label:'PRODUCTION',   color:'#f59e0b', x:1.0,  y:4.5},
  {id:'kitchen',   label:'KITCHEN',      color:'#ec4899', x:1.5,  y:17.5},
  {id:'understair',label:'UNDER-STAIRS', color:'#0ea5e9', x:5.0,  y:17.5},
  {id:'office',    label:'OFFICE',       color:'#22c55e', x:10.5, y:17.5},
];

// ── State ─────────────────────────────────────────────────────────────────
let layout    = buildDefaultLayout();
let mode      = 'select';
let zoom      = 40;
let panX      = 40, panY = 40;

// Selection
let selIds    = new Set();    // IDs of selected shelves
let selWallIdx = null;        // index into layout.interiorWalls when a wall is selected

// Drag
let drag      = null;

// Modes & helpers
let ghostRot  = 0;            // rotation while placing a shelf
let wallStart = null;         // first point when drawing a new wall
let lasso     = null;         // {sx,sy,ex,ey} lasso rectangle (canvas px)
let mouseW    = {x:0, y:0};  // current mouse in world (metres)

let canvas, ctx;

// ── Undo History ──────────────────────────────────────────────────────────
const MAX_HISTORY = 50;
let history = [];

function pushHistory() {
  history.push(JSON.stringify(layout));
  if (history.length > MAX_HISTORY) history.shift();
  const btn = document.getElementById('wm-undo-btn');
  if (btn) btn.disabled = false;
}

function undo() {
  if (history.length === 0) return;
  layout = JSON.parse(history.pop());
  selIds = new Set(); selWallIdx = null;
  updateSidebar(); updateUI(); draw();
  const btn = document.getElementById('wm-undo-btn');
  if (btn) {
    btn.disabled = history.length === 0;
    const orig = btn.textContent;
    btn.textContent = '↩ Undone!';
    setTimeout(() => { btn.textContent = orig; }, 800);
  }
}

function buildDefaultLayout() {
  return {
    walls:         DEFAULT_WALLS.map(v=>({...v})),
    interiorWalls: DEFAULT_INTERIOR_WALLS.map(w=>w.map(p=>({...p}))),
    zones:         DEFAULT_ZONES.map(z=>({...z})),
    shelves:       [],
  };
}

// ── Init ──────────────────────────────────────────────────────────────────
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

// ── Canvas ────────────────────────────────────────────────────────────────
function resizeCanvas() {
  const wrap = canvas.parentElement;
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  draw();
}

function autoFit() {
  const pad = 50, bw = 14.6, bh = 20.2;
  zoom = Math.min((canvas.width-pad*2)/bw, (canvas.height-pad*2)/bh, 55);
  panX = Math.round((canvas.width - 14.13*zoom) / 2);
  panY = pad;
  draw();
}

// ── Coordinates ───────────────────────────────────────────────────────────
function w2c(x,y)   { return {x: panX + x*zoom, y: panY + y*zoom}; }
function c2w(cx,cy) { return {x: (cx-panX)/zoom, y: (cy-panY)/zoom}; }
function snapV(v)   { return Math.round(v/SNAP)*SNAP; }

function evtCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return {cx: e.clientX-r.left, cy: e.clientY-r.top};
}
function evtWorld(e) {
  const {cx,cy} = evtCanvas(e);
  return c2w(cx,cy);
}

// ── Persistence ───────────────────────────────────────────────────────────
async function loadLayout() {
  try {
    const r = await fetch('/api/warehouse/layout');
    if (!r.ok) return;
    const d = await r.json();
    if (d?.walls?.length > 3) layout = d;
  } catch(_) {}
}

async function saveLayout() {
  const btn = document.getElementById('wm-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const r = await fetch('/api/warehouse/layout', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(layout),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    btn.textContent = '✓ Saved';
    setTimeout(()=>{ btn.textContent='💾 Save Layout'; btn.disabled=false; }, 2000);
  } catch(err) {
    alert('Save failed: ' + err.message);
    btn.textContent='💾 Save Layout'; btn.disabled=false;
  }
}

// ── Draw ──────────────────────────────────────────────────────────────────
function draw() {
  if (!ctx) return;
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawGrid();
  drawRoom();
  drawInteriorWalls();
  drawZoneLabels();
  drawShelves();

  if (mode === 'editWalls')          drawWallHandles();
  if (mode === 'place')              drawGhostShelf();
  if (mode === 'addWall')            drawGhostWall();
  if (lasso)                         drawLasso();

  drawScaleBar();
}

function drawGrid() {
  const minM = Math.floor((0 - Math.max(panX,panY)) / zoom) - 2;
  const maxM = Math.ceil(Math.max(canvas.width,canvas.height) / zoom) + 2;
  for (let m = minM; m <= maxM; m++) {
    const major = m % 5 === 0;
    ctx.strokeStyle = major ? '#d1d5db' : '#e5e7eb';
    ctx.lineWidth   = major ? 0.8 : 0.4;
    const cx = panX + m*zoom, cy = panY + m*zoom;
    ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,cy); ctx.lineTo(canvas.width,cy); ctx.stroke();
  }
}

function drawRoom() {
  const walls = layout.walls;
  if (!walls.length) return;
  ctx.beginPath();
  const f = w2c(walls[0].x, walls[0].y);
  ctx.moveTo(f.x, f.y);
  for (let i=1; i<walls.length; i++) { const p=w2c(walls[i].x,walls[i].y); ctx.lineTo(p.x,p.y); }
  ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 3; ctx.stroke();
}

function drawInteriorWalls() {
  layout.interiorWalls.forEach((wall, wi) => {
    if (wall.length < 2) return;
    const selected = selWallIdx === wi && (mode === 'editWalls');
    ctx.strokeStyle = selected ? '#ef4444' : '#475569';
    ctx.lineWidth   = selected ? 3 : 2;
    ctx.beginPath();
    const s = w2c(wall[0].x, wall[0].y); ctx.moveTo(s.x, s.y);
    for (let i=1; i<wall.length; i++) { const p=w2c(wall[i].x,wall[i].y); ctx.lineTo(p.x,p.y); }
    ctx.stroke();
  });
}

function drawZoneLabels() {
  ctx.textAlign = 'center';
  for (const z of layout.zones) {
    const {x:cx, y:cy} = w2c(z.x, z.y);
    const fs = Math.max(8, Math.min(zoom*0.4, 13));
    ctx.font = `700 ${fs}px sans-serif`;
    ctx.fillStyle = z.color || '#94a3b8';
    ctx.globalAlpha = 0.4;
    ctx.fillText(z.label, cx, cy);
    ctx.globalAlpha = 1;
  }
}

function drawShelves() {
  for (const s of layout.shelves) drawShelf(s, selIds.has(s.id));
}

function drawShelf(s, selected) {
  const vert = s.rot === 90;
  const sw = (vert ? SHELF_D : SHELF_W) * zoom;
  const sh = (vert ? SHELF_W : SHELF_D) * zoom;
  const {x:cx, y:cy} = w2c(s.x, s.y);
  const col = s.aisle != null ? AISLE_COLORS[s.aisle % AISLE_COLORS.length] : '#94a3b8';

  ctx.fillStyle   = col + (selected ? 'ee' : '99');
  ctx.strokeStyle = selected ? '#1e293b' : col + 'bb';
  ctx.lineWidth   = selected ? 2.5 : 1;
  ctx.fillRect(cx, cy, sw, sh);
  ctx.strokeRect(cx, cy, sw, sh);

  // Show shelf label: custom label OR auto "A2-4" (aisle+bay) OR just "A2"
  const autoTxt = s.aisle != null
    ? `A${s.aisle+1}${s.bay != null ? '-' + s.bay : ''}`
    : '';
  const txt = s.label || autoTxt;
  if (txt && zoom >= 22) {
    ctx.save();
    ctx.fillStyle    = '#fff';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur   = 2;
    // If we have both aisle and bay, split onto two lines
    if (!s.label && s.aisle != null && s.bay != null && zoom >= 32) {
      const fs = Math.max(7, zoom * 0.22);
      ctx.font = `700 ${fs}px sans-serif`;
      ctx.fillText(`A${s.aisle+1}`, cx+sw/2, cy+sh/2 - fs*0.6);
      ctx.font = `600 ${Math.max(6, zoom*0.19)}px sans-serif`;
      ctx.fillText(`B${s.bay}`, cx+sw/2, cy+sh/2 + fs*0.55);
    } else {
      ctx.font = `700 ${Math.max(7, zoom*0.24)}px sans-serif`;
      ctx.fillText(txt.slice(0,8), cx+sw/2, cy+sh/2);
    }
    ctx.restore();
  }

  if (selected) {
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5;
    [[cx,cy],[cx+sw,cy],[cx+sw,cy+sh],[cx,cy+sh]].forEach(([hx,hy]) => {
      ctx.beginPath(); ctx.arc(hx,hy,4,0,Math.PI*2); ctx.fill(); ctx.stroke();
    });
  }
}

function drawWallHandles() {
  // Outer wall vertex handles (red) — drag to move, double-click to delete
  layout.walls.forEach((v, i) => {
    const {x:cx,y:cy} = w2c(v.x, v.y);
    const active = drag?.type==='wallVtx' && drag.idx===i;
    ctx.fillStyle   = active ? '#dc2626' : '#ef4444';
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx,cy, active?8:6, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  });

  // Interior wall vertex handles (orange)
  layout.interiorWalls.forEach((wall, wi) => {
    wall.forEach((v, vi) => {
      const {x:cx,y:cy} = w2c(v.x, v.y);
      const active = drag?.type==='iWallVtx' && drag.wi===wi && drag.vi===vi;
      ctx.fillStyle   = active ? '#ea580c' : '#f97316';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx,cy, active?7:5, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    });
  });

  // Hover hint
  ctx.fillStyle  = '#64748b';
  ctx.font       = '11px sans-serif';
  ctx.textAlign  = 'left';
  ctx.fillText('Click segment → add point  ·  Double-click point → remove  ·  Click wall line → select', 8, canvas.height-8);
}

function drawGhostShelf() {
  const vert = ghostRot === 90;
  const sx = snapV(mouseW.x) - (vert?SHELF_D:SHELF_W)/2;
  const sy = snapV(mouseW.y) - (vert?SHELF_W:SHELF_D)/2;
  const sw = (vert?SHELF_D:SHELF_W)*zoom, sh = (vert?SHELF_W:SHELF_D)*zoom;
  const {x:cx,y:cy} = w2c(sx, sy);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = '#6366f1'; ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 1.5;
  ctx.fillRect(cx,cy,sw,sh); ctx.strokeRect(cx,cy,sw,sh);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#1e293b'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`${vert?'↕ 1.5m tall':'⟷ 1.5m wide'}  R = rotate`, cx+sw+6, cy+sh/2+4);
}

function drawGhostWall() {
  if (!wallStart) {
    ctx.fillStyle = '#f97316'; ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('Click to set wall start point', 8, canvas.height-8);
    return;
  }
  const a = w2c(wallStart.x, wallStart.y);
  const b = w2c(snapV(mouseW.x), snapV(mouseW.y));
  ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2;
  ctx.setLineDash([6,4]);
  ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#f97316'; ctx.beginPath(); ctx.arc(a.x,a.y,5,0,Math.PI*2); ctx.fill();
  ctx.fillStyle = '#f97316'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Click end point  ·  Esc = cancel', 8, canvas.height-8);
}

function drawLasso() {
  const x = Math.min(lasso.sx,lasso.ex), y = Math.min(lasso.sy,lasso.ey);
  const w = Math.abs(lasso.ex-lasso.sx), h = Math.abs(lasso.ey-lasso.sy);
  ctx.fillStyle = 'rgba(99,102,241,0.08)'; ctx.fillRect(x,y,w,h);
  ctx.strokeStyle = '#6366f1'; ctx.lineWidth = 1.5;
  ctx.setLineDash([4,3]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
}

function drawScaleBar() {
  const bars=5, barPx=bars*zoom;
  const x=canvas.width-barPx-16, y=canvas.height-16;
  ctx.strokeStyle='#475569'; ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(x,y); ctx.lineTo(x+barPx,y);
  ctx.moveTo(x,y-5); ctx.lineTo(x,y+5);
  ctx.moveTo(x+barPx,y-5); ctx.lineTo(x+barPx,y+5);
  ctx.stroke();
  ctx.fillStyle='#475569'; ctx.font='11px sans-serif'; ctx.textAlign='center';
  ctx.fillText(`${bars}m`, x+barPx/2, y-8);
}

// ── Geometry helpers ──────────────────────────────────────────────────────
function distPtSeg(px,py, ax,ay, bx,by) {
  const dx=bx-ax, dy=by-ay;
  const len2 = dx*dx+dy*dy;
  if (len2===0) return Math.hypot(px-ax,py-ay);
  const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/len2));
  return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
}

// Returns {type:'outerSeg',idx} or {type:'iWallSeg',wi,si} or null
function hitWallSegment(cx,cy) {
  const HIT = 8;
  for (let i=0; i<layout.walls.length; i++) {
    const j = (i+1) % layout.walls.length;
    const a=w2c(layout.walls[i].x,layout.walls[i].y);
    const b=w2c(layout.walls[j].x,layout.walls[j].y);
    if (distPtSeg(cx,cy,a.x,a.y,b.x,b.y) < HIT) return {type:'outerSeg',idx:i};
  }
  for (let wi=0; wi<layout.interiorWalls.length; wi++) {
    const wall=layout.interiorWalls[wi];
    for (let si=0; si<wall.length-1; si++) {
      const a=w2c(wall[si].x,wall[si].y);
      const b=w2c(wall[si+1].x,wall[si+1].y);
      if (distPtSeg(cx,cy,a.x,a.y,b.x,b.y) < HIT) return {type:'iWallSeg',wi,si};
    }
  }
  return null;
}

// ── Events ────────────────────────────────────────────────────────────────
function setupEvents() {
  canvas.addEventListener('mousedown',   onDown);
  canvas.addEventListener('mousemove',   onMove);
  canvas.addEventListener('mouseup',     onUp);
  canvas.addEventListener('mouseleave',  onUp);
  canvas.addEventListener('dblclick',    onDblClick);
  canvas.addEventListener('wheel',       onWheel, {passive:false});
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (mode==='place') { ghostRot = ghostRot===0?90:0; draw(); }
  });
  document.addEventListener('keydown', onKey);
}

function onDown(e) {
  const w        = evtWorld(e);
  const {cx,cy}  = evtCanvas(e);

  // Middle mouse → pan
  if (e.button===1) {
    drag = {type:'pan', sx:e.clientX, sy:e.clientY, opx:panX, opy:panY};
    return;
  }
  if (e.button!==0) return;

  // ── Place shelf ──
  if (mode==='place') { placeShelf(w.x, w.y); return; }

  // ── Add wall ──
  if (mode==='addWall') {
    if (!wallStart) {
      wallStart = {x:snapV(w.x), y:snapV(w.y)};
    } else {
      pushHistory();
      layout.interiorWalls.push([
        {x:wallStart.x, y:wallStart.y},
        {x:snapV(w.x),  y:snapV(w.y)},
      ]);
      wallStart = null;
      selWallIdx = layout.interiorWalls.length - 1;
      updateWallSidebar();
      draw();
    }
    draw();
    return;
  }

  // ── Edit walls ──
  if (mode==='editWalls') {
    // 1. Outer wall vertex drag?
    for (let i=0; i<layout.walls.length; i++) {
      const p=w2c(layout.walls[i].x,layout.walls[i].y);
      if (Math.hypot(cx-p.x,cy-p.y)<12) {
        pushHistory();
        drag={type:'wallVtx',idx:i,sx:e.clientX,sy:e.clientY,
              ox:layout.walls[i].x,oy:layout.walls[i].y};
        selWallIdx=null; updateWallSidebar(); return;
      }
    }
    // 2. Interior wall vertex drag?
    for (let wi=0; wi<layout.interiorWalls.length; wi++) {
      for (let vi=0; vi<layout.interiorWalls[wi].length; vi++) {
        const p=w2c(layout.interiorWalls[wi][vi].x,layout.interiorWalls[wi][vi].y);
        if (Math.hypot(cx-p.x,cy-p.y)<12) {
          pushHistory();
          drag={type:'iWallVtx',wi,vi,sx:e.clientX,sy:e.clientY,
                ox:layout.interiorWalls[wi][vi].x,oy:layout.interiorWalls[wi][vi].y};
          selWallIdx=wi; updateWallSidebar(); return;
        }
      }
    }
    // 3. Segment hit → insert vertex (outer) or select (interior)
    const segHit = hitWallSegment(cx, cy);
    if (segHit) {
      if (segHit.type==='outerSeg') {
        // Insert new vertex at the click position
        pushHistory();
        layout.walls.splice(segHit.idx+1, 0, {x:snapV(w.x), y:snapV(w.y)});
        selWallIdx=null;
      } else {
        // Select interior wall
        selWallIdx = segHit.wi;
      }
      updateWallSidebar(); draw(); return;
    }
    // 4. Click on nothing → deselect
    selWallIdx=null; updateWallSidebar(); draw();
    return;
  }

  // ── Select mode ──
  const hit = hitShelf(w.x, w.y);

  if (e.shiftKey) {
    if (hit) {
      if (selIds.has(hit)) selIds.delete(hit); else selIds.add(hit);
      updateSidebar(); draw();
    }
    return;
  }

  if (hit) {
    if (!selIds.has(hit)) selIds = new Set([hit]);
    // Start drag for all selected shelves
    pushHistory();
    drag = {
      type:'shelf', sx:e.clientX, sy:e.clientY,
      origPositions: [...selIds].map(id => {
        const s=layout.shelves.find(s=>s.id===id);
        return {id, ox:s.x, oy:s.y};
      }),
    };
    updateSidebar(); draw();
    return;
  }

  // Click on empty → start lasso
  selIds = new Set();
  lasso  = {sx:cx, sy:cy, ex:cx, ey:cy};
  updateSidebar(); draw();
}

function onDblClick(e) {
  if (mode!=='editWalls') return;
  const {cx,cy} = evtCanvas(e);
  // Double-click outer wall vertex → remove it (keep polygon valid: ≥3 vertices)
  for (let i=0; i<layout.walls.length; i++) {
    const p=w2c(layout.walls[i].x,layout.walls[i].y);
    if (Math.hypot(cx-p.x,cy-p.y)<12) {
      if (layout.walls.length>3) { pushHistory(); layout.walls.splice(i,1); }
      draw(); return;
    }
  }
  // Double-click interior wall vertex → remove it (if segment, whole wall goes if only 2 pts)
  for (let wi=0; wi<layout.interiorWalls.length; wi++) {
    for (let vi=0; vi<layout.interiorWalls[wi].length; vi++) {
      const p=w2c(layout.interiorWalls[wi][vi].x,layout.interiorWalls[wi][vi].y);
      if (Math.hypot(cx-p.x,cy-p.y)<12) {
        pushHistory();
        if (layout.interiorWalls[wi].length<=2) {
          layout.interiorWalls.splice(wi,1);
          if (selWallIdx===wi) selWallIdx=null;
        } else {
          layout.interiorWalls[wi].splice(vi,1);
        }
        updateWallSidebar(); draw(); return;
      }
    }
  }
}

function onMove(e) {
  mouseW = evtWorld(e);
  const {cx,cy} = evtCanvas(e);

  if (!drag && !lasso) {
    if (mode==='place' || mode==='addWall') draw();
    return;
  }

  if (lasso) {
    lasso.ex = cx; lasso.ey = cy;
    draw(); return;
  }

  const dx=e.clientX-drag.sx, dy=e.clientY-drag.sy;

  if (drag.type==='pan') {
    panX=drag.opx+dx; panY=drag.opy+dy; draw(); return;
  }
  if (drag.type==='shelf') {
    for (const {id,ox,oy} of drag.origPositions) {
      const s=layout.shelves.find(s=>s.id===id);
      if (s) { s.x=snapV(ox+dx/zoom); s.y=snapV(oy+dy/zoom); }
    }
    draw(); return;
  }
  if (drag.type==='wallVtx') {
    layout.walls[drag.idx].x=snapV(mouseW.x);
    layout.walls[drag.idx].y=snapV(mouseW.y);
    draw(); return;
  }
  if (drag.type==='iWallVtx') {
    layout.interiorWalls[drag.wi][drag.vi].x=snapV(mouseW.x);
    layout.interiorWalls[drag.wi][drag.vi].y=snapV(mouseW.y);
    draw(); return;
  }
}

function onUp(e) {
  if (lasso) {
    const minX=Math.min(lasso.sx,lasso.ex), maxX=Math.max(lasso.sx,lasso.ex);
    const minY=Math.min(lasso.sy,lasso.ey), maxY=Math.max(lasso.sy,lasso.ey);
    if (maxX-minX>5 || maxY-minY>5) {
      selIds = new Set();
      for (const s of layout.shelves) {
        const vert=s.rot===90;
        const sw=(vert?SHELF_D:SHELF_W)*zoom, sh=(vert?SHELF_W:SHELF_D)*zoom;
        const {x:scx,y:scy}=w2c(s.x,s.y);
        if (scx+sw>=minX && scx<=maxX && scy+sh>=minY && scy<=maxY) selIds.add(s.id);
      }
    }
    lasso = null;
    updateSidebar(); draw(); return;
  }
  drag = null;
}

function onWheel(e) {
  e.preventDefault();
  const f=e.deltaY<0?1.12:1/1.12;
  const r=canvas.getBoundingClientRect();
  const cx=e.clientX-r.left, cy=e.clientY-r.top;
  panX=cx-(cx-panX)*f; panY=cy-(cy-panY)*f;
  zoom=Math.max(8,Math.min(300,zoom*f));
  draw();
}

function onKey(e) {
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;

  if ((e.key==='z'||e.key==='Z') && (e.ctrlKey||e.metaKey)) {
    e.preventDefault(); undo(); return;
  }

  if (e.key==='Escape') {
    if (mode==='addWall') { wallStart=null; setMode('editWalls'); }
    else { setMode('select'); }
    return;
  }

  if ((e.key==='r'||e.key==='R') && mode==='place') {
    ghostRot=ghostRot===0?90:0; draw(); return;
  }
  if ((e.key==='r'||e.key==='R') && selIds.size===1) {
    rotateSelected(); return;
  }

  if (e.key==='Delete'||e.key==='Backspace') {
    if (mode==='editWalls' && selWallIdx!==null) {
      deleteSelectedWall(); return;
    }
    if (selIds.size>0) { deleteSelection(); }
  }
}

// ── Hit test ──────────────────────────────────────────────────────────────
function hitShelf(wx,wy) {
  for (const s of [...layout.shelves].reverse()) {
    const vert=s.rot===90;
    const sw=vert?SHELF_D:SHELF_W, sh=vert?SHELF_W:SHELF_D;
    if (wx>=s.x&&wx<=s.x+sw&&wy>=s.y&&wy<=s.y+sh) return s.id;
  }
  return null;
}

// ── Shelf operations ──────────────────────────────────────────────────────
function placeShelf(wx,wy) {
  pushHistory();
  const vert=ghostRot===90;
  const sx=snapV(wx)-(vert?SHELF_D:SHELF_W)/2;
  const sy=snapV(wy)-(vert?SHELF_W:SHELF_D)/2;
  const id='sh_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
  layout.shelves.push({id,x:sx,y:sy,rot:ghostRot,label:'',aisle:null});
  selIds=new Set([id]);
  updateSidebar(); updateUI(); draw();
}

function rotateSelected() {
  pushHistory();
  for (const id of selIds) {
    const s=layout.shelves.find(s=>s.id===id);
    if (s) s.rot=s.rot===0?90:0;
  }
  updateSidebar(); draw();
}

function deleteSelection() {
  if (selIds.size===0) return;
  if (selIds.size>1 && !confirm(`Delete ${selIds.size} shelves?`)) return;
  pushHistory();
  layout.shelves=layout.shelves.filter(s=>!selIds.has(s.id));
  selIds=new Set();
  updateSidebar(); updateUI(); draw();
}

function assignAisleToSelection(val) {
  pushHistory();
  const aisleVal=(val===''||val==='clear')?null:+val;
  for (const id of selIds) {
    const s=layout.shelves.find(s=>s.id===id);
    if (s) s.aisle=aisleVal;
  }
  draw();
}

function autoNumberBays() {
  pushHistory();
  const selected=layout.shelves.filter(s=>selIds.has(s.id));
  if (selected.length===0) return;
  const startInput=document.getElementById('wm-bay-start');
  const startFrom=startInput ? Math.max(1,+startInput.value||1) : 1;
  // Determine dominant axis: sort by Y (along aisle) or X (across aisles)
  const xs=selected.map(s=>s.x), ys=selected.map(s=>s.y);
  const xSpread=Math.max(...xs)-Math.min(...xs);
  const ySpread=Math.max(...ys)-Math.min(...ys);
  selected.sort((a,b)=> ySpread>=xSpread ? a.y-b.y : a.x-b.x);
  selected.forEach((s,i)=>{ s.bay=startFrom+i; });
  draw(); updateSidebar();
}

// ── Wall operations ───────────────────────────────────────────────────────
function startAddWall() {
  wallStart=null;
  setMode('addWall');
}

function deleteSelectedWall() {
  if (selWallIdx===null) return;
  pushHistory();
  layout.interiorWalls.splice(selWallIdx,1);
  selWallIdx=null;
  updateWallSidebar(); draw();
}

function clearShelves() {
  if (!layout.shelves.length) return;
  if (!confirm('Remove all placed shelves?')) return;
  pushHistory();
  layout.shelves=[]; selIds=new Set();
  updateSidebar(); updateUI(); draw();
}

function resetToDefaults() {
  if (!confirm('Reset walls to original RoomScan layout? Shelves will also be cleared.')) return;
  pushHistory();
  layout=buildDefaultLayout(); selIds=new Set(); selWallIdx=null;
  updateSidebar(); updateUI(); autoFit();
}

// ── Mode ──────────────────────────────────────────────────────────────────
function setMode(m) {
  mode=m;
  document.querySelectorAll('.wm-mode-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('wm-mode-'+m)?.classList.add('active');
  canvas.style.cursor = m==='place'?'crosshair': m==='editWalls'||m==='addWall'?'cell':'default';
  document.getElementById('wm-tip-place').style.display  = m==='place'?'block':'none';
  document.getElementById('wm-tip-walls').style.display  = (m==='editWalls'||m==='addWall')?'block':'none';
  document.getElementById('wm-wall-tools').style.display = (m==='editWalls'||m==='addWall')?'block':'none';
  if (m!=='addWall') wallStart=null;
  if (m!=='editWalls'&&m!=='addWall') { selWallIdx=null; }
  updateWallSidebar();
  draw();
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function updateSidebar() {
  const info=document.getElementById('wm-sel-info');
  if (!info) return;

  if (selIds.size===0) {
    info.innerHTML=`<p class="wm-hint">Click a shelf to select it<br>Shift+click to multi-select<br>Drag on empty space to lasso</p>`;
    return;
  }

  if (selIds.size>1) {
    const aisleOpts=AISLE_COLORS.map((_,i)=>
      `<option value="${i}">Aisle ${i+1}</option>`).join('');
    info.innerHTML=`
      <p class="wm-stat">${selIds.size} shelves selected</p>
      <div class="wm-field" style="margin-top:10px">
        <label>Assign Aisle (all selected)</label>
        <select onchange="assignAisleToSelection(this.value)">
          <option value="">— Choose Aisle —</option>
          ${aisleOpts}
          <option value="clear">Clear / Unassigned</option>
        </select>
      </div>
      <div class="wm-field">
        <label>Auto-number Bays</label>
        <p class="wm-hint" style="margin-bottom:5px">Sorts by position, assigns 1, 2, 3…</p>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
          <span style="font-size:0.8rem;color:#64748b;white-space:nowrap">Start from</span>
          <input type="number" id="wm-bay-start" min="1" max="99" value="1"
                 style="width:54px;padding:5px 7px;border:1.5px solid #e2e8f0;
                        border-radius:6px;font-size:0.85rem" />
        </div>
        <button onclick="autoNumberBays()"
                style="width:100%;padding:7px 10px;background:#eff6ff;color:#1d4ed8;
                       border:1.5px solid #bfdbfe;border-radius:7px;font-weight:600;
                       cursor:pointer;font-size:0.82rem">
          ↕ Number by Position
        </button>
      </div>
      <button onclick="deleteSelection()"
              style="width:100%;padding:7px;background:#fee2e2;color:#b91c1c;
                     border:1px solid #fca5a5;border-radius:7px;font-weight:600;
                     cursor:pointer;font-size:0.82rem;margin-top:4px">
        🗑 Delete ${selIds.size} shelves
      </button>`;
    return;
  }

  // Single shelf
  const id=[...selIds][0];
  const s=layout.shelves.find(s=>s.id===id);
  if (!s) return;
  const aisleOpts=[
    `<option value="" ${s.aisle==null?'selected':''}>— Unassigned —</option>`,
    ...AISLE_COLORS.map((_,i)=>`<option value="${i}" ${s.aisle===i?'selected':''}>Aisle ${i+1}</option>`),
  ].join('');

  const locPreview = s.aisle != null
    ? `A${s.aisle+1}${s.bay != null ? '-B'+s.bay : ' (no bay yet)'}`
    : '(no aisle assigned)';
  info.innerHTML=`
    <p class="wm-hint" style="margin-bottom:8px;font-size:0.76rem">
      Location: <b style="color:#334155">${esc(locPreview)}</b>
    </p>
    <div class="wm-field">
      <label>Aisle</label>
      <select onchange="patchShelf('${s.id}','aisle',this.value===''?null:+this.value);updateSidebar()">
        ${aisleOpts}
      </select>
    </div>
    <div class="wm-field">
      <label>Bay #</label>
      <input type="number" min="1" max="99"
             value="${s.bay != null ? s.bay : ''}"
             oninput="patchShelf('${s.id}','bay',this.value===''?null:+this.value);updateSidebar()"
             placeholder="e.g. 4" />
    </div>
    <div class="wm-field">
      <label>Custom Label <span style="font-weight:400;text-transform:none;font-size:0.68rem;color:#94a3b8">(overrides auto)</span></label>
      <input type="text" value="${esc(s.label)}"
             oninput="patchShelf('${s.id}','label',this.value)"
             placeholder="leave blank for auto" />
    </div>
    <div class="wm-field">
      <button class="btn btn-secondary" style="width:100%;font-size:0.82rem"
              onclick="rotateSelected()">
        ↺ ${s.rot===0?'⟷ Horizontal (1.5m wide)':'↕ Vertical (1.5m tall)'}
      </button>
    </div>
    <button onclick="deleteSelection()"
            style="width:100%;padding:7px;background:#fee2e2;color:#b91c1c;
                   border:1px solid #fca5a5;border-radius:7px;font-weight:600;
                   cursor:pointer;font-size:0.82rem">
      🗑 Delete Shelf
    </button>`;
}

function updateWallSidebar() {
  const el=document.getElementById('wm-wall-sel');
  if (!el) return;
  if (selWallIdx!==null && (mode==='editWalls'||mode==='addWall')) {
    el.style.display='block';
  } else {
    el.style.display='none';
  }
}

function patchShelf(id,key,val) {
  const s=layout.shelves.find(s=>s.id===id);
  if (s) { s[key]=val; draw(); }
}

// ── UI helpers ────────────────────────────────────────────────────────────
function updateUI() {
  const n=layout.shelves.length;
  const el=document.getElementById('wm-shelf-count');
  if (el) el.textContent=`${n} shelf${n!==1?'s':''} placed`;
}

function populateLegend() {
  const el=document.getElementById('wm-aisle-legend');
  if (!el) return;
  el.innerHTML=AISLE_COLORS.slice(0,5).map((c,i)=>
    `<div class="wm-legend-item">
       <div class="wm-legend-swatch" style="background:${c}"></div>
       <span>Aisle ${i+1}</span>
     </div>`).join('')+
    `<div class="wm-legend-item">
       <div class="wm-legend-swatch" style="background:#94a3b8"></div>
       <span>Unassigned</span>
     </div>`;
}

function zoomIn()  { zoom=Math.min(zoom*1.2,300); draw(); }
function zoomOut() { zoom=Math.max(zoom/1.2,  8); draw(); }

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
