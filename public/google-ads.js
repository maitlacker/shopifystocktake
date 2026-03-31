let currentDays = 7;

function fmt(n, decimals = 0) {
  if (n == null || n === '') return '—';
  return Number(n).toLocaleString('en-AU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AU');
}

function roasClass(roas) {
  const r = Number(roas);
  if (r >= 4)  return 'style="color:#15803d;font-weight:700"';
  if (r >= 2)  return 'style="color:#b45309;font-weight:700"';
  if (r > 0)   return 'style="color:#dc2626;font-weight:700"';
  return '';
}

async function load() {
  const notConnected   = document.getElementById('not-connected');
  const noData         = document.getElementById('no-data');
  const summaryRow     = document.getElementById('summary-row');
  const campaignsWrap  = document.getElementById('campaigns-wrap');
  const dailyWrap      = document.getElementById('daily-wrap');

  // Check if configured
  const statusRes = await fetch('/api/google-ads/status');
  const status    = await statusRes.json();

  if (!status.configured) {
    notConnected.style.display = 'block';
    [summaryRow, campaignsWrap, dailyWrap, noData].forEach(el => el.style.display = 'none');
    return;
  }

  notConnected.style.display = 'none';

  const [summaryRes, campaignsRes, dailyRes] = await Promise.all([
    fetch(`/api/google-ads/summary?days=${currentDays}`),
    fetch(`/api/google-ads/campaigns?days=${currentDays}`),
    fetch(`/api/google-ads/daily?days=${currentDays}`),
  ]);

  const summary   = await summaryRes.json();
  const campaigns = await campaignsRes.json();
  const daily     = await dailyRes.json();

  if (!campaigns.length) {
    noData.style.display = 'block';
    [summaryRow, campaignsWrap, dailyWrap].forEach(el => el.style.display = 'none');
    return;
  }

  noData.style.display = 'none';

  // Summary cards
  summaryRow.style.display = 'flex';
  document.getElementById('stat-spend').textContent       = fmtCurrency(summary.cost);
  document.getElementById('stat-roas').textContent        = fmt(summary.roas, 2) + 'x';
  document.getElementById('stat-conv-value').textContent  = fmtCurrency(summary.conversionValue);
  document.getElementById('stat-conversions').textContent = fmt(summary.conversions, 1);
  document.getElementById('stat-clicks').textContent      = fmt(summary.clicks);
  document.getElementById('stat-impressions').textContent = fmt(summary.impressions);

  // Campaigns table
  campaignsWrap.style.display = 'block';
  document.getElementById('campaigns-tbody').innerHTML = campaigns.map(c => `
    <tr>
      <td style="font-weight:500">${c.campaignName}</td>
      <td><span class="disc-badge ${c.campaignStatus === 'ENABLED' ? 'disc-badge--reviewed' : 'disc-badge--pending'}">${c.campaignStatus}</span></td>
      <td style="text-align:right">${fmtCurrency(c.cost)}</td>
      <td style="text-align:right">${fmtCurrency(c.conversionValue)}</td>
      <td style="text-align:right" ${roasClass(c.roas)}>${fmt(c.roas, 2)}x</td>
      <td style="text-align:right">${fmt(c.conversions, 1)}</td>
      <td style="text-align:right">${fmt(c.clicks)}</td>
      <td style="text-align:right">${fmt(c.impressions)}</td>
      <td style="text-align:right">${fmt(c.ctr, 2)}%</td>
      <td style="text-align:right">${fmtCurrency(c.cpc)}</td>
    </tr>
  `).join('');

  // Daily table
  dailyWrap.style.display = 'block';
  document.getElementById('daily-tbody').innerHTML = daily.map(d => `
    <tr>
      <td>${fmtDate(d.date)}</td>
      <td style="text-align:right">${fmtCurrency(d.cost)}</td>
      <td style="text-align:right">${fmtCurrency(d.conversionValue)}</td>
      <td style="text-align:right" ${roasClass(d.roas)}>${fmt(d.roas, 2)}x</td>
      <td style="text-align:right">${fmt(d.conversions, 1)}</td>
      <td style="text-align:right">${fmt(d.clicks)}</td>
      <td style="text-align:right">${fmt(d.impressions)}</td>
    </tr>
  `).join('');
}

