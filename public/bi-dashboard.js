'use strict';

// ── DOM refs ──────────────────────────────────────────────────────
const periodBtns  = document.querySelectorAll('.bi-period-btn');
const periodRange = document.getElementById('periodRange');
const biLoading   = document.getElementById('biLoading');
const biContent   = document.getElementById('biContent');
const biError     = document.getElementById('biError');

// ── Date range helpers ────────────────────────────────────────────
function computeRange(period) {
  const now = new Date();
  let start, end;

  if (period === 'ttm') {
    // Last 12 complete months: 1st of month 12 months ago → last day of last month
    const endD   = new Date(now.getFullYear(), now.getMonth(), 0); // last day of prev month
    const startD = new Date(endD.getFullYear(), endD.getMonth() - 11, 1); // 1st of month 12 months prior
    start = startD.toISOString().slice(0, 10);
    end   = endD.toISOString().slice(0, 10);
  } else if (period === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    start = d.toISOString().slice(0, 10);
    end   = now.toISOString().slice(0, 10);
  } else {
    const days = parseInt(period, 10);
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1));
    start = d.toISOString().slice(0, 10);
    end   = now.toISOString().slice(0, 10);
  }
  return { start, end };
}

// ── Load ──────────────────────────────────────────────────────────
async function load(period) {
  const { start, end } = computeRange(period);

  biLoading.style.display = 'block';
  biContent.style.display = 'none';
  biError.style.display   = 'none';
  periodRange.textContent = `${fmtDateShort(start)} → ${fmtDateShort(end)}`;

  try {
    const r = await fetch(`/api/bi/summary?start=${start}&end=${end}`);
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(txt || `HTTP ${r.status}`);
    }
    const data = await r.json();
    render(data);
  } catch (err) {
    biLoading.style.display = 'none';
    biError.textContent     = 'Failed to load data: ' + err.message;
    biError.style.display   = 'block';
  }
}

// ── Render ────────────────────────────────────────────────────────
function render(d) {
  biLoading.style.display = 'none';
  biContent.style.display = 'block';

  const { shopify: sh, googleAds: ga, metaAds: ma, combined: co, xero } = d;

  // ── KPI cards ──────────────────────────────────────────────────
  set('kpiRevenue',    fmtCurrency(sh.revenue));
  set('kpiRevenueSub', `${fmtNum(sh.orders)} orders · ${fmtNum(sh.daysWithData)} days data`);

  set('kpiOrders', fmtNum(sh.orders));
  set('kpiAov',    sh.orders > 0 ? `AOV ${fmtCurrency(sh.aov)}` : '–');

  set('kpiSpend',    co.totalAdSpend > 0 ? fmtCurrency(co.totalAdSpend) : '–');
  set('kpiSpendSub', `${fmtCurrency(ga.spend)} Google · ${fmtCurrency(ma.spend)} Meta`);

  set('kpiMer', co.totalAdSpend > 0 ? merLabel(co.mer) : '–');

  if (sh.sessions != null) {
    set('kpiSessions', fmtNum(sh.sessions));
    set('kpiConvRate', sh.conversionRate != null
      ? `${sh.conversionRate.toFixed(2)}% conv. rate`
      : '–');
  } else {
    set('kpiSessions', '–');
    set('kpiConvRate', 'No sessions synced');
  }

  set('kpiItems',    fmtNum(sh.itemsSold));
  set('kpiItemsSub', sh.orders > 0
    ? `${(sh.itemsSold / sh.orders).toFixed(1)} items / order`
    : '–');

  // Google ROAS card
  set('kpiGroas',  ga.spend > 0 ? roasLabel(ga.roas) : '–');
  set('kpiGspend', ga.spend > 0 ? `${fmtCurrency(ga.spend)} spend` : 'Not connected');

  // Meta ROAS card
  set('kpiMroas',  ma.spend > 0 ? roasLabel(ma.roas) : '–');
  set('kpiMspend', ma.spend > 0 ? `${fmtCurrency(ma.spend)} spend` : 'Not connected');

  // ── Ads channel table ──────────────────────────────────────────
  const totalImpr  = ga.impressions  + ma.impressions;
  const totalClick = ga.clicks       + ma.clicks;
  const totalConv  = ga.conversions  + ma.purchases;
  const totalCVal  = ga.conversionValue + ma.purchaseValue;
  const totalRoas  = co.totalAdSpend > 0 ? totalCVal / co.totalAdSpend : 0;
  const gCpc = ga.clicks > 0 ? ga.spend / ga.clicks : null;
  const mCpc = ma.clicks > 0 ? ma.spend / ma.clicks : null;
  const tCpc = totalClick > 0 ? co.totalAdSpend / totalClick : null;

  document.getElementById('adsTbody').innerHTML = [
    adsRow('🟠 Google Ads', ga.spend, ga.impressions, ga.clicks, ga.conversions,  ga.conversionValue, ga.roas, gCpc),
    adsRow('🔵 Meta Ads',   ma.spend, ma.impressions, ma.clicks, ma.purchases,    ma.purchaseValue,   ma.roas, mCpc),
    adsRow('Total',         co.totalAdSpend, totalImpr, totalClick, totalConv, totalCVal, totalRoas, tCpc, true),
  ].join('');

  // ── Xero P&L table ────────────────────────────────────────────
  const xeroTbody = document.getElementById('xeroTbody');
  const xeroNote  = document.getElementById('xeroNote');

  if (!xero || xero.length === 0) {
    xeroTbody.innerHTML = `
      <tr>
        <td colspan="11" style="text-align:center; padding:28px; color:#94a3b8;">
          No P&L data for this period.
          <a href="/syncing.html" style="color:#4f46e5;">Sync from Xero</a> first.
        </td>
      </tr>`;
    xeroNote.style.display = 'none';
  } else {
    // Sum EBITDA across all months in period for the KPI card
    const totalEbitda   = xero.reduce((s, r) => s + (r.ebitda  || 0), 0);
    const totalRevenue  = xero.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalDa       = xero.reduce((s, r) => s + (r.da      || 0), 0);
    const ebitdaPct     = totalRevenue > 0 ? (totalEbitda / totalRevenue) * 100 : null;
    const ebitdaEl      = document.getElementById('kpiEbitda');
    const ebitdaSubEl   = document.getElementById('kpiEbitdaSub');
    if (ebitdaEl)    ebitdaEl.textContent    = fmtCurrency(totalEbitda);
    if (ebitdaSubEl) ebitdaSubEl.textContent = ebitdaPct != null
      ? `${ebitdaPct.toFixed(1)}% margin${totalDa > 0 ? ' · D&A $' + fmtNum(Math.round(totalDa)) : ''}`
      : (totalDa > 0 ? `D&A $${fmtNum(Math.round(totalDa))} added back` : 'No D&A found in line items');

    xeroTbody.innerHTML = xero.map((r) => {
      const gpPct     = r.revenue > 0 ? (r.grossProfit / r.revenue) * 100 : null;
      const npPct     = r.revenue > 0 ? (r.netProfit   / r.revenue) * 100 : null;
      const ebitdaPct = r.revenue > 0 ? (r.ebitda      / r.revenue) * 100 : null;
      const gpCls     = r.grossProfit > 0 ? 'good' : (r.grossProfit < 0 ? 'bad' : '');
      const npCls     = r.netProfit   > 0 ? 'good' : (r.netProfit   < 0 ? 'bad' : '');
      const ebCls     = r.ebitda      > 0 ? 'good' : (r.ebitda      < 0 ? 'bad' : '');
      const daTitle   = [
        r.da       > 0 ? `D&A $${Math.round(r.da).toLocaleString()}`       : '',
        r.interest > 0 ? `Interest $${Math.round(r.interest).toLocaleString()}` : '',
        r.taxExp   > 0 ? `Tax $${Math.round(r.taxExp).toLocaleString()}`   : '',
      ].filter(Boolean).join(' + ') || 'No addbacks found';
      return `<tr>
        <td>${fmtMonth(r.month)}</td>
        <td>${fmtCurrency(r.revenue)}</td>
        <td>${fmtCurrency(r.cogs)}</td>
        <td class="${gpCls}">${fmtCurrency(r.grossProfit)}</td>
        <td class="${gpCls}">${gpPct != null ? gpPct.toFixed(1) + '%' : '–'}</td>
        <td>${fmtCurrency(r.expenses)}</td>
        <td class="${npCls}">${fmtCurrency(r.netProfit)}</td>
        <td class="${npCls}">${npPct != null ? npPct.toFixed(1) + '%' : '–'}</td>
        <td title="${daTitle}" style="color:#64748b;font-size:0.82em">${(r.da + r.interest + r.taxExp) > 0 ? fmtCurrency(r.da + r.interest + r.taxExp) : '<span class="dim">–</span>'}</td>
        <td class="${ebCls}">${fmtCurrency(r.ebitda)}</td>
        <td class="${ebCls}">${ebitdaPct != null ? ebitdaPct.toFixed(1) + '%' : '–'}</td>
      </tr>`;
    }).join('');
    xeroNote.textContent   = 'Xero P&L is monthly. D&A column = Depreciation + Amortisation + Interest addbacks identified from Xero line items.';
    xeroNote.style.display = 'block';
  }
}

