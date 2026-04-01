let pickState = {}; // variantId -> { picked: boolean }
let lastTap = {};   // variantId -> timestamp (for double-tap detection)
let currentItems = [];

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

    if (!data.items.length) {
      resultEl.innerHTML = `<div class="pick-state">No items found for orders #${start}–#${end}.<br>Check the order numbers and try again.</div>`;
      return;
    }

    renderList(data);
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

  const itemsHtml = data.items.map(item => {
    const id      = String(item.variantId || item.sku || item.title);
    const isMulti = item.qty > 1;
    const thumb   = shopifyThumb(item.image, 160);

    const imgHtml = thumb
      ? `<img class="pick-thumb" src="${thumb}" alt="" loading="lazy" onerror="this.parentNode.innerHTML='<div class=\\'pick-thumb-placeholder\\'>&#128230;</div>'" />`
      : `<div class="pick-thumb-placeholder">&#128230;</div>`;

    const variantHtml = item.variantTitle
      ? `<div class="pick-variant">${escHtml(item.variantTitle)}</div>`
      : '';

    const ordersHtml = item.orders && item.orders.length > 1
      ? `<div class="pick-orders-row">across ${item.orders.length} orders</div>`
      : '';

    return `
      <div class="pick-item" data-id="${escHtml(id)}" id="pick-${escHtml(id)}">
        <div class="pick-tick"><span class="pick-tick-icon">&#10003;</span></div>
        ${imgHtml}
        <div class="pick-details">
          <div class="pick-sku">${escHtml(item.sku || '—')}</div>
          <div class="pick-title">${escHtml(item.title)}</div>
          ${variantHtml}
          ${ordersHtml}
        </div>
        <div class="pick-qty${isMulti ? ' multi' : ''}">${item.qty}</div>
      </div>
    `;
  }).join('');

  resultEl.innerHTML = `
    <p style="font-size:0.85rem;color:#64748b;margin-bottom:12px">${escHtml(orderLabel)} · ${data.items.length} line item${data.items.length !== 1 ? 's' : ''}</p>
    <div class="pick-list">${itemsHtml}</div>
  `;

  document.getElementById('pick-progress').classList.add('visible');

  // Attach tap listeners to every item
  document.querySelectorAll('.pick-item').forEach(el => {
    el.addEventListener('touchend',  (e) => handleTap(e, el), { passive: true });
    el.addEventListener('dblclick',  (e) => handleDblClick(e, el));
  });
}

// ── Tap / double-tap handling ──────────────────────────────────────
function handleTap(e, el) {
  const id  = el.dataset.id;
  const now = Date.now();

  if (lastTap[id] && (now - lastTap[id]) < 420) {
    // Double-tap confirmed
    lastTap[id] = 0;
    togglePicked(el, id);
    // Prevent ghost click
    e.preventDefault && e.preventDefault();
  } else {
    lastTap[id] = now;
    // Brief visual flash on first tap so user knows it registered
    el.classList.add('tap-flash');
    setTimeout(() => el.classList.remove('tap-flash'), 200);
  }
}

function handleDblClick(e, el) {
  const id = el.dataset.id;
  togglePicked(el, id);
}

function togglePicked(el, id) {
  pickState[id] = !pickState[id];
  if (pickState[id]) {
    el.classList.add('picked');
  } else {
    el.classList.remove('picked');
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
  completeMsg.classList.toggle('visible', picked === total && total > 0);
}

// ── Reset ──────────────────────────────────────────────────────────
function resetAll() {
  pickState = {};
  lastTap   = {};
  document.querySelectorAll('.pick-item.picked').forEach(el => el.classList.remove('picked'));
  document.getElementById('complete-msg').classList.remove('visible');
  updateProgress();
}

// ── Submit on Enter ────────────────────────────────────────────────
document.getElementById('start-order').addEventListener('keydown', e => { if (e.key === 'Enter') loadOrders(); });
document.getElementById('end-order').addEventListener('keydown',   e => { if (e.key === 'Enter') loadOrders(); });

// ── Helpers ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
