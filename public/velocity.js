// ── State ──────────────────────────────────────────────────────────
let reportData   = null;
let activeFilter = 'all';
let activePeriod = 30;

// ── Insights state ─────────────────────────────────────────────────
// keyed by period (30/60/90): { hot, not_hot, generated_at, products_analysed }
let insightsCache       = {};
let activeInsightsType  = 'hot';   // 'hot' | 'not_hot'
let insightsRunning     = false;

// ── Element refs ───────────────────────────────────────────────────
const resultsDiv        = document.getElementById('results');
const analysisPanel     = document.getElementById('analysis-panel');
const analysisLoading   = document.getElementById('analysis-loading');
const analysisRunPrompt = document.getElementById('analysis-run-prompt');
const analysisResults   = document.getElementById('analysis-results');

// ── HTML escape ────────────────────────────────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Period buttons ─────────────────────────────────────────────────
document.querySelectorAll('.vel-period-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.vel-period-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activePeriod = parseInt(btn.dataset.days);
  });
});

// ── Summary card clicks ────────────────────────────────────────────
document.getElementById('summary-row').addEventListener('click', (e) => {
  const card = e.target.closest('[data-filter]');
  if (card) setFilter(card.dataset.filter);
});

// ── Filter tab clicks ──────────────────────────────────────────────
document.getElementById('filter-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.vel-tab');
  if (tab) setFilter(tab.dataset.filter);
});

function setFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.vel-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.filter === filter);
  });

  const isAnalysis = filter === 'hot_analysis' || filter === 'cold_analysis';
  activeInsightsType = filter === 'cold_analysis' ? 'not_hot' : 'hot';

  if (isAnalysis) {
    resultsDiv.style.display    = 'none';
    analysisPanel.style.display = 'block';
    showInsights();
  } else {
    resultsDiv.style.display    = '';
    analysisPanel.style.display = 'none';
    renderStyles();
  }
}

// ── Run report ─────────────────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', runReport);

async function runReport() {
  const btn          = document.getElementById('btn-run');
  const lowStockDays = document.getElementById('low-stock-days').value || 21;
  const criticalDays = document.getElementById('critical-days').value || 7;

  btn.disabled    = true;
  btn.textContent = 'Loading…';

  // Hide everything during load
  resultsDiv.innerHTML            =
    '<div class="state-msg"><div class="spinner"></div><br>Fetching orders and calculating velocity…<br><small style="color:#94a3b8">This may take a moment for large catalogues.</small></div>';
  resultsDiv.style.display        = '';
  analysisPanel.style.display     = 'none';
  document.getElementById('summary-row').style.display  = 'none';
  document.getElementById('filter-tabs').style.display  = 'none';
  document.getElementById('report-meta').textContent    = '';

  // Reset to "All" tab on each new run
  activeFilter = 'all';
  document.querySelectorAll('.vel-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.filter === 'all');
  });

  try {
    const deadMinSold       = document.getElementById('dead-min-sold').value || 10;
    const excludeCollection = (document.getElementById('exclude-collection').value || '').trim();
    const params = new URLSearchParams({
      days:           activePeriod,
      low_stock_days: lowStockDays,
      critical_days:  criticalDays,
      dead_min_sold:  deadMinSold,
    });
    if (excludeCollection) params.append('exclude_collection', excludeCollection);
    const res = await fetch(`/api/velocity?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    reportData = await res.json();
    renderReport();
  } catch (err) {
    resultsDiv.innerHTML =
      `<div class="state-msg" style="color:#b91c1c">&#9888; Error: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '⟳ Run Report';
  }
}

// ── Render full report ─────────────────────────────────────────────
function renderReport() {
  const { summary, period_days, generated_at, total_orders_analysed, styles } = reportData;
  const dt = new Date(generated_at);

  document.getElementById('report-meta').textContent =
    `${styles.length} styles · ${total_orders_analysed} orders · ${period_days}d window · ${dt.toLocaleTimeString()}`;

  document.getElementById('count-critical').textContent   = summary.critical_stock;
  document.getElementById('count-low').textContent        = summary.low_stock;
  document.getElementById('count-imbalanced').textContent = summary.imbalanced;
  document.getElementById('count-dead').textContent       = summary.dead_stock;
  document.getElementById('count-ok').textContent         = summary.ok;

  document.getElementById('summary-row').style.display = 'flex';
  document.getElementById('filter-tabs').style.display = 'flex';

  renderStyles();
}

