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

// Period tabs
document.querySelectorAll('#period-tabs .disc-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#period-tabs .disc-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentDays = parseInt(tab.dataset.days);
    load();
  });
});

load().catch(err => {
  document.getElementById('no-data').style.display = 'block';
  document.getElementById('no-data').textContent = `Error loading data: ${err.message}`;
});
