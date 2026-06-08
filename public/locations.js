'use strict';

const AISLE_COLORS = ['#6366f1','#22c55e','#f97316','#ef4444','#0ea5e9','#8b5cf6','#14b8a6','#f59e0b'];
const AISLE_LABELS = ['A1','A2','A3','A4','A5','A6','A7','A8'];

let allProducts = [];
let locations   = {};  // { [product_id]: { aisle, bay, excess_loc, variants: { [variant_id]: { aisle, bay } } } }

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function aisleOpts(selected) {
  let html = '<option value="">— Aisle —</option>';
  AISLE_LABELS.forEach((lbl, i) => {
    html += `<option value="${i+1}" ${selected===i+1?'selected':''}>${lbl}</option>`;
  });
  return html;
}

// ── Load data ──────────────────────────────────────────────────────────────
async function loadAll() {
  const [products, locs] = await Promise.all([
    fetch('/api/locations/products').then(r => r.json()),
    fetch('/api/locations').then(r => r.json()),
  ]);
  allProducts = products;
  locations   = locs;
  renderList(allProducts);
  updateCount(allProducts.length);
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderList(products) {
  const list = document.getElementById('loc-list');
  if (!products.length) {
    list.innerHTML = '<div class="loc-loading">No products found.</div>';
    return;
  }
  list.innerHTML = products.map(p => renderCard(p)).join('');
}

function renderCard(p) {
  const loc = locations[p.id] || { aisle: null, bay: null, excess_loc: '', variants: {} };
  const thumb = p.image
    ? `<img src="${esc(p.image)}" class="loc-thumb" alt="" loading="lazy" />`
    : `<div class="loc-thumb-placeholder">📦</div>`;

  const hasOverrides = Object.keys(loc.variants).length;

  return `
    <div class="loc-card" data-pid="${esc(p.id)}">
      <div class="loc-card-main">
        ${thumb}
        <div class="loc-title-col">
          <div class="loc-title">${esc(p.title)}</div>
          <div class="loc-title-meta">${p.variants.length} variant${p.variants.length!==1?'s':''}</div>
        </div>
        <div class="loc-fields">
          <div>
            <div class="loc-field-label">Aisle</div>
            <select class="loc-aisle-select" data-pid="${esc(p.id)}" data-vid=""
                    onchange="fieldChanged(this)" style="border-left: 3px solid ${loc.aisle ? AISLE_COLORS[loc.aisle-1] : '#e2e8f0'}">
              ${aisleOpts(loc.aisle)}
            </select>
          </div>
          <div>
            <div class="loc-field-label">Bay</div>
            <input type="number" class="loc-bay-input" min="1" max="99"
                   value="${loc.bay || ''}" placeholder="—"
                   data-pid="${esc(p.id)}" data-vid=""
                   onchange="fieldChanged(this)" />
          </div>
          <div>
            <div class="loc-field-label">Excess Stock Location</div>
            <input type="text" class="loc-excess-input"
                   value="${esc(loc.excess_loc || '')}" placeholder="e.g. Racking B3"
                   data-pid="${esc(p.id)}"
                   onchange="excessChanged(this)" />
          </div>
          <div class="loc-save-dot" id="dot-${esc(p.id)}"></div>
        </div>
        <button class="loc-variants-btn ${hasOverrides?'open':''}"
                onclick="toggleVariants(this, '${esc(p.id)}')" data-pid="${esc(p.id)}">
          ${hasOverrides ? `▼ ${hasOverrides} override${hasOverrides!==1?'s':''}` : '▼ Variants'}
        </button>
      </div>
      <div class="loc-variants-panel" id="vp-${esc(p.id)}" style="display:none">
        ${renderVariants(p, loc)}
      </div>
    </div>`;
}

function renderVariants(p, loc) {
  return p.variants.map(v => {
    const ov = loc.variants[v.id];
    const inherited = ov == null;
    const a = inherited ? loc.aisle : ov.aisle;
    const b = inherited ? loc.bay   : ov.bay;
    const inheritedLabel = loc.aisle ? `A${loc.aisle}-B${loc.bay || '?'}` : 'none';

    return `
      <div class="loc-variant-row" data-vid="${esc(v.id)}" data-pid="${esc(p.id)}">
        <div class="loc-variant-name">
          ${esc(v.title)}
          ${v.sku ? `<span class="loc-variant-sku">${esc(v.sku)}</span>` : ''}
        </div>
        ${inherited
          ? `<span class="loc-inherit-badge">inherits product (${esc(inheritedLabel)})</span>
             <button class="loc-override-btn" onclick="addOverride('${esc(p.id)}','${esc(v.id)}')">+ Override</button>`
          : `<select class="loc-aisle-select" data-pid="${esc(p.id)}" data-vid="${esc(v.id)}"
                     onchange="fieldChanged(this)" style="border-left:3px solid ${a ? AISLE_COLORS[a-1] : '#e2e8f0'}">
               ${aisleOpts(a)}
             </select>
             <input type="number" class="loc-bay-input" min="1" max="99"
                    value="${b || ''}" placeholder="—"
                    data-pid="${esc(p.id)}" data-vid="${esc(v.id)}"
                    onchange="fieldChanged(this)" />
             <button class="loc-remove-btn" onclick="removeOverride('${esc(p.id)}','${esc(v.id)}')">✕ Remove</button>`
        }
      </div>`;
  }).join('');
}

function updateCount(n) {
  const el = document.getElementById('loc-count');
  if (el) el.textContent = `${n} product${n!==1?'s':''}`;
}

// ── Panel toggle ───────────────────────────────────────────────────────────
function toggleVariants(btn, pid) {
  const panel = document.getElementById('vp-' + pid);
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  btn.classList.toggle('open', !open);
}

// ── Save helpers ───────────────────────────────────────────────────────────
const saveTimers = {};

function dot(pid, state) {
  const el = document.getElementById('dot-' + pid);
  if (!el) return;
  el.className = 'loc-save-dot ' + state;
  if (state === 'saved') setTimeout(() => { el.className = 'loc-save-dot'; }, 2000);
}

async function saveLocation(pid, vid, aisle, bay, excess_loc) {
  dot(pid, 'saving');
  try {
    const r = await fetch('/api/locations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: pid, variant_id: vid || '', aisle, bay, excess_loc }),
    });
    if (!r.ok) throw new Error(await r.text());
    // Update local cache
    if (!locations[pid]) locations[pid] = { aisle: null, bay: null, excess_loc: '', variants: {} };
    if (!vid) {
      locations[pid].aisle = aisle;
      locations[pid].bay = bay;
      locations[pid].excess_loc = excess_loc;
    } else {
      locations[pid].variants[vid] = { aisle, bay };
    }
    dot(pid, 'saved');
  } catch {
    dot(pid, 'error');
  }
}

