'use strict';

// ── Constants ─────────────────────────────────────────────────────────
const SALE_CONFIG = {
  6:  { name: 'EOFY',         badge: 'eofy', rowClass: 'fc-row-eofy' },
  11: { name: 'Black Friday', badge: 'bf',   rowClass: 'fc-row-bf'   },
};

// Stock build ordering window — orders placed Jul–Sep arrive by November (6-week lead)
const BUILD_MONTHS = [7, 8, 9];

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL  = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

const YEAR_COLORS = [
  'rgba(148,163,184,.40)',
  'rgba(148,163,184,.60)',
  'rgba(100,116,139,.75)',
  'rgba(30,41,59,.90)',
  'rgba(99,102,241,1)',
];

// ── State ─────────────────────────────────────────────────────────────
let apiData       = null;
let shopifyMap    = {};   // "YYYY-M" → { revenue, days_with_data, days_in_month }
let metaMap       = {};   // "YYYY-M" → { spend, roas }
let xeroMap       = {};   // "YYYY-M" → { revenue, expenses, cogs, gross_profit }
let chartInst     = null;
let growthRate    = 15;        // % (display/input unit)
let marginPct     = 70;        // % normal
let marginEofy    = 45;        // % EOFY sale
let marginBf      = 38;        // % Black Friday
let profitTarget  = 50000;     // $ per month
let stockTarget   = 3000000;   // $ RRP by November
let autoGrowthPct = 15;        // % from server CAGR
let forecastYear  = new Date().getFullYear();
let savedBudgets  = {};   // "YYYY-M" → { meta_planned, opex_planned, purchasing_planned }

