'use strict';

let pollTimer = null;

// ── Boot ──────────────────────────────────────────────────────────
(function init() {
  setTaxYear();       // default to current AU tax year
  checkExistingJob(); // re-attach if a job was already running
})();

// ── Helpers ───────────────────────────────────────────────────────
function currentTaxYear() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based
  // AU tax year starts 1 July
  const fyStart = month >= 7 ? year : year - 1;
  return {
    from: `${fyStart}-07-01`,
    to:   `${now.getFullYear()}-${String(month).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`,
  };
}

function setTaxYear() {
  const { from, to } = currentTaxYear();
  document.getElementById('fromDate').value = from;
  document.getElementById('toDate').value   = to;
}

function fmtCurrency(n) {
  return Number(n || 0).toLocaleString('en-AU', {
    style: 'currency', currency: 'AUD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function fmtMonth(ym) {
  const d = new Date((ym || '2000-01') + '-15');
  return d.toLocaleString('en-AU', { month: 'short', year: 'numeric' });
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Run ───────────────────────────────────────────────────────────
async function runReport() {
  const from     = document.getElementById('fromDate').value;
  const to       = document.getElementById('toDate').value;
  const keywords = document.getElementById('keywords').value.trim();
  const excludeGiftCards = document.getElementById('excludeGiftCards').checked;

  if (!from || !to) { alert('Please set both From and To dates.'); return; }
  if (from > to)    { alert('"From" date must be before "To" date.'); return; }

  setUiState('running');

  try {
    const r = await fetch('/api/gst-gap/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, keywords, excludeGiftCards }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    startPolling();
  } catch (err) {
    showError(err.message);
    setUiState('idle');
  }
}

// ── Check if a job was already running on page load ───────────────
async function checkExistingJob() {
  try {
    const r = await fetch('/api/gst-gap/status');
    const s = await r.json();
    if (s.isRunning) {
      setUiState('running');
      startPolling();
    } else if (s.result) {
      renderResults(s.result);
      setUiState('done');
    }
  } catch (e) { /* ignore */ }
}

// ── Polling ───────────────────────────────────────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch('/api/gst-gap/status');
      const s = await r.json();

      if (s.isRunning) {
        updateProgress(s);
      } else {
        stopPolling();
        if (s.error) {
          showError(s.error);
          setUiState('idle');
        } else if (s.result) {
          renderResults(s.result);
          setUiState('done');
        }
      }
    } catch (e) { /* ignore transient */ }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function updateProgress(s) {
  const pct = s.totalMonths > 0
    ? Math.round((s.processedMonths / s.totalMonths) * 100)
    : 0;
  const monthLabel = s.currentMonth ? fmtMonth(s.currentMonth) : '…';
  document.getElementById('progressLabel').innerHTML =
    `<span class="gg-spinner"></span>Processing ${escHtml(monthLabel)}…`;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressSub').textContent =
    `${s.processedMonths} of ${s.totalMonths} months complete`;
}

// ── UI state machine ──────────────────────────────────────────────
function setUiState(state) {
  const runBtn      = document.getElementById('runBtn');
  const progressCard = document.getElementById('progressCard');
  const resultsArea  = document.getElementById('resultsArea');
  const emptyState   = document.getElementById('emptyState');

  runBtn.disabled    = (state === 'running');
  runBtn.textContent = (state === 'running') ? 'Running…' : 'Run Report';
  progressCard.style.display = (state === 'running') ? '' : 'none';
  resultsArea.style.display  = (state === 'done')    ? '' : 'none';
  emptyState.style.display   = (state === 'idle')    ? '' : 'none';
}

function showError(msg) {
  const el = document.getElementById('errorMsg');
  el.textContent = '⚠ ' + msg;
  el.style.display = '';
}

// ── Render results ────────────────────────────────────────────────
function renderResults(d) {
  document.getElementById('errorMsg').style.display = 'none';

  // ATO callout
  const noIssues = d.totalMissingGST === 0;
  document.getElementById('atoCallout').innerHTML = noIssues
    ? `<strong>✅ No missing GST found</strong> for the selected period and keywords. All non-gift-card domestic orders had tax applied correctly.`
    : `<strong>Missing GST identified — action required</strong><br>
       For the period <strong>${escHtml(d.from)}</strong> to <strong>${escHtml(d.to)}</strong>
       ${d.keywords ? ` (products matching: <em>${escHtml(d.keywords)}</em>)` : ' (all products)'},
       the following GST was not collected on domestic AU orders:<br>
       <span class="gg-ato-amount">${fmtCurrency(d.totalMissingGST)}</span>
       This amount should be reported to the ATO. Your accountant will advise whether a BAS amendment is required.`;

  if (noIssues) {
    document.getElementById('atoCallout').style.cssText =
      'background:#f0fdf4; border:1px solid #bbf7d0; border-radius:12px; padding:16px 20px; ' +
      'margin-bottom:22px; font-size:0.88rem; color:#15803d; line-height:1.6;';
  }

  // Summary cards
  document.getElementById('rOrders').textContent   = d.totalOrders.toLocaleString();
  document.getElementById('rUnits').textContent    = d.totalUnits.toLocaleString();
  document.getElementById('rRevenue').textContent  = fmtCurrency(d.totalRevenue);
  document.getElementById('rMissingGST').textContent = fmtCurrency(d.totalMissingGST);

  // Product table
  document.getElementById('productBadge').textContent =
    `${d.products.length} product${d.products.length !== 1 ? 's' : ''}`;
  document.getElementById('productBadge').className =
    'gg-badge ' + (d.products.length > 0 ? 'red' : 'green');

  renderProductTable(d.products);
  renderMonthTable(d.byMonth, d.totalMissingGST);
}

function renderProductTable(products) {
  const area = document.getElementById('productTableArea');

  if (products.length === 0) {
    area.innerHTML = `<div class="gg-empty" style="padding:40px 24px;">
      <div class="gg-empty-icon">✅</div>
      <div class="gg-empty-title">No non-taxable products found</div>
    </div>`;
    return;
  }

  let rowsHtml = '';
  products.forEach((p, pi) => {
    const varCount = p.variants.length;
    rowsHtml += `
      <tr class="gg-prod-main-row" data-pi="${pi}" onclick="toggleVariants(${pi})">
        <td>
          <div class="gg-prod-title">
            <span class="gg-caret" id="caret-${pi}">▶</span>
            ${escHtml(p.title)}
            ${varCount > 1 ? `<span style="font-size:0.72rem; color:#94a3b8; font-weight:400;">(${varCount} variants)</span>` : ''}
          </div>
        </td>
        <td class="num">${p.units}</td>
        <td class="num">${fmtCurrency(p.revenue)}</td>
        <td class="num gg-missing-gst">${fmtCurrency(p.missingGST)}</td>
      </tr>`;

    p.variants.forEach(v => {
      rowsHtml += `
        <tr class="gg-variant-row hidden" id="var-${pi}-row">
          <td>${escHtml(v.name)}${v.sku && v.sku !== '—' ? ` <span style="color:#94a3b8; font-family:monospace; font-size:0.75rem;">${escHtml(v.sku)}</span>` : ''}</td>
          <td class="num" style="color:#64748b;">${v.units}</td>
          <td class="num" style="color:#64748b;">${fmtCurrency(v.revenue)}</td>
          <td class="num" style="color:#ef4444;">${fmtCurrency(v.missingGST)}</td>
        </tr>`;
    });
  });

  area.innerHTML = `
    <table class="gg-table">
      <thead>
        <tr>
          <th>Product</th>
          <th class="num">Units</th>
          <th class="num">Revenue</th>
          <th class="num">Missing GST</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function toggleVariants(pi) {
  const caret = document.getElementById(`caret-${pi}`);
  const varRows = document.querySelectorAll(`#var-${pi}-row`);
  const isOpen = caret.classList.contains('open');

  if (isOpen) {
    caret.classList.remove('open');
    varRows.forEach(r => r.classList.add('hidden'));
  } else {
    caret.classList.add('open');
    varRows.forEach(r => r.classList.remove('hidden'));
  }
}

function renderMonthTable(byMonth, totalMissingGST) {
  const area = document.getElementById('monthTableArea');
  const maxGST = Math.max(...byMonth.map(m => m.missingGST), 0.01);

  const rowsHtml = byMonth.map(m => {
    const barPct = Math.round((m.missingGST / maxGST) * 100);
    const hasData = m.missingGST > 0;
    return `<tr>
      <td style="white-space:nowrap; font-weight:600;">${escHtml(fmtMonth(m.month))}</td>
      <td class="num" style="color:#64748b;">${m.orders || 0}</td>
      <td class="num" style="color:#64748b;">${m.units || 0}</td>
      <td class="num">${fmtCurrency(m.revenue)}</td>
      <td class="num ${hasData ? 'gg-missing-gst' : ''}">${fmtCurrency(m.missingGST)}</td>
      <td class="gg-month-bar-cell" style="padding-right:20px;">
        <div class="gg-month-bar">
          <div class="gg-month-bar-fill" style="width:${barPct}%"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  area.innerHTML = `
    <table class="gg-table">
      <thead>
        <tr>
          <th>Month</th>
          <th class="num">Orders</th>
          <th class="num">Units</th>
          <th class="num">Revenue</th>
          <th class="num">Missing GST</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr style="background:#f8fafc;">
          <td colspan="4" style="padding:10px 16px; font-weight:700; color:#1e293b;">Total</td>
          <td class="num gg-missing-gst" style="padding:10px 16px;">${fmtCurrency(totalMissingGST)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
}