// ── Render filtered style list ─────────────────────────────────────
function renderStyles() {
  if (!reportData) return;

  const styles = activeFilter === 'all'
    ? reportData.styles.filter((s) => s.alert_type !== 'no_activity')
    : reportData.styles.filter((s) => s.alert_type === activeFilter);

  if (styles.length === 0) {
    resultsDiv.innerHTML = '<div class="state-msg">No styles in this category.</div>';
    return;
  }

  resultsDiv.innerHTML = styles.map(styleCard).join('');
}

// ── Expand/collapse — single delegated listener on results div ─────
resultsDiv.addEventListener('click', (e) => {
  const btn = e.target.closest('.vel-expand-btn');
  if (!btn) return;
  const id    = btn.dataset.id;
  const table = document.getElementById(`variants-${id}`);
  if (!table) return;
  const open  = table.style.display !== 'none';
  table.style.display = open ? 'none' : 'table';
  btn.innerHTML = open ? '&#9654; Show variants' : '&#9660; Hide variants';
});

// ── Status config ──────────────────────────────────────────────────
const STATUS_CONFIG = {
  red:    { badgeCls: 'vel-badge-red',    label: '🔴 Critical Stock',   hint: 'Restock urgently — running very low' },
  amber:  { badgeCls: 'vel-badge-amber',  label: '🟠 Low Stock',        hint: 'Plan a restock soon' },
  yellow: { badgeCls: 'vel-badge-yellow', label: '🟡 Imbalanced',       hint: 'Some variants sold out — restock or discount remaining' },
  blue:   { badgeCls: 'vel-badge-blue',   label: '📦 Dead Stock',       hint: 'High inventory, low sales — review pricing or promotions' },
  green:  { badgeCls: 'vel-badge-green',  label: '🟢 Healthy',          hint: 'Selling well with adequate stock' },
  grey:   { badgeCls: 'vel-badge-grey',   label: '⬜ No Activity',      hint: 'No inventory or sales recorded' },
};

// ── Style card HTML ────────────────────────────────────────────────
function styleCard(s) {
  const sc    = STATUS_CONFIG[s.status] || STATUS_CONFIG.grey;
  const thumb = s.image
    ? `<img class="product-thumb" src="${esc(s.image)}" alt="" loading="lazy" />`
    : `<div class="product-thumb-placeholder">📦</div>`;

  const daysStockHtml = s.days_of_stock !== null
    ? `<div class="vel-metric ${s.status === 'red' ? 'vel-metric-danger' : s.status === 'amber' ? 'vel-metric-warn' : ''}">
         <span class="vel-metric-value">${s.days_of_stock}</span>
         <span class="vel-metric-label">days of stock</span>
       </div>`
    : `<div class="vel-metric vel-metric-muted">
         <span class="vel-metric-value">&#8734;</span>
         <span class="vel-metric-label">days of stock</span>
       </div>`;

  const soldOutBadge = s.variant_sold_out_count > 0
    ? `<span class="vel-soldout-badge">${s.variant_sold_out_count} of ${s.variant_total_count} variant${s.variant_total_count !== 1 ? 's' : ''} sold out</span>`
    : '';

  const variantRows = s.variants.map((v) => variantRow(v)).join('');

  return `
<div class="product-card vel-card-${s.status}">
  <div class="product-header">
    ${thumb}
    <div class="product-header-info">
      <div class="product-title">${esc(s.title)}</div>
      <div class="vel-badges">
        <span class="vel-status-badge ${sc.badgeCls}">${sc.label}</span>
        ${soldOutBadge}
      </div>
      <div class="vel-action-hint">${sc.hint}</div>
    </div>
    <div class="vel-metrics-row">
      <div class="vel-metric">
        <span class="vel-metric-value">${s.total_inventory}</span>
        <span class="vel-metric-label">in stock</span>
      </div>
      <div class="vel-metric">
        <span class="vel-metric-value">${s.total_sold}</span>
        <span class="vel-metric-label">sold (${reportData.period_days}d)</span>
      </div>
      <div class="vel-metric">
        <span class="vel-metric-value">${s.daily_velocity > 0 ? s.daily_velocity.toFixed(1) : '0'}</span>
        <span class="vel-metric-label">units/day</span>
      </div>
      ${daysStockHtml}
      ${s.avg_margin_pct !== null
        ? `<div class="vel-metric">
             <span class="vel-metric-value">${s.avg_margin_pct.toFixed(1)}%</span>
             <span class="vel-metric-label">avg margin</span>
           </div>`
        : ''}
      ${s.total_markup_on_hand !== null
        ? `<div class="vel-metric">
             <span class="vel-metric-value">$${s.total_markup_on_hand.toLocaleString('en-AU', {minimumFractionDigits:0, maximumFractionDigits:0})}</span>
             <span class="vel-metric-label">profit on hand</span>
           </div>`
        : ''}
    </div>
    <button class="btn btn-secondary vel-expand-btn" data-id="${s.id}">&#9654; Show variants</button>
  </div>
  <table class="variants-table" id="variants-${s.id}" style="display:none">
    <thead>
      <tr>
        <th>Variant</th>
        <th>SKU</th>
        <th style="text-align:center">In Stock</th>
        <th style="text-align:center">Sold (${reportData.period_days}d)</th>
        <th style="text-align:center">Units/Day</th>
        <th style="text-align:center">Days of Stock</th>
        <th style="text-align:right">Price</th>
        <th style="text-align:right">Cost</th>
        <th style="text-align:right">Profit/unit</th>
        <th style="text-align:right">Margin %</th>
      </tr>
    </thead>
    <tbody>${variantRows}</tbody>
  </table>
</div>`;
}