// ── Formatting ───────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
}
function fmtK(n) {
  if (n == null || isNaN(n)) return '—';
  return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n / 1000)) + 'K';
}
function pct(n, decimals) {
  if (n == null || isNaN(n)) return '—';
  const d = decimals != null ? decimals : 1;
  return (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
}

// ── Margin ────────────────────────────────────────────────────────────
function getMonthMarginPct(month) {
  if (month === 6)  return marginEofy;
  if (month === 11) return marginBf;
  return marginPct;
}

// ── Per-month smart growth rate ──────────────────────────────────────
// Weighted average of same-month YoY % changes: newest 60%, prev 30%, oldest 10%
function getMonthSmartGrowthPct(month) {
  if (!apiData) return growthRate;
  const years = Object.keys(apiData.yearTotals || {}).map(Number).sort((a, b) => b - a);
  if (years.length < 2) return growthRate;

  const weights = [0.6, 0.3, 0.1];
  let weighted = 0, totalW = 0, slot = 0;

  for (let i = 0; i < years.length - 1; i++) {
    const yNew = years[i];
    const yOld = years[i + 1];
    if (yNew >= forecastYear) continue;   // skip the forecast year itself
    const rNew = (shopifyMap[`${yNew}-${month}`]?.revenue || 0);
    const rOld = (shopifyMap[`${yOld}-${month}`]?.revenue || 0);
    if (rOld > 0 && rNew > 0) {
      const w   = weights[slot] ?? 0.05;
      weighted += ((rNew - rOld) / rOld) * w;
      totalW   += w;
      slot++;
    }
    if (slot >= 3) break;
  }

  return totalW > 0 ? (weighted / totalW) * 100 : growthRate;
}

// ── Expense growth rate from Xero ────────────────────────────────────
function getExpenseGrowthPct() {
  if (!apiData) return null;
  const entries = Object.entries(xeroMap)
    .filter(([, v]) => v.expenses > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length < 13) return null;

  const n          = entries.length;
  const firstYrOp  = entries.slice(0, 12).reduce((s, [, v]) => s + v.expenses, 0);
  const lastYrOp   = entries.slice(n - 12).reduce((s, [, v]) => s + v.expenses, 0);
  return firstYrOp > 0 ? ((lastYrOp - firstYrOp) / firstYrOp) * 100 : null;
}

// ── Revenue forecast ─────────────────────────────────────────────────
function forecastRevenue(year, month) {
  const weights = [0.6, 0.3, 0.1];
  let total = 0, totalW = 0;

  for (let i = 1; i <= 3; i++) {
    const rev = shopifyMap[`${year - i}-${month}`]?.revenue || 0;
    if (rev > 0) {
      total  += rev * weights[i - 1];
      totalW += weights[i - 1];
    }
  }

  if (totalW === 0) return 0;
  const smartGrowthRate = getMonthSmartGrowthPct(month) / 100;
  return Math.round((total / totalW) * (1 + smartGrowthRate));
}

// ── Revenue resolver ─────────────────────────────────────────────────
// Returns { value, type: 'actual'|'xero'|'forecast' }
function getRevenue(year, month) {
  const sm = shopifyMap[`${year}-${month}`];
  if (sm && sm.days_with_data / sm.days_in_month >= 0.9)
    return { value: parseFloat(sm.revenue), type: 'actual' };

  const xr = xeroMap[`${year}-${month}`];
  if (xr && xr.revenue > 0)
    return { value: xr.revenue, type: 'xero' };

  return { value: forecastRevenue(year, month), type: 'forecast' };
}

// ── Opex resolver ────────────────────────────────────────────────────
function getOpex(year, month) {
  const bk = savedBudgets[`${year}-${month}`];
  if (bk?.opex_planned != null) return { value: bk.opex_planned, type: 'planned' };

  const xr = xeroMap[`${year}-${month}`];
  if (xr && xr.expenses > 0) return { value: xr.expenses, type: 'actual' };

  // Trend from same month prior year
  const pyXr = xeroMap[`${year - 1}-${month}`];
  if (pyXr && pyXr.expenses > 0) {
    const expGrowth = getExpenseGrowthPct();
    return { value: pyXr.expenses * (1 + (expGrowth || 8) / 100), type: 'forecast' };
  }

  return { value: null, type: 'unknown' };
}

// ── Meta spend resolver ──────────────────────────────────────────────
function getMeta(year, month) {
  const bk = savedBudgets[`${year}-${month}`];
  if (bk?.meta_planned != null) return { value: bk.meta_planned, type: 'planned' };

  const mm = metaMap[`${year}-${month}`];
  if (mm && mm.spend > 0) return { value: mm.spend, type: 'actual' };

  // Trend: prior year same month × ~70% of growth rate
  const pyMm = metaMap[`${year - 1}-${month}`];
  if (pyMm && pyMm.spend > 0)
    return { value: pyMm.spend * (1 + (growthRate / 100) * 0.7), type: 'forecast' };

  return { value: null, type: 'unknown' };
}

// ── Purchasing calculator ─────────────────────────────────────────────
// Returns replenishment COGS + stock build allocation for ordering window months
function calcPurchasing(year, month) {
  const bk = savedBudgets[`${year}-${month}`];
  if (bk?.purchasing_planned != null) return { value: bk.purchasing_planned, type: 'override' };

  const rev    = getRevenue(year, month).value;
  const mgPct  = getMonthMarginPct(month);
  const cogs   = rev * (1 - mgPct / 100);  // replenishment covers COGS

  const now = new Date();
  const isUpcoming = year > now.getFullYear() ||
    (year === now.getFullYear() && month >= now.getMonth() + 1);

  if (!BUILD_MONTHS.includes(month) || !isUpcoming)
    return { value: cogs, type: 'replenishment' };

  const currentRRP = apiData?.stockLatest?.total_rrp || 0;
  if (currentRRP >= stockTarget) return { value: cogs, type: 'replenishment' };

  const costRatio = (apiData?.stockLatest?.total_cost && apiData?.stockLatest?.total_rrp)
    ? apiData.stockLatest.total_cost / apiData.stockLatest.total_rrp : 0.30;
  const rrpGap   = stockTarget - currentRRP;

  // Spread build evenly across remaining ordering months
  const remaining = BUILD_MONTHS.filter(m =>
    year > now.getFullYear() || (year === now.getFullYear() && m >= now.getMonth() + 1));
  const perMonth  = remaining.length > 0 ? (rrpGap * costRatio) / remaining.length : 0;

  return { value: cogs + perMonth, type: 'build' };
}

// ── Data load ─────────────────────────────────────────────────────────
async function loadData() {
  document.getElementById('fc-loading').style.display = '';
  document.getElementById('fc-content').style.display = 'none';

  try {
    const res = await fetch('/api/forecast/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    apiData = await res.json();

    // Build fast lookup maps from arrays
    shopifyMap = {};
    (apiData.shopifyMonthly || []).forEach(r => {
      shopifyMap[`${r.year}-${r.month}`] = r;
    });
    metaMap = {};
    (apiData.metaMonthly || []).forEach(r => {
      metaMap[`${r.year}-${r.month}`] = r;
    });
    xeroMap = {};
    (apiData.xeroMonthly || []).forEach(r => {
      xeroMap[`${r.year}-${r.month}`] = r;
    });

    // Index saved budgets
    savedBudgets = {};
    (apiData.budgets || []).forEach(b => {
      savedBudgets[`${b.year}-${b.month}`] = {
        meta_planned:       b.meta_planned       != null ? +b.meta_planned       : null,
        opex_planned:       b.opex_planned       != null ? +b.opex_planned       : null,
        purchasing_planned: b.purchasing_planned != null ? +b.purchasing_planned : null,
      };
    });

    // Apply saved settings
    const s = apiData.settings || {};
    autoGrowthPct = (apiData.autoGrowthRate || 0.15) * 100;

    if (s.growth_rate   != null) { growthRate   = +s.growth_rate;   }
    else                         { growthRate   = +autoGrowthPct.toFixed(1); }
    if (s.margin_pct    != null) { marginPct    = +s.margin_pct;    }
    if (s.margin_eofy   != null) { marginEofy   = +s.margin_eofy;   }
    if (s.margin_bf     != null) { marginBf     = +s.margin_bf;     }
    if (s.profit_target != null) { profitTarget = +s.profit_target; }
    if (s.stock_target  != null) { stockTarget  = +s.stock_target;  }
    if (s.forecast_year != null) { forecastYear = +s.forecast_year; }

    // Apply to UI controls
    document.getElementById('fc-growth').value        = growthRate;
    document.getElementById('fc-margin').value         = marginPct;
    document.getElementById('fc-margin-eofy').value    = marginEofy;
    document.getElementById('fc-margin-bf').value      = marginBf;
    document.getElementById('fc-profit-target').value  = profitTarget;
    document.getElementById('fc-stock-target').value   = stockTarget;

    // Populate year selector
    const thisYear = new Date().getFullYear();
    const sel = document.getElementById('fc-year');
    sel.innerHTML = '';
    for (let y = thisYear; y <= thisYear + 3; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === forecastYear) opt.selected = true;
      sel.appendChild(opt);
    }

    document.getElementById('fc-loading').style.display = 'none';
    document.getElementById('fc-content').style.display = '';
    render();
  } catch (err) {
    document.getElementById('fc-loading').innerHTML =
      `<div style="color:#dc2626;padding:40px;text-align:center">Error loading data: ${err.message}</div>`;
  }
}

// ── Render ───────────────────────────────────────────────────────────
function render() {
  renderNotice();
  renderCards();
  renderInsights();
  renderChart();
  renderTable();
  document.getElementById('fc-pl-title').textContent = `Budget — ${forecastYear}`;
}

// ── Coverage notice ──────────────────────────────────────────────────
function renderNotice() {
  const el   = document.getElementById('fc-notice');
  const rows = apiData?.shopifyMonthly || [];
  if (!rows.length) { el.style.display = 'none'; return; }
  const earliest = rows[0];
  document.getElementById('fc-notice-text').innerHTML =
    `Shopify data from ${MONTH_NAMES[earliest.month - 1]} ${earliest.year}. ` +
    `Forecast values shown in <em style="color:#818cf8">purple italic</em>.`;
  el.style.display = '';
}

// ── Summary cards ─────────────────────────────────────────────────────
function renderCards() {
  const now  = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  // Full-year projected revenue
  let fullYear = 0;
  for (let m = 1; m <= 12; m++) fullYear += getRevenue(forecastYear, m).value;

  // Focus month
  const focusM   = forecastYear === curY ? curM : 1;
  const cmRev    = getRevenue(forecastYear, focusM);
  const smGrowth = getMonthSmartGrowthPct(focusM);
  const expGrowth = getExpenseGrowthPct();

  // YoY vs prior year
  const priorTotal = apiData?.yearTotals?.[forecastYear - 1] || 0;
  const annualYoY  = priorTotal > 0 ? ((fullYear - priorTotal) / priorTotal) * 100 : null;

  // Stock progress
  const currentRRP = apiData?.stockLatest?.total_rrp || 0;
  const stockPct   = stockTarget > 0 ? Math.min(100, (currentRRP / stockTarget) * 100) : 0;
  const stockGap   = stockTarget - currentRRP;
  const stockColor = stockPct >= 90 ? '#16a34a' : stockPct >= 60 ? '#d97706' : '#dc2626';

  const cards = [
    {
      val: fmt(fullYear), lbl: `${forecastYear} Revenue`,
      sub: annualYoY != null ? pct(annualYoY) + ` vs ${forecastYear - 1}` : 'projected',
      cls: annualYoY != null ? (annualYoY >= 10 ? 'fc-pos' : 'fc-warn') : '',
    },
    {
      val: fmt(cmRev.value), lbl: `${MONTH_NAMES[focusM - 1]} Revenue`,
      sub: cmRev.type === 'actual' ? 'Actual' : 'Forecast',
      cls: '',
    },
    {
      val: pct(smGrowth), lbl: 'Smart Growth Rate',
      sub: 'Weighted same-month YoY', cls: 'fc-growth',
    },
    expGrowth != null ? {
      val: pct(expGrowth), lbl: 'Opex Growth YoY',
      sub: 'From Xero data',
      cls: expGrowth > 10 ? 'fc-warn' : '',
    } : null,
    {
      val: `$${(currentRRP / 1e6).toFixed(2)}M`,
      lbl: 'Current Stock RRP',
      sub: `Target $${(stockTarget / 1e6).toFixed(1)}M by Nov`,
      cls: stockPct >= 90 ? 'fc-pos' : stockPct >= 60 ? 'fc-warn' : 'fc-neg',
      progress: { pct: stockPct, gap: stockGap, color: stockColor },
    },
  ].filter(Boolean);

  document.getElementById('fc-cards').innerHTML = cards.map(c => `
    <div class="fc-card ${c.cls || ''}">
      <div class="fc-card-val">${c.val}</div>
      <div class="fc-card-lbl">${c.lbl}</div>
      ${c.sub ? `<div class="fc-card-sub">${c.sub}</div>` : ''}
      ${c.progress ? `
        <div class="fc-progress-wrap">
          <div class="fc-progress-track">
            <div class="fc-progress-fill" style="width:${c.progress.pct.toFixed(1)}%;background:${c.progress.color}"></div>
          </div>
          <div class="fc-progress-label">
            <span>${c.progress.pct.toFixed(0)}%</span>
            <span>${c.progress.gap > 0 ? fmt(c.progress.gap) + ' to go' : '✓ on track'}</span>
          </div>
        </div>` : ''}
    </div>`).join('');
}

// ── Insights ──────────────────────────────────────────────────────────
function renderInsights() {
  const now       = new Date();
  const curM      = now.getMonth() + 1;
  const expGrowth = getExpenseGrowthPct();
  const insights  = [];
  const focusM    = forecastYear === now.getFullYear() ? curM : 1;

  // 1. Smart growth recommendation
  const smGrowth = getMonthSmartGrowthPct(focusM);
  const minGrowth = expGrowth ?? 5;
  insights.push({
    type: smGrowth >= minGrowth ? 'good' : 'warn',
    title: `Smart Growth: ${MONTH_NAMES[focusM - 1]} target ${pct(smGrowth)}`,
    body: `Weighted same-month performance over ${Math.min(3, Object.keys(apiData?.yearTotals || {}).length)} prior years. ` +
      (expGrowth != null
        ? `Opex is trending at <strong>${pct(expGrowth)}</strong> YoY — revenue must outpace this to hold margins. `
        : '') +
      (smGrowth >= minGrowth
        ? `${pct(smGrowth)} target exceeds expense growth — margins should hold.`
        : `⚠ Expense growth (${pct(minGrowth)}) may outpace revenue trend.`),
  });

  // 2. Profit gap for current + next month
  for (let offset = 0; offset <= 1; offset++) {
    const m  = focusM + offset;
    if (m > 12) break;
    const rev    = getRevenue(forecastYear, m).value;
    if (rev <= 0) continue;
    const mgPct  = getMonthMarginPct(m);
    const gp     = rev * (mgPct / 100);
    const opex   = getOpex(forecastYear, m).value  || 0;
    const meta   = getMeta(forecastYear, m).value   || 0;
    const ebitda = gp - opex - meta;
    const gap    = ebitda - profitTarget;
    const sale   = SALE_CONFIG[m];
    if (gap < 0) {
      insights.push({
        type: 'alert',
        title: `${MONTH_FULL[m - 1]}: ${fmtK(Math.abs(gap))} short of $${(profitTarget / 1000).toFixed(0)}K target`,
        body: `Projected EBITDA <strong>${fmt(ebitda)}</strong>` +
          (sale ? ` (${sale.name} — ${mgPct}% margin)` : '') +
          `. Review opex or ad spend to close the gap.`,
      });
    }
  }

  // 3. Stock build urgency
  const currentRRP = apiData?.stockLatest?.total_rrp || 0;
  const stockGap   = stockTarget - currentRRP;
  if (stockGap > 0) {
    const remaining = BUILD_MONTHS.filter(m =>
      forecastYear > now.getFullYear() ||
      (forecastYear === now.getFullYear() && m >= now.getMonth() + 1));
    const costRatio = (apiData?.stockLatest?.total_cost && apiData?.stockLatest?.total_rrp)
      ? apiData.stockLatest.total_cost / apiData.stockLatest.total_rrp : 0.30;
    const buildCost = stockGap * costRatio;
    const n = remaining.length;

    if (n > 0) {
      insights.push({
        type: n <= 1 ? 'alert' : n <= 2 ? 'warn' : 'good',
        title: `Stock Build: ${n} ordering month${n !== 1 ? 's' : ''} before Black Friday`,
        body: `Stock at <strong>${fmt(currentRRP)}</strong> RRP vs <strong>${fmt(stockTarget)}</strong> target — ` +
          `gap <strong>${fmt(stockGap)}</strong> RRP (~<strong>${fmt(buildCost)}</strong> at cost). ` +
          `Spread over ${remaining.map(m => MONTH_NAMES[m - 1]).join(', ')}: ` +
          `<strong>~${fmt(buildCost / n)}/month</strong> additional purchasing.`,
      });
    } else {
      insights.push({
        type: 'warn',
        title: 'Stock Build: Ordering window for Black Friday has closed',
        body: `Current stock <strong>${fmt(currentRRP)}</strong> vs <strong>${fmt(stockTarget)}</strong> target. ` +
          `Next build window opens July next year.`,
      });
    }
  }

  // 4. Upcoming sale preview
  const upcomingSale = [6, 11].find(m =>
    forecastYear > now.getFullYear() ||
    (forecastYear === now.getFullYear() && m >= now.getMonth() + 1));
  if (upcomingSale) {
    const sale   = SALE_CONFIG[upcomingSale];
    const rev    = getRevenue(forecastYear, upcomingSale).value;
    const mgPct  = getMonthMarginPct(upcomingSale);
    const gp     = rev * (mgPct / 100);
    const opex   = getOpex(forecastYear, upcomingSale).value  || 0;
    const meta   = getMeta(forecastYear, upcomingSale).value   || 0;
    const ebitda = gp - opex - meta;
    insights.push({
      type: ebitda >= profitTarget ? 'good' : 'warn',
      title: `${sale.name} (${MONTH_FULL[upcomingSale - 1]}): ${mgPct}% margin`,
      body: `Forecast revenue <strong>${fmt(rev)}</strong> → gross profit <strong>${fmt(gp)}</strong>. ` +
        `After opex & Meta: <strong>${fmt(ebitda)}</strong> EBITDA ` +
        `(${ebitda >= profitTarget ? '✓ above' : '⚠ below'} $${(profitTarget / 1000).toFixed(0)}K target).`,
    });
  }

  document.getElementById('fc-insights').innerHTML = insights.map(i => `
    <div class="fc-insight-card ${i.type || ''}">
      <div class="fc-insight-title">${i.title}</div>
      <div class="fc-insight-body">${i.body}</div>
    </div>`).join('');
}

// ── Seasonal chart ───────────────────────────────────────────────────
function renderChart() {
  const canvas = document.getElementById('fc-chart');
  if (!canvas || !apiData) return;
  if (chartInst) { chartInst.destroy(); chartInst = null; }

  // Show up to 4 prior years + forecast year
  const years = [];
  for (let y = forecastYear - 4; y <= forecastYear; y++) years.push(y);

  const datasets = years.map((y, idx) => {
    const isFcYear = y === forecastYear;
    const color    = YEAR_COLORS[Math.min(idx, YEAR_COLORS.length - 1)];

    const data = Array.from({ length: 12 }, (_, mi) => {
      const m  = mi + 1;
      const sm = shopifyMap[`${y}-${m}`];
      if (!isFcYear) return sm ? parseFloat(sm.revenue) : null;
      if (sm && sm.days_with_data / sm.days_in_month >= 0.9) return parseFloat(sm.revenue);
      return forecastRevenue(y, m) || null;
    });

    return {
      label:           String(y),
      data,
      borderColor:     color,
      backgroundColor: isFcYear ? 'rgba(99,102,241,.07)' : 'transparent',
      borderWidth:     isFcYear ? 2.5 : (y === forecastYear - 1 ? 2 : 1.5),
      borderDash:      isFcYear ? [6, 3] : [],
      pointRadius:     isFcYear ? 3.5 : 2,
      pointBackgroundColor: color,
      fill:            isFcYear,
      tension:         0.35,
      spanGaps:        true,
      order:           years.length - idx,
    };
  });

  chartInst = new Chart(canvas, {
    type: 'line',
    data: { labels: MONTH_NAMES, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: { label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw) },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: {
          grid: { color: '#f1f5f9' },
          ticks: {
            font: { size: 11 },
            callback: v => v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + (v / 1e3).toFixed(0) + 'K',
          },
        },
      },
    },
  });
}