// ── Build an ads table row ────────────────────────────────────────
function adsRow(name, spend, impr, clicks, conv, convVal, roas, cpc, isTotal) {
  const hasSp   = spend > 0;
  const roasCls = !hasSp ? '' : roas >= 3 ? 'good' : roas >= 1.5 ? 'warn' : 'bad';
  const cls     = isTotal ? ' class="bi-total-row"' : '';
  const dash    = '<span class="dim">–</span>';

  return `<tr${cls}>
    <td>${name}</td>
    <td>${hasSp ? fmtCurrency(spend) : dash}</td>
    <td>${impr  > 0 ? fmtNum(impr)  : dash}</td>
    <td>${clicks > 0 ? fmtNum(clicks) : dash}</td>
    <td>${conv  > 0 ? fmtNum(Math.round(conv)) : dash}</td>
    <td>${convVal > 0 ? fmtCurrency(convVal) : dash}</td>
    <td class="${roasCls}">${hasSp ? roas.toFixed(2) + 'x' : dash}</td>
    <td>${(hasSp && cpc != null) ? fmtCurrency(cpc) : dash}</td>
  </tr>`;
}

// ── Period button wiring ──────────────────────────────────────────
periodBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    periodBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    load(btn.dataset.period);
  });
});

// ── Formatters ────────────────────────────────────────────────────
function fmtCurrency(v) {
  if (v == null || isNaN(v)) return '–';
  return '$' + Number(v).toLocaleString('en-AU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function fmtNum(v) {
  if (v == null || isNaN(v)) return '–';
  return Number(v).toLocaleString('en-AU');
}

function fmtDateShort(iso) {
  const [y, m, dd] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(dd, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function fmtMonth(ym) {
  const [y, m] = ym.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

// Return a coloured ROAS string
function roasLabel(r) { return r.toFixed(2) + 'x'; }

// Return a coloured MER string
function merLabel(m) { return m.toFixed(2) + 'x'; }

// Shorthand DOM setter
function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Boot ──────────────────────────────────────────────────────────
load('30');
