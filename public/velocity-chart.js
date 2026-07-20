'use strict';

const PALETTE = [
  { border: '#6366f1', raw: 'rgba(99,102,241,0.18)' },
  { border: '#f59e0b', raw: 'rgba(245,158,11,0.18)' },
  { border: '#10b981', raw: 'rgba(16,185,129,0.18)' },
  { border: '#ef4444', raw: 'rgba(239,68,68,0.18)' },
];

let selectedProducts = [];  // [{ id, title }]
let chartInstance    = null;
let chartData        = [];  // full API response products array
let debounceTimer    = null;

// ── Product search autocomplete ────────────────────────────────────

document.getElementById('vc-search').addEventListener('input', function () {
  clearTimeout(debounceTimer);
  const q = this.value.trim();
  if (q.length < 2) { hideAC(); return; }
  debounceTimer = setTimeout(() => searchProducts(q), 280);
});

document.getElementById('vc-search').addEventListener('blur', () => {
  setTimeout(hideAC, 180);
});

async function searchProducts(q) {
  try {
    const r = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) return;
    const results = await r.json();
    showAC(results);
  } catch (_) {}
}

function showAC(results) {
  const list = document.getElementById('vc-autocomplete');
  if (!results.length) { list.style.display = 'none'; return; }
  const alreadyIds = new Set(selectedProducts.map(p => p.id));
  const available  = results.filter(p => !alreadyIds.has(p.id)).slice(0, 12);
  if (!available.length) { list.style.display = 'none'; return; }
  list.innerHTML = available.map(p =>
    `<div class="vc-autocomplete-item" data-id="${p.id}" data-title="${escHtml(p.title)}" onmousedown="selectProductFromEl(this)">
      ${escHtml(p.title)}
      <div class="sub">${escHtml(p.variants?.[0]?.sku || '')}</div>
    </div>`
  ).join('');
  list.style.display = 'block';
}

function hideAC() {
  document.getElementById('vc-autocomplete').style.display = 'none';
}

function selectProductFromEl(el) {
  selectProduct(Number(el.dataset.id), el.dataset.title);
}

function selectProduct(id, title) {
  if (selectedProducts.length >= 4) return;
  if (selectedProducts.find(p => p.id === id)) return;
  selectedProducts.push({ id, title });
  document.getElementById('vc-search').value = '';
  hideAC();
  renderChips();
}

function removeProduct(id) {
  selectedProducts = selectedProducts.filter(p => p.id !== id);
  renderChips();
}

function renderChips() {
  const wrap = document.getElementById('vc-chips');
  if (!selectedProducts.length) {
    wrap.innerHTML = '<span class="vc-chips-hint">Search and select up to 4 products above</span>';
    document.getElementById('vc-generate').disabled = true;
    return;
  }
  wrap.innerHTML = selectedProducts.map((p, i) => {
    const col = PALETTE[i].border;
    return `<span class="vc-chip" style="background:${col}">
      ${escHtml(p.title)}
      <button class="vc-chip-x" onclick="removeProduct(${p.id})" title="Remove">✕</button>
    </span>`;
  }).join('');
  if (selectedProducts.length < 4) {
    wrap.innerHTML += `<span class="vc-chips-hint" style="margin-left:4px">
      ${4 - selectedProducts.length} slot${4 - selectedProducts.length !== 1 ? 's' : ''} remaining
    </span>`;
  }
  document.getElementById('vc-generate').disabled = false;
}

// ── Chart generation ───────────────────────────────────────────────

