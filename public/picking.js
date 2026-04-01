let pickState    = {};
let lastTap      = {};
let currentItems = [];

// ── Session tracking ───────────────────────────────────────────────
let session = null; // active session data

function sessionStart(data) {
  session = {
    orderStart:    data.orders[0]   || 0,
    orderEnd:      data.orders[data.orders.length - 1] || 0,
    orderCount:    data.orderCount  || 0,
    itemCount:     data.items.length,
    pickTimestamps: [],   // ms timestamps of each pick action
    saved:          false,
  };
}

function sessionRecordPick() {
  if (!session) return;
  session.pickTimestamps.push(Date.now());
}

function sessionRecordUnpick() {
  // Remove the last timestamp if staff undo a pick
  if (!session || !session.pickTimestamps.length) return;
  session.pickTimestamps.pop();
}

function computeSessionStats() {
  if (!session || session.pickTimestamps.length < 2) return null;
  const ts = [...session.pickTimestamps].sort((a, b) => a - b);

  const MAX_GAP_MS = 2 * 60 * 1000; // 2 minutes
  const gaps = [];
  let excluded = 0;

  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap <= MAX_GAP_MS) {
      gaps.push(gap);
    } else {
      excluded++;
    }
  }

  const avgPickSeconds = gaps.length > 0
    ? gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000
    : null;
  const activeSeconds = gaps.length > 0
    ? Math.round(gaps.reduce((a, b) => a + b, 0) / 1000)
    : null;

  return {
    picksCompleted: ts.length,
    avgPickSeconds: avgPickSeconds != null ? Math.round(avgPickSeconds * 10) / 10 : null,
    activeSeconds,
    excludedGaps:   excluded,
    firstPickAt:    new Date(ts[0]).toISOString(),
    lastPickAt:     new Date(ts[ts.length - 1]).toISOString(),
  };
}

async function saveSession(force = false) {
  if (!session || session.saved) return;
  if (!force && session.pickTimestamps.length < 2) return;

  const stats = computeSessionStats();
  if (!stats) return;

  session.saved = true;

  const initials = (document.getElementById('pick-initials')?.value || '').toUpperCase().trim();

  const payload = {
    initials,
    orderStart:    session.orderStart,
    orderEnd:      session.orderEnd,
    orderCount:    session.orderCount,
    itemCount:     session.itemCount,
    ...stats,
  };

  try {
    // Use sendBeacon for page-unload saves (fire and forget)
    if (force && navigator.sendBeacon) {
      navigator.sendBeacon('/api/picking/session', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    } else {
      await fetch('/api/picking/session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
    }
  } catch (_) { /* best effort */ }
}

// Save on page hide (tab close, navigation away, iPhone home button)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveSession(true);
});
window.addEventListener('pagehide', () => saveSession(true));

