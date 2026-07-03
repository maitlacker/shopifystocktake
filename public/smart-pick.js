// ── Constants ──────────────────────────────────────────────────────
const BAG_COLORS = [
  '#ef4444', // 1 — red
  '#3b82f6', // 2 — blue
  '#22c55e', // 3 — green
  '#a855f7', // 4 — purple
  '#f97316', // 5 — orange
  '#ec4899', // 6 — pink
  '#14b8a6', // 7 — teal
  '#eab308', // 8 — yellow
];

const AISLE_COLORS = ['#6366f1','#22c55e','#f97316','#ef4444','#0ea5e9','#8b5cf6','#14b8a6','#f59e0b'];
const AISLE_LABELS = ['A1','A2','A3','A4','A5','A6','A7','A8'];

function bagColor(n)   { return BAG_COLORS[(n - 1) % BAG_COLORS.length]; }
function aisleColor(n) { return (n >= 1 && n <= 8) ? AISLE_COLORS[n - 1] : '#64748b'; }
function aisleLabel(n) { return (n >= 1 && n <= 8) ? AISLE_LABELS[n - 1] : 'A' + n; }

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shopifyThumb(url, size = 100) {
  if (!url) return null;
  return url.replace(/(\.[a-z]+)(\?.*)?$/i, `_${size}x${size}_crop_center$1$2`);
}

// ── State ──────────────────────────────────────────────────────────
let planData   = null;   // { bags, stops, unlocatedItems, stats }
let pickState  = {};     // 'stop-X-item-Y' → true
let planKey    = '';     // localStorage key for this batch's pick state

// ── LocalStorage persistence ───────────────────────────────────────
function savePick() {
  if (!planKey) return;
  try { localStorage.setItem(planKey, JSON.stringify(pickState)); } catch (_) {}
}

function restorePick() {
  if (!planKey) return;
  try {
    const s = localStorage.getItem(planKey);
    if (s) pickState = JSON.parse(s);
  } catch (_) {}
}

// ── Setup helpers ──────────────────────────────────────────────────
function addToEnd(n) {
  const s = parseInt(document.getElementById('sp-start').value);
  if (!s || isNaN(s)) { alert('Enter a start order number first.'); return; }
  document.getElementById('sp-end').value = s + n;
}

function showSetup() {
  document.getElementById('view-setup').style.display   = 'block';
  document.getElementById('view-loading').style.display = 'none';
  document.getElementById('view-plan').style.display    = 'none';
  document.getElementById('view-picking').style.display = 'none';
}

// ── Generate plan ──────────────────────────────────────────────────
async function generatePlan() {
  const start    = document.getElementById('sp-start').value.trim();
  const end      = document.getElementById('sp-end').value.trim();
  if (!start || !end) { alert('Enter both a start and end order number.'); return; }
  if (parseInt(end) < parseInt(start)) { alert('End must be ≥ start.'); return; }

  document.getElementById('view-setup').style.display   = 'none';
  document.getElementById('view-loading').style.display = 'block';
  document.getElementById('view-plan').style.display    = 'none';
  document.getElementById('view-picking').style.display = 'none';

  try {
    const res  = await fetch('/api/smart-pick/plan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ orderStart: parseInt(start), orderEnd: parseInt(end) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate plan');

    if (!data.bags.length) {
      document.getElementById('view-loading').style.display = 'none';
      document.getElementById('view-setup').style.display   = 'block';
      alert(`No unfulfilled orders found in range #${start}–#${end}.`);
      return;
    }

    planData = data;
    // Plan key: all order numbers sorted, joined
    planKey = 'sp_' + data.bags.map(b => b.orderNumber).sort().join('_');
    pickState = {};
    restorePick();

    renderPlan();
  } catch (err) {
    document.getElementById('view-loading').style.display = 'none';
    document.getElementById('view-setup').style.display   = 'block';
    alert('Error: ' + err.message);
  }
}