// ── P&L table ─────────────────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById('fc-tbody');
  const tfoot = document.getElementById('fc-tfoot');
  if (!tbody || !tfoot) return;

  const now  = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const totals = { rev: 0, meta: 0, cogs: 0, gp: 0, opex: 0, ebitda: 0, purchasing: 0, net: 0 };
  const rows   = [];

  for (let m = 1; m <= 12; m++) {
    const { value: rev, type: revType } = getRevenue(forecastYear, m);
    const mgPct   = getMonthMarginPct(m);
    const cogs    = rev * (1 - mgPct / 100);
    const gp      = rev * (mgPct / 100);
    const metaVal = getMeta(forecastYear, m).value  || 0;
    const opexVal = getOpex(forecastYear, m).value  || 0;
    const ebitda  = gp - opexVal - metaVal;
    const { value: purchasing } = calcPurchasing(forecastYear, m);
    const net     = ebitda - purchasing;

    const isPast    = forecastYear < curY || (forecastYear === curY && m < curM);
    const isCurrent = forecastYear === curY && m === curM;
    const sale      = SALE_CONFIG[m];
    const isBuy     = BUILD_MONTHS.includes(m) &&
      (forecastYear > curY || (forecastYear === curY && m >= curM));

    const rowCls = sale ? sale.rowClass
      : isPast    ? 'fc-row-past'
      : isCurrent ? 'fc-row-current'
      : 'fc-row-future';

    // Month cell badges
    const nowBadge  = isCurrent ? `<span class="fc-now-badge">NOW</span>` : '';
    const fcBadge   = !isCurrent && revType === 'forecast' ? `<span class="fc-fc-badge">FC</span>` : '';
    const saleBadge = sale ? `<span class="fc-sale-badge ${sale.badge}">${sale.badge === 'bf' ? 'BF' : 'EOFY'}</span>` : '';

    // EBITDA colouring + vs-target annotation
    let ebitdaCls = '';
    let vsTarget  = '';
    if (rev > 0) {
      const gap   = ebitda - profitTarget;
      ebitdaCls   = ebitda < 0 ? 'fc-neg' : gap < 0 ? 'fc-warn' : 'fc-pos';
      const sign  = gap >= 0 ? '+' : '−';
      const vsCls = gap >= 0 ? 'pos' : gap > -profitTarget * 0.5 ? 'warn' : 'neg';
      vsTarget    = `<span class="fc-vs-target ${vsCls}">${sign}${fmtK(Math.abs(gap))} vs target</span>`;
    }

    // BUY badge goes into Net Cash cell
    const buyBadge = isBuy ? `<span class="fc-buy-badge">BUY</span>` : '';

    // Editable cell helper
    const editTd = (field, value, extraCls) => {
      const disp = value != null ? fmt(value) : '—';
      if (isPast) return `<td${extraCls ? ` class="${extraCls}"` : ''}>${disp}</td>`;
      return `<td class="${(extraCls ? extraCls + ' ' : '') + 'fc-editable'}" data-field="${field}" data-year="${forecastYear}" data-month="${m}">${disp}</td>`;
    };

    totals.rev        += rev;
    totals.meta       += metaVal;
    totals.cogs       += cogs;
    totals.gp         += gp;
    totals.opex       += opexVal;
    totals.ebitda     += ebitda;
    totals.purchasing += purchasing;
    totals.net        += net;

    rows.push(`<tr class="${rowCls}">
      <td class="fc-col-month">${MONTH_FULL[m - 1]}${nowBadge}${fcBadge}${saleBadge}</td>
      <td class="${revType === 'forecast' ? 'fc-forecast-val' : ''}">${fmt(rev)}</td>
      ${editTd('meta_planned', metaVal || null)}
      <td>${fmt(cogs)}</td>
      <td class="fc-gp">${fmt(gp)}</td>
      ${editTd('opex_planned', opexVal || null)}
      <td class="${ebitdaCls}">${fmt(ebitda)}${vsTarget}</td>
      <td class="${ebitdaCls}">${rev > 0 ? ((ebitda / rev) * 100).toFixed(1) + '%' : '—'}</td>
      ${editTd('purchasing_planned', purchasing, 'fc-col-divider fc-purchasing')}
      <td class="${net < 0 ? 'fc-neg' : net < profitTarget * 0.3 ? 'fc-warn' : ''}">${fmt(net)}${buyBadge}</td>
    </tr>`);
  }

  tbody.innerHTML = rows.join('');

  const totEbitdaCls = totals.ebitda < 0 ? 'fc-neg' : totals.ebitda >= profitTarget * 12 ? 'fc-pos' : 'fc-warn';
  const totNetCls    = totals.net < 0 ? 'fc-neg' : 'fc-pos';
  tfoot.innerHTML = `<tr class="fc-row-total">
    <td>TOTAL</td>
    <td>${fmt(totals.rev)}</td>
    <td>${fmt(totals.meta || null)}</td>
    <td>${fmt(totals.cogs)}</td>
    <td class="fc-gp">${fmt(totals.gp)}</td>
    <td>${fmt(totals.opex || null)}</td>
    <td class="${totEbitdaCls}">${fmt(totals.ebitda)}</td>
    <td class="${totEbitdaCls}">${totals.rev > 0 ? ((totals.ebitda / totals.rev) * 100).toFixed(1) + '%' : '—'}</td>
    <td class="fc-col-divider fc-purchasing">${fmt(totals.purchasing)}</td>
    <td class="${totNetCls}">${fmt(totals.net)}</td>
  </tr>`;

  attachEditHandlers();
}

