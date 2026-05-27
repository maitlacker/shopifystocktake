'use strict';

// ── Boot ──────────────────────────────────────────────────────────
(function init() {
  // Default to previous month
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yyyy = prev.getFullYear();
  const mm   = String(prev.getMonth() + 1).padStart(2, '0');
  document.getElementById('monthPicker').value = `${yyyy}-${mm}`;
})();

// ── Product taxability scan ───────────────────────────────────────
async function runTaxScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';

  document.getElementById('scanArea').innerHTML = `
    <div class="rec-loading">
      <div class="rec-spinner"></div>
      <span>Scanning all active products for tax settings… this may take 10–20 seconds.</span>
    </div>`;

  try {
    const r = await fetch('/api/reconcile/taxability-scan');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    renderTaxScan(d);
  } catch (err) {
    document.getElementById('scanArea').innerHTML = `
      <div class="rec-callout red"><strong>Error:</strong> ${escHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-scan Products';
  }
}

function renderTaxScan(d) {
  const hasIssues = d.nonTaxableProductCount > 0;

  const statsHtml = `
    <div class="rec-scan-stats">
      <div class="rec-scan-stat">
        <div class="rec-scan-stat-val" style="color:#1e293b;">${d.scannedProducts}</div>
        <div class="rec-scan-stat-lbl">Products scanned</div>
      </div>
      <div class="rec-scan-stat">
        <div class="rec-scan-stat-val" style="color:#1e293b;">${d.scannedVariants}</div>
        <div class="rec-scan-stat-lbl">Variants checked</div>
      </div>
      <div class="rec-scan-stat">
        <div class="rec-scan-stat-val ${hasIssues ? 'bad' : 'ok'}">${d.nonTaxableProductCount}</div>
        <div class="rec-scan-stat-lbl">Products with tax off</div>
      </div>
      <div class="rec-scan-stat">
        <div class="rec-scan-stat-val ${hasIssues ? 'bad' : 'ok'}">${d.nonTaxableVariantCount}</div>
        <div class="rec-scan-stat-lbl">Variants with tax off</div>
      </div>
    </div>`;

  if (!hasIssues) {
    document.getElementById('scanArea').innerHTML = statsHtml + `
      <div class="rec-callout green">
        ✅ <strong>All clear.</strong> Every active product variant has tax enabled — no taxability issues found.
      </div>`;
    return;
  }

  const productRowsHtml = d.products.map(p => {
    const countLabel = p.allAffected
      ? `All ${p.affectedCount} variants`
      : `${p.affectedCount} of ${p.totalVariants} variants`;
    const countClass = p.allAffected ? 'rec-prod-count all' : 'rec-prod-count';

    // Build variant chips — show option labels if available, fall back to SKU
    const variantChips = p.variants.map(v => {
      const opts = [v.option1, v.option2, v.option3].filter(Boolean).join(' / ');
      const label = opts || v.sku;
      const price = v.price ? ` · $${v.price}` : '';
      return `<span class="rec-sku-chip" title="SKU: ${escHtml(v.sku)}">${escHtml(label)}${escHtml(price)}</span>`;
    }).join('');

    const shopifyUrl = `https://${window.location.hostname.includes('localhost') ? 'admin.shopify.com/store' : 'admin.shopify.com/store'}/products/${p.id}`;

    return `<div class="rec-prod-row">
      <div>
        <div class="rec-prod-title">
          <a href="https://admin.shopify.com/store/theselfstyler/products/${escHtml(p.id)}"
             target="_blank" rel="noopener"
             style="color:inherit; text-decoration:none;"
             onmouseover="this.style.textDecoration='underline'"
             onmouseout="this.style.textDecoration='none'">
            ${escHtml(p.title)}
          </a>
        </div>
        ${p.productType ? `<div class="rec-prod-type">${escHtml(p.productType)}</div>` : ''}
        <div class="rec-prod-variants">${variantChips}</div>
      </div>
      <div class="${countClass}">${escHtml(countLabel)}</div>
    </div>`;
  }).join('');

  document.getElementById('scanArea').innerHTML = statsHtml + `
    <div class="rec-callout red" style="margin-bottom:14px;">
      ⚠️ <strong>${d.nonTaxableProductCount} product${d.nonTaxableProductCount !== 1 ? 's' : ''} found with tax disabled</strong>
      on ${d.nonTaxableVariantCount} variant${d.nonTaxableVariantCount !== 1 ? 's' : ''}.
      These products will never charge GST — even on domestic Australian orders.
      Fix them in Shopify Admin → Product → scroll down to <strong>Shipping</strong> section → check <strong>"Charge tax on this product"</strong>.
    </div>
    <div style="max-height:480px; overflow-y:auto; border:1px solid #f1f5f9; border-radius:10px; padding:0 16px;">
      ${productRowsHtml}
    </div>`;
}