// ── Variant row HTML ───────────────────────────────────────────────
function variantRow(v) {
  const { critical_days, low_stock_days } = reportData.thresholds;

  let daysHtml;
  if (v.days_of_stock === null) {
    daysHtml = `<span class="diff-badge diff-none">&#8734;</span>`;
  } else if (v.days_of_stock <= critical_days) {
    daysHtml = `<span class="diff-badge diff-under">${v.days_of_stock}d</span>`;
  } else if (v.days_of_stock <= low_stock_days) {
    daysHtml = `<span class="diff-badge diff-over">${v.days_of_stock}d</span>`;
  } else {
    daysHtml = `<span class="diff-badge diff-ok">${v.days_of_stock}d</span>`;
  }

  const stockHtml = v.inventory === 0
    ? `<span class="diff-badge diff-under">SOLD OUT</span>`
    : v.inventory;

  const rowCls = v.inventory === 0 ? 'vel-variant-soldout' : '';

  const fmt = (n) => n !== null ? `$${n.toFixed(2)}` : '—';
  const marginHtml = v.margin_pct !== null
    ? `<span class="${v.margin_pct < 0 ? 'vel-margin-neg' : v.margin_pct < 30 ? 'vel-margin-low' : 'vel-margin-ok'}">${v.margin_pct.toFixed(1)}%</span>`
    : '—';

  return `<tr class="${rowCls}">
    <td>${esc(v.title === 'Default Title' ? '—' : v.title)}</td>
    <td><code>${esc(v.sku || '—')}</code></td>
    <td style="text-align:center">${stockHtml}</td>
    <td style="text-align:center">${v.sold}</td>
    <td style="text-align:center">${v.daily_velocity > 0 ? v.daily_velocity.toFixed(2) : '—'}</td>
    <td style="text-align:center">${daysHtml}</td>
    <td style="text-align:right">${fmt(v.price)}</td>
    <td style="text-align:right">${fmt(v.cost)}</td>
    <td style="text-align:right">${v.margin !== null ? fmt(v.margin) : '—'}</td>
    <td style="text-align:right">${marginHtml}</td>
  </tr>`;
}

// ── AI Insights ────────────────────────────────────────────────────

document.getElementById('btn-run-analysis').addEventListener('click', runAnalysis);

