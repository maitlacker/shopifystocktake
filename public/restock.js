'use strict';

let allProducts  = [];
let filteredProducts = [];
let activeFilter = 'all';
let activeSortField = 'default';
let expandedRows = new Set();
let globalSettings = {};
let productConfigs = {};  // productId → config row
let refreshPoller  = null;
let modalVariants  = []; // variants for the currently open modal
let allOrders      = []; // master PO list for search filtering

// ── Boot ───────────────────────────────────────────────────────────
(async function init() {
  await Promise.all([loadSettings(), loadAnalysis(), loadOrders()]);
})();

// ── Settings ───────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const r = await fetch('/api/restock/settings');
    if (!r.ok) return;
    globalSettings = await r.json();
    document.getElementById('cfg-sea').value   = globalSettings.sea_lead_days || 60;
    document.getElementById('cfg-air').value   = globalSettings.air_lead_days || 14;
    document.getElementById('cfg-cover').value = globalSettings.cover_weeks   || 8;
    document.getElementById('cfg-vel').value   = globalSettings.velocity_days || 42;
  } catch (_) {}
}

async function saveSettings() {
  const body = {
    sea_lead_days: parseInt(document.getElementById('cfg-sea').value)   || 60,
    air_lead_days: parseInt(document.getElementById('cfg-air').value)   || 14,
    cover_weeks:   parseInt(document.getElementById('cfg-cover').value) || 8,
    velocity_days: parseInt(document.getElementById('cfg-vel').value)   || 42,
  };
  try {
    const r = await fetch('/api/restock/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('Save failed');
    globalSettings = body;
    showToast('Settings saved');
  } catch (e) {
    alert('Error saving settings: ' + e.message);
  }
}

function toggleSettings() {
  document.getElementById('rs-settings-panel').classList.toggle('open');
}

// ── Analysis ───────────────────────────────────────────────────────
async function loadAnalysis() {
  try {
    const r = await fetch('/api/restock/analysis');
    if (!r.ok) return;
    const data = await r.json();
    renderAnalysis(data);
  } catch (_) {}
}

async function runAnalysis() {
  const btn = document.getElementById('rs-run-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  document.getElementById('rs-sync-info').textContent = 'Analysis running — takes ~30 seconds…';

  try {
    const kick = await fetch('/api/restock/analysis/refresh', { method: 'POST' });
    if (!kick.ok) throw new Error(`Server responded ${kick.status} — is a deploy in progress? Try again in a minute.`);

    // Poll the run status — surfaces real errors instead of a silent timeout
    const prevGenerated = window._lastGeneratedAt || '';
    let attempts = 0;
    refreshPoller = setInterval(async () => {
      attempts++;
      try {
        const sr = await fetch('/api/restock/analysis/status');
        const status = sr.ok ? await sr.json() : {};
        if (status.isRunning) {
          document.getElementById('rs-sync-info').textContent =
            `Analysis running… (${attempts * 5}s)`;
          return;
        }
        if (status.lastError) {
          clearInterval(refreshPoller);
          refreshPoller = null;
          btn.disabled = false;
          btn.textContent = 'Run Analysis';
          document.getElementById('rs-sync-info').textContent = 'Analysis failed';
          alert(`Analysis failed: ${status.lastError}`);
          return;
        }
        // Not running, no error — grab the fresh result
        const r = await fetch('/api/restock/analysis');
        if (r.ok) {
          const data = await r.json();
          if (data.generatedAt && data.generatedAt !== prevGenerated) {
            clearInterval(refreshPoller);
            refreshPoller = null;
            renderAnalysis(data);
            btn.disabled = false;
            btn.textContent = 'Run Analysis';
            document.getElementById('rs-sync-info').textContent =
              `Analysis updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
          }
        }
      } catch (_) {}
      if (attempts >= 60) { // 5-minute timeout
        clearInterval(refreshPoller);
        refreshPoller = null;
        btn.disabled = false;
        btn.textContent = 'Run Analysis';
        document.getElementById('rs-sync-info').textContent = 'Analysis timed out — try again';
      }
    }, 5000);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Run Analysis';
    alert('Error: ' + e.message);
  }
}

// Silent background refresh — no UI changes, just updates the table when done
async function silentRefreshAnalysis() {
  try {
    await fetch('/api/restock/analysis/refresh', { method: 'POST' });
    const prevGenerated = window._lastGeneratedAt || '';
    let attempts = 0;
    const poller = setInterval(async () => {
      attempts++;
      try {
        const r = await fetch('/api/restock/analysis');
        if (r.ok) {
          const data = await r.json();
          if (data.generatedAt && data.generatedAt !== prevGenerated) {
            clearInterval(poller);
            renderAnalysis(data);
            showToast('Analysis updated ✓');
          }
        }
      } catch (_) {}
      if (attempts >= 24) clearInterval(poller); // 2-min timeout
    }, 5000);
  } catch (_) {}
}

function renderAnalysis(data) {
  window._lastGeneratedAt = data.generatedAt;
  allProducts = data.products || [];
  maybeHandleAddPoParam();

  // Load product configs
  fetch('/api/restock/config')
    .then(r => r.json())
    .then(cfgs => {
      productConfigs = {};
      for (const c of cfgs) productConfigs[String(c.product_id)] = c;
      applyFilterAndRender();
    })
    .catch(() => applyFilterAndRender());

  // Sync info
  const syncEl = document.getElementById('rs-sync-info');
  if (data.generatedAt) {
    const ago = Math.round((Date.now() - new Date(data.generatedAt)) / 60000);
    syncEl.textContent = `Last analysed: ${ago < 2 ? 'just now' : ago + 'm ago'} · ${data.totalProducts || 0} products · ${data.totalOrders || 0} orders`;
  } else {
    syncEl.textContent = 'No analysis yet';
  }

  // Filter badges
  const counts = { 'AA+': 0, A: 0, B: 0, C: 0, F: 0, null: 0 };
  for (const p of allProducts) {
    const k = p.rating === null ? 'null' : (p.rating || 'null');
    counts[k] = (counts[k] || 0) + 1;
  }
  const highReturnCount = allProducts.filter(p => (p.returnRate || 0) >= 10).length;
  document.getElementById('fb-all').textContent = allProducts.length;
  document.getElementById('fb-aap').textContent = counts['AA+'];
  document.getElementById('fb-a').textContent   = counts['A'];
  document.getElementById('fb-b').textContent   = counts['B'];
  document.getElementById('fb-c').textContent   = counts['C'];
  document.getElementById('fb-f').textContent   = counts['F'];
  document.getElementById('fb-nd').textContent  = counts['null'];
  document.getElementById('fb-ret').textContent = highReturnCount;

  // Stat cards
  const airAlert  = allProducts.filter(p => p.rating && p.rating !== 'F' && p.minDaysRemaining !== null
    && p.minDaysRemaining <= p.effectiveAirLeadDays).length;
  const seaAlert  = allProducts.filter(p => p.rating && p.rating !== 'F' && p.minDaysRemaining !== null
    && p.minDaysRemaining <= p.effectiveSeaLeadDays
    && p.minDaysRemaining > p.effectiveAirLeadDays).length;
  const watching  = counts['B'] + counts['C'];
  const doNotRe   = counts['F'];

  document.getElementById('stat-air').textContent   = airAlert;
  document.getElementById('stat-sea').textContent   = seaAlert;
  document.getElementById('stat-watch').textContent = watching;
  document.getElementById('stat-f').textContent     = doNotRe;
}

function applyFilterAndRender() {
  filteredProducts = activeFilter === 'all'
    ? allProducts.slice()
    : activeFilter === 'null'
      ? allProducts.filter(p => p.rating === null)
      : activeFilter === 'highReturn'
        ? allProducts.filter(p => (p.returnRate || 0) >= 10)
        : allProducts.filter(p => p.rating === activeFilter);

  if (activeSortField === 'velocity') {
    filteredProducts.sort((a, b) => (b.avgDailyVel || 0) - (a.avgDailyVel || 0));
  }

  renderProductTable();
}

function setFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll('.rs-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  expandedRows.clear();
  applyFilterAndRender();
}

function setSort(val) {
  activeSortField = val;
  applyFilterAndRender();
}

// ── Product table rendering ────────────────────────────────────────
function renderProductTable() {
  const tbody = document.getElementById('rs-product-body');

  if (!filteredProducts.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="rs-empty">No products match this filter</td></tr>`;
    return;
  }

  const rows = [];
  for (const p of filteredProducts) {
    const isExpanded = expandedRows.has(p.productId);
    rows.push(productRow(p, isExpanded));
    rows.push(expandRow(p, isExpanded));
  }
  tbody.innerHTML = rows.join('');
}

function ratingClass(r) {
  if (!r) return 'none';
  return { 'AA+': 'aap', A: 'a', B: 'b', C: 'c', F: 'f' }[r] || 'none';
}

function ratingLabel(r) {
  if (!r) return '—';
  const emojis = { 'AA+': '🚀', A: '✅', B: '📊', C: '⚠️', F: '⛔' };
  return (emojis[r] || '') + ' ' + r;
}

function trendArrow(ratio) {
  if (ratio === null || ratio === undefined) return '—';
  if (ratio >= 1.4) return '↑↑';
  if (ratio >= 1.1) return '↑';
  if (ratio >= 0.9) return '→';
  if (ratio >= 0.6) return '↓';
  return '↓↓';
}

function daysClass(days, p) {
  if (days === null) return 'grey';
  if (days <= p.effectiveAirLeadDays)                           return 'red';
  if (days <= p.effectiveSeaLeadDays)                           return 'orange';
  if (days <= p.effectiveSeaLeadDays * 1.5)                     return 'amber';
  return 'green';
}

function alertBadge(sent, label) {
  if (sent === null) return `<span class="rs-alert-badge na">—</span>`;
  return sent
    ? `<span class="rs-alert-badge sent">✓ Sent</span>`
    : `<span class="rs-alert-badge unsent">${label}</span>`;
}

function returnRateCell(rate, returnedUnits) {
  if (returnedUnits === undefined || returnedUnits === 0) {
    return `<span class="rs-return none">—</span>`;
  }
  const cls = rate >= 20 ? 'high' : rate >= 10 ? 'medium' : 'low';
  return `<span class="rs-return ${cls}" title="${returnedUnits} unit${returnedUnits !== 1 ? 's' : ''} returned">${rate}%</span>`;
}

function thumb(src) {
  if (!src) return `<span class="rs-thumb-placeholder"></span>`;
  const small = src.replace(/(\.[a-z]+)(\?.*)?$/i, `_40x40_crop_center$1$2`);
  return `<img class="rs-thumb" src="${small}" onerror="this.style.display='none'" />`;
}

function productRow(p, expanded) {
  const seaBadge = (p.rating === 'F' || p.rating === null) ? alertBadge(null, '')
    : alertBadge(p.seaAlertSent, 'Pending');
  const airBadge = (p.rating === 'F' || p.rating === null) ? alertBadge(null, '')
    : alertBadge(p.airAlertSent, 'Pending');

  const daysStr = p.minDaysRemaining !== null
    ? `<span class="rs-days ${daysClass(p.minDaysRemaining, p)}">${p.minDaysRemaining}d</span>`
    : `<span class="rs-days grey">—</span>`;

  const incomingStr = p.incomingOrders.length
    ? `<span style="color:#4f46e5;font-weight:700">${p.incomingOrders.reduce((s,o)=>s+o.totalQty,0)} units</span>` +
      (p.incomingOrders.length > 1
        ? `<span style="color:#64748b;font-size:0.76rem"> · ${p.incomingOrders.length} deliveries</span>` : '') +
      ((p.recentlyReceived || []).length ? ' <span title="PO received in the last 7 days — check stock updated">✅</span>' : '')
    : ((p.recentlyReceived || []).length
        ? '<span title="PO received in the last 7 days — check stock updated">✅ received</span>'
        : '<span style="color:#cbd5e1">none</span>');

  const adjVel = p.adjustedDailyVel || 0;
  const adjLift = adjVel - (p.avgDailyVel || 0);
  const oosCount = (p.variants || []).filter(v => v.isOos).length;
  const adjVelStr = adjLift > 0.05
    ? `<span class="rs-vel" style="color:#d97706" title="${oosCount} OOS size${oosCount !== 1 ? 's' : ''} add ${adjLift.toFixed(2)}/day of suppressed demand">${adjVel.toFixed(2)}</span>`
    : `<span style="color:#cbd5e1;font-size:0.82rem">—</span>`;

  const cfg = productConfigs[String(p.productId)] || {};
  const disabledNote = cfg.restock_enabled === false
    ? ' <span style="font-size:0.7rem;color:#dc2626;font-weight:700">[disabled]</span>' : '';
  const finalSaleNote = p.isFinalSale
    ? ' <span style="font-size:0.7rem;font-weight:700;background:#fef9c3;color:#713f12;border:1px solid #fde68a;padding:1px 6px;border-radius:10px;margin-left:4px">Final Sale</span>' : '';

  return `<tr class="rs-row${expanded ? ' expanded' : ''}${p.isFinalSale ? ' rs-row-finalsale' : ''}" onclick="toggleExpand(${p.productId})" data-pid="${p.productId}">
    <td>
      ${thumb(p.image)}${escHtml(p.title)}${disabledNote}${finalSaleNote}
    </td>
    <td><span class="rs-rating ${ratingClass(p.rating)}">${ratingLabel(p.rating)}</span></td>
    <td>
      <span class="rs-vel">${p.avgDailyVel.toFixed(2)}</span>
      <span class="rs-trend">${trendArrow(p.trendRatio)}</span>
    </td>
    <td>${returnRateCell(p.returnRate || 0, p.totalReturnedUnits || 0)}</td>
    <td>${daysStr}${p.criticalVariant ? `<div style="font-size:0.7rem;color:#94a3b8">${escHtml(p.criticalVariant)}</div>` : ''}</td>
    <td>${incomingStr}</td>
    <td>${adjVelStr}</td>
    <td>${seaBadge}</td>
    <td>${airBadge}</td>
    <td style="text-align:center;color:#94a3b8;font-size:0.9rem">${expanded ? '▲' : '▼'}</td>
  </tr>`;
}

function expandRow(p, expanded) {
  const cfg = productConfigs[String(p.productId)] || {};

  // Size breakdown table
  const varRows = p.variants.map(v => {
    const seaStr = v.suggestedSeaQty > 0
      ? `<span class="rs-suggest">${v.suggestedSeaQty}</span>`
      : `<span class="rs-suggest zero">covered</span>`;
    const airStr = v.suggestedAirQty > 0
      ? `<span class="rs-suggest">${v.suggestedAirQty}</span>`
      : `<span class="rs-suggest zero">covered</span>`;
    const dStr = v.effectiveDaysRemaining !== null ? v.effectiveDaysRemaining + 'd' : '—';

    // OOS: show the frozen demand velocity (last known rate before selling out).
    // recentDailyVel is 0 only because there's no stock — not because demand stopped.
    const velDisplay = v.isOos
      ? `${v.demandDailyVel.toFixed(3)} <span style="background:#fef3c7;color:#92400e;font-size:0.68rem;font-weight:700;padding:1px 5px;border-radius:4px;margin-left:3px"
               title="Out of stock — velocity frozen at last known selling rate">OOS</span>`
      : v.recentDailyVel.toFixed(3);

    const retStr = (v.returnedUnits > 0)
      ? `<span style="font-size:0.78rem;font-weight:700;color:${v.returnRate >= 20 ? '#b91c1c' : v.returnRate >= 10 ? '#c2410c' : '#a16207'}"
              title="${v.returnedUnits} unit${v.returnedUnits !== 1 ? 's' : ''} returned">${v.returnRate}%</span>`
      : `<span style="color:#cbd5e1;font-size:0.78rem">—</span>`;

    const soldQty = v.soldRecent + v.soldOlder;
    const stBase  = soldQty + v.inventory;
    const sellThrough = stBase > 0 ? Math.round(soldQty / stBase * 100) : null;
    const stColor = sellThrough === null ? '#94a3b8'
      : sellThrough >= 80 ? '#dc2626'
      : sellThrough >= 50 ? '#d97706'
      : '#059669';
    const stStr = sellThrough !== null
      ? `<span style="font-weight:600;color:${stColor}" title="${soldQty} sold / ${stBase} observable">${sellThrough}%</span>`
      : `<span style="color:#cbd5e1">—</span>`;

    return `<tr${v.isOos ? ' style="opacity:0.8"' : ''}>
      <td>${escHtml(v.title)}</td>
      <td>${v.inventory}</td>
      <td style="font-variant-numeric:tabular-nums">${soldQty > 0 ? soldQty : '—'}</td>
      <td>${stStr}</td>
      <td>${v.incomingQty > 0 ? '+' + v.incomingQty : '—'}</td>
      <td>${velDisplay}</td>
      <td>${retStr}</td>
      <td>${dStr}</td>
      <td>${seaStr}</td>
      <td>${airStr}</td>
    </tr>`;
  }).join('');

  const hasOos = p.variants.some(v => v.isOos);
  const oosNote = hasOos
    ? `<div style="font-size:0.75rem;color:#92400e;background:#fef3c7;border:1px solid #fde68a;
         border-radius:6px;padding:6px 10px;margin-bottom:10px">
         ⚠️ <strong>OOS</strong> — one or more sizes are out of stock. Velocity shows the frozen last-known selling rate, not zero.
         Sell-through is 100% for OOS sizes. Suggestions use the frozen rate as the demand basis.
       </div>`
    : '';

  const sizeTable = `
    ${oosNote}
    <table class="rs-size-table">
      <thead><tr>
        <th>Size</th><th>Stock</th><th>Sold (42d)</th><th>ST%</th><th>Incoming</th>
        <th>Vel/day</th><th>Returns</th><th>Runway</th>
        <th>🚢 Suggest</th><th>✈️ Suggest</th>
      </tr></thead>
      <tbody>${varRows}</tbody>
    </table>`;

  // Incoming PO summary
  // Incoming deliveries — one line each, earliest first
  const sortedIncoming = [...p.incomingOrders].sort((a, b) =>
    String(a.expectedDelivery).localeCompare(String(b.expectedDelivery)));
  const incomingLines = sortedIncoming.map((o, idx) => {
    const due = String(o.expectedDelivery).slice(0,10) + (o.estimatedDelivery ? ' (est.)' : '');
    const nth = sortedIncoming.length > 1
      ? `<span style="color:#94a3b8;font-size:0.72rem;font-weight:700;margin-right:6px">#${idx + 1}</span>` : '';
    const core = `${nth}<span style="color:#4f46e5">📦 <strong>${o.freightMode.toUpperCase()}</strong> · <strong>${o.totalQty}</strong> units · due ${due}</span>`;
    if (o.source === 'production_order') {
      return `<div style="padding:2px 0">${core}
        <a href="/production-order.html?id=${o.poId}" onclick="event.stopPropagation()"
           style="margin-left:6px;color:#15803d;background:#dcfce7;border-radius:99px;padding:1px 8px;font-size:0.72rem;font-weight:700;text-decoration:none">PO ${escHtml(String(o.poNumber || ''))}</a></div>`;
    }
    return `<div style="padding:2px 0">${core}
      <button onclick="deleteOrder(${o.orderId});event.stopPropagation()" title="Delete this order"
         style="margin-left:8px;background:none;border:none;color:#ef4444;font-size:0.8rem;cursor:pointer;padding:0 4px;font-weight:700">✕</button></div>`;
  });

  // Recently received POs — expect a Shopify stock increase of ~totalQty
  const receivedLines = (p.recentlyReceived || []).map(r =>
    `<div style="padding:2px 0;color:#15803d">✅ PO
      <a href="/production-order.html?id=${r.poId}" onclick="event.stopPropagation()"
         style="color:#15803d;font-weight:700">${escHtml(String(r.poNumber || ''))}</a>
      received ${String(r.receivedAt).slice(0,10)} — expect Shopify stock <strong>+${r.totalQty}</strong> units (verify updated)</div>`);

  const incomingHtml = (incomingLines.length || receivedLines.length)
    ? `<div style="font-size:0.82rem;margin-bottom:10px">${incomingLines.join('')}${receivedLines.join('')}</div>`
    : '';

  // Config override form
  const seaVal   = cfg.sea_lead_days || '';
  const airVal   = cfg.air_lead_days || '';
  const covVal   = cfg.cover_weeks   || '';
  const enabled  = cfg.restock_enabled !== false;

  const configForm = `
    <div class="rs-config-row">
      <div class="rs-field" style="max-width:130px">
        <label>Sea lead (days)</label>
        <input type="number" id="oc-sea-${p.productId}" value="${seaVal}" placeholder="${p.effectiveSeaLeadDays} (global)" min="1" max="365" />
      </div>
      <div class="rs-field" style="max-width:130px">
        <label>Air lead (days)</label>
        <input type="number" id="oc-air-${p.productId}" value="${airVal}" placeholder="${p.effectiveAirLeadDays} (global)" min="1" max="90" />
      </div>
      <div class="rs-field" style="max-width:130px">
        <label>Cover (weeks)</label>
        <input type="number" id="oc-cov-${p.productId}" value="${covVal}" placeholder="${p.effectiveCoverWeeks} (global)" min="1" max="52" />
      </div>
      <div class="rs-toggle-wrap" style="padding-bottom:2px">
        <input type="checkbox" id="oc-en-${p.productId}" ${enabled ? 'checked' : ''} />
        <label for="oc-en-${p.productId}">Restock enabled</label>
      </div>
      <button class="btn btn-secondary" style="padding:8px 16px;font-size:0.82rem"
        onclick="saveProductConfig(${p.productId},'${escHtml(p.title).replace(/'/g,"\\'")}',event)">
        Save Overrides
      </button>
    </div>`;

  const buffer   = p.velocityBuffer || 1.0;
  const seaTotal = p.variants.reduce((s, v) => s + Math.ceil((v.suggestedSeaQty || 0) * buffer), 0);
  const airTotal = p.variants.reduce((s, v) => s + Math.ceil((v.suggestedAirQty || 0) * buffer), 0);
  const inBasket = poBasket.some(b => b.productId === p.productId);
  const logBtn = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" style="padding:9px 20px;font-size:0.85rem"
        onclick="addToBasket(${p.productId},'sea',event)">🛒 Add to PO — 🚢 Sea qtys (${seaTotal})</button>
      <button class="btn btn-secondary" style="padding:9px 20px;font-size:0.85rem"
        onclick="addToBasket(${p.productId},'air',event)">🛒 Add to PO — ✈️ Air qtys (${airTotal})</button>
      ${inBasket ? '<span style="color:#15803d;font-weight:800;font-size:0.82rem">✓ in basket</span>' : ''}
    </div>`;

  return `<tr class="rs-expand${expanded ? ' open' : ''}" id="expand-${p.productId}">
    <td colspan="9">
      <div class="rs-expand-inner">
        ${incomingHtml}
        ${sizeTable}
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
          ${logBtn}
        </div>
        ${configForm}
      </div>
    </td>
  </tr>`;
}

function toggleExpand(productId) {
  if (expandedRows.has(productId)) {
    expandedRows.delete(productId);
  } else {
    expandedRows.add(productId);
  }
  applyFilterAndRender();
}

// ── Per-product config save ────────────────────────────────────────
async function saveProductConfig(productId, productTitle, e) {
  e.stopPropagation();
  const body = {
    productTitle,
    seaLeadDays:    parseInt(document.getElementById(`oc-sea-${productId}`).value)  || null,
    airLeadDays:    parseInt(document.getElementById(`oc-air-${productId}`).value)  || null,
    coverWeeks:     parseInt(document.getElementById(`oc-cov-${productId}`).value)  || null,
    restockEnabled: document.getElementById(`oc-en-${productId}`).checked,
  };
  try {
    await fetch(`/api/restock/config/${productId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    productConfigs[String(productId)] = { product_id: productId, ...body,
      sea_lead_days: body.seaLeadDays, air_lead_days: body.airLeadDays,
      cover_weeks: body.coverWeeks, restock_enabled: body.restockEnabled };
    showToast('Overrides saved');
    applyFilterAndRender();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Purchase orders ────────────────────────────────────────────────
async function loadOrders() {
  try {
    const r = await fetch('/api/restock/orders');
    if (!r.ok) return;
    allOrders = await r.json();
    filterOrders();
  } catch (_) {}
}

function filterOrders() {
  const q = (document.getElementById('po-search')?.value || '').toLowerCase().trim();
  const visible = q
    ? allOrders.filter(o =>
        (o.product_title || '').toLowerCase().includes(q) ||
        (o.status        || '').toLowerCase().includes(q) ||
        (o.freight_mode  || '').toLowerCase().includes(q) ||
        (o.notes         || '').toLowerCase().includes(q)
      )
    : allOrders;
  renderOrders(visible);
}

function renderOrders(orders) {
  const tbody = document.getElementById('rs-orders-body');
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="rs-empty" style="padding:24px">No purchase orders yet</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map(o => {
    const due      = o.expected_delivery ? String(o.expected_delivery).slice(0, 10) : '—';
    const ordered  = o.ordered_at        ? String(o.ordered_at).slice(0, 10) : '—';
    const daysUntil = o.expected_delivery
      ? Math.round((new Date(due) - Date.now()) / 86400000)
      : null;
    const dueStr   = daysUntil !== null
      ? `${due} <span class="${daysUntil <= 7 ? 'rs-delivery-soon' : ''}">(${daysUntil > 0 ? daysUntil + 'd' : 'today/overdue'})</span>`
      : '—';
    const qbv = o.qty_by_variant || {};
    const sizeSummary = Object.entries(qbv)
      .filter(([, q]) => q > 0)
      .map(([s, q]) => `${s}×${q}`)
      .join(', ') || '—';

    const isPending = o.status === 'pending';
    const actions = isPending
      ? `<button class="btn btn-secondary" style="padding:5px 10px;font-size:0.75rem;margin-right:4px"
           onclick="markOrderReceived(${o.id})">Mark Received</button>
         <button class="btn" style="padding:5px 10px;font-size:0.75rem;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;margin-right:4px"
           onclick="cancelOrder(${o.id})">Cancel</button>
         <button class="btn" style="padding:5px 10px;font-size:0.75rem;background:#fef2f2;color:#991b1b;border:1px solid #fca5a5"
           onclick="deleteOrder(${o.id})" title="Permanently delete this order">🗑</button>`
      : `<button class="btn" style="padding:5px 10px;font-size:0.75rem;background:#fef2f2;color:#991b1b;border:1px solid #fca5a5"
           onclick="deleteOrder(${o.id})" title="Permanently delete this order">🗑</button>`;

    return `<tr>
      <td><strong>${escHtml(o.product_title)}</strong></td>
      <td><span class="rs-freight-badge ${o.freight_mode}">${o.freight_mode === 'sea' ? '🚢 Sea' : '✈️ Air'}</span></td>
      <td>${ordered}</td>
      <td>${dueStr}</td>
      <td style="font-weight:700">${o.total_qty}</td>
      <td style="font-size:0.78rem;color:#64748b">${sizeSummary}</td>
      <td><span class="rs-status-badge ${o.status}">${o.status}</span></td>
      <td style="font-size:0.78rem;color:#64748b;max-width:120px;word-break:break-word">${escHtml(o.notes || '')}</td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }).join('');
}

async function markOrderReceived(id) {
  if (!confirm('Mark this order as received? This will reset the alert log for this product so future alerts can fire again.')) return;
  try {
    const res = await fetch(`/api/restock/orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'received' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Update failed');
    }
    loadOrders();
    showToast('Order marked received — alert log cleared');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function cancelOrder(id) {
  if (!confirm('Cancel this restock order?')) return;
  try {
    const res = await fetch(`/api/restock/orders/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Update failed');
    }
    loadOrders();
    showToast('Order cancelled');
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteOrder(id) {
  if (!confirm('Permanently delete this restock order? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/restock/orders/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Delete failed');
    }
    loadOrders();
    showToast('Order deleted — refreshing analysis…');
    silentRefreshAnalysis();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Log Order modal ────────────────────────────────────────────────
function openModal(productId, e) {
  if (e) e.stopPropagation();

  const product = allProducts.find(p => p.productId === productId);
  if (!product) return;

  document.getElementById('modal-product-id').value   = productId;
  document.getElementById('modal-product-name').value = product.title;

  // Default ordered date = today
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('modal-ordered').value = today;
  document.getElementById('modal-mode').value    = 'sea';
  document.getElementById('modal-notes').value   = '';
  updateModalDelivery();

  // Build size inputs
  modalVariants = product.variants;
  const sizesList = document.getElementById('modal-sizes-list');
  sizesList.innerHTML = product.variants.map(v => `
    <div class="rs-modal-size-row">
      <label>${escHtml(v.title)}</label>
      <input type="number" id="mq-${v.id}" min="0" value="${v.suggestedSeaQty || 0}"
        oninput="updateModalTotal()" placeholder="0" />
      <span class="rs-suggest-hint">suggest: ${v.suggestedSeaQty || 0}</span>
    </div>
  `).join('');
  updateModalTotal();

  document.getElementById('rs-modal').classList.add('open');
}

function updateModalDelivery() {
  const mode    = document.getElementById('modal-mode').value;
  const ordered = document.getElementById('modal-ordered').value;
  if (!ordered) return;
  const leadDays = mode === 'sea'
    ? (globalSettings.sea_lead_days || 60)
    : (globalSettings.air_lead_days || 14);
  const delivery = new Date(ordered);
  delivery.setDate(delivery.getDate() + leadDays);
  document.getElementById('modal-delivery').value = delivery.toISOString().slice(0, 10);

  // Update suggested hints
  const product = allProducts.find(p => p.productId === parseInt(document.getElementById('modal-product-id').value));
  if (product) {
    product.variants.forEach(v => {
      const hint = document.querySelector(`#mq-${v.id}`)?.parentElement?.querySelector('.rs-suggest-hint');
      if (hint) {
        const sug = mode === 'sea' ? v.suggestedSeaQty : v.suggestedAirQty;
        hint.textContent = `suggest: ${sug || 0}`;
      }
    });
  }
}

function updateModalTotal() {
  const total = modalVariants.reduce((s, v) => {
    return s + (parseInt(document.getElementById('mq-' + v.id)?.value) || 0);
  }, 0);
  document.getElementById('rs-total-display').textContent = `Total: ${total} units`;
}

function closeModal() {
  document.getElementById('rs-modal').classList.remove('open');
}

async function submitOrder() {
  const productId   = parseInt(document.getElementById('modal-product-id').value);
  const productTitle = document.getElementById('modal-product-name').value;
  const freightMode  = document.getElementById('modal-mode').value;
  const orderedAt    = document.getElementById('modal-ordered').value;
  const expectedDelivery = document.getElementById('modal-delivery').value;
  const notes        = document.getElementById('modal-notes').value.trim();

  if (!orderedAt || !expectedDelivery) { alert('Please fill in the order dates.'); return; }

  const qtyByVariant = {};
  let totalQty = 0;
  for (const v of modalVariants) {
    const q = parseInt(document.getElementById('mq-' + v.id)?.value) || 0;
    if (q > 0) { qtyByVariant[v.title] = q; totalQty += q; }
  }
  if (totalQty === 0) { alert('Please enter at least one quantity.'); return; }

  try {
    const res = await fetch('/api/restock/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, productTitle, freightMode, orderedAt,
        expectedDelivery, qtyByVariant, totalQty, notes: notes || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Save failed');
    }
    closeModal();
    loadOrders();
    showToast('Restock order logged ✓ — refreshing analysis…');
    silentRefreshAnalysis();
  } catch (err) {
    alert('Error saving order: ' + err.message);
  }
}

// Close modal on overlay click
document.getElementById('rs-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// ── PO Basket — planner → draft Production Orders ──────────────────
let poBasket = [];
try { poBasket = JSON.parse(localStorage.getItem('rs-po-basket') || '[]'); } catch (_) { poBasket = []; }

function saveBasket() {
  try { localStorage.setItem('rs-po-basket', JSON.stringify(poBasket)); } catch (_) {}
  renderBasketBar();
}

function addToBasket(productId, mode, e) {
  if (e) e.stopPropagation();
  const p = allProducts.find(x => x.productId === productId);
  if (!p) return;
  const buffer = p.velocityBuffer || 1.0;
  const sugKey = mode === 'air' ? 'suggestedAirQty' : 'suggestedSeaQty';
  const qtyByVariant = {};
  let total = 0;
  for (const v of p.variants) {
    const q = Math.ceil((v[sugKey] || 0) * buffer);
    if (q > 0) { qtyByVariant[v.title] = q; total += q; }
  }
  if (!total) { showToast('Fully covered — nothing suggested for this freight mode'); return; }
  poBasket = poBasket.filter(b => b.productId !== productId); // replace if re-added
  poBasket.push({
    productId, title: p.title, image: p.image || null,
    supplierName: p.supplierName || null,
    freightMode: mode, qtyByVariant, totalQty: total,
  });
  saveBasket();
  showToast(`${p.title} added to PO basket (${total} units, ${mode})`);
  applyFilterAndRender();
}

function removeFromBasket(productId) {
  poBasket = poBasket.filter(b => b.productId !== productId);
  saveBasket();
  renderBasketModal();
  applyFilterAndRender();
}

function clearBasket() {
  poBasket = [];
  saveBasket();
  closeBasketModal();
  applyFilterAndRender();
}

function renderBasketBar() {
  let bar = document.getElementById('rs-basket-bar');
  if (!poBasket.length) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'rs-basket-bar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:900;background:#1e293b;' +
      'color:#fff;display:flex;align-items:center;gap:14px;padding:12px 22px;flex-wrap:wrap;' +
      'box-shadow:0 -4px 16px rgba(0,0,0,0.25)';
    document.body.appendChild(bar);
  }
  const units = poBasket.reduce((s, b) => s + b.totalQty, 0);
  const suppliers = new Set(poBasket.map(b => b.supplierName || '(no supplier yet)'));
  bar.innerHTML = `
    <span style="font-weight:800">🛒 PO Basket</span>
    <span style="font-size:0.88rem">${poBasket.length} style${poBasket.length !== 1 ? 's' : ''} · ${units} units · ${suppliers.size} supplier${suppliers.size !== 1 ? 's' : ''}</span>
    <button onclick="openBasketModal()" style="margin-left:auto;background:#6366f1;border:none;color:#fff;font-weight:800;padding:9px 20px;border-radius:10px;cursor:pointer;font-size:0.88rem">Review &amp; Create POs</button>
    <button onclick="clearBasket()" style="background:none;border:1.5px solid #475569;color:#cbd5e1;font-weight:700;padding:8px 14px;border-radius:10px;cursor:pointer;font-size:0.82rem">Clear</button>`;
}

function openBasketModal() {
  let overlay = document.getElementById('rs-basket-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'rs-basket-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:1000;' +
      'display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBasketModal(); });
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  renderBasketModal();
}

function closeBasketModal() {
  const overlay = document.getElementById('rs-basket-modal');
  if (overlay) overlay.style.display = 'none';
}

function renderBasketModal() {
  const overlay = document.getElementById('rs-basket-modal');
  if (!overlay) return;
  if (!poBasket.length) { closeBasketModal(); return; }

  // Group preview by supplier + freight (mirrors how POs will be created)
  const groups = {};
  for (const b of poBasket) {
    const key = `${b.supplierName || '(no supplier — set on draft)'}|${b.freightMode}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(b);
  }

  const itemHtml = (b) => {
    const sizeInputs = Object.entries(b.qtyByVariant).map(([size, q]) => `
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:0.78rem;color:#475569;margin:2px 6px 2px 0">
        ${escHtml(size)}
        <input type="number" min="0" value="${q}" data-bpid="${b.productId}" data-bsize="${escHtml(size)}"
          oninput="updateBasketQty(this)"
          style="width:58px;padding:4px 6px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.8rem" />
      </label>`).join('');
    return `
      <div style="border:1.5px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:8px;background:#fff">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <strong style="color:#1e293b">${escHtml(b.title)}</strong>
          <span style="font-size:0.74rem;font-weight:700;color:${b.freightMode === 'air' ? '#7c3aed' : '#0369a1'}">${b.freightMode === 'air' ? '✈️ AIR' : '🚢 SEA'}</span>
          <span style="font-size:0.8rem;color:#64748b" id="btot-${b.productId}">${b.totalQty} units</span>
          <button onclick="removeFromBasket(${b.productId})"
            style="margin-left:auto;background:none;border:none;color:#ef4444;font-weight:800;cursor:pointer;font-size:0.9rem">✕</button>
        </div>
        <div style="margin-top:6px">${sizeInputs}</div>
      </div>`;
  };

  const groupsHtml = Object.entries(groups).map(([key, items]) => {
    const [supplier, mode] = key.split('|');
    return `
      <div style="margin-bottom:14px">
        <div style="font-size:0.76rem;font-weight:800;color:#6366f1;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">
          → Draft PO: ${escHtml(supplier)} · ${mode.toUpperCase()}</div>
        ${items.map(itemHtml).join('')}
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div style="background:#f8fafc;border-radius:16px;max-width:680px;width:100%;max-height:85vh;overflow-y:auto;padding:22px" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:6px">
        <h2 style="margin:0;font-size:1.1rem;color:#1e293b">Review &amp; Create Draft POs</h2>
        <button onclick="closeBasketModal()" style="margin-left:auto;background:none;border:none;font-size:1.3rem;color:#64748b;cursor:pointer">✕</button>
      </div>
      <p style="font-size:0.8rem;color:#64748b;margin:0 0 14px">One draft Production Order is created per supplier + freight group below —
        pre-filled with supplier, currency, FX, delivery date from lead times, and last-paid unit prices. Adjust quantities here or on the draft.</p>
      <div id="rs-basket-items">${groupsHtml}</div>
      <div id="rs-basket-result"></div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <button id="rs-create-pos-btn" onclick="createPosFromBasket()"
          style="background:#6366f1;border:none;color:#fff;font-weight:800;padding:11px 24px;border-radius:10px;cursor:pointer;font-size:0.9rem">Create Draft PO${Object.keys(groups).length !== 1 ? 's' : ''} (${Object.keys(groups).length})</button>
        <button onclick="closeBasketModal()" style="background:#fff;border:1.5px solid #e2e8f0;color:#475569;font-weight:700;padding:11px 20px;border-radius:10px;cursor:pointer;font-size:0.88rem">Keep Shopping</button>
      </div>
    </div>`;
}

function updateBasketQty(input) {
  const pid  = Number(input.dataset.bpid);
  const size = input.dataset.bsize;
  const b = poBasket.find(x => x.productId === pid);
  if (!b) return;
  const q = parseInt(input.value) || 0;
  if (q > 0) b.qtyByVariant[size] = q; else delete b.qtyByVariant[size];
  b.totalQty = Object.values(b.qtyByVariant).reduce((s, n) => s + n, 0);
  const totEl = document.getElementById(`btot-${pid}`);
  if (totEl) totEl.textContent = `${b.totalQty} units`;
  saveBasket();
}

async function createPosFromBasket() {
  const btn = document.getElementById('rs-create-pos-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const items = poBasket.filter(b => b.totalQty > 0).map(b => ({
      productId: b.productId, title: b.title,
      freightMode: b.freightMode, qtyByVariant: b.qtyByVariant,
    }));
    const r = await fetch('/api/restock/create-pos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    poBasket = [];
    saveBasket();
    const resultEl = document.getElementById('rs-basket-result');
    document.getElementById('rs-basket-items').innerHTML = '';
    btn.style.display = 'none';
    resultEl.innerHTML = `
      <div style="background:#dcfce7;border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="font-weight:800;color:#166534;margin-bottom:8px">✓ ${data.created.length} draft PO${data.created.length !== 1 ? 's' : ''} created — open to review &amp; confirm:</div>
        ${data.created.map(po => `
          <div style="padding:3px 0"><a href="/production-order.html?id=${po.id}" target="_blank"
            style="color:#166534;font-weight:800;text-decoration:underline">PO ${escHtml(po.po_number)}</a>
            <span style="font-size:0.82rem;color:#15803d"> — ${escHtml(po.supplier_name)} · ${po.freight_mode.toUpperCase()} · ${po.line_count} style${po.line_count !== 1 ? 's' : ''} · ${po.total_qty} units</span></div>`).join('')}
      </div>
      ${(data.warnings || []).length ? `
        <div style="background:#fef3c7;border-radius:10px;padding:10px 14px;font-size:0.8rem;color:#92400e">
          ${data.warnings.map(w => '⚠ ' + escHtml(w)).join('<br/>')}</div>` : ''}`;
    applyFilterAndRender();
  } catch (err) {
    alert('Failed to create POs: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Create Draft POs';
  }
}

// Slack deep-link: restock.html?addpo=<productId> pre-adds that product
let addPoParamHandled = false;
function maybeHandleAddPoParam() {
  if (addPoParamHandled) return;
  const pid = Number(new URLSearchParams(window.location.search).get('addpo'));
  if (!pid || !allProducts.length) return;
  addPoParamHandled = true;
  if (!poBasket.some(b => b.productId === pid)) addToBasket(pid, 'sea');
  const p = allProducts.find(x => x.productId === pid);
  if (p) { expandedRows.add(pid); applyFilterAndRender(); }
}

renderBasketBar();

// ── Helpers ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let toastTimer;
function showToast(msg) {
  let el = document.getElementById('rs-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rs-toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:#1a1a2e;color:#fff;padding:10px 22px;border-radius:24px;font-size:0.88rem;' +
      'font-weight:600;z-index:9999;pointer-events:none;transition:opacity 0.3s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}
