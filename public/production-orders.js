'use strict';

let allOrders = [];
let currentFilter = 'all';

(async function init() {
  await loadOrders();
})();

async function loadOrders() {
  try {
    const r = await fetch('/api/production-orders');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    allOrders = await r.json();
    render();
  } catch (err) {
    document.getElementById('po-tbody').innerHTML =
      `<tr><td colspan="8" class="empty-cell">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function setFilter(status, btn) {
  currentFilter = status;
  document.querySelectorAll('.po-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
}

function render() {
  const filtered = currentFilter === 'all'
    ? allOrders
    : allOrders.filter(o => o.status === currentFilter);

  const tbody = document.getElementById('po-tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">No production orders${currentFilter !== 'all' ? ` with status "${currentFilter}"` : ''} — <a href="/production-order.html" style="color:#6366f1">create one</a>.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(o => {
    const freight = o.freight_mode === 'sea'
      ? `<span class="po-freight-badge sea">🚢 Sea</span>`
      : `<span class="po-freight-badge air">✈️ Air</span>`;

    const orderDate   = o.order_date    ? String(o.order_date).slice(0,10)    : '—';
    const delivDate   = o.delivery_date ? String(o.delivery_date).slice(0,10) : '—';
    const currency    = o.currency !== 'AUD' ? ` <span style="font-size:0.75rem;color:#94a3b8">${o.currency}</span>` : '';

    return `<tr onclick="window.location.href='/production-order.html?id=${o.id}'">
      <td><span class="po-num">${escHtml(o.po_number)}</span></td>
      <td>${escHtml(o.supplier_name || '—')}${currency}</td>
      <td>${orderDate}</td>
      <td>${delivDate}</td>
      <td>${freight}</td>
      <td style="text-align:center">${o.line_count}</td>
      <td style="text-align:center;font-weight:700">${o.total_items}</td>
      <td><span class="po-status ${o.status}">${o.status}</span></td>
    </tr>`;
  }).join('');
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
