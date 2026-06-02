'use strict';

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1; // 1-based
let yearData     = []; // 12-row array for currentYear
let allOrders    = []; // all production orders (for PO list)
let saveTimers   = {};

// ── Boot ──────────────────────────────────────────────────────────────
(async function init() {
  updateLabels();
  await Promise.all([loadBudgets(), loadOrders()]);
  renderMonth();
})();

// ── Data loading ──────────────────────────────────────────────────────
async function loadBudgets() {
  try {
    const r = await fetch(`/api/production-budgets?year=${currentYear}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    yearData = await r.json();
  } catch (err) {
    yearData = Array.from({length:12}, (_,i) => ({
      year: currentYear, month: i+1, budget_aud: 0, actual_aud: 0, notes: null
    }));
    console.error('Budget load error:', err.message);
  }
}

async function loadOrders() {
  try {
    const r = await fetch('/api/production-orders');
    if (!r.ok) return;
    allOrders = await r.json();
  } catch (_) {}
}

// ── Navigation ────────────────────────────────────────────────────────
async function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth > 12) { currentMonth = 1; currentYear++; await loadBudgets(); }
  else if (currentMonth < 1) { currentMonth = 12; currentYear--; await loadBudgets(); }
  updateLabels();
  renderMonth();
}

function updateLabels() {
  document.getElementById('bud-month-label').textContent =
    `${MONTH_NAMES[currentMonth-1]} ${currentYear}`;
  document.getElementById('set-month-label').textContent =
    `${MONTH_NAMES[currentMonth-1]} ${currentYear}`;
  document.getElementById('annual-year-label').textContent = currentYear;
}

// ── Month view render ─────────────────────────────────────────────────
function renderMonth() {
  updateLabels();
  const row    = yearData[currentMonth - 1] || {};
  const budget = parseFloat(row.budget_aud) || 0;
  const actual = parseFloat(row.actual_aud) || 0;
  const remaining = Math.max(0, budget - actual);
  const pct    = budget > 0 ? Math.min(Math.round((actual / budget) * 100), 999) : 0;
  const over   = actual > budget && budget > 0;

  // Cards
  document.getElementById('card-budget').textContent    = budget > 0 ? `AUD ${fmt(budget)}` : '—';
  document.getElementById('card-budget').className      = 'bud-card-value blue';

  document.getElementById('card-actual').textContent    = actual > 0  ? `AUD ${fmt(actual)}`    : '—';
  document.getElementById('card-actual').className      = `bud-card-value${over ? ' red' : ''}`;

  document.getElementById('card-remaining').textContent = budget > 0  ? `AUD ${fmt(remaining)}` : '—';
  document.getElementById('card-remaining').className   = `bud-card-value${over ? ' red' : remaining > 0 ? ' green' : ''}`;

  document.getElementById('card-pct').textContent  = budget > 0 ? `${pct}%` : '—';
  document.getElementById('card-pct').className    = `bud-card-value${pct > 100 ? ' red' : pct > 0 ? ' blue' : ' grey'}`;

  // Progress bar
  document.getElementById('prog-label').textContent = over
    ? '⚠️ Over budget'
    : budget > 0 ? 'Budget usage' : 'No budget set for this month';
  document.getElementById('prog-pct').textContent   = budget > 0 ? `${pct}% used` : '';
  const fill = document.getElementById('bud-bar-fill');
  fill.style.width    = budget > 0 ? `${Math.min(pct, 100)}%` : '0%';
  fill.className      = `bud-bar-fill${over ? ' over' : ''}`;

  // Budget input
  document.getElementById('set-budget-input').value = budget || '';
  document.getElementById('set-notes-input').value  = row.notes || '';
  document.getElementById('set-save-status').style.display = 'none';

  // PO list
  renderMonthOrders();

  // Annual table (if open)
  if (document.getElementById('bud-annual-panel').classList.contains('open')) {
    renderAnnual();
  }
}

// ── PO list for this month ─────────────────────────────────────────────
function renderMonthOrders() {
  const ymPrefix = `${currentYear}-${String(currentMonth).padStart(2,'0')}`;
  const orders = allOrders.filter(o =>
    o.delivery_date && String(o.delivery_date).slice(0, 7) === ymPrefix
  );

  const tbody = document.getElementById('bud-po-tbody');
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="bud-empty">No production orders with a delivery date in this month</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => {
    const audTotal = getAudTotal(o);
    const products = (o.line_summaries || []).map(l => escHtml(l.name || '—')).join(', ') || '—';
    const freight  = o.freight_mode === 'sea'
      ? `<span style="color:#0369a1;font-weight:700">🚢 Sea</span>`
      : `<span style="color:#7c3aed;font-weight:700">✈️ Air</span>`;
    return `<tr onclick="window.location.href='/production-order.html?id=${o.id}'">
      <td><span class="bud-po-num">${escHtml(o.po_number)}</span></td>
      <td>${escHtml(o.supplier_name || '—')}</td>
      <td style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${products}</td>
      <td>${freight}</td>
      <td style="text-align:right;font-weight:700">AUD ${fmt(audTotal)}</td>
      <td><span class="bud-po-status ${o.status}">${o.status}</span></td>
    </tr>`;
  }).join('');
}

function getAudTotal(o) {
  return parseFloat(o.subtotal_aud || 0) * (o.include_gst ? 1.1 : 1.0);
}

// ── Save current month's budget ───────────────────────────────────────
async function saveCurrentMonth() {
  const btn       = document.getElementById('set-save-btn');
  const statusEl  = document.getElementById('set-save-status');
  const budgetAud = parseFloat(document.getElementById('set-budget-input').value) || 0;
  const notes     = document.getElementById('set-notes-input').value.trim() || null;

  btn.disabled = true;
  statusEl.style.display = 'none';

  try {
    const res = await fetch(`/api/production-budgets/${currentYear}/${currentMonth}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budgetAud, notes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Update local yearData
    if (yearData[currentMonth-1]) {
      yearData[currentMonth-1].budget_aud = budgetAud;
      yearData[currentMonth-1].notes = notes;
    }
    statusEl.style.display = '';
    setTimeout(() => { statusEl.style.display = 'none'; }, 2500);
    renderMonth();
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Annual overview ────────────────────────────────────────────────────
function toggleAnnual() {
  const panel = document.getElementById('bud-annual-panel');
  panel.classList.toggle('open');
  if (panel.classList.contains('open')) renderAnnual();
}

function renderAnnual() {
  const now       = new Date();
  const thisYear  = now.getFullYear();
  const thisMonth = now.getMonth() + 1;

  let totalBudget = 0;
  let totalActual = 0;

  const rows = yearData.map((row, idx) => {
    const m        = idx + 1;
    const budget   = parseFloat(row.budget_aud) || 0;
    const actual   = parseFloat(row.actual_aud) || 0;
    const variance = budget - actual;
    const isCurrent = currentYear === thisYear && m === thisMonth;
    totalBudget += budget;
    totalActual += actual;

    let varHtml;
    if (budget === 0) {
      varHtml = `<span class="var-none">—</span>`;
    } else if (variance >= 0) {
      varHtml = `<span class="var-under">+AUD ${fmt(variance)}</span>`;
    } else {
      varHtml = `<span class="var-over">-AUD ${fmt(Math.abs(variance))}</span>`;
    }

    return `<tr class="${isCurrent ? 'ann-current' : ''}">
      <td style="font-weight:600;color:${isCurrent ? '#6366f1':'#1e293b'}">
        ${isCurrent ? '▶ ' : ''}${MONTH_SHORT[m-1]}
      </td>
      <td>
        <div class="ann-input-wrap">
          <span>AUD</span>
          <input type="number" class="ann-bud-input" id="ann-input-${m}"
                 value="${budget || ''}" min="0" step="500" placeholder="0"
                 oninput="scheduleAnnualSave(${m})" />
        </div>
      </td>
      <td style="text-align:right;font-weight:700;color:${actual > 0 ? '#334155' : '#cbd5e1'}">
        ${actual > 0 ? 'AUD ' + fmt(actual) : '—'}
      </td>
      <td style="text-align:right">${varHtml}</td>
      <td>
        <input type="text" class="ann-notes-input" id="ann-notes-${m}"
               value="${escHtml(row.notes || '')}" placeholder="Notes…"
               onblur="scheduleAnnualSave(${m})" />
      </td>
    </tr>`;
  }).join('');

  document.getElementById('bud-annual-tbody').innerHTML = rows;

  const totalVar = totalBudget - totalActual;
  document.getElementById('bud-annual-tfoot').innerHTML = `
    <tr>
      <td>Total</td>
      <td style="text-align:right">AUD ${fmt(totalBudget)}</td>
      <td style="text-align:right">AUD ${fmt(totalActual)}</td>
      <td style="text-align:right" class="${totalVar >= 0 ? 'var-under' : 'var-over'}">
        ${totalBudget > 0 ? (totalVar >= 0 ? '+' : '-') + 'AUD ' + fmt(Math.abs(totalVar)) : '—'}
      </td>
      <td></td>
    </tr>`;
}

// Debounced save from the annual table inputs
function scheduleAnnualSave(month) {
  clearTimeout(saveTimers[month]);
  const input = document.getElementById(`ann-input-${month}`);
  if (input) input.classList.add('saving');
  saveTimers[month] = setTimeout(() => saveAnnualMonth(month), 900);
}

async function saveAnnualMonth(month) {
  const input     = document.getElementById(`ann-input-${month}`);
  const notesEl   = document.getElementById(`ann-notes-${month}`);
  const budgetAud = parseFloat(input?.value) || 0;
  const notes     = notesEl?.value.trim() || null;

  try {
    const res = await fetch(`/api/production-budgets/${currentYear}/${month}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budgetAud, notes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (yearData[month-1]) {
      yearData[month-1].budget_aud = budgetAud;
      yearData[month-1].notes = notes;
    }
    // Refresh cards if this is the currently viewed month
    if (month === currentMonth) renderMonth();
  } catch (err) {
    console.error('Annual save failed:', err.message);
  } finally {
    if (input) input.classList.remove('saving');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function escHtml(str) {
  return String(str??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