// ── Plan overview ──────────────────────────────────────────────────
function renderPlan() {
  document.getElementById('view-loading').style.display = 'none';
  document.getElementById('view-plan').style.display    = 'block';

  const { bags, stops, unlocatedItems, stats } = planData;

  document.getElementById('plan-title').textContent =
    `${stats.orderCount} Order${stats.orderCount !== 1 ? 's' : ''} · ${stats.stopCount} Stop${stats.stopCount !== 1 ? 's' : ''}`;

  // Compute how many items are already picked (restore case)
  const totalPickable = countTotal();
  const alreadyPicked = countPicked();

  document.getElementById('plan-subtitle').textContent =
    `${stats.totalItems} item${stats.totalItems !== 1 ? 's' : ''} · ${stats.aisleCount} aisle${stats.aisleCount !== 1 ? 's' : ''}` +
    (alreadyPicked ? ` · ${alreadyPicked} already picked` : '');

  // Stats row
  document.getElementById('plan-stats').innerHTML = `
    <div class="sp-stat"><strong>${stats.orderCount}</strong><span>Orders</span></div>
    <div class="sp-stat"><strong>${stats.totalItems}</strong><span>Items</span></div>
    <div class="sp-stat"><strong>${stats.stopCount}</strong><span>Stops</span></div>
    <div class="sp-stat"><strong>${stats.aisleCount}</strong><span>Aisles</span></div>
  `;

  // Bag cards — count items per bag from stops + unlocated
  const bagItemCounts = {};
  for (const stop of stops) for (const item of stop.items) {
    bagItemCounts[item.bagNum] = (bagItemCounts[item.bagNum] || 0) + 1;
  }
  for (const item of unlocatedItems) {
    bagItemCounts[item.bagNum] = (bagItemCounts[item.bagNum] || 0) + 1;
  }

  document.getElementById('plan-bags').innerHTML = bags.map(bag => {
    const color = bagColor(bag.bagNum);
    const count = bagItemCounts[bag.bagNum] || 0;
    return `
      <div class="sp-bag-card" style="border-color:${color}20;background:${color}08">
        <div class="sp-bag-num" style="background:${color}">${bag.bagNum}</div>
        <div class="sp-bag-info">
          <div class="sp-bag-order">${escHtml(bag.orderName)}</div>
          <div class="sp-bag-count">${count} item${count !== 1 ? 's' : ''}</div>
          ${bag.note ? `<div class="sp-bag-note" title="${escHtml(bag.note)}">&#128203; ${escHtml(bag.note)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  // Unlocated warning
  const warnEl = document.getElementById('plan-warn');
  if (unlocatedItems.length) {
    warnEl.style.display = 'block';
    warnEl.innerHTML = `&#9888;&#65039; <strong>${unlocatedItems.length} item${unlocatedItems.length !== 1 ? 's' : ''}</strong> have no location assigned — they'll appear at the end of the pick list. <a href="/locations.html" style="color:#b45309;font-weight:700">Assign locations</a>`;
  } else {
    warnEl.style.display = 'none';
  }

  // Route preview — show aisle sequence
  const aisleSeq = [];
  let lastAisle = null;
  for (const stop of stops) {
    if (stop.aisle !== lastAisle) { aisleSeq.push(stop.aisle); lastAisle = stop.aisle; }
  }
  document.getElementById('plan-route').innerHTML =
    '<strong style="color:#334155">Route:</strong> ' +
    aisleSeq.map(a =>
      `<span class="sp-route-aisle" style="background:${aisleColor(a)}">${escHtml(aisleLabel(a))}</span>`
    ).join(' → ') +
    (unlocatedItems.length ? ' → <span class="sp-route-aisle" style="background:#f59e0b">Unlocated</span>' : '');
}

// ── Start picking ──────────────────────────────────────────────────
function startPicking() {
  document.getElementById('view-plan').style.display    = 'none';
  document.getElementById('view-picking').style.display = 'block';
  renderPickList();
  updateProgress();
}

// ── Render pick list ───────────────────────────────────────────────
function renderPickList() {
  const { stops, unlocatedItems } = planData;
  let html = '';

  // Stops
  for (const stop of stops) {
    const stopId    = `stop-${stop.stopNum}`;
    const color     = aisleColor(stop.aisle);
    const label     = aisleLabel(stop.aisle);
    const bayLabel  = stop.bay != null ? `Bay ${stop.bay}` : 'No Bay';
    const pickedInStop = stop.items.filter((_, i) => pickState[`${stopId}-item-${i}`]).length;
    const allDone   = pickedInStop === stop.items.length;

    html += `
      <div class="sp-stop${allDone ? ' done' : ''}" id="${stopId}">
        <div class="sp-stop-hdr" style="background:${color}" onclick="toggleStop('${stopId}')">
          <span class="sp-stop-num">Stop ${stop.stopNum}</span>
          <span class="sp-stop-loc">${escHtml(label)} / ${escHtml(bayLabel)}</span>
          <span class="sp-stop-progress">${pickedInStop}/${stop.items.length}</span>
          <span class="sp-stop-tick">${allDone ? '✓' : ''}</span>
        </div>
        <div class="sp-stop-items" id="${stopId}-items">
          ${stop.items.map((item, i) => itemRowHtml(item, `${stopId}-item-${i}`)).join('')}
        </div>
      </div>`;
  }

  // Unlocated items (at the end)
  if (unlocatedItems.length) {
    html += `
      <div class="sp-stop" id="stop-unlocated">
        <div class="sp-unlocated-hdr">&#9888; No location assigned — ${unlocatedItems.length} item${unlocatedItems.length !== 1 ? 's' : ''}</div>
        <div class="sp-stop-items" id="stop-unlocated-items">
          ${unlocatedItems.map((item, i) => itemRowHtml(item, `unlocated-item-${i}`)).join('')}
        </div>
      </div>`;
  }

  document.getElementById('sp-pick-list').innerHTML = html;

  // Attach double-tap listeners
  const timers = {};
  document.querySelectorAll('.sp-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (timers[id]) {
        clearTimeout(timers[id]);
        timers[id] = null;
        toggleItem(el, id);
      } else {
        el.classList.add('tap-flash');
        setTimeout(() => el.classList.remove('tap-flash'), 200);
        timers[id] = setTimeout(() => { timers[id] = null; }, 400);
      }
    });
  });
}

