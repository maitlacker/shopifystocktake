// ── State ──────────────────────────────────────────────────────────
let apiData     = null;   // raw response from /api/forecast/data
let chartInst   = null;   // Chart.js instance
let growthRate  = 0.15;   // decimal e.g. 0.18
let marginPct   = 0.70;   // decimal e.g. 0.70
let autoGrowth  = 0.15;
let forecastYear = new Date().getFullYear();

// ── Formatting ─────────────────────────────────────────────────────
function fmtAUD(n) {
  if (n == null || isNaN(n)) return '—';
  return '$' + Math.round(n).toLocaleString('en-AU');
}
function fmtPctVal(n) {
  if (n == null || isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

// ── Forecast engine ────────────────────────────────────────────────
// Returns forecast revenue for a given year/month using weighted same-month prior years
function forecastRevenue(year, month) {
  if (!apiData) return null;
  const sm = apiData.shopifyMonthly;

  const p1 = sm.find(r => r.year === year - 1 && r.month === month);
  const p2 = sm.find(r => r.year === year - 2 && r.month === month);
  const p3 = sm.find(r => r.year === year - 3 && r.month === month);

  // Need at least one prior year
  if (!p1 && !p2 && !p3) return null;

  let num = 0, den = 0;
  if (p1) { const w = 0.6; num += parseFloat(p1.revenue) * Math.pow(1 + growthRate, 1) * w; den += w; }
  if (p2) { const w = 0.3; num += parseFloat(p2.revenue) * Math.pow(1 + growthRate, 2) * w; den += w; }
  if (p3) { const w = 0.1; num += parseFloat(p3.revenue) * Math.pow(1 + growthRate, 3) * w; den += w; }

  return Math.round(num / den);
}

// Returns the best revenue figure for a year/month — prefers Shopify actuals, falls back to forecast
function getRevenue(year, month) {
  const sm   = apiData.shopifyMonthly;
  const xero = apiData.xeroMonthly;

  const shopifyRow = sm.find(r => r.year === year && r.month === month);
  const xeroRow    = xero.find(r => r.year === year && r.month === month);

  // Shopify actual — consider month complete if we have ≥90% of days
  if (shopifyRow && parseInt(shopifyRow.days_with_data) >= parseInt(shopifyRow.days_in_month) * 0.9) {
    return { rev: parseFloat(shopifyRow.revenue), isActual: true, source: 'shopify' };
  }
  // Xero actual (P&L already closed)
  if (xeroRow && parseFloat(xeroRow.revenue) > 0) {
    return { rev: parseFloat(xeroRow.revenue), isActual: true, source: 'xero' };
  }
  // Partial shopify data for current month
  if (shopifyRow && parseInt(shopifyRow.days_with_data) > 0) {
    const partial = parseFloat(shopifyRow.revenue);
    const fc      = forecastRevenue(year, month);
    return { rev: fc ?? partial, isActual: false, source: 'forecast', partial };
  }

  return { rev: forecastRevenue(year, month), isActual: false, source: 'forecast' };
}

// ── Load ───────────────────────────────────────────────────────────
async function loadData() {
  document.getElementById('fc-loading').style.display  = 'block';
  document.getElementById('fc-content').style.display  = 'none';

  try {
    const res  = await fetch('/api/forecast/data');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load');

    apiData    = json;
    autoGrowth = json.autoGrowthRate;

    // Apply saved settings
    growthRate = json.settings.growth_rate_override != null
      ? parseFloat(json.settings.growth_rate_override) : autoGrowth;
    marginPct  = json.settings.margin_pct != null
      ? parseFloat(json.settings.margin_pct) / 100 : 0.70;

    document.getElementById('fc-growth').value = (growthRate * 100).toFixed(1);
    document.getElementById('fc-margin').value  = (marginPct  * 100).toFixed(0);

    // Year selector
    const curYear  = new Date().getFullYear();
    const yearSel  = document.getElementById('fc-year');
    yearSel.innerHTML = [curYear, curYear + 1].map(y =>
      `<option value="${y}"${y === forecastYear ? ' selected' : ''}>${y}</option>`
    ).join('');

    render();
  } catch (err) {
    document.getElementById('fc-loading').textContent = 'Error loading data: ' + err.message;
  }
}

// ── Master render ──────────────────────────────────────────────────
function render() {
  document.getElementById('fc-loading').style.display = 'none';
  document.getElementById('fc-content').style.display = 'block';
  renderNotice();
  renderCards();
  renderInsights();
  renderChart();
  renderTable();
}

// ── Data coverage notice ───────────────────────────────────────────
function renderNotice() {
  const years = [...new Set(apiData.shopifyMonthly.map(r => r.year))].sort();
  const notice = document.getElementById('fc-notice');
  const text   = document.getElementById('fc-notice-text');

  if (years.length < 2) {
    notice.style.display = 'flex';
    text.innerHTML = `Only ${years.length || 0} year(s) of Shopify history found — forecast accuracy improves with more data. Click <strong>Sync History</strong> to backfill up to 5 years.`;
  } else {
    notice.style.display = 'none';
  }
}

// ── Summary cards ──────────────────────────────────────────────────
function renderCards() {
  let totRev = 0, totGP = 0, count = 0;
  for (let m = 1; m <= 12; m++) {
    const { rev } = getRevenue(forecastYear, m);
    if (rev != null) { totRev += rev; count++; }
  }
  totGP = totRev * marginPct;

  // YoY comparison
  let prevRev = 0;
  for (let m = 1; m <= 12; m++) {
    const { rev } = getRevenue(forecastYear - 1, m);
    if (rev != null) prevRev += rev;
  }
  const yoyChg = prevRev > 0 ? (totRev - prevRev) / prevRev : null;

  // Best month
  let bestMonth = null, bestRev = 0;
  for (let m = 1; m <= 12; m++) {
    const { rev } = getRevenue(forecastYear, m);
    if (rev > bestRev) { bestRev = rev; bestMonth = m; }
  }
  const bestMonthName = bestMonth ? new Date(forecastYear, bestMonth - 1, 1)
    .toLocaleString('en-AU', { month: 'long' }) : '—';

  // Meta total
  let totMeta = 0;
  for (let m = 1; m <= 12; m++) {
    const metaActual = apiData.metaMonthly.find(r => r.year === forecastYear && r.month === m);
    const budget     = apiData.budgets.find(r => r.year === forecastYear && r.month === m);
    const meta = metaActual ? parseFloat(metaActual.spend) : (budget?.meta_planned ?? 0);
    totMeta += meta || 0;
  }

  const cards = document.getElementById('fc-cards');
  cards.innerHTML = `
    <div class="fc-card">
      <div class="fc-card-val">${fmtAUD(totRev)}</div>
      <div class="fc-card-lbl">Forecast Revenue ${forecastYear}</div>
      ${yoyChg != null ? `<div class="fc-card-sub">${yoyChg >= 0 ? '+' : ''}${(yoyChg*100).toFixed(1)}% vs ${forecastYear-1}</div>` : ''}
    </div>
    <div class="fc-card fc-pos">
      <div class="fc-card-val">${fmtAUD(totGP)}</div>
      <div class="fc-card-lbl">Est. Gross Profit</div>
      <div class="fc-card-sub">at ${(marginPct*100).toFixed(0)}% margin</div>
    </div>
    <div class="fc-card fc-growth">
      <div class="fc-card-val">${autoGrowth >= 0 ? '+' : ''}${(autoGrowth*100).toFixed(1)}%</div>
      <div class="fc-card-lbl">Historical Growth Rate</div>
      <div class="fc-card-sub">CAGR from available data</div>
    </div>
    <div class="fc-card">
      <div class="fc-card-val">${bestMonthName}</div>
      <div class="fc-card-lbl">Strongest Month</div>
      <div class="fc-card-sub">${fmtAUD(bestRev)} forecast</div>
    </div>
    ${totMeta > 0 ? `
    <div class="fc-card">
      <div class="fc-card-val">${fmtAUD(totMeta)}</div>
      <div class="fc-card-lbl">Meta Spend ${forecastYear}</div>
      <div class="fc-card-sub">actual + planned</div>
    </div>` : ''}
  `;
}

// ── Data-driven insights ───────────────────────────────────────────
function renderInsights() {
  const insights  = [];
  const sm        = apiData.shopifyMonthly;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Seasonal peak/trough (from historical data)
  const monthAvgs = {};
  for (let m = 1; m <= 12; m++) {
    const vals = sm.filter(r => r.month === m).map(r => parseFloat(r.revenue));
    if (vals.length) monthAvgs[m] = vals.reduce((s, v) => s + v, 0) / vals.length;
  }
  const monthAvgEntries = Object.entries(monthAvgs);
  if (monthAvgEntries.length >= 6) {
    const sorted = [...monthAvgEntries].sort((a, b) => b[1] - a[1]);
    const peak   = sorted[0];
    const trough = sorted[sorted.length - 1];
    const swing  = ((peak[1] - trough[1]) / trough[1] * 100).toFixed(0);
    insights.push({
      cls: 'good',
      title: `Peak: ${monthNames[peak[0]-1]}, Trough: ${monthNames[trough[0]-1]}`,
      body: `Your best month averages ${fmtAUD(peak[1])} — ${swing}% above your weakest (${monthNames[trough[0]-1]} at ${fmtAUD(trough[1])}). Plan inventory and ad spend accordingly.`,
    });
  }

  // YoY growth trend
  const years = Object.keys(apiData.yearTotals).map(Number).sort();
  if (years.length >= 3) {
    const recentGrowths = [];
    for (let i = 1; i < years.length; i++) {
      const g = (apiData.yearTotals[years[i]] - apiData.yearTotals[years[i-1]]) / apiData.yearTotals[years[i-1]];
      recentGrowths.push(g);
    }
    const recent2 = recentGrowths.slice(-2);
    const avgRecent = recent2.reduce((s, v) => s + v, 0) / recent2.length;
    const isAccelerating = recentGrowths.length >= 2 &&
      recentGrowths[recentGrowths.length-1] > recentGrowths[recentGrowths.length-2];
    insights.push({
      cls: avgRecent >= 0.1 ? 'good' : avgRecent >= 0 ? '' : 'warn',
      title: `Growth ${isAccelerating ? 'Accelerating ↑' : 'Decelerating ↓'}`,
      body: `Recent annual growth is averaging ${(avgRecent*100).toFixed(1)}%. The CAGR across all ${years.length} years is ${(autoGrowth*100).toFixed(1)}%. Applied growth rate: ${(growthRate*100).toFixed(1)}%.`,
    });
  }

  // Meta ROAS insight
  const metaData = apiData.metaMonthly.filter(r => r.roas > 0);
  if (metaData.length >= 3) {
    const avgRoas    = metaData.reduce((s, r) => s + parseFloat(r.roas), 0) / metaData.length;
    const recentMeta = metaData.slice(-3);
    const recentRoas = recentMeta.reduce((s, r) => s + parseFloat(r.roas), 0) / recentMeta.length;
    insights.push({
      cls: recentRoas >= 3 ? 'good' : recentRoas >= 2 ? '' : 'warn',
      title: `Meta ROAS: ${recentRoas.toFixed(2)}x (recent avg)`,
      body: `Meta Ads are returning ${recentRoas.toFixed(2)}x on recent spend, vs ${avgRoas.toFixed(2)}x all-time average. ${recentRoas >= avgRoas ? 'Efficiency is improving.' : 'Recent efficiency is below average — review targeting.'}`,
    });
  }

  // Margin reminder
  if (marginPct < 0.60) {
    insights.push({
      cls: 'warn',
      title: 'Margin below 60%',
      body: `Current margin is set to ${(marginPct*100).toFixed(0)}%. The TSS target is ~70% outside sale periods. Check if COGS are being captured correctly in Xero.`,
    });
  }

  const container = document.getElementById('fc-insights');
  container.innerHTML = insights.map(i => `
    <div class="fc-insight-card ${i.cls}">
      <div class="fc-insight-title">${i.title}</div>
      <div class="fc-insight-body">${i.body}</div>
    </div>
  `).join('');
}

// ── Chart ──────────────────────────────────────────────────────────
function renderChart() {
  const canvas = document.getElementById('fc-chart');
  if (chartInst) { chartInst.destroy(); chartInst = null; }

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sm      = apiData.shopifyMonthly;

  const allYears  = [...new Set(sm.map(r => r.year))].sort();
  const showYears = allYears.slice(-4); // last 4 historical years

  // Color ramp: older = more faded
  const historicalPalette = [
    'rgba(203,213,225,0.7)',  // gray-300   (oldest)
    'rgba(148,163,184,0.7)',  // slate-400
    'rgba(99,102,241,0.4)',   // indigo-500 faded
    'rgba(99,102,241,0.75)',  // indigo-500 medium  (most recent prior year)
  ];

  const datasets = showYears.map((year, i) => ({
    label: String(year),
    data: months.map((_, mi) => {
      const row = sm.find(r => r.year === year && r.month === mi + 1);
      return row ? parseFloat(row.revenue) : null;
    }),
    borderColor:     historicalPalette[Math.max(0, historicalPalette.length - (showYears.length - i))],
    backgroundColor: 'transparent',
    borderWidth:     i === showYears.length - 1 ? 2.5 : 1.5,
    pointRadius:     i === showYears.length - 1 ? 3 : 2,
    tension: 0.35,
    spanGaps: true,
  }));

  // Forecast year line (dashed)
  datasets.push({
    label: `${forecastYear} Forecast`,
    data: months.map((_, mi) => forecastRevenue(forecastYear, mi + 1)),
    borderColor:     'rgba(99,102,241,0.9)',
    backgroundColor: 'rgba(99,102,241,0.07)',
    borderDash:      [6, 3],
    borderWidth:     2,
    pointRadius:     3,
    tension: 0.35,
    spanGaps: true,
    fill: true,
  });

  // Actuals for forecast year (solid, if any data exists)
  const hasActuals = sm.some(r => r.year === forecastYear);
  if (hasActuals) {
    datasets.push({
      label: `${forecastYear} Actual`,
      data: months.map((_, mi) => {
        const row = sm.find(r => r.year === forecastYear && r.month === mi + 1);
        return row ? parseFloat(row.revenue) : null;
      }),
      borderColor:     '#4f46e5',
      backgroundColor: 'rgba(79,70,229,0.08)',
      borderWidth:     2.5,
      pointRadius:     4,
      tension: 0.35,
      spanGaps: false,
      fill: true,
    });
  }

  chartInst = new Chart(canvas, {
    type: 'line',
    data: { labels: months, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { boxWidth: 20, padding: 14, font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: ctx => ctx.parsed.y == null ? null
              : ` ${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString('en-AU')}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,0,0,.04)' },
          ticks: { font: { size: 11 } },
        },
        y: {
          grid: { color: 'rgba(0,0,0,.04)' },
          ticks: {
            font: { size: 11 },
            callback: v => '$' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v),
          },
        },
      },
    },
  });
}

// ── P&L Table ──────────────────────────────────────────────────────
function renderTable() {
  const now   = new Date();
  const tbody = document.getElementById('fc-tbody');
  const tfoot = document.getElementById('fc-tfoot');
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  document.getElementById('fc-pl-title').textContent = `Budget — ${forecastYear}`;

  let totRev = 0, totMeta = 0, totCogs = 0, totGP = 0, totOpex = 0, totEBITDA = 0;
  const rows = [];

  for (let m = 1; m <= 12; m++) {
    const isPast    = forecastYear < now.getFullYear() ||
                      (forecastYear === now.getFullYear() && m < now.getMonth() + 1);
    const isCurrent = forecastYear === now.getFullYear() && m === now.getMonth() + 1;
    const isFuture  = !isPast && !isCurrent;

    const { rev, isActual } = getRevenue(forecastYear, m);

    // Meta spend: actual from DB, else planned
    const metaRow  = apiData.metaMonthly.find(r => r.year === forecastYear && r.month === m);
    const budgetRow = apiData.budgets.find(r => r.year === forecastYear && r.month === m);
    const metaSpend = (isPast || isCurrent) && metaRow
      ? parseFloat(metaRow.spend)
      : (budgetRow?.meta_planned ?? null);

    // Opex: actual from Xero, else planned
    const xeroRow = apiData.xeroMonthly.find(r => r.year === forecastYear && r.month === m);
    const opex    = (isPast || isCurrent) && xeroRow && parseFloat(xeroRow.expenses) > 0
      ? parseFloat(xeroRow.expenses)
      : (budgetRow?.opex_planned ?? null);

    const cogs   = rev != null ? Math.round(rev * (1 - marginPct)) : null;
    const gp     = rev != null && cogs != null ? Math.round(rev - cogs) : null;
    const marketing = metaSpend ?? 0;
    const ebitda    = gp != null ? gp - marketing - (opex ?? 0) : null;
    const ebitdaPct = rev && ebitda != null ? ebitda / rev : null;

    if (rev    != null) totRev    += rev;
    if (cogs   != null) totCogs   += cogs;
    if (gp     != null) totGP     += gp;
    if (metaSpend != null) totMeta += metaSpend;
    if (opex   != null) totOpex   += opex;
    if (ebitda != null) totEBITDA += ebitda;

    const rowCls = isPast ? 'fc-row-past' : isCurrent ? 'fc-row-current' : 'fc-row-future';
    const revCls = !isActual ? ' fc-forecast-val' : '';
    const ebitdaCls = ebitdaPct == null ? '' : ebitdaPct < 0 ? ' fc-neg' : ebitdaPct < 0.1 ? ' fc-warn' : ' fc-pos';

    const metaEditAttr = isFuture ? ` data-edit="meta" data-year="${forecastYear}" data-month="${m}"` : '';
    const opexEditAttr = isFuture ? ` data-edit="opex" data-year="${forecastYear}" data-month="${m}"` : '';

    rows.push(`<tr class="${rowCls}">
      <td class="fc-col-month">
        ${MONTHS[m - 1]}
        ${isCurrent ? '<span class="fc-now-badge">NOW</span>' : ''}
        ${!isActual && (isFuture || isCurrent) ? '<span class="fc-fc-badge">FC</span>' : ''}
      </td>
      <td class="${revCls}">${fmtAUD(rev)}</td>
      <td class="fc-editable"${metaEditAttr}>${fmtAUD(metaSpend)}</td>
      <td style="color:#94a3b8">${fmtAUD(cogs)}</td>
      <td class="fc-gp">${fmtAUD(gp)}</td>
      <td class="fc-editable"${opexEditAttr}>${fmtAUD(opex)}</td>
      <td class="fc-ebitda${ebitdaCls}">${fmtAUD(ebitda)}</td>
      <td class="fc-ebitda-pct${ebitdaCls}">${fmtPctVal(ebitdaPct)}</td>
    </tr>`);
  }

  tbody.innerHTML = rows.join('');

  const totEbitdaPct = totRev > 0 ? totEBITDA / totRev : null;
  const totCls = totEbitdaPct == null ? '' : totEbitdaPct < 0 ? ' fc-neg' : totEbitdaPct < 0.1 ? ' fc-warn' : ' fc-pos';
  tfoot.innerHTML = `<tr class="fc-row-total">
    <td>TOTAL</td>
    <td>${fmtAUD(totRev)}</td>
    <td>${fmtAUD(totMeta || null)}</td>
    <td>${fmtAUD(totCogs)}</td>
    <td class="fc-gp">${fmtAUD(totGP)}</td>
    <td>${fmtAUD(totOpex || null)}</td>
    <td class="${totCls}">${fmtAUD(totEBITDA)}</td>
    <td class="${totCls}">${fmtPctVal(totEbitdaPct)}</td>
  </tr>`;
}

// ── Inline cell editing ────────────────────────────────────────────
document.addEventListener('click', e => {
  const cell = e.target.closest('[data-edit]');
  if (!cell || cell.querySelector('input')) return;

  const type  = cell.dataset.edit;
  const year  = parseInt(cell.dataset.year);
  const month = parseInt(cell.dataset.month);

  let budgetRow = apiData.budgets.find(r => r.year === year && r.month === month);
  const current = type === 'meta'
    ? (budgetRow?.meta_planned ?? '')
    : (budgetRow?.opex_planned ?? '');

  cell.innerHTML = `<input class="fc-cell-input" type="number" value="${current}" placeholder="0" min="0" step="100">`;
  const inp = cell.querySelector('input');
  inp.focus();
  inp.select();

  function commitEdit() {
    const val = inp.value === '' ? null : parseFloat(inp.value);
    if (!budgetRow) { budgetRow = { year, month }; apiData.budgets.push(budgetRow); }
    if (type === 'meta') budgetRow.meta_planned = val;
    else                 budgetRow.opex_planned = val;

    fetch('/api/forecast/monthly-budget', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month, [type === 'meta' ? 'meta_planned' : 'opex_planned']: val }),
    }).catch(() => {});

    renderTable();
    renderCards();
  }

  inp.addEventListener('blur',   commitEdit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  inp.blur();
    if (e.key === 'Escape') { inp.removeEventListener('blur', commitEdit); renderTable(); }
  });
});

// ── Control listeners ──────────────────────────────────────────────
document.getElementById('fc-growth').addEventListener('input', e => {
  growthRate = parseFloat(e.target.value) / 100 || 0;
  renderChart();
  renderTable();
  renderCards();
});

document.getElementById('fc-margin').addEventListener('input', e => {
  marginPct = parseFloat(e.target.value) / 100 || 0;
  renderTable();
  renderCards();
  renderInsights();
});

document.getElementById('fc-year').addEventListener('change', e => {
  forecastYear = parseInt(e.target.value);
  renderChart();
  renderTable();
  renderCards();
  document.getElementById('fc-pl-title').textContent = `Budget — ${forecastYear}`;
});

document.getElementById('fc-growth-auto').addEventListener('click', () => {
  growthRate = autoGrowth;
  document.getElementById('fc-growth').value = (growthRate * 100).toFixed(1);
  renderChart();
  renderTable();
  renderCards();
});

document.getElementById('fc-save-settings').addEventListener('click', async () => {
  const btn = document.getElementById('fc-save-settings');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    await fetch('/api/forecast/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        growth_rate_override: growthRate !== autoGrowth ? growthRate : null,
        margin_pct: marginPct * 100,
      }),
    });
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = 'Save Settings'; btn.disabled = false; }, 2000);
  } catch {
    btn.textContent = 'Error — try again';
    btn.disabled = false;
  }
});

document.getElementById('fc-backfill-btn').addEventListener('click', async () => {
  const btn = document.getElementById('fc-backfill-btn');
  btn.textContent = 'Syncing…';
  btn.disabled = true;
  try {
    const res  = await fetch('/api/forecast/backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ years: 5 }),
    });
    const json = await res.json();
    alert(json.message || 'Sync started. Refresh in a few minutes.');
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.textContent = '↻ Sync History';
    btn.disabled = false;
  }
});

// ── Init ───────────────────────────────────────────────────────────
loadData();
