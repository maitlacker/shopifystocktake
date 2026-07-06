// ── Helpers ────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function shopifyThumb(url, size) {
  if (!url) return null;
  return url.replace(/(\.[a-z]+)(\?.*)?$/i, `_${size}x${size}_crop_center$1$2`);
}

// ── State ──────────────────────────────────────────────────────────
let orders     = [];         // [{orderNumber, orderName, customerName, note, totalItems, items, removedItems}]
let currentIdx = 0;
let packedSet  = new Set();  // set of packed orderNumbers
let packKey    = '';
let packTimer  = null;
let packPrimed = false;

// ── View helpers ───────────────────────────────────────────────────
function showView(id) {
  ['view-setup','view-loading','view-packing','view-done'].forEach(v => {
    const el = document.getElementById(v);
    if (v === 'view-packing') {
      el.style.display = v === id ? 'flex' : 'none';
    } else {
      el.style.display = v === id ? 'block' : 'none';
    }
  });
}

// ── Load orders ────────────────────────────────────────────────────
async function loadOrders() {
  const start = document.getElementById('pk-start').value.trim();
  const end   = document.getElementById('pk-end').value.trim();
  if (!start || !end) { alert('Enter both a start and end order number.'); return; }
  if (parseInt(end) < parseInt(start)) { alert('End must be ≥ start.'); return; }

  showView('view-loading');

  try {
    const res  = await fetch(`/api/packing/orders?start=${start}&end=${end}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load orders');

    if (!data.orders.length) {
      showView('view-setup');
      alert(`No packable orders found in range #${start}–#${end}.`);
      return;
    }

    orders  = data.orders;
    packKey = `pack_${start}_${end}`;
    packedSet = new Set();

    // Restore any previously packed orders from this session
    try {
      const saved = JSON.parse(localStorage.getItem(packKey) || '[]');
      if (Array.isArray(saved)) saved.forEach(n => packedSet.add(n));
    } catch (_) {}

    // Start at first unpacked order (or first overall if all already packed)
    const firstUnpacked = orders.findIndex(o => !packedSet.has(o.orderNumber));
    currentIdx = firstUnpacked !== -1 ? firstUnpacked : 0;

    showView('view-packing');
    renderOrder(currentIdx);
  } catch (err) {
    showView('view-setup');
    alert('Error: ' + err.message);
  }
}

// ── Render a single order ──────────────────────────────────────────
function renderOrder(idx) {
  const order    = orders[idx];
  if (!order) return;
  const isPacked = packedSet.has(order.orderNumber);

  // Header
  document.getElementById('pk-order-num').textContent    = order.orderName;
  const custEl = document.getElementById('pk-customer-name');
  custEl.textContent   = order.customerName || '';
  custEl.style.display = order.customerName ? '' : 'none';

  // Progress
  document.getElementById('pk-progress').textContent = `${idx + 1} of ${orders.length}`;
  const pct = orders.length > 0 ? Math.round(packedSet.size / orders.length * 100) : 0;
  document.getElementById('pk-prog-bar').style.width = pct + '%';

  // Note banner
  const noteBanner = document.getElementById('pk-note-banner');
  if (order.note || order.noteAttributes?.length) {
    let html = '<strong>&#128203; Order Note:</strong>';
    if (order.note) {
      html += `<div class="pk-note-text">${escHtml(order.note)}</div>`;
    }
    if (order.noteAttributes?.length) {
      html += order.noteAttributes.map(a =>
        `<div class="pk-note-attr"><strong>${escHtml(a.name)}:</strong> ${escHtml(a.value)}</div>`
      ).join('');
    }
    noteBanner.innerHTML = html;
    noteBanner.style.display = 'block';
  } else {
    noteBanner.style.display = 'none';
  }

  // Removed items banner
  const removedBanner = document.getElementById('pk-removed-banner');
  if (order.removedItems?.length) {
    removedBanner.innerHTML =
      `&#9888;&#65039; <strong>${order.removedItems.length} item${order.removedItems.length !== 1 ? 's' : ''} removed/refunded</strong> from this order: ` +
      order.removedItems.map(i =>
        escHtml([i.title, i.variantTitle].filter(Boolean).join(' · '))
      ).join(', ');
    removedBanner.style.display = 'block';
  } else {
    removedBanner.style.display = 'none';
  }

  // Items grid
  const grid = document.getElementById('pk-items-grid');
  grid.className = 'pk-grid ' + gridClass(order.items.length);
  grid.innerHTML = order.items.map(itemCardHtml).join('');

  // Packed indicator
  document.getElementById('pk-packed-indicator').style.display = isPacked ? 'flex' : 'none';

  // Pack button
  updatePackBtn(order, isPacked);

  // Nav buttons
  const prevBtn = document.getElementById('pk-prev-btn');
  const nextBtn = document.getElementById('pk-next-btn');
  prevBtn.disabled = idx === 0;
  nextBtn.style.display = idx < orders.length - 1 ? 'inline-block' : 'none';

  // Reset double-tap state
  clearPackPrime();
}

// ── Grid class ─────────────────────────────────────────────────────
function gridClass(count) {
  if (count <= 1) return 'pk-grid--1';
  if (count === 2) return 'pk-grid--2';
  if (count === 3) return 'pk-grid--3';
  if (count <= 6)  return 'pk-grid--4';
  return 'pk-grid--many';
}

