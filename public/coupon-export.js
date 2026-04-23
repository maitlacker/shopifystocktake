'use strict';

let allCoupons = [];

const monthInput      = document.getElementById('monthInput');
const btnSync         = document.getElementById('btnSync');
const btnMatchOrders  = document.getElementById('btnMatchOrders');
const btnExport       = document.getElementById('btnExport');
const statusMsg       = document.getElementById('statusMsg');
const loadingMsg      = document.getElementById('loadingMsg');
const couponTable     = document.getElementById('couponTable');
const couponTbody     = document.getElementById('couponTbody');
const emptyMsg        = document.getElementById('emptyMsg');
const statTotal       = document.getElementById('statTotal');
const statMatched     = document.getElementById('statMatched');
const statUnmatched   = document.getElementById('statUnmatched');
const statUnused      = document.getElementById('statUnused');

// ── Default to current month ───────────────────────────────────────
(function setDefaultMonth() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  monthInput.value = `${y}-${m}`;
}());

// ── Load coupons for selected month ───────────────────────────────
async function loadMonth(clearStatus) {
  const month = monthInput.value;
  if (!month) return;

  loadingMsg.style.display  = 'block';
  couponTable.style.display = 'none';
  emptyMsg.style.display    = 'none';
  if (clearStatus) setStatus('');

  try {
    const r = await fetch(`/api/coupons/list?month=${encodeURIComponent(month)}`);
    if (!r.ok) throw new Error(await r.text());
    allCoupons = await r.json();
    render();
  } catch (err) {
    loadingMsg.style.display = 'none';
    setStatus('Error loading coupons: ' + err.message, true);
  }
}

// ── Render table ──────────────────────────────────────────────────
function render() {
  loadingMsg.style.display = 'none';

  const matched   = allCoupons.filter((c) => c.orderId != null).length;
  const unmatched = allCoupons.length - matched;
  const unused    = allCoupons.filter((c) => Number(c.usageCount) === 0).length;

  statTotal.textContent     = allCoupons.length;
  statMatched.textContent   = matched;
  statUnmatched.textContent = unmatched;
  statUnused.textContent    = unused;

  if (allCoupons.length === 0) {
    couponTable.style.display = 'none';
    emptyMsg.style.display    = 'block';
    return;
  }

  emptyMsg.style.display    = 'none';
  couponTable.style.display = 'table';

  couponTbody.innerHTML = allCoupons.map((c) => {
    const expiry   = c.expiresAt ? fmtDate(c.expiresAt) : '—';
    const discount = fmtDiscount(c.discountType, c.discountValue);
    const matchBadge = c.orderId
      ? '<span class="match-badge match-yes">Matched</span>'
      : '<span class="match-badge match-no">Unmatched</span>';

    return `<tr>
      <td style="font-family:monospace; font-weight:700; font-size:0.82rem;">${escHtml(c.code)}</td>
      <td style="text-align:center;">${c.usageCount}</td>
      <td style="white-space:nowrap; color:#64748b;">${escHtml(expiry)}</td>
      <td>${escHtml(discount)}</td>
      <td>${c.orderName ? escHtml(c.orderName) : '<span style="color:#94a3b8;">—</span>'}</td>
      <td>${c.customerName ? escHtml(c.customerName) : '<span style="color:#94a3b8;">—</span>'}</td>
      <td style="font-size:0.82rem;">${c.customerEmail ? escHtml(c.customerEmail) : '<span style="color:#94a3b8;">—</span>'}</td>
      <td>${matchBadge}</td>
    </tr>`;
  }).join('');
}

// ── Import from Shopify ───────────────────────────────────────────
btnSync.addEventListener('click', async () => {
  const month = monthInput.value;
  if (!month) { alert('Please select a month first.'); return; }

  setAllBtnsDisabled(true);
  setStatus('Importing from Shopify… this may take a minute while price rules are fetched.');

  try {
    const r = await fetch('/api/coupons/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ expiryMonth: month }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');

    const hint = data.monthFiltered === 0
      ? ' ⚠️ No matching codes found — check you have the right expiry month selected.'
      : '';
    setStatus(
      `Done. ${data.monthFiltered} code${data.monthFiltered !== 1 ? 's' : ''} stored ` +
      `(${data.inserted} new, ${data.updated} updated). ` +
      `Checked ${data.priceRulesChecked} price rule${data.priceRulesChecked !== 1 ? 's' : ''}, ` +
      `${data.totalFetched} total codes scanned.${hint}`
    );
    await loadMonth(); // don't pass clearStatus — keep the message above
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    setAllBtnsDisabled(false);
  }
});

// ── Match Orders ──────────────────────────────────────────────────
btnMatchOrders.addEventListener('click', async () => {
  const month = monthInput.value;
  if (!month) { alert('Please select a month first.'); return; }
  if (allCoupons.length === 0) { alert('No coupons loaded. Run Import first.'); return; }

  setAllBtnsDisabled(true);
  setStatus('Matching orders… fetching customer details from Shopify. This may take a while for large batches.');

  try {
    const r = await fetch('/api/coupons/match-orders', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ expiryMonth: month }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');

    let msg = `Matched ${data.matched} of ${data.processed} unmatched code${data.processed !== 1 ? 's' : ''}.`;
    if (data.notFound)  msg += ` ${data.notFound} order${data.notFound !== 1 ? 's' : ''} not found.`;
    if (data.noOrderId) msg += ` ${data.noOrderId} code${data.noOrderId !== 1 ? 's' : ''} had no parseable order ID.`;
    if (data.errors)    msg += ` ${data.errors} error${data.errors !== 1 ? 's' : ''} — check server log.`;
    setStatus(msg);
    await loadMonth();
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    setAllBtnsDisabled(false);
  }
});

// ── Download CSV ──────────────────────────────────────────────────
// Navigate to the export URL — server sends Content-Disposition: attachment
// so the browser downloads without leaving the page.
btnExport.addEventListener('click', () => {
  const month = monthInput.value;
  if (!month) { alert('Please select a month first.'); return; }
  if (allCoupons.length === 0) { alert('No coupons loaded for this month.'); return; }
  window.location.href = `/api/coupons/export?month=${encodeURIComponent(month)}`;
});

// ── Reload when month changes ─────────────────────────────────────
monthInput.addEventListener('change', () => loadMonth(true));

// ── Helpers ───────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function fmtDiscount(type, value) {
  if (value == null) return '—';
  if (type === 'percentage')   return `${Number(value).toFixed(0)}%`;
  if (type === 'fixed_amount') return `$${Number(value).toFixed(2)}`;
  return String(value);
}

function setStatus(msg, isError) {
  statusMsg.textContent = msg;
  statusMsg.className   = isError ? 'is-error' : '';
}

function setAllBtnsDisabled(disabled) {
  btnSync.disabled        = disabled;
  btnMatchOrders.disabled = disabled;
  btnExport.disabled      = disabled;
  monthInput.disabled     = disabled;
}

// ── Boot ──────────────────────────────────────────────────────────
loadMonth();
