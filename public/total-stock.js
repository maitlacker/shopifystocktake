'use strict';

let allRows    = [];   // raw rows from API, ascending date order
let chart      = null;
let currentDays = 90;

/* ── Boot ───────────────────────────────────────────────────────── */
(async function init() {
  await load(currentDays);
})();

/* ── Load & render ──────────────────────────────────────────────── */
async function load(days) {
  try {
    const r = await fetch(`/api/stock-value/history?days=${days}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    allRows = await r.json();
    render();
  } catch (err) {
    document.getElementById('sync-msg').textContent = 'Error loading data: ' + err.message;
    document.getElementById('sync-msg').className = 'ts-sync-msg err';
  }
}

function render() {
  if (!allRows.length) {
    updateCards(null);
    renderChart([]);
    renderTable([]);
    return;
  }

  const latest = allRows[allRows.length - 1];
  updateCards(latest);
  renderChart(allRows);
  renderTable([...allRows].reverse()); // newest first in table
}

/* ── Cards ──────────────────────────────────────────────────────── */
function updateCards(row) {
  if (!row) {
    ['card-rrp','card-cost','card-margin','card-variants'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });
    return;
  }
  const rrp     = parseFloat(row.total_rrp);
  const cost    = parseFloat(row.total_cost);
  const margin  = rrp - cost;
  const marginPct = rrp > 0 ? (margin / rrp * 100) : 0;

  document.getElementById('card-rrp').textContent      = fmtAud(rrp);
  document.getElementById('card-cost').textContent     = fmtAud(cost);
  document.getElementById('card-margin').textContent   = fmtAud(margin);
  document.getElementById('card-margin-sub').textContent = `${marginPct.toFixed(1)}% gross margin on stock`;
  document.getElementById('card-variants').textContent = Number(row.variant_count).toLocaleString();

  const dateStr = fmtDate(row.date);
  document.getElementById('card-rrp-date').textContent = `as at ${dateStr}`;
}

/* ── Chart ──────────────────────────────────────────────────────── */
function renderChart(rows) {
  const ctx = document.getElementById('stock-chart');
  if (chart) { chart.destroy(); chart = null; }

  if (!rows.length) return;

  const labels   = rows.map(r => fmtDate(r.date));
  const rrpData  = rows.map(r => parseFloat(r.total_rrp));
  const costData = rows.map(r => parseFloat(r.total_cost));

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label:           'Total at RRP',
          data:            rrpData,
          borderColor:     '#6366f1',
          backgroundColor: 'rgba(99,102,241,0.08)',
          borderWidth:     2.5,
          pointRadius:     rows.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
          fill:            false,
          tension:         0.3,
        },
        {
          label:           'Total at Cost',
          data:            costData,
          borderColor:     '#059669',
          backgroundColor: 'rgba(5,150,105,0.08)',
          borderWidth:     2.5,
          pointRadius:     rows.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
          fill:            false,
          tension:         0.3,
        },
        {
          // Invisible dataset for the filled margin area between cost and RRP
          label:           'Margin',
          data:            rrpData,
          borderColor:     'transparent',
          backgroundColor: 'rgba(224,231,255,0.45)',
          borderWidth:     0,
          pointRadius:     0,
          fill:            '+1',   // fill down to the next dataset (cost)
          tension:         0.3,
        },
      ],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label(ctx) {
              if (ctx.datasetIndex === 2) return null; // hide margin fill tooltip
              return ` ${ctx.dataset.label}: ${fmtAud(ctx.parsed.y)}`;
            },
            afterBody(items) {
              const rrp  = items.find(i => i.datasetIndex === 0)?.parsed.y;
              const cost = items.find(i => i.datasetIndex === 1)?.parsed.y;
              if (rrp != null && cost != null) {
                const margin  = rrp - cost;
                const pct     = rrp > 0 ? (margin / rrp * 100).toFixed(1) : '0.0';
                return [`  Margin: ${fmtAud(margin)} (${pct}%)`];
              }
              return [];
            },
          },
        },
      },
      scales: {
        x: {
          grid:  { color: '#f1f5f9' },
          ticks: {
            color:      '#94a3b8',
            font:       { size: 11 },
            maxTicksLimit: 10,
            maxRotation: 0,
          },
        },
        y: {
          grid:  { color: '#f1f5f9' },
          ticks: {
            color: '#94a3b8',
            font:  { size: 11 },
            callback(val) { return fmtAudShort(val); },
          },
        },
      },
    },
  });
}

/* ── Table ──────────────────────────────────────────────────────── */
function renderTable(rows) {
  const wrap = document.getElementById('table-wrap');
  if (!rows.length) {
    wrap.innerHTML = `
      <div class="ts-empty">
        <div class="ts-empty-icon">📦</div>
        <div class="ts-empty-title">No snapshots yet</div>
        <div class="ts-empty-sub">Click <strong>Sync Today</strong> to capture your first snapshot. After that, it runs automatically at 3 AM every day.</div>
      </div>`;
    return;
  }

  const rowsHtml = rows.map(r => {
    const rrp      = parseFloat(r.total_rrp);
    const cost     = parseFloat(r.total_cost);
    const margin   = rrp - cost;
    const marginPct = rrp > 0 ? (margin / rrp * 100) : 0;
    const chipCls  = marginPct >= 55 ? 'high' : marginPct >= 40 ? 'medium' : 'low';
    return `<tr>
      <td>${fmtDate(r.date)}</td>
      <td class="num val-rrp">${fmtAud(rrp)}</td>
      <td class="num val-cost">${fmtAud(cost)}</td>
      <td class="num">${fmtAud(margin)}</td>
      <td class="num"><span class="margin-chip ${chipCls}">${marginPct.toFixed(1)}%</span></td>
      <td class="num" style="color:#94a3b8">${Number(r.variant_count).toLocaleString()}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="ts-table">
      <thead>
        <tr>
          <th>Date</th>
          <th class="num">Total RRP</th>
          <th class="num">Total Cost</th>
          <th class="num">Margin $</th>
          <th class="num">Margin %</th>
          <th class="num">Variants</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

/* ── Range selector ─────────────────────────────────────────────── */
async function setRange(days, btn) {
  currentDays = days;
  document.querySelectorAll('.ts-range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  await load(days);
}

/* ── Manual sync ────────────────────────────────────────────────── */
async function triggerSync() {
  const btn = document.getElementById('sync-btn');
  const msg = document.getElementById('sync-msg');
  btn.disabled = true;
  msg.textContent = 'Syncing… this takes 1–3 minutes';
  msg.className = 'ts-sync-msg running';

  try {
    const r = await fetch('/api/stock-value/sync', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    msg.textContent = `✓ Synced ${fmtDate(data.date)} — RRP ${fmtAud(data.totalRrp)}, Cost ${fmtAud(data.totalCost)}`;
    msg.className = 'ts-sync-msg ok';
    await load(currentDays); // reload chart + table
  } catch (err) {
    msg.textContent = '✗ ' + err.message;
    msg.className = 'ts-sync-msg err';
  } finally {
    btn.disabled = false;
  }
}

/* ── Formatters ─────────────────────────────────────────────────── */
function fmtAud(n) {
  return 'AUD $' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtAudShort(n) {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'k';
  return '$' + n;
}

function fmtDate(dateStr) {
  // dateStr is YYYY-MM-DD
  const [y, m, d] = String(dateStr).slice(0, 10).split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}