// ── Run analysis ──────────────────────────────────────────────────
async function runAnalysis() {
  const month = document.getElementById('monthPicker').value;
  if (!month) {
    alert('Please select a month first.');
    return;
  }

  const btn = document.getElementById('analyseBtn');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  document.getElementById('resultsArea').innerHTML = `
    <div class="rec-loading">
      <div class="rec-spinner"></div>
      <span>Fetching all orders for ${fmtMonth(month)}… this may take a moment for busy months.</span>
    </div>`;

  try {
    const r = await fetch(`/api/reconcile/analyse?month=${encodeURIComponent(month)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    renderResults(d);
  } catch (err) {
    document.getElementById('resultsArea').innerHTML = `
      <div class="rec-callout red">
        <strong>Error:</strong> ${escHtml(err.message)}
      </div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyse Month';
  }
}

// ── Render ────────────────────────────────────────────────────────
function renderResults(d) {
  const s = d.shopify;
  const x = d.xero;
  const domPct = d.revenueOrders > 0
    ? (s.domesticOrders / d.revenueOrders * 100).toFixed(0)
    : 0;

  // GST variance classification
  const variance    = s.gstVariance;
  const varAbs      = Math.abs(variance);
  const varColor    = varAbs < 50 ? 'green' : varAbs < 500 ? 'amber' : 'red';

  // Xero vs Shopify difference
  const diff       = d.comparison ? d.comparison.difference : null;
  const diffAbs    = diff !== null ? Math.abs(diff) : null;
  const diffColor  = diff === null ? '' : (diffAbs < 100 ? 'green' : diffAbs < 1000 ? 'amber' : 'red');

  document.getElementById('resultsArea').innerHTML = `

    <!-- ── Overview ─────────────────────────────────────────────── -->
    <div class="rec-section">
      <div class="rec-section-title">📦 Shopify Orders — ${escHtml(fmtMonth(d.month))}</div>
      <div class="rec-grid">
        ${statCard('Orders (revenue)', d.revenueOrders, `${d.ordersTotal} total fetched`, '')}
        ${statCard('Gross Revenue (inc GST)', fmtCurrency(s.grossRevenue), 'Total charged to customers', '')}
        ${statCard('GST Collected', fmtCurrency(s.totalTaxCollected), 'From Shopify tax_lines', '')}
        ${statCard('Shipping', fmtCurrency(s.totalShipping), 'Total shipping charged', '')}
        ${statCard('Net Revenue (ex-GST)', fmtCurrency(s.netRevenue), 'Gross minus collected GST', 'green')}
      </div>

      <!-- Order status breakdown -->
      <div class="rec-status-chips" style="margin-top:12px;">
        ${Object.entries(d.byStatus).map(([k, v]) =>
          `<span class="rec-status-chip">${escHtml(k)}: ${v}</span>`
        ).join('')}
      </div>
    </div>

    <!-- ── Domestic / International split ────────────────────────── -->
    <div class="rec-section">
      <div class="rec-section-title">🌏 Domestic vs International</div>
      <div class="rec-grid">
        ${statCard('Domestic (AU)', s.domesticOrders + ' orders', fmtCurrency(s.domesticRevenue), '')}
        ${statCard('International', s.internationalOrders + ' orders', fmtCurrency(s.internationalRevenue), '')}
      </div>
      <div style="margin-top:12px; max-width:500px;">
        <div style="display:flex; justify-content:space-between; font-size:0.78rem; color:#64748b; margin-bottom:4px;">
          <span>AU ${domPct}%</span>
          <span>Intl ${100 - domPct}%</span>
        </div>
        <div class="rec-split-bar">
          <div class="rec-split-fill" style="width:${domPct}%"></div>
        </div>
        <p class="rec-note">International orders are GST-free — only domestic AU orders attract the 10% GST.</p>
      </div>
    </div>

    <!-- ── GST Analysis ───────────────────────────────────────────── -->
    <div class="rec-section">
      <div class="rec-section-title">🧾 GST Analysis</div>
      <div class="rec-gst-card">
        <div class="rec-gst-row">
          <span class="rec-gst-label">Domestic revenue (inc GST)</span>
          <span class="rec-gst-val">${fmtCurrency(s.domesticRevenue)}</span>
        </div>
        <div class="rec-gst-row">
          <span class="rec-gst-label">Expected GST <small style="font-weight:400; color:#94a3b8;">(domestic ÷ 11)</small></span>
          <span class="rec-gst-val">${fmtCurrency(s.expectedGST)}</span>
        </div>
        <div class="rec-gst-row">
          <span class="rec-gst-label">GST actually collected</span>
          <span class="rec-gst-val">${fmtCurrency(s.totalTaxCollected)}</span>
        </div>
        <div class="rec-gst-row" style="background:#fafafe; margin: 0 -24px; padding: 10px 24px; border-radius:0 0 14px 14px;">
          <span class="rec-gst-label" style="font-weight:700;">GST variance <small style="font-weight:400; color:#94a3b8;">(collected − expected)</small></span>
          <span class="rec-gst-val ${varColor}">${fmtCurrencySigned(variance)}</span>
        </div>
      </div>
      ${renderGSTCallout(variance, varColor, s.zeroTaxDomesticCount, s.impliedMissingGST)}
    </div>

    <!-- ── Xero Comparison ────────────────────────────────────────── -->
    ${renderXeroSection(d)}

    <!-- ── Zero-tax domestic orders ──────────────────────────────── -->
    <div class="rec-section">
      <div class="rec-table-wrap">
        <div class="rec-table-head">
          <div class="rec-table-title">
            🔍 Zero-Tax Domestic Orders
            <span style="font-size:0.78rem; font-weight:400; color:#64748b; margin-left:6px;">
              — AU orders where Shopify charged $0 GST
            </span>
          </div>
          ${s.zeroTaxDomesticCount > 0
            ? `<span class="rec-badge red">${s.zeroTaxDomesticCount} orders · ${fmtCurrency(s.zeroTaxDomesticRevenue)} · ~${fmtCurrency(s.impliedMissingGST)} missing GST</span>`
            : `<span class="rec-badge green">None found ✓</span>`
          }
        </div>
        ${s.zeroTaxOrders.length === 0
          ? `<div class="rec-empty" style="padding:40px 24px;">
               <div class="rec-empty-icon">✅</div>
               <div class="rec-empty-title">No zero-tax domestic orders</div>
               <div class="rec-empty-sub">All Australian orders had GST applied correctly.</div>
             </div>`
          : renderZeroTaxTable(s.zeroTaxOrders)
        }
      </div>
    </div>
  `;
}

// ── GST callout ───────────────────────────────────────────────────
function renderGSTCallout(variance, color, zeroTaxCount, impliedMissing) {
  if (color === 'green') {
    return `<div class="rec-callout green" style="margin-top:12px;">
      ✅ <strong>GST looks correct.</strong> The variance is under $50 — well within rounding tolerance.
    </div>`;
  }
  const abs = Math.abs(variance).toLocaleString('en-AU', { style:'currency', currency:'AUD' });
  if (variance < 0) {
    // Collected less than expected
    let hint = '';
    if (zeroTaxCount > 0) {
      hint = ` The ${zeroTaxCount} zero-tax domestic order${zeroTaxCount !== 1 ? 's' : ''} below account for ~${fmtCurrency(impliedMissing)} of this gap — check those products are set as taxable in Shopify.`;
    }
    return `<div class="rec-callout ${color}" style="margin-top:12px;">
      ⚠️ <strong>${abs} less GST collected than expected.</strong>
      Some domestic orders may have products not configured as taxable in Shopify.${hint}
    </div>`;
  } else {
    // Collected more than expected (unusual — could be rounding or international address issue)
    return `<div class="rec-callout amber" style="margin-top:12px;">
      ℹ️ <strong>${abs} more GST collected than expected.</strong>
      This can happen if some international orders were incorrectly treated as domestic.
      Check orders with no shipping address in the table below.
    </div>`;
  }
}

// ── Xero section ─────────────────────────────────────────────────
function renderXeroSection(d) {
  if (!d.xero.available) {
    return `<div class="rec-section">
      <div class="rec-section-title">📒 Xero Comparison</div>
      <div class="rec-callout amber">
        No Xero P&amp;L data found for ${escHtml(fmtMonth(d.month))}.
        Run a Xero sync from the <a href="/syncing.html" style="color:inherit;font-weight:700;">Manage Syncs</a> page to import this month's data.
      </div>
    </div>`;
  }

  const cmp = d.comparison;
  const diff = cmp.difference;
  const diffColor = Math.abs(diff) < 100 ? 'green' : Math.abs(diff) < 1000 ? 'amber' : 'red';
  const diffLabel = diff > 0
    ? `Shopify ${fmtCurrency(Math.abs(diff))} higher`
    : diff < 0
      ? `Xero ${fmtCurrency(Math.abs(diff))} higher`
      : 'Exact match';

  const incomeLinesHtml = d.xero.incomeLines.length > 0
    ? `<details style="margin-top:14px;">
        <summary style="cursor:pointer; font-size:0.82rem; color:#64748b; font-weight:600;">
          Show Xero income accounts (${d.xero.incomeLines.length})
        </summary>
        <table class="rec-income-table">
          ${d.xero.incomeLines.map(l =>
            `<tr><td>${escHtml(l.account)}</td><td>${fmtCurrency(l.value)}</td></tr>`
          ).join('')}
        </table>
      </details>`
    : '';

  return `<div class="rec-section">
    <div class="rec-section-title">📒 Xero Comparison</div>
    <div class="rec-compare-card">
      <div class="rec-compare-row">
        <span class="rec-compare-label">Shopify net revenue (ex-GST)</span>
        <span class="rec-compare-val">${fmtCurrency(cmp.shopifyNetRevenue)}</span>
      </div>
      <div class="rec-compare-row">
        <span class="rec-compare-label">Xero P&amp;L revenue (ex-GST)</span>
        <span class="rec-compare-val">${fmtCurrency(cmp.xeroRevenue)}</span>
      </div>
      <hr class="rec-compare-divider" />
      <div class="rec-compare-row">
        <span class="rec-compare-label" style="font-weight:700;">Difference</span>
        <span class="rec-compare-val ${diffColor}">
          ${fmtCurrencySigned(diff)}
          <span style="font-size:0.78rem; font-weight:400; color:#94a3b8; margin-left:6px;">${escHtml(diffLabel)}</span>
        </span>
      </div>
      ${incomeLinesHtml}
    </div>
    <p class="rec-note">
      Note: Xero revenue is ex-GST. Shopify net revenue = gross sales minus collected GST (includes shipping).
      A small difference is normal due to rounding and how shipping is mapped in Xero.
    </p>
  </div>`;
}

// ── Zero-tax orders table ─────────────────────────────────────────
function renderZeroTaxTable(orders) {
  const rowsHtml = orders.map(o => {
    const pill = o.taxesIncluded
      ? `<span class="rec-pill tax-inc" title="Prices include tax but $0 tax was calculated">tax-incl / $0</span>`
      : `<span class="rec-pill tax-exc" title="Tax-exclusive pricing and $0 tax collected">tax-excl / $0</span>`;
    return `<tr>
      <td style="font-weight:600; white-space:nowrap;">${escHtml(o.name)}</td>
      <td style="white-space:nowrap; color:#64748b; font-size:0.82rem;">${fmtDateTime(o.createdAt)}</td>
      <td>${escHtml(o.customer)}</td>
      <td style="font-weight:700; color:#1e293b;">${fmtCurrency(o.totalPrice)}</td>
      <td style="color:#94a3b8; font-size:0.8rem;">${fmtCurrency(o.totalPrice / 11)}</td>
      <td>${pill}</td>
    </tr>`;
  }).join('');

  return `<table class="rec-table">
    <thead>
      <tr>
        <th>Order</th>
        <th>Date</th>
        <th>Customer</th>
        <th>Order Total</th>
        <th>GST Should Be</th>
        <th>Tax Setting</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>`;
}

// ── Helpers ───────────────────────────────────────────────────────
function statCard(label, value, sub, colorClass) {
  return `<div class="rec-card">
    <div class="rec-card-label">${escHtml(label)}</div>
    <div class="rec-card-val ${colorClass}">${escHtml(String(value))}</div>
    ${sub ? `<div class="rec-card-sub">${escHtml(String(sub))}</div>` : ''}
  </div>`;
}

function fmtCurrency(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtCurrencySigned(n) {
  if (n === null || n === undefined) return '—';
  const prefix = n > 0.005 ? '+' : '';
  return prefix + fmtCurrency(n);
}

function fmtMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const d = new Date(parseInt(y), parseInt(m) - 1, 1);
  return d.toLocaleString('en-AU', { month: 'long', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