async function generateChart() {
  if (!selectedProducts.length) return;

  const ids     = selectedProducts.map(p => p.id).join(',');
  const maxDays = document.getElementById('vc-lookback').value;
  const body    = document.getElementById('vc-chart-body');
  const genBtn  = document.getElementById('vc-generate');

  genBtn.disabled = true;
  genBtn.textContent = 'Loading…';
  document.getElementById('vc-stats').style.display = 'none';

  body.innerHTML = `
    <div class="vc-loading">
      <div class="vc-loading-spinner"></div>
      <div>Fetching order history — this may take a moment for older products…</div>
    </div>`;

  try {
    const r    = await fetch(`/api/velocity-chart?ids=${ids}&max_days=${maxDays}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    chartData = data.products;
    renderChart(chartData);
    renderStats(chartData);
  } catch (err) {
    body.innerHTML = `<div class="vc-error">Error: ${escHtml(err.message)}</div>`;
  } finally {
    genBtn.disabled = false;
    genBtn.textContent = 'Generate Chart';
  }
}

// ── Rolling average ────────────────────────────────────────────────

function rollingAvg(data, window = 7) {
  return data.map((_, i) => {
    const slice = data.slice(Math.max(0, i - window + 1), i + 1);
    const avg   = slice.reduce((s, v) => s + v, 0) / slice.length;
    return Math.round(avg * 10) / 10;
  });
}

// ── Chart render ───────────────────────────────────────────────────

function renderChart(products) {
  const body = document.getElementById('vc-chart-body');

  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  body.innerHTML = '<div class="vc-canvas-wrap"><canvas id="vc-canvas"></canvas></div>';
  const ctx = document.getElementById('vc-canvas').getContext('2d');

  // Max days across all products
  const maxLen = Math.max(...products.map(p => p.days.length));
  const labels = Array.from({ length: maxLen }, (_, i) => `Day ${i + 1}`);

  const datasets = [];

  products.forEach((product, pi) => {
    const col     = PALETTE[pi];
    const rawVals = product.days.map(d => d.sold);
    const avgVals = rollingAvg(rawVals);

    // Pad shorter products with null so they end at their last day
    const padRaw = [...rawVals, ...Array(maxLen - rawVals.length).fill(null)];
    const padAvg = [...avgVals, ...Array(maxLen - avgVals.length).fill(null)];

    // Raw daily (thin, semi-transparent) — hidden by default via hidden flag
    datasets.push({
      label:           `${product.title} — daily`,
      data:            padRaw,
      borderColor:     col.raw,
      backgroundColor: 'transparent',
      borderWidth:     1,
      pointRadius:     0,
      tension:         0.15,
      spanGaps:        false,
      hidden:          !document.getElementById('vc-show-raw').checked,
      _productIdx:     pi,
      _isRaw:          true,
    });

    // 7-day rolling average (thick, solid)
    datasets.push({
      label:           `${product.title} — 7d avg`,
      data:            padAvg,
      borderColor:     col.border,
      backgroundColor: 'transparent',
      borderWidth:     2.5,
      pointRadius:     0,
      tension:         0.35,
      spanGaps:        false,
      _productIdx:     pi,
      _isRaw:          false,
    });
  });

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction:         { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position:  'bottom',
          align:     'start',
          labels:    {
            filter: item => !item.text.includes('— daily'),
            usePointStyle: true,
            pointStyle:    'line',
            padding:       20,
            font:          { size: 12, weight: '600' },
          },
        },
        tooltip: {
          callbacks: {
            title(items) {
              const idx = items[0].dataIndex;
              // Show day number + actual dates per product
              const lines = [`Day ${idx + 1}`];
              products.forEach((p, pi) => {
                if (p.days[idx]) lines.push(`  ${p.title.slice(0, 28)}: ${p.days[idx].date}`);
              });
              return lines;
            },
            label(item) {
              if (item.dataset._isRaw) return null;
              const pi  = item.dataset._productIdx;
              const idx = item.dataIndex;
              const raw = products[pi]?.days[idx]?.sold ?? '—';
              const avg = item.raw ?? '—';
              return `  ${item.dataset.label.replace(' — 7d avg', '')}: ${raw} sold  (7d avg ${avg})`;
            },
            filter(item) { return !item.dataset._isRaw; },
          },
        },
      },
      scales: {
        x: {
          title:  { display: true, text: 'Days since launch', color: '#94a3b8',
                    font: { size: 11, weight: '600' } },
          ticks:  { color: '#64748b', font: { size: 11 }, maxTicksLimit: 20 },
          grid:   { color: '#f1f5f9' },
        },
        y: {
          title:  { display: true, text: 'Units sold / day', color: '#94a3b8',
                    font: { size: 11, weight: '600' } },
          ticks:  { color: '#64748b', font: { size: 11 }, precision: 0 },
          grid:   { color: '#f1f5f9' },
          min:    0,
        },
      },
    },
  });
}

function toggleRawLines() {
  if (!chartInstance) return;
  const show = document.getElementById('vc-show-raw').checked;
  chartInstance.data.datasets.forEach(ds => {
    if (ds._isRaw) ds.hidden = !show;
  });
  chartInstance.update();
}

// ── Stats cards ────────────────────────────────────────────────────

function renderStats(products) {
  const grid = document.getElementById('vc-stats');

  const trendLabel = { up: '↑ Rising', flat: '→ Stable', down: '↓ Declining' };
  const fmt = d => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  grid.innerHTML = products.map((p, i) => {
    const col = PALETTE[i].border;
    const trend = p.trend || 'flat';
    return `
      <div class="vc-stat-card" style="--card-color:${col}">
        <div class="vc-stat-product" title="${escHtml(p.title)}">${escHtml(p.title)}</div>
        <div class="vc-stat-row">
          <span class="vc-stat-lbl">Live since</span>
          <span class="vc-stat-val">${fmt(p.published_at)}</span>
        </div>
        <div class="vc-stat-row">
          <span class="vc-stat-lbl">Days on sale</span>
          <span class="vc-stat-val">${p.total_days}</span>
        </div>
        <div class="vc-stat-row">
          <span class="vc-stat-lbl">Total sold</span>
          <span class="vc-stat-val">${p.total_sold} units</span>
        </div>
        <div class="vc-stat-row">
          <span class="vc-stat-lbl">Peak day</span>
          <span class="vc-stat-val">Day ${p.peak.dayNum} — ${p.peak.sold} units</span>
        </div>
        <div class="vc-stat-row">
          <span class="vc-stat-lbl">Last 7d avg</span>
          <span class="vc-stat-val">${p.recent7_avg}/day</span>
        </div>
        <div class="vc-stat-row">
          <span class="vc-stat-lbl">Prior 7d avg</span>
          <span class="vc-stat-val">${p.prior7_avg}/day</span>
        </div>
        <div class="vc-stat-row" style="margin-top:4px">
          <span class="vc-stat-lbl">Momentum</span>
          <span class="vc-trend ${trend}">${trendLabel[trend]}</span>
        </div>
      </div>`;
  }).join('');

  grid.style.display = 'grid';
}

// ── Helpers ────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
