'use strict';

let reportData      = null;
let activeFilter    = 'all';
let currentProducts = [];

// Default season start: 90 days ago
(function () {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  document.getElementById('st-since').value = d.toISOString().split('T')[0];
})();

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function runReport() {
  const btn  = document.getElementById('btn-run');
  const meta = document.getElementById('st-meta');
  btn.disabled   = true;
  btn.textContent = 'Loading…';
  meta.textContent = '';
  document.getElementById('st-list').innerHTML = '<p class="st-empty">Fetching orders and inventory…</p>';

  try {
    const since     = document.getElementById('st-since').value;
    const seasonEnd = document.getElementById('st-season-end').value;
    const minStock  = document.getElementById('st-min-stock').value || 10;
    const params    = new URLSearchParams({ min_stock: minStock });
    if (since)     params.set('since',      since);
    if (seasonEnd) params.set('season_end', seasonEnd);

    const res = await fetch(`/api/sell-through?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    reportData = await res.json();
    renderReport();
    meta.textContent = `${reportData.total_analysed} products · generated ${new Date(reportData.generated_at).toLocaleTimeString('en-AU')}`;
  } catch (e) {
    document.getElementById('st-list').innerHTML = `<p style="color:#ef4444;padding:20px">Error: ${escHtml(e.message)}</p>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '↻ Run Report';
  }
}

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.st-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === f));
  document.querySelectorAll('.st-tile').forEach(t => t.classList.toggle('active', t.id === `tile-${f}`));
  renderList();
}

