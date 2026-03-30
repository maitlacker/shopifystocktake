// ── State ──────────────────────────────────────────────────────────
let reportData  = null;
let activeFilter = 'all';
let activePeriod = 30;

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
  renderStyles();
}

// ── Run report ─────────────────────────────────────────────────────
document.getElementById('btn-run').addEventListener('click', runReport);

async function runReport() {
  const btn          = document.getElementById('btn-run');
  const lowStockDays = document.getElementById('low-stock-days').value || 21;
  const criticalDays = document.getElementById('critical-days').value || 7;

  btn.disabled    = true;
  btn.textContent = 'Loading…';

  document.getElementById('results').innerHTML =
    '<div class="state-msg"><div class="spinner"></div><br>Fetching orders and calculating velocity…<br><small style="color:#94a3b8">This may take a moment for large catalogues.</small></div>';
  document.getElementById('summary-row').style.display  = 'none';
  document.getElementById('filter-tabs').style.display  = 'none';
  document.getElementById('report-meta').textContent    = '';

  // Reset to "All" tab on each new run
  activeFilter = 'all';
  document.querySelectorAll('.vel-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.filter === 'all');
  });

  try {
    const params = new URLSearchParams({
      days:           activePeriod,
      low_stock_days: lowStockDays,
      critical_days:  criticalDays,
    });
    const res = await fetch(`/api/velocity?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    reportData = await res.json();
    renderReport();
  } catch (err) {
    document.getElementById('results').innerHTML =
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

  document.getElementById('count-critical').textContent  = summary.critical_stock;
  document.getElementById('count-low').textContent       = summary.low_stock;
  document.getElementById('count-imbalanced').textContent = summary.imbalanced;
  document.getElementById('count-dead').textContent      = summary.dead_stock;
  document.getElementById('count-ok').textContent        = summary.ok;

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
    document.getElementById('results').innerHTML =
      '<div class="state-msg">No styles in this category.</div>';
    return;
  }

  document.getElementById('results').innerHTML = styles.map(styleCard).join('');

}

// ── Expand/collapse — single delegated listener on results div ─────
document.getElementById('results').addEventListener('click', (e) => {
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
