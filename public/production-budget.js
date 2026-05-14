'use strict';

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let currentYear = new Date().getFullYear();
let budgetData  = [];
let saveTimers  = {};

(async function init() {
  document.getElementById('bud-year').textContent = currentYear;
  await load();
})();

async function changeYear(delta) {
  currentYear += delta;
  document.getElementById('bud-year').textContent = currentYear;
  await load();
}

async function load() {
  document.getElementById('bud-tbody').innerHTML =
    `<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:40px">Loading…</td></tr>`;
  try {
    const r = await fetch(`/api/production-budgets?year=${currentYear}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    budgetData = await r.json();
    render();
  } catch (err) {
    document.getElementById('bud-tbody').innerHTML =
      `<tr><td colspan="6" style="text-align:center;color:#ef4444;padding:40px">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function render() {
  const now   = new Date();
  const thisYear  = now.getFullYear();
  const thisMonth = now.getMonth() + 1;

  let totalBudget = 0;
  let totalActual = 0;

  const tbody = document.getElementById('bud-tbody');
  tbody.innerHTML = budgetData.map((row, idx) => {
    const m         = idx + 1;
    const budget    = row.budget_aud || 0;
    const actual    = row.actual_aud || 0;
    const variance  = budget - actual;
    const pct       = budget > 0 ? Math.min(Math.round((actual / budget) * 100), 999) : null;
    const isCurrent = currentYear === thisYear && m === thisMonth;

    totalBudget += budget;
    totalActual += actual;

    const barHtml = budget > 0
      ? `<div class="bud-bar-wrap">
           <div class="bud-bar${actual > budget ? ' over' : ''}"
                style="width:${Math.min((actual/budget)*100, 100)}%"></div>
         </div>
         <span style="font-size:0.75rem;color:#64748b;margin-left:6px">${pct}%</span>`
      : `<span style="color:#cbd5e1;font-size:0.8rem">—</span>`;

    let varHtml;
    if (budget === 0) {
      varHtml = `<span class="var-none">—</span>`;
    } else if (variance >= 0) {
      varHtml = `<span class="var-under">+AUD ${fmt(variance)}</span><div style="font-size:0.7rem;color:#94a3b8">under budget</div>`;
    } else {
      varHtml = `<span class="var-over">-AUD ${fmt(Math.abs(variance))}</span><div style="font-size:0.7rem;color:#94a3b8">over budget</div>`;
    }

    return `<tr class="${isCurrent ? 'current-month' : ''}">
      <td>
        <span class="month-label${isCurrent?' current':''}">
          ${isCurrent ? '▶ ' : ''}${MONTH_NAMES[m-1]}
        </span>
      </td>
      <td>
        <div class="bud-input-wrap">
          <span>AUD</span>
          <input type="number" class="bud-input" id="bud-input-${m}"
                 value="${budget || ''}" min="0" step="100" placeholder="0"
                 oninput="scheduleSave(${m})" />
        </div>
      </td>
      <td>
        <span class="actual-value${actual === 0 ? ' zero' : ''}">
          ${actual > 0 ? 'AUD ' + fmt(actual) : '—'}
        </span>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">${barHtml}</div>
      </td>
      <td>${varHtml}</td>
      <td>
        <input type="text" class="bud-notes-input" id="bud-notes-${m}"
               value="${escHtml(row.notes || '')}" placeholder="Notes…"
               onblur="scheduleSave(${m})" />
      </td>
    </tr>`;
  }).join('');

  // Footer totals
  const totalVariance = totalBudget - totalActual;
  const totalPct = totalBudget > 0 ? Math.round((totalActual/totalBudget)*100) : null;
  document.getElementById('bud-tfoot').innerHTML = `
    <tr>
      <td>Total</td>
      <td>AUD ${fmt(totalBudget)}</td>
      <td>AUD ${fmt(totalActual)}</td>
      <td>${totalPct !== null ? totalPct + '%' : '—'}</td>
      <td class="${totalVariance >= 0 ? 'var-under' : 'var-over'}">
        ${totalBudget > 0 ? (totalVariance >= 0 ? '+' : '-') + 'AUD ' + fmt(Math.abs(totalVariance)) : '—'}
      </td>
      <td></td>
    </tr>`;

  // Summary cards
  const remaining = Math.max(0, totalBudget - totalActual);
  const pctUsed   = totalBudget > 0 ? Math.round((totalActual/totalBudget)*100) : 0;
  document.getElementById('card-total-budget').textContent = `AUD ${fmt(totalBudget)}`;
  document.getElementById('card-total-actual').textContent = `AUD ${fmt(totalActual)}`;
  document.getElementById('card-total-actual').className   = `bud-card-value${totalActual > totalBudget ? ' red' : ''}`;
  document.getElementById('card-remaining').textContent    = `AUD ${fmt(remaining)}`;
  document.getElementById('card-remaining').className      = `bud-card-value${totalActual > totalBudget ? ' red' : ' green'}`;
  document.getElementById('card-pct').textContent          = totalBudget > 0 ? `${pctUsed}% used` : '—';
  document.getElementById('card-pct').className            = `bud-card-value${pctUsed > 100 ? ' red' : pctUsed > 80 ? '' : ' blue'}`;
}

// Debounced auto-save when user edits a budget field
function scheduleSave(month) {
  clearTimeout(saveTimers[month]);
  const input = document.getElementById(`bud-input-${month}`);
  if (input) input.classList.add('saving');
  saveTimers[month] = setTimeout(() => saveBudget(month), 800);
}

async function saveBudget(month) {
  const input    = document.getElementById(`bud-input-${month}`);
  const notesEl  = document.getElementById(`bud-notes-${month}`);
  const budgetAud = parseFloat(input?.value) || 0;
  const notes     = notesEl?.value.trim() || null;

  try {
    const res = await fetch(`/api/production-budgets/${currentYear}/${month}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budgetAud, notes }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Update local data
    if (budgetData[month-1]) budgetData[month-1].budget_aud = budgetAud;
    // Refresh totals and cards without full re-render (to preserve focus)
    refreshTotalsOnly();
  } catch (err) {
    console.error('Budget save failed:', err.message);
  } finally {
    if (input) input.classList.remove('saving');
  }
}

function refreshTotalsOnly() {
  // Recompute totals from current input values + actual data, update cards + footer
  let totalBudget = 0;
  let totalActual = 0;
  budgetData.forEach((row, idx) => {
    const m = idx + 1;
    const inputEl = document.getElementById(`bud-input-${m}`);
    const budget = inputEl ? (parseFloat(inputEl.value) || 0) : (row.budget_aud || 0);
    totalBudget += budget;
    totalActual += row.actual_aud || 0;
  });
  const remaining = Math.max(0, totalBudget - totalActual);
  const pctUsed   = totalBudget > 0 ? Math.round((totalActual/totalBudget)*100) : 0;
  const totalVar  = totalBudget - totalActual;

  document.getElementById('card-total-budget').textContent = `AUD ${fmt(totalBudget)}`;
  document.getElementById('card-total-actual').textContent = `AUD ${fmt(totalActual)}`;
  document.getElementById('card-remaining').textContent    = `AUD ${fmt(remaining)}`;
  document.getElementById('card-pct').textContent          = totalBudget > 0 ? `${pctUsed}% used` : '—';

  const tfoot = document.getElementById('bud-tfoot');
  if (tfoot.querySelector('td')) {
    const cells = tfoot.querySelectorAll('td');
    if (cells[1]) cells[1].textContent = `AUD ${fmt(totalBudget)}`;
    if (cells[3]) cells[3].textContent = totalBudget > 0 ? pctUsed + '%' : '—';
    if (cells[4]) {
      cells[4].textContent = totalBudget > 0
        ? (totalVar >= 0 ? '+' : '-') + 'AUD ' + fmt(Math.abs(totalVar)) : '—';
      cells[4].className = totalVar >= 0 ? 'var-under' : 'var-over';
    }
  }
}

function fmt(n) {
  return Number(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function escHtml(str) {
  return String(str??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