function renderReport() {
  const s = reportData.summary;
  document.getElementById('sum-critical').textContent = s.critical;
  document.getElementById('sum-action').textContent   = s.action;
  document.getElementById('sum-monitor').textContent  = s.monitor;
  document.getElementById('sum-healthy').textContent  = s.healthy;
  document.getElementById('st-summary').style.display = '';
  document.getElementById('st-tabs').style.display    = '';
  activeFilter = 'all';
  document.querySelectorAll('.st-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
  document.querySelectorAll('.st-tile').forEach(t => t.classList.remove('active'));
  renderList();
}

function renderList() {
  currentProducts = (reportData?.products || []).filter(p => activeFilter === 'all' || p.tier === activeFilter);

  if (currentProducts.length === 0) {
    document.getElementById('st-list').innerHTML = '<p class="st-empty">No products in this tier.</p>';
    return;
  }
  document.getElementById('st-list').innerHTML = currentProducts.map((p, i) => cardHtml(p, i)).join('');
}

const FLAG_LABELS = {
  stale:          '⚠️ Stale',
  stalling:       '📉 Stalling',
  excess_stock:   '📦 Excess stock',
  size_imbalance: '📐 Size imbalance',
  deadline_risk:  '⏰ Deadline risk',
};
const FLAG_TIPS = {
  stale:          'Below 30% sell-through after 6+ weeks',
  stalling:       'Recent weekly sales well below the overall average — momentum is dying',
  excess_stock:   'More than 52 weeks of stock remaining at current sell rate',
  size_imbalance: 'Some sizes selling well, others barely moving — consider targeted size promotions',
  deadline_risk:  'Projected not to clear before the configured season end date',
};
const TIER_LABEL = { critical: '🔴 Critical', action: '🟠 Action', monitor: '🟡 Monitor', healthy: '🟢 Healthy' };
const TIER_SUGGESTION = {
  critical: 'Strong sale candidate — consider a 30–50% discount immediately.',
  action:   'Consider a 20–30% promotional discount to accelerate sell-through.',
  monitor:  'Monitor closely — consider a targeted promotion if the rate continues to slow.',
  healthy:  'Performing well — keep at full price.',
};

function cardHtml(p, i) {
  const imgEl = p.image
    ? `<img class="st-card-img" src="${escHtml(p.image)}" alt="" loading="lazy" />`
    : `<div class="st-card-img-ph">📦</div>`;

  const flags = (p.flags || []).map(f =>
    `<span class="st-flag" title="${escHtml(FLAG_TIPS[f] || '')}">${FLAG_LABELS[f] || f}</span>`
  ).join('');

  const clearText = p.weeks_to_clear != null
    ? `${p.weeks_to_clear} wks`
    : `<span style="color:#dc2626;font-size:0.85rem">Never</span>`;

  const barWidth = Math.min(100, Math.max(0, p.sell_through_pct));

  const suggestion = (p.tier === 'critical' || p.tier === 'action')
    ? `<div style="font-size:0.76rem;color:#64748b;margin-top:10px;font-style:italic">💡 ${escHtml(TIER_SUGGESTION[p.tier])}</div>`
    : '';

  return `
    <div class="st-card ${p.tier}">
      <div class="st-card-top">
        ${imgEl}
        <div class="st-card-info">
          <div class="st-card-title">${escHtml(p.title)}</div>
          <div class="st-card-type">${escHtml(p.product_type || '')}</div>
          <div class="st-card-badges">
            <span class="st-badge ${p.tier}">${TIER_LABEL[p.tier]}</span>
            ${flags}
          </div>
        </div>
      </div>

      <div class="st-stats">
        <div class="st-stat">
          <div class="st-stat-val ${p.tier}">${p.sell_through_pct}%</div>
          <div class="st-bar"><div class="st-bar-fill" style="width:${barWidth}%"></div></div>
          <div class="st-stat-lbl">Sell-Through</div>
        </div>
        <div class="st-stat">
          <div class="st-stat-val">${p.unitsSold}</div>
          <div class="st-stat-lbl">Units Sold</div>
        </div>
        <div class="st-stat">
          <div class="st-stat-val">${p.currentStock}</div>
          <div class="st-stat-lbl">In Stock</div>
        </div>
        <div class="st-stat">
          <div class="st-stat-val">${p.startingStock}</div>
          <div class="st-stat-lbl">Starting Stock</div>
        </div>
        <div class="st-stat">
          <div class="st-stat-val">${p.weeks_live}</div>
          <div class="st-stat-lbl">Weeks Live</div>
        </div>
        <div class="st-stat">
          <div class="st-stat-val">${p.weekly_rate}</div>
          <div class="st-stat-lbl">Units / Week</div>
        </div>
        <div class="st-stat">
          <div class="st-stat-val">${clearText}</div>
          <div class="st-stat-lbl">Weeks to Clear</div>
        </div>
      </div>

      ${suggestion}

      <button class="st-expand-btn" onclick="toggleVariants(this,${i})">
        ▸ Show variants (${p.variants.length})
      </button>
      <div class="st-var-wrap" id="vt-${i}" style="display:none"></div>
    </div>`;
}

function toggleVariants(btn, idx) {
  const el = document.getElementById(`vt-${idx}`);
  if (el.style.display === 'none') {
    el.innerHTML = variantTableHtml(currentProducts[idx].variants);
    el.style.display = '';
    btn.textContent = `▾ Hide variants (${currentProducts[idx].variants.length})`;
  } else {
    el.style.display = 'none';
    btn.textContent = `▸ Show variants (${currentProducts[idx].variants.length})`;
  }
}

function variantTableHtml(variants) {
  const sorted = [...variants].sort((a, b) => a.sell_through_pct - b.sell_through_pct);
  const rows = sorted.map(v => {
    const pct   = v.sell_through_pct;
    const color = pct >= 80 ? '#16a34a' : pct >= 50 ? '#b45309' : pct >= 30 ? '#ea580c' : '#dc2626';
    const w     = Math.min(100, Math.max(0, pct));
    return `<tr>
      <td>${escHtml(v.title)}${v.sku ? `<br><span style="font-size:0.7rem;color:#94a3b8">${escHtml(v.sku)}</span>` : ''}</td>
      <td style="text-align:right">${v.current_stock}</td>
      <td style="text-align:right">${v.units_sold}</td>
      <td style="text-align:right">${v.starting_stock}</td>
      <td style="min-width:100px">
        <span style="font-weight:700;color:${color}">${pct}%</span>
        <div class="vbar"><div class="vbar-fill" style="width:${w}%;background:${color}"></div></div>
      </td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr>
      <th>Variant</th>
      <th style="text-align:right">In Stock</th>
      <th style="text-align:right">Sold</th>
      <th style="text-align:right">Starting</th>
      <th>Sell-Through</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}
