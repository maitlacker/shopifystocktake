'use strict';

let allCards = [];

const monthInput       = document.getElementById('monthInput');
const btnSync          = document.getElementById('btnSync');
const btnMatchCustomers = document.getElementById('btnMatchCustomers');
const btnExport        = document.getElementById('btnExport');
const statusMsg        = document.getElementById('statusMsg');
const loadingMsg       = document.getElementById('loadingMsg');
const gcTable          = document.getElementById('gcTable');
const gcTbody          = document.getElementById('gcTbody');
const emptyMsg         = document.getElementById('emptyMsg');
const statTotal        = document.getElementById('statTotal');
const statMatched      = document.getElementById('statMatched');
const statUnmatched    = document.getElementById('statUnmatched');
const statBalance      = document.getElementById('statBalance');

// ── Default to current month ───────────────────────────────────────
(function setDefaultMonth() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, '0');
  monthInput.value = `${y}-${m}`;
}());

// ── Load gift cards for selected month ────────────────────────────
async function loadMonth(clearStatus) {
  const month = monthInput.value;
  if (!month) return;

  loadingMsg.style.display = 'block';
  gcTable.style.display    = 'none';
  emptyMsg.style.display   = 'none';
  if (clearStatus) setStatus('');

  try {
    const r = await fetch(`/api/gift-cards/list?month=${encodeURIComponent(month)}`);
    if (!r.ok) throw new Error(await r.text());
    allCards = await r.json();
    render();
  } catch (err) {
    loadingMsg.style.display = 'none';
    setStatus('Error loading gift cards: ' + err.message, true);
  }
}

// ── Render table ──────────────────────────────────────────────────
function render() {
  loadingMsg.style.display = 'none';

  const matched   = allCards.filter((c) => c.customerEmail != null).length;
  const unmatched = allCards.length - matched;
  const totalBal  = allCards.reduce((sum, c) => sum + parseFloat(c.balance || 0), 0);

  statTotal.textContent    = allCards.length;
  statMatched.textContent  = matched;
  statUnmatched.textContent = unmatched;
  statBalance.textContent  = `$${totalBal.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (allCards.length === 0) {
    gcTable.style.display  = 'none';
    emptyMsg.style.display = 'block';
    return;
  }

  emptyMsg.style.display = 'none';
  gcTable.style.display  = 'table';

  gcTbody.innerHTML = allCards.map((c) => {
    const lastFour   = c.lastCharacters ? `...${escHtml(c.lastCharacters)}` : '—';
    const initVal    = c.initialValue != null ? `$${Number(c.initialValue).toFixed(2)}` : '—';
    const balance    = c.balance      != null ? `$${Number(c.balance).toFixed(2)}`      : '—';
    const expiry     = c.expiresOn    ? escHtml(String(c.expiresOn).slice(0, 10))        : '—';
    const orderDisp  = c.orderName    ? escHtml(c.orderName)                             : (c.orderId ? `#${c.orderId}` : '<span style="color:#94a3b8;">—</span>');
    const matchBadge = c.customerEmail
      ? '<span class="match-badge match-yes">Matched</span>'
      : '<span class="match-badge match-no">Unmatched</span>';

    return `<tr>
      <td style="font-family:monospace; font-weight:700; font-size:0.85rem; letter-spacing:0.05em;">${lastFour}</td>
      <td style="text-align:right;">${initVal}</td>
      <td style="text-align:right; font-weight:600;">${balance}</td>
      <td style="color:#64748b;">${escHtml(c.currency || 'AUD')}</td>
      <td style="white-space:nowrap; color:#64748b;">${expiry}</td>
      <td>${orderDisp}</td>
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
  setStatus('Importing from Shopify… scanning all active gift cards. This may take a moment for large stores.');

  try {
    const r = await fetch('/api/gift-cards/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ expiryMonth: month }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');

    setStatus(
      `Done. ${data.monthFiltered} gift card${data.monthFiltered !== 1 ? 's' : ''} stored ` +
      `(${data.inserted} new, ${data.updated} updated). ` +
      `Scanned ${data.totalFetched} total cards.` +
      (data.hint || '')
    );
    await loadMonth(); // keep the status message above
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    setAllBtnsDisabled(false);
  }
});

// ── Match Customers ───────────────────────────────────────────────
btnMatchCustomers.addEventListener('click', async () => {
  const month = monthInput.value;
  if (!month) { alert('Please select a month first.'); return; }
  if (allCards.length === 0) { alert('No gift cards loaded. Run Import first.'); return; }

  setAllBtnsDisabled(true);
  setStatus('Matching customers… fetching order details from Shopify. This may take a while for large batches.');

  try {
    const r = await fetch('/api/gift-cards/match-customers', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ expiryMonth: month }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');

    let msg = `Matched ${data.matched} of ${data.processed} unmatched card${data.processed !== 1 ? 's' : ''}.`;
    if (data.notFound)  msg += ` ${data.notFound} order${data.notFound !== 1 ? 's' : ''} not found.`;
    if (data.noOrderId) msg += ` ${data.noOrderId} card${data.noOrderId !== 1 ? 's' : ''} have no linked order.`;
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
btnExport.addEventListener('click', () => {
  const month = monthInput.value;
  if (!month) { alert('Please select a month first.'); return; }
  if (allCards.length === 0) { alert('No gift cards loaded for this month.'); return; }
  window.location.href = `/api/gift-cards/export?month=${encodeURIComponent(month)}`;
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

function setStatus(msg, isError) {
  statusMsg.textContent = msg;
  statusMsg.className   = isError ? 'is-error' : '';
}

function setAllBtnsDisabled(disabled) {
  btnSync.disabled           = disabled;
  btnMatchCustomers.disabled = disabled;
  btnExport.disabled         = disabled;
  monthInput.disabled        = disabled;
}

// ── Boot ──────────────────────────────────────────────────────────
loadMonth();
