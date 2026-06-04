'use strict';

let allOrders   = [];
let budgets     = {};   // keyed by "YYYY-MM"
let currentFilter = 'all';
let groupByMonth  = false;

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const NUMERIC_SIZES = ['6','8','10','12','14','16','18'];
const ALPHA_SIZES   = ['XS','S','M','L','XL','XXL'];
const PANTS_SIZES   = ['6','7','8','9','10','11','12','14','16','18'];

(async function init() {
  await Promise.all([loadOrders(), loadBudgets()]);
})();

async function loadOrders() {
  try {
    const r = await fetch('/api/production-orders');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    allOrders = await r.json();
    render();
  } catch (err) {
    document.getElementById('po-tbody').innerHTML =
      `<tr><td colspan="9" class="empty-cell">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

async function loadBudgets() {
  // Load budgets for current year and next year to cover all visible delivery dates
  const thisYear = new Date().getFullYear();
  try {
    const [r1, r2] = await Promise.all([
      fetch(`/api/production-budgets?year=${thisYear}`),
      fetch(`/api/production-budgets?year=${thisYear + 1}`),
    ]);
    const process = async (r) => {
      if (!r.ok) return;
      const rows = await r.json();
      rows.forEach(b => { budgets[`${b.year}-${String(b.month).padStart(2,'0')}`] = b; });
    };
    await Promise.all([process(r1), process(r2)]);
    render(); // re-render with budget data
  } catch (_) {}
}

function setFilter(status, btn) {
  currentFilter = status;
  document.querySelectorAll('.po-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  render();
}

function toggleMonthView() {
  groupByMonth = !groupByMonth;
  const btn = document.getElementById('month-toggle');
  btn.classList.toggle('on', groupByMonth);
  render();
}

function getAudTotal(o) {
  const subtotal = parseFloat(o.subtotal_aud) || 0;
  return o.include_gst ? subtotal * 1.1 : subtotal;
}

function render() {
  let orders = currentFilter === 'all'
    ? allOrders
    : allOrders.filter(o => o.status === currentFilter);

  const q = (document.getElementById('po-search')?.value || '').toLowerCase().trim();
  if (q) {
    orders = orders.filter(o =>
      (o.po_number      || '').toLowerCase().includes(q) ||
      (o.supplier_name  || '').toLowerCase().includes(q) ||
      (o.line_summaries || []).some(l => (l.name || '').toLowerCase().includes(q))
    );
  }

  const tbody = document.getElementById('po-tbody');
  if (!orders.length) {
    tbody.innerHTML = q
      ? `<tr><td colspan="9" class="empty-cell">No orders match "${escHtml(q)}".</td></tr>`
      : `<tr><td colspan="9" class="empty-cell">No orders found — <a href="/production-order.html" style="color:#6366f1">create one</a>.</td></tr>`;
    return;
  }

  if (groupByMonth) {
    tbody.innerHTML = renderGroupedByMonth(orders);
  } else {
    tbody.innerHTML = orders.map(o => orderRow(o)).join('');
  }
}

function renderGroupedByMonth(orders) {
  // Group by delivery month (YYYY-MM), nulls at end
  const groups = {};
  orders.forEach(o => {
    const key = o.delivery_date ? String(o.delivery_date).slice(0,7) : 'no-date';
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  });

  const sortedKeys = Object.keys(groups).sort((a,b) => {
    if (a === 'no-date') return 1;
    if (b === 'no-date') return -1;
    return a.localeCompare(b);
  });

  return sortedKeys.map(key => {
    const grp   = groups[key];
    const total = grp.reduce((s,o) => s + getAudTotal(o), 0);
    const units = grp.reduce((s,o) => s + (parseInt(o.total_items)||0), 0);
    const budget = budgets[key];
    const headerHtml = monthGroupHeader(key, grp.length, units, total, budget);
    return headerHtml + grp.map(o => orderRow(o)).join('');
  }).join('');
}

function monthGroupHeader(key, count, units, totalAud, budget) {
  let label = 'No Delivery Date';
  if (key !== 'no-date') {
    const [y, m] = key.split('-');
    label = `${MONTH_NAMES[parseInt(m)-1]} ${y}`;
  }

  let budgetChip = '';
  if (budget && budget.budget_aud > 0) {
    const variance = budget.budget_aud - totalAud;
    const pct = Math.round((totalAud / budget.budget_aud) * 100);
    const cls  = variance >= 0 ? 'under' : 'over';
    const sign = variance >= 0 ? 'under' : 'over';
    budgetChip = `<span class="po-budget-chip ${cls}">
      Budget: AUD ${fmt(budget.budget_aud)} · ${pct}% used · ${sign} by AUD ${fmt(Math.abs(variance))}
    </span>`;
  } else {
    budgetChip = `<span class="po-budget-chip none">No budget set</span>`;
  }

  return `<tr class="po-month-row">
    <td colspan="9">
      <span class="po-month-label">📅 ${label}</span>
      <span class="po-month-stats"> · ${count} order${count!==1?'s':''} · ${units} units · AUD ${fmt(totalAud)}</span>
      ${budgetChip}
    </td>
  </tr>`;
}

function orderRow(o) {
  const lines    = o.line_summaries || [];
  const audTotal = getAudTotal(o);

  // Products + codes column
  const productsHtml = lines.length
    ? lines.map(l => `
        <div class="po-line-block">
          <div class="po-product-name" title="${escHtml(l.name)}">${escHtml(l.name || '—')}</div>
          ${l.code ? `<div class="po-product-code">${escHtml(l.code)}</div>` : ''}
        </div>`).join('')
    : '<span style="color:#94a3b8">—</span>';

  // Size / QTY breakdown column
  const qtyHtml = lines.length
    ? lines.map(l => {
        const sizes = l.size_set === 'alpha' ? ALPHA_SIZES : l.size_set === 'pants' ? PANTS_SIZES : NUMERIC_SIZES;
        const qtys  = l.quantities || {};
        const pills = sizes
          .filter(sz => qtys[sz] > 0)
          .map(sz => `<span class="po-qty-pill nonzero">${sz}×${qtys[sz]}</span>`)
          .join('');
        return `<div class="po-line-block">
          <div class="po-qty-pills">${pills || `<span class="po-qty-pill">${l.qty} units</span>`}</div>
        </div>`;
      }).join('')
    : '—';

  const orderDate  = o.order_date    ? String(o.order_date).slice(0,10)    : '—';
  const delivDate  = o.delivery_date ? String(o.delivery_date).slice(0,10) : '—';
  const freight    = o.freight_mode === 'sea'
    ? `<span class="po-freight-sm sea">🚢 Sea</span>`
    : `<span class="po-freight-sm air">✈️ Air</span>`;

  const audHtml = `<span class="po-aud-total">AUD ${fmt(audTotal)}</span>` +
    (o.include_gst ? `<div class="po-aud-gst">inc. GST</div>` : '') +
    (o.currency !== 'AUD'
      ? `<div class="po-aud-gst">${o.currency} @ ${parseFloat(o.exchange_rate).toFixed(4)}</div>` : '');

  return `<tr class="po-data-row" onclick="window.location.href='/production-order.html?id=${o.id}'">
    <td><span class="po-num">${escHtml(o.po_number)}</span></td>
    <td>${escHtml(o.supplier_name || '—')}</td>
    <td>${productsHtml}</td>
    <td>${qtyHtml}</td>
    <td style="white-space:nowrap">${orderDate}</td>
    <td style="white-space:nowrap">${delivDate}</td>
    <td>${freight}</td>
    <td>${audHtml}</td>
    <td><span class="po-status ${o.status}">${o.status}</span></td>
  </tr>`;
}

function fmt(n) {
  return Number(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
}
function escHtml(str) {
  return String(str??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