// View tabs (Overview / Sheet Export)
const overviewEls     = ['summary-row','not-connected','no-data','campaigns-wrap','daily-wrap'];
const sheetExportPanel = document.getElementById('sheet-export-panel');
const periodTabs      = document.getElementById('period-tabs');
let currentView = 'overview';

document.querySelectorAll('#view-tabs .disc-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#view-tabs .disc-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentView = tab.dataset.view;
    if (currentView === 'overview') {
      sheetExportPanel.style.display = 'none';
      periodTabs.style.display       = '';
      load();
    } else {
      overviewEls.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
      sheetExportPanel.style.display = 'block';
      periodTabs.style.display       = 'none';
    }
  });
});

// Period tabs
document.querySelectorAll('#period-tabs .disc-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#period-tabs .disc-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDays = parseInt(tab.dataset.days);
    load();
  });
});

// ── Sheet Export ───────────────────────────────────────────────────
let sheetData    = [];
let activeMetric = 'cost';

const METRIC_LABELS = {
  cost:            'Spend',
  conversionValue: 'Conv. Value',
  roas:            'ROAS',
  conversions:     'Conversions',
  clicks:          'Clicks',
  impressions:     'Impressions',
};

function fmtMetric(metric, value) {
  const n = Number(value);
  if (metric === 'cost' || metric === 'conversionValue') return n.toFixed(2);
  if (metric === 'roas')        return n.toFixed(2);
  if (metric === 'conversions') return n.toFixed(1);
  return Math.round(n).toString();
}

function fmtSheetDate(d) {
  const dt = new Date(d);
  // Format as DD/MM so it pastes neatly
  return `${String(dt.getUTCDate()).padStart(2,'0')}/${String(dt.getUTCMonth()+1).padStart(2,'0')}`;
}

function renderSheetPreview() {
  if (!sheetData.length) return;
  const dates  = sheetData.map(r => fmtSheetDate(r.date));
  const values = sheetData.map(r => fmtMetric(activeMetric, r[activeMetric] ?? 0));

  document.getElementById('preview-dates').textContent  = dates.join('  |  ');
  document.getElementById('preview-values').textContent = values.join('  |  ');
}

document.querySelectorAll('.sheet-metric-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sheet-metric-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeMetric = tab.dataset.metric;
    renderSheetPreview();
  });
});

document.getElementById('btn-sheet-load').addEventListener('click', async () => {
  const start = document.getElementById('sheet-start').value;
  const end   = document.getElementById('sheet-end').value;
  if (!start || !end) { alert('Please select both a start and end date.'); return; }

  const btn = document.getElementById('btn-sheet-load');
  btn.disabled = true; btn.textContent = 'Loading…';

  try {
    const res  = await fetch(`/api/google-ads/daily?start=${start}&end=${end}`);
    sheetData  = await res.json();

    const resultsEl = document.getElementById('sheet-results');
    const emptyEl   = document.getElementById('sheet-empty');

    if (!sheetData.length) {
      resultsEl.style.display = 'none';
      emptyEl.style.display   = 'block';
    } else {
      emptyEl.style.display   = 'none';
      resultsEl.style.display = 'block';
      renderSheetPreview();
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Load';
  }
});

function copyTSV(type) {
  if (!sheetData.length) return;
  let text;
  if (type === 'dates') {
    text = sheetData.map(r => fmtSheetDate(r.date)).join('\t');
  } else {
    text = sheetData.map(r => fmtMetric(activeMetric, r[activeMetric] ?? 0)).join('\t');
  }
  navigator.clipboard.writeText(text).then(() => {
    const confirm = document.getElementById('copy-confirm');
    confirm.style.display = 'inline';
    setTimeout(() => confirm.style.display = 'none', 2000);
  });
}

document.getElementById('btn-copy-dates').addEventListener('click',  () => copyTSV('dates'));
document.getElementById('btn-copy-values').addEventListener('click', () => copyTSV('values'));

// Set default dates (last 30 days)
(function setDefaultDates() {
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  document.getElementById('sheet-end').value   = end.toISOString().split('T')[0];
  document.getElementById('sheet-start').value = start.toISOString().split('T')[0];
})();

load().catch(err => {
  document.getElementById('no-data').style.display = 'block';
  document.getElementById('no-data').textContent = `Error loading data: ${err.message}`;
});