function itemRowHtml(item, id) {
  const t    = shopifyThumb(item.image, 100);
  const img  = t
    ? `<img class="sp-item-thumb" src="${t}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'sp-item-thumb-ph\\'>&#128230;</div>'">`
    : `<div class="sp-item-thumb-ph">&#128230;</div>`;
  const sub  = [item.variantTitle, item.sku].filter(Boolean).join(' · ');
  const isMulti = item.qty > 1;
  const isPicked = !!pickState[id];

  return `
    <div class="sp-item${isPicked ? ' picked' : ''}" data-id="${escHtml(id)}" id="sp-item-${escHtml(id)}">
      <div class="sp-item-bag" style="background:${bagColor(item.bagNum)}">${item.bagNum}</div>
      ${img}
      <div class="sp-item-info">
        <div class="sp-item-title">${escHtml(item.title)}</div>
        ${sub ? `<div class="sp-item-sub">${escHtml(sub)}</div>` : ''}
        <div class="sp-item-order">${escHtml(item.orderName)}</div>
      </div>
      <div class="sp-item-qty${isMulti ? ' multi' : ''}">×${item.qty}</div>
    </div>`;
}

// ── Toggle item picked ─────────────────────────────────────────────
function toggleItem(el, id) {
  pickState[id] = !pickState[id];
  el.classList.toggle('picked', pickState[id]);
  savePick();

  // Update the parent stop
  const stopEl = el.closest('.sp-stop');
  if (stopEl) refreshStop(stopEl);

  updateProgress();
}

function refreshStop(stopEl) {
  const stopId   = stopEl.id;
  if (stopId === 'stop-unlocated') return; // no progress counter for unlocated

  const stopNum  = parseInt(stopId.replace('stop-', ''));
  const stop     = planData.stops[stopNum - 1];
  if (!stop) return;

  const pickedInStop = stop.items.filter((_, i) => pickState[`${stopId}-item-${i}`]).length;
  const allDone      = pickedInStop === stop.items.length;

  // Update progress counter in header
  const progEl = stopEl.querySelector('.sp-stop-progress');
  if (progEl) progEl.textContent = `${pickedInStop}/${stop.items.length}`;

  const tickEl = stopEl.querySelector('.sp-stop-tick');
  if (tickEl) tickEl.textContent = allDone ? '✓' : '';

  stopEl.classList.toggle('done', allDone);
}

function toggleStop(stopId) {
  // Allow manual expand/collapse of completed stops
  const itemsEl = document.getElementById(stopId + '-items');
  if (!itemsEl) return;
  const stopEl = document.getElementById(stopId);
  if (!stopEl || !stopEl.classList.contains('done')) return; // only collapse completed stops
  itemsEl.style.display = itemsEl.style.display === 'none' ? 'block' : 'none';
}

// ── Progress ───────────────────────────────────────────────────────
function countTotal() {
  if (!planData) return 0;
  let t = 0;
  for (const stop of planData.stops) t += stop.items.length;
  t += planData.unlocatedItems.length;
  return t;
}

function countPicked() {
  return Object.values(pickState).filter(Boolean).length;
}

function updateProgress() {
  const total  = countTotal();
  const picked = countPicked();
  const pct    = total > 0 ? Math.round(picked / total * 100) : 0;

  document.getElementById('sp-prog-text').textContent = `${picked} of ${total} picked`;
  const bar = document.getElementById('sp-prog-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('complete', picked === total && total > 0);

  // Count completed stops
  const doneStops = document.querySelectorAll('.sp-stop.done').length;
  const totalStops = document.querySelectorAll('.sp-stop').length;
  document.getElementById('sp-stop-text').textContent = `Stop ${doneStops}/${totalStops}`;

  // Show complete message
  if (picked === total && total > 0) {
    const bags = planData.bags.length;
    document.getElementById('sp-complete-sub').textContent =
      `All ${total} items picked across ${bags} order${bags !== 1 ? 's' : ''}. Take the trolley to packing!`;
    document.getElementById('sp-complete-msg').style.display = 'block';
    try { localStorage.removeItem(planKey); } catch (_) {}
  }
}

// ── Initials persistence ───────────────────────────────────────────
(function () {
  const el    = document.getElementById('sp-initials');
  const saved = localStorage.getItem('pick_initials'); // shared with picking.js
  if (saved) el.value = saved;
  el.addEventListener('input', () => {
    el.value = el.value.toUpperCase();
    localStorage.setItem('pick_initials', el.value);
  });
})();

// ── Enter key shortcuts ────────────────────────────────────────────
document.getElementById('sp-start').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('sp-end').focus(); });
document.getElementById('sp-end').addEventListener('keydown',   e => { if (e.key === 'Enter') generatePlan(); });