// ── Inline cell editing ──────────────────────────────────────────────
function attachEditHandlers() {
  document.querySelectorAll('.fc-editable').forEach(cell => {
    cell.addEventListener('click', function () {
      if (this.querySelector('input')) return;
      const { field, year, month } = this.dataset;
      const bk      = `${year}-${month}`;
      const current = savedBudgets[bk]?.[field] ?? null;

      const input     = document.createElement('input');
      input.type      = 'number';
      input.className = 'fc-cell-input';
      input.value     = current != null ? Math.round(current) : '';
      input.placeholder = 'Amount';
      this.innerHTML  = '';
      this.appendChild(input);
      input.focus();
      input.select();

      const save = async () => {
        const val = input.value !== '' ? +input.value : null;
        if (!savedBudgets[bk]) savedBudgets[bk] = {};
        savedBudgets[bk][field] = val;

        try {
          await fetch('/api/forecast/monthly-budget', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
              year:  +year, month: +month,
              meta_planned:       field === 'meta_planned'       ? val : (savedBudgets[bk]?.meta_planned       ?? null),
              opex_planned:       field === 'opex_planned'       ? val : (savedBudgets[bk]?.opex_planned       ?? null),
              purchasing_planned: field === 'purchasing_planned' ? val : (savedBudgets[bk]?.purchasing_planned ?? null),
            }),
          });
        } catch (e) { console.warn('Budget save failed:', e.message); }

        renderTable();
        renderCards();
        renderInsights();
      };

      input.addEventListener('blur',    save);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { renderTable(); }
      });
    });
  });
}

