const searchInput  = document.getElementById('history-search');
const resultsEl    = document.getElementById('history-results');

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderHistory(records) {
  if (records.length === 0) {
    resultsEl.innerHTML = `<div class="state-msg">No stocktake records found.</div>`;
    return;
  }

  // Group by productId, most recent entry per product at top
  const grouped = new Map();
  records.forEach((r) => {
    if (!grouped.has(r.productId)) {
      grouped.set(r.productId, { title: r.productTitle, entries: [] });
    }
    grouped.get(r.productId).entries.push(r);
  });

  const cards = Array.from(grouped.values()).map(({ title, entries }) => {
    const latest = entries[0]; // already sorted newest first from server

    const rows = entries.map((e) => `
      <tr>
        <td>${formatDate(e.timestamp)}</td>
        <td style="text-align:center"><span class="initials-tag">${escHtml(e.initials)}</span></td>
      </tr>`).join('');

    return `
      <div class="product-card">
        <div class="product-header">
          <div class="product-thumb-placeholder">📦</div>
          <div class="product-header-info">
            <span class="product-title">${escHtml(title)}</span>
            <span class="last-check">Last checked: ${formatDate(latest.timestamp)} by <strong>${escHtml(latest.initials)}</strong></span>
          </div>
          <span class="variant-count">${entries.length} check${entries.length !== 1 ? 's' : ''}</span>
        </div>
        <table class="variants-table">
          <thead>
            <tr>
              <th>Date &amp; Time</th>
              <th style="text-align:center">Initials</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });

  resultsEl.innerHTML = cards.join('');
}

async function loadHistory(query = '') {
  resultsEl.innerHTML = `<div class="state-msg"><div class="spinner"></div></div>`;
  try {
    const url = query ? `/api/stocktake/history?q=${encodeURIComponent(query)}` : '/api/stocktake/history';
    const res  = await fetch(url);
    const data = await res.json();
    renderHistory(data);
  } catch (err) {
    resultsEl.innerHTML = `<div class="state-msg" style="color:#b91c1c">Error loading history: ${err.message}</div>`;
  }
}

const doSearch = debounce((q) => loadHistory(q), 300);

searchInput.addEventListener('input', (e) => doSearch(e.target.value.trim()));

// Load on page open
loadHistory();