function fieldChanged(el) {
  const pid = el.dataset.pid;
  const vid = el.dataset.vid || '';
  const card = el.closest('.loc-card');
  // Update aisle border colour
  if (el.classList.contains('loc-aisle-select')) {
    const idx = parseInt(el.value) - 1;
    el.style.borderLeft = el.value ? `3px solid ${AISLE_COLORS[idx]}` : '3px solid #e2e8f0';
  }
  // Collect current values for this scope (product or variant)
  const scope = vid
    ? el.closest('.loc-variant-row')
    : card;
  const aisleEl  = scope.querySelector(`.loc-aisle-select[data-vid="${vid}"]`);
  const bayEl    = scope.querySelector(`.loc-bay-input[data-vid="${vid}"]`);
  const aisle    = aisleEl  ? (parseInt(aisleEl.value) || null) : null;
  const bay      = bayEl    ? (parseInt(bayEl.value)   || null) : null;
  const excessEl = !vid ? card.querySelector('.loc-excess-input') : null;
  const excess   = excessEl ? excessEl.value.trim() : (locations[pid]?.excess_loc || '');

  clearTimeout(saveTimers[pid + vid]);
  saveTimers[pid + vid] = setTimeout(() => saveLocation(pid, vid, aisle, bay, excess), 600);
}

function excessChanged(el) {
  const pid = el.dataset.pid;
  const card = el.closest('.loc-card');
  const aisleEl = card.querySelector(`.loc-aisle-select[data-vid=""]`);
  const bayEl   = card.querySelector(`.loc-bay-input[data-vid=""]`);
  const aisle   = aisleEl ? (parseInt(aisleEl.value) || null) : null;
  const bay     = bayEl   ? (parseInt(bayEl.value)   || null) : null;
  const excess  = el.value.trim() || null;

  clearTimeout(saveTimers[pid]);
  saveTimers[pid] = setTimeout(() => saveLocation(pid, '', aisle, bay, excess), 600);
}

// ── Override add/remove ────────────────────────────────────────────────────
function addOverride(pid, vid) {
  const p = allProducts.find(p => String(p.id) === String(pid));
  if (!p) return;
  const loc = locations[pid] || { aisle: null, bay: null, excess_loc: '', variants: {} };
  // Pre-fill from product default
  loc.variants[vid] = { aisle: loc.aisle, bay: loc.bay };
  // Save immediately
  saveLocation(pid, vid, loc.aisle, loc.bay, loc.excess_loc || '');
  // Re-render card
  rerenderCard(p);
}

async function removeOverride(pid, vid) {
  dot(pid, 'saving');
  try {
    const r = await fetch('/api/locations/variant', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: pid, variant_id: vid }),
    });
    if (!r.ok) throw new Error();
    if (locations[pid]) delete locations[pid].variants[vid];
    const p = allProducts.find(p => String(p.id) === String(pid));
    if (p) rerenderCard(p);
    dot(pid, 'saved');
  } catch {
    dot(pid, 'error');
  }
}

function rerenderCard(p) {
  const existing = document.querySelector(`.loc-card[data-pid="${p.id}"]`);
  if (!existing) return;
  const wasOpen = document.getElementById('vp-' + p.id)?.style.display !== 'none';
  existing.outerHTML = renderCard(p);
  if (wasOpen) {
    const panel = document.getElementById('vp-' + p.id);
    const btn   = document.querySelector(`.loc-variants-btn[data-pid="${p.id}"]`);
    if (panel) panel.style.display = 'block';
    if (btn)   btn.classList.add('open');
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  document.getElementById('loc-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const filtered = q
      ? allProducts.filter(p =>
          p.title.toLowerCase().includes(q) ||
          p.variants.some(v => v.sku && v.sku.toLowerCase().includes(q))
        )
      : allProducts;
    renderList(filtered);
    updateCount(filtered.length);
  });
});