// ── Control event wiring ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);

  on('fc-growth',        'input',  e => { growthRate   = +e.target.value; render(); });
  on('fc-margin',        'input',  e => { marginPct    = +e.target.value; render(); });
  on('fc-margin-eofy',   'input',  e => { marginEofy   = +e.target.value; render(); });
  on('fc-margin-bf',     'input',  e => { marginBf     = +e.target.value; render(); });
  on('fc-profit-target', 'input',  e => { profitTarget = +e.target.value; render(); });
  on('fc-stock-target',  'input',  e => { stockTarget  = +e.target.value; render(); });
  on('fc-year',          'change', e => { forecastYear = +e.target.value; render(); });

  on('fc-growth-auto', 'click', () => {
    growthRate = +autoGrowthPct.toFixed(1);
    document.getElementById('fc-growth').value = growthRate;
    render();
  });

  on('fc-save-settings', 'click', async () => {
    const btn = document.getElementById('fc-save-settings');
    btn.textContent = 'Saving…'; btn.disabled = true;
    try {
      await fetch('/api/forecast/settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          growth_rate:   growthRate,   margin_pct:   marginPct,
          margin_eofy:   marginEofy,   margin_bf:    marginBf,
          profit_target: profitTarget, stock_target: stockTarget,
          forecast_year: forecastYear,
        }),
      });
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save Settings'; btn.disabled = false; }, 1800);
    } catch {
      btn.textContent = 'Error'; btn.disabled = false;
    }
  });

  on('fc-backfill-btn', 'click', async () => {
    const btn = document.getElementById('fc-backfill-btn');
    btn.textContent = 'Syncing…'; btn.disabled = true;
    try {
      const res = await fetch('/api/forecast/backfill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body:   JSON.stringify({ years: 5 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      btn.textContent = '✓ Sync started';
      setTimeout(() => { btn.textContent = '↻ Sync History'; btn.disabled = false; }, 6000);
    } catch (e) {
      btn.textContent = '↻ Sync History'; btn.disabled = false;
      alert('Sync error: ' + e.message);
    }
  });

  loadData();
});