async function showInsights() {
  // In-memory cache hit — instant
  if (insightsCache[activePeriod]) {
    renderInsights(insightsCache[activePeriod]);
    return;
  }

  // Check server-side cache
  analysisLoading.style.display   = 'block';
  analysisRunPrompt.style.display = 'none';
  analysisResults.style.display   = 'none';

  try {
    const r = await fetch(`/api/velocity/insights/latest?days=${activePeriod}`);
    if (r.ok) {
      const data = await r.json();
      if (data) {
        insightsCache[activePeriod] = data;
        renderInsights(data);
        return;
      }
    }
  } catch (_) { /* fall through */ }

  // No cached analysis — show run prompt
  analysisLoading.style.display   = 'none';
  analysisRunPrompt.style.display = 'block';
  analysisResults.style.display   = 'none';
}

async function runAnalysis() {
  if (!reportData) {
    alert('Please run the velocity report first, then click Run AI Analysis.');
    return;
  }
  if (insightsRunning) return;

  insightsRunning = true;
  analysisLoading.style.display   = 'block';
  analysisRunPrompt.style.display = 'none';
  analysisResults.style.display   = 'none';
  document.getElementById('btn-run-analysis').disabled = true;

  try {
    const r = await fetch('/api/velocity/insights', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ days: activePeriod, styles: reportData.styles }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err.error || r.statusText);
    }
    const data = await r.json();
    insightsCache[activePeriod] = data;
    renderInsights(data);
  } catch (err) {
    analysisLoading.style.display   = 'none';
    analysisRunPrompt.style.display = 'block';
    analysisResults.innerHTML       =
      `<div class="state-msg" style="color:#b91c1c; padding:16px 0">&#9888; ${esc(err.message)}</div>`;
    analysisResults.style.display   = 'block';
  } finally {
    insightsRunning = false;
    document.getElementById('btn-run-analysis').disabled = false;
  }
}

function renderInsights(data) {
  analysisLoading.style.display   = 'none';
  analysisRunPrompt.style.display = 'none';
  analysisResults.style.display   = 'block';

  const section = activeInsightsType === 'hot' ? data.hot : data.not_hot;
  if (!section || !section.clusters || section.clusters.length === 0) {
    analysisResults.innerHTML = '<div class="state-msg">No pattern data available for this category.</div>';
    return;
  }

  const isHot       = activeInsightsType === 'hot';
  const typeLabel   = isHot ? '🔥 What\'s Hot' : '❄️ What\'s Not Selling';
  const clsCls      = isHot ? 'insight-cluster-hot'  : 'insight-cluster-cold';
  const kwCls       = isHot ? 'insight-keyword-hot'  : 'insight-keyword-cold';
  const genAt       = data.generated_at ? new Date(data.generated_at) : null;
  const genAgo      = genAt ? timeAgo(genAt) : '';

  const clusterCards = section.clusters.map((c) => `
    <div class="insight-cluster ${clsCls}">
      <div class="insight-cluster-label">
        ${esc(c.label)}
        ${c.product_count ? `<span class="insight-cluster-count">${c.product_count} products</span>` : ''}
      </div>
      <div class="insight-keywords">
        ${(c.keywords || []).map((k) => `<span class="insight-keyword ${kwCls}">${esc(k)}</span>`).join('')}
      </div>
      <div class="insight-text">${esc(c.insight)}</div>
      ${c.examples && c.examples.length > 0 ? `
        <div class="insight-examples">
          <strong>Examples</strong>
          ${c.examples.slice(0, 3).map((e) => `• ${esc(e)}`).join('<br>')}
        </div>` : ''}
    </div>
  `).join('');

  analysisResults.innerHTML = `
    <div class="insights-header">
      <h2>${typeLabel}</h2>
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        ${genAgo ? `<span style="color:#94a3b8; font-size:0.82rem;">Analysed ${genAgo}</span>` : ''}
        <button class="btn btn-secondary" id="btn-reanalyse"
                style="font-size:0.82rem; padding:6px 14px; touch-action:manipulation;">
          ↺ Re-analyse
        </button>
      </div>
    </div>
    <div class="insights-summary">${esc(section.summary)}</div>
    <div class="insights-grid">${clusterCards}</div>
  `;

  document.getElementById('btn-reanalyse').addEventListener('click', () => {
    delete insightsCache[activePeriod];
    runAnalysis();
  });
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 90)    return 'just now';
  if (secs < 3600)  return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} day${Math.floor(secs / 86400) !== 1 ? 's' : ''} ago`;
}