// ── Load orders ────────────────────────────────────────────────────
async function loadOrders() {
  const start = document.getElementById('start-order').value.trim();
  const end   = document.getElementById('end-order').value.trim();

  if (!start || !end) { alert('Please enter both a start and end order number.'); return; }
  if (parseInt(end) < parseInt(start)) { alert('End order must be greater than or equal to start order.'); return; }

  const btn = document.getElementById('btn-load');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  const resultEl = document.getElementById('pick-result');
  resultEl.innerHTML = '<div class="pick-state">Fetching orders from Shopify…</div>';
  document.getElementById('pick-progress').classList.remove('visible');
  document.getElementById('complete-msg').classList.remove('visible');

  try {
    const res  = await fetch(`/api/picking/orders?start=${start}&end=${end}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load orders');

    currentItems = data.items;
    pickState    = {};
    lastTap      = {};
    session      = null;

    if (!data.items.length) {
      resultEl.innerHTML = `<div class="pick-state">No items found for orders #${start}–#${end}.<br>Check the order numbers and try again.</div>`;
      return;
    }

    renderList(data);
    sessionStart(data);
    updateProgress();

  } catch (err) {
    resultEl.innerHTML = `<div class="pick-state" style="color:#b91c1c">Error: ${err.message}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load';
  }
}

// ── Render pick list ───────────────────────────────────────────────
function shopifyThumb(url, size = 120) {
  if (!url) return null;
  // Insert _SIZExSIZE_crop_center before the file extension
  return url.replace(/(\.[a-z]+)(\?.*)?$/i, `_${size}x${size}_crop_center$1$2`);
}

function renderList(data) {
  const resultEl = document.getElementById('pick-result');

  const orderLabel = data.orders.length === 1
    ? `Order #${data.orders[0]}`
    : `Orders #${data.orders[0]}–#${data.orders[data.orders.length - 1]} · ${data.orderCount} order${data.orderCount !== 1 ? 's' : ''}`;

  const itemsHtml = data.items.map((item, idx) => {
    const id      = `item-${idx}`;
    const isMulti = item.qty > 1;
    const thumb   = shopifyThumb(item.image, 160);

    const imgHtml = thumb
      ? `<img class="pick-thumb" src="${thumb}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'pick-thumb-placeholder\\'>&#128230;</div>'" />`
      : `<div class="pick-thumb-placeholder">&#128230;</div>`;

    const variantHtml = item.variantTitle
      ? `<div class="pick-variant">${escHtml(item.variantTitle)}</div>`
      : '';

    return `
      <div class="pick-item" data-id="${id}" id="pick-${id}">
        <div class="pick-tick"><span class="pick-tick-icon">&#10003;</span></div>
        ${imgHtml}
        <div class="pick-details">
          <div class="pick-sku">${escHtml(item.sku || '—')}</div>
          <div class="pick-title">${escHtml(item.title)}</div>
          ${variantHtml}
        </div>
        <div class="pick-right">
          <div class="pick-order-num">#${item.orderNumber}</div>
          <div class="pick-qty${isMulti ? ' multi' : ''}">${item.qty}</div>
        </div>
      </div>
    `;
  }).join('');

  resultEl.innerHTML = `
    <p style="font-size:0.85rem;color:#64748b;margin-bottom:12px">${escHtml(orderLabel)} · ${data.items.length} line item${data.items.length !== 1 ? 's' : ''}</p>
    <div class="pick-list">${itemsHtml}</div>
  `;

  document.getElementById('pick-progress').classList.add('visible');

  // Attach double-tap listener to every item
  const clickTimers = {};
  document.querySelectorAll('.pick-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (clickTimers[id]) {
        // Second tap within window — confirm double-tap
        clearTimeout(clickTimers[id]);
        clickTimers[id] = null;
        togglePicked(el, id);
      } else {
        // First tap — flash and wait for possible second
        el.classList.add('tap-flash');
        setTimeout(() => el.classList.remove('tap-flash'), 200);
        clickTimers[id] = setTimeout(() => { clickTimers[id] = null; }, 400);
      }
    });
  });
}

function togglePicked(el, id) {
  pickState[id] = !pickState[id];
  if (pickState[id]) {
    el.classList.add('picked');
    sessionRecordPick();
  } else {
    el.classList.remove('picked');
    sessionRecordUnpick();
  }
  updateProgress();
}

// ── Progress ───────────────────────────────────────────────────────
function updateProgress() {
  const total  = document.querySelectorAll('.pick-item').length;
  const picked = document.querySelectorAll('.pick-item.picked').length;
  const pct    = total > 0 ? Math.round((picked / total) * 100) : 0;

  document.getElementById('progress-text').textContent = `${picked} of ${total} picked`;

  const bar = document.getElementById('progress-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('complete', picked === total && total > 0);

  const completeMsg = document.getElementById('complete-msg');
  const justCompleted = picked === total && total > 0;
  completeMsg.classList.toggle('visible', justCompleted);
  if (justCompleted) saveSession();
}

// ── Reset ──────────────────────────────────────────────────────────
function resetAll() {
  pickState = {};
  lastTap   = {};
  document.querySelectorAll('.pick-item.picked').forEach(el => el.classList.remove('picked'));
  document.getElementById('complete-msg').classList.remove('visible');
  updateProgress();
}

// ── +50 / +100 shortcuts ──────────────────────────────────────────
function addToEnd(n) {
  const start = parseInt(document.getElementById('start-order').value);
  if (!start || isNaN(start)) { alert('Enter a start order number first.'); return; }
  document.getElementById('end-order').value = start + n;
}

// ── Cancel ────────────────────────────────────────────────────────
function cancelPick() {
  document.getElementById('start-order').value = '';
  document.getElementById('end-order').value   = '';
  document.getElementById('pick-result').innerHTML = '';
  document.getElementById('pick-progress').classList.remove('visible');
  document.getElementById('complete-msg').classList.remove('visible');
  pickState    = {};
  lastTap      = {};
  currentItems = [];
  document.getElementById('start-order').focus();
}

// ── Persist initials in localStorage ──────────────────────────────
(function () {
  const el = document.getElementById('pick-initials');
  const saved = localStorage.getItem('pick_initials');
  if (saved) el.value = saved;
  el.addEventListener('input', () => {
    el.value = el.value.toUpperCase();
    localStorage.setItem('pick_initials', el.value);
  });
})();

// ── Submit on Enter ────────────────────────────────────────────────
document.getElementById('start-order').addEventListener('keydown', e => { if (e.key === 'Enter') loadOrders(); });
document.getElementById('end-order').addEventListener('keydown',   e => { if (e.key === 'Enter') loadOrders(); });

// ── Helpers ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