// ── Item card HTML ─────────────────────────────────────────────────
function itemCardHtml(item) {
  const isMulti  = item.qty > 1;
  const imgUrl   = shopifyThumb(item.image, 400);

  const imgEl = imgUrl
    ? `<img src="${escHtml(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="pk-img-ph">&#128230;</div>`;

  const qtyBadge = isMulti
    ? `<div class="pk-qty-badge">&#215;${item.qty}</div>` : '';

  const sizeHtml = item.variantTitle
    ? `<div class="pk-item-size">${escHtml(item.variantTitle)}</div>` : '';

  const modBadge = item.modified
    ? `<div class="pk-mod-badge">Qty edited</div>` : '';

  const multiLabel = isMulti
    ? `<div class="pk-item-qty-label">${item.qty} &#215; this item</div>` : '';

  return `
    <div class="pk-item-card${isMulti ? ' multi' : ''}">
      <div class="pk-img-wrap">
        ${imgEl}
        ${qtyBadge}
      </div>
      <div class="pk-item-info">
        <div class="pk-item-name">${escHtml(item.title)}</div>
        ${sizeHtml}
        <div class="pk-item-sku">${escHtml(item.sku || '—')}</div>
        ${modBadge}
        ${multiLabel}
      </div>
    </div>`;
}

// ── Pack button state ──────────────────────────────────────────────
function updatePackBtn(order, isPacked) {
  const btn   = document.getElementById('pk-pack-btn');
  const label = document.getElementById('pk-pack-label');

  if (isPacked) {
    btn.classList.add('packed');
    btn.classList.remove('primed');
    label.textContent = '✓ PACKED';
  } else {
    btn.classList.remove('packed', 'primed');
    const total = order.totalItems;
    label.textContent = `PACK ORDER · ${total} ITEM${total !== 1 ? 'S' : ''}`;
  }
}

// ── Pack interaction (double-tap, 800ms window) ────────────────────
function onPackBtn() {
  const order    = orders[currentIdx];
  if (!order) return;
  const isPacked = packedSet.has(order.orderNumber);

  if (isPacked) return; // already packed — button is inert

  if (packPrimed) {
    // Second tap within window — confirm
    clearTimeout(packTimer);
    packPrimed = false;
    packTimer  = null;
    confirmPack(order);
  } else {
    // First tap — prime with visual feedback
    packPrimed = true;
    const btn   = document.getElementById('pk-pack-btn');
    const label = document.getElementById('pk-pack-label');
    btn.classList.add('primed');
    label.textContent = 'Tap again to confirm ✓';

    packTimer = setTimeout(() => {
      packPrimed = false;
      btn.classList.remove('primed');
      updatePackBtn(order, false);
    }, 800);
  }
}

function clearPackPrime() {
  packPrimed = false;
  if (packTimer) { clearTimeout(packTimer); packTimer = null; }
  const btn = document.getElementById('pk-pack-btn');
  if (btn) btn.classList.remove('primed');
}

// ── Confirm pack ───────────────────────────────────────────────────
function confirmPack(order) {
  packedSet.add(order.orderNumber);
  savePacked();

  document.getElementById('pk-packed-indicator').style.display = 'flex';
  updatePackBtn(order, true);

  // All done?
  if (packedSet.size >= orders.length) {
    setTimeout(showDone, 500);
    return;
  }

  // Auto-advance to next unpacked order
  const nextUnpacked = orders.findIndex((o, i) => i > currentIdx && !packedSet.has(o.orderNumber));
  if (nextUnpacked !== -1) {
    setTimeout(() => goTo(nextUnpacked), 450);
  }
}

// ── Done screen ────────────────────────────────────────────────────
function showDone() {
  const totalOrders = orders.length;
  const totalItems  = orders.reduce((s, o) => s + o.totalItems, 0);
  document.getElementById('pk-done-sub').textContent =
    `${totalOrders} order${totalOrders !== 1 ? 's' : ''} packed · ${totalItems} item${totalItems !== 1 ? 's' : ''} total`;
  showView('view-done');
  try { localStorage.removeItem(packKey); } catch (_) {}
}

// ── Navigation ─────────────────────────────────────────────────────
function goTo(idx) {
  if (idx < 0 || idx >= orders.length) return;
  clearPackPrime();

  const body = document.getElementById('pk-body');
  body.style.transition = 'none';
  body.style.opacity   = '0';
  body.style.transform = 'translateX(16px)';

  requestAnimationFrame(() => {
    currentIdx = idx;
    renderOrder(idx);
    // Scroll to top of body after switching
    window.scrollTo({ top: 0, behavior: 'instant' });

    requestAnimationFrame(() => {
      body.style.transition = 'opacity .18s ease, transform .18s ease';
      body.style.opacity   = '1';
      body.style.transform = 'translateX(0)';
      setTimeout(() => { body.style.transition = ''; }, 200);
    });
  });
}

function prevOrder() { goTo(currentIdx - 1); }
function nextOrder() { goTo(currentIdx + 1); }

// ── Persistence ────────────────────────────────────────────────────
function savePacked() {
  if (!packKey) return;
  try { localStorage.setItem(packKey, JSON.stringify([...packedSet])); } catch (_) {}
}

// ── Setup helpers ──────────────────────────────────────────────────
function addToEnd(n) {
  const s = parseInt(document.getElementById('pk-start').value);
  if (!s || isNaN(s)) { alert('Enter a start order number first.'); return; }
  document.getElementById('pk-end').value = s + n;
}

function backToSetup() {
  clearPackPrime();
  showView('view-setup');
}

// ── Initials persistence ───────────────────────────────────────────
(function () {
  const el    = document.getElementById('pk-initials');
  const saved = localStorage.getItem('pick_initials');
  if (saved) el.value = saved;
  el.addEventListener('input', () => {
    el.value = el.value.toUpperCase();
    localStorage.setItem('pick_initials', el.value);
  });
})();

// ── Enter key shortcuts ────────────────────────────────────────────
document.getElementById('pk-start').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('pk-end').focus(); });
document.getElementById('pk-end').addEventListener('keydown',   e => { if (e.key === 'Enter') loadOrders(); });
