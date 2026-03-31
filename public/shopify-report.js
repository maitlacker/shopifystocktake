let dailyData = [];

function fmtDate(d) {
  const dt = new Date(d + 'T00:00:00Z');
  return `${String(dt.getUTCDate()).padStart(2,'0')}/${String(dt.getUTCMonth()+1).padStart(2,'0')}`;
}

function fmtFull(d) {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-AU');
}

function previewText(values) {
  // Show first few values with ellipsis if long
  const all = values.join('  |  ');
  return all.length > 120 ? all.slice(0, 117) + '…' : all;
}

function renderPreviews() {
  const dates    = dailyData.map(r => fmtDate(r.date));
  const revenue  = dailyData.map(r => Number(r.revenue).toFixed(2));
  const orders   = dailyData.map(r => String(r.orders));
  const items    = dailyData.map(r => String(r.itemsSold));
  const sessions = dailyData.map(r => r.sessions != null ? String(r.sessions) : 'N/A');

  document.getElementById('preview-dates').textContent   = previewText(dates);
  document.getElementById('preview-revenue').textContent = previewText(revenue);
  document.getElementById('preview-orders').textContent  = previewText(orders);
  document.getElementById('preview-items').textContent   = previewText(items);
  document.getElementById('preview-sessions').textContent = previewText(sessions);

  // Dim sessions card if no data
  const hasSessionData = dailyData.some(r => r.sessions != null);
  const sessCard = document.getElementById('sessions-card');
  if (sessCard) sessCard.style.opacity = hasSessionData ? '1' : '0.45';
}

function getTSV(metric) {
  if (metric === 'dates')    return dailyData.map(r => fmtDate(r.date)).join('\t');
  if (metric === 'revenue')  return dailyData.map(r => Number(r.revenue).toFixed(2)).join('\t');
  if (metric === 'orders')   return dailyData.map(r => String(r.orders)).join('\t');
  if (metric === 'itemsSold') return dailyData.map(r => String(r.itemsSold)).join('\t');
  if (metric === 'sessions') return dailyData.map(r => r.sessions != null ? String(r.sessions) : '').join('\t');
  return '';
}

function renderTable() {
  document.getElementById('daily-tbody').innerHTML = dailyData.map(r => `
    <tr>
      <td>${fmtFull(r.date)}</td>
      <td style="text-align:right">$${Number(r.revenue).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td style="text-align:right">${r.orders}</td>
      <td style="text-align:right">${r.itemsSold}</td>
      <td style="text-align:right">${r.sessions ?? '<span style="color:#94a3b8">N/A</span>'}</td>
    </tr>
  `).join('');
}

// Load data
document.getElementById('btn-load').addEventListener('click', async () => {
  const start = document.getElementById('sheet-start').value;
  const end   = document.getElementById('sheet-end').value;
  if (!start || !end) { alert('Please select both a start and end date.'); return; }

  const btn = document.getElementById('btn-load');
  btn.disabled = true; btn.textContent = 'Loading…';

  try {
    const res  = await fetch(`/api/shopify-analytics/daily?start=${start}&end=${end}`);
    dailyData  = await res.json();

    const resultsEl = document.getElementById('results');
    const noDataEl  = document.getElementById('no-data');

    if (!res.ok || dailyData.error) throw new Error(dailyData.error || 'Unknown error');

    if (!dailyData.length) {
      resultsEl.style.display = 'none';
      noDataEl.style.display  = 'block';
    } else {
      noDataEl.style.display  = 'none';
      resultsEl.style.display = 'block';
      renderPreviews();
      renderTable();
    }
  } catch (err) {
    document.getElementById('no-data').style.display = 'block';
    document.getElementById('no-data').textContent   = `Error: ${err.message}`;
  } finally {
    btn.disabled = false; btn.textContent = 'Load';
  }
});

// Copy buttons
document.querySelectorAll('.shopify-copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!dailyData.length) return;
    const tsv     = getTSV(btn.dataset.metric);
    const confirm = document.getElementById('copy-confirm');
    navigator.clipboard.writeText(tsv).then(() => {
      confirm.style.display = 'inline';
      setTimeout(() => confirm.style.display = 'none', 2000);
    });
  });
});

// Default date range — last 30 days
(function () {
  const end   = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  document.getElementById('sheet-end').value   = end.toISOString().split('T')[0];
  document.getElementById('sheet-start').value = start.toISOString().split('T')[0];
})();
