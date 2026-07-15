'use strict';

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
}

// Allow Enter key to submit
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('sl-sku').addEventListener('keydown', e => {
    if (e.key === 'Enter') runSleuth();
  });
});

async function runSleuth() {
  const sku  = document.getElementById('sl-sku').value.trim();
  const days = document.getElementById('sl-window').value;
  const btn  = document.getElementById('sl-btn');
  const out  = document.getElementById('sl-results');

  if (!sku) {
    document.getElementById('sl-sku').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Investigating…';
  out.innerHTML = `<div class="sl-empty"><div class="sl-empty-icon">⏳</div><div class="sl-empty-text">Fetching orders and inventory — this may take a moment…</div></div>`;

  try {
    const r = await fetch(`/api/stock-sleuth?sku=${encodeURIComponent(sku)}&days=${days}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    out.innerHTML = renderResults(data);
  } catch (e) {
    out.innerHTML = `<div class="sl-error">Error: ${escHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Investigate';
  }
}

const ANOMALY_ICON = { error: '🚨', warning: '⚠️', info: 'ℹ️' };
const ANOMALY_TYPE_LABEL = {
  negative_stock:   'Negative Stock',
  race_condition:   'Checkout Race Condition',
  refund_no_restock:'Refund — No Restock',
  paid_cancellation:'Paid Cancellation',
  stock_drift:      'Stock Drift',
  multi_negative:   'Multiple Negative Stock',
};

function renderResults(d) {
  const inv = d.inventory || {};
  const totals = inv.totals || {};
  const stats = d.stats || {};
  const events = d.events || [];
  const anomalies = d.anomalies || [];
  const v = d.variant;

  const sections = [];

  // ── Variant header + inventory ──
  const imgEl = v.product_image
    ? `<img class="sl-variant-img" src="${escHtml(v.product_image)}" alt="" />`
    : `<div class="sl-variant-img-ph">👗</div>`;

  const trackedBadge = inv.tracked === false
    ? `<span class="sl-status voided" style="margin-left:8px">Not tracked</span>` : '';

  const invGrid = Object.entries({
    on_hand:       { label: 'On Hand',       cls: '' },
    available:     { label: 'Available',     cls: totals.available < 0 ? 'danger' : totals.available === 0 ? '' : 'positive' },
    committed:     { label: 'Committed',     cls: totals.committed > 0 ? 'highlight' : '' },
    reserved:      { label: 'Reserved',      cls: totals.reserved > 0 ? 'highlight' : '' },
    damaged:       { label: 'Damaged',       cls: totals.damaged > 0 ? 'danger' : '' },
    safety_stock:  { label: 'Safety Stock',  cls: '' },
    quality_control:{ label: 'Quality Ctrl', cls: totals.quality_control > 0 ? 'highlight' : '' },
    incoming:      { label: 'Incoming',      cls: totals.incoming > 0 ? 'positive' : '' },
  }).map(([key, { label, cls }]) => {
    const val = totals[key] ?? 0;
    const valCls = val < 0 ? 'negative' : '';
    return `<div class="sl-inv-cell ${cls}">
      <div class="sl-inv-val ${valCls}">${val}</div>
      <div class="sl-inv-lbl">${label}</div>
    </div>`;
  }).join('');

  // Multi-location breakdown (only if >1 location or interesting non-zero states)
  let locHtml = '';
  if ((inv.locations || []).length > 1) {
    locHtml = `<div class="sl-locations">` + (inv.locations || []).map(loc => {
      const q = loc.quantities || {};
      const parts = Object.entries(q)
        .filter(([k, v]) => v !== 0 && k !== 'on_hand')
        .map(([k, v]) => `<span class="sl-loc-stat">${k}: <span>${v}</span></span>`)
        .join('  ');
      return `<div class="sl-loc-row"><span class="sl-loc-name">📍 ${escHtml(loc.name)}</span>${parts}</div>`;
    }).join('') + `</div>`;
  }

  sections.push(`
    <div class="sl-section">
      <div class="sl-section-title">Variant &amp; Inventory</div>
      <div class="sl-variant-hdr">
        ${imgEl}
        <div>
          <div class="sl-variant-name">${escHtml(v.product_title)}</div>
          <div class="sl-variant-sub">${escHtml(v.title)}</div>
          <span class="sl-variant-sku">${escHtml(v.sku)}</span>${trackedBadge}
        </div>
      </div>
      <div class="sl-inv-grid">${invGrid}</div>
      ${locHtml}
      <div class="sl-stats-bar">
        <div class="sl-stat">
          <div class="sl-stat-val">${stats.orders_in_window || 0}</div>
          <div class="sl-stat-lbl">Orders in window</div>
        </div>
        <div class="sl-stat">
          <div class="sl-stat-val">${stats.total_sold || 0}</div>
          <div class="sl-stat-lbl">Units sold</div>
        </div>
        <div class="sl-stat">
          <div class="sl-stat-val">${stats.total_refund_restocked || 0}</div>
          <div class="sl-stat-lbl">Refund restocked</div>
        </div>
        <div class="sl-stat">
          <div class="sl-stat-val">${stats.inferred_start ?? '—'}</div>
          <div class="sl-stat-lbl">Implied start (${stats.window_days}d)</div>
        </div>
      </div>
    </div>`);

  // ── Anomalies ──
  const anomHtml = anomalies.length === 0
    ? `<div class="sl-no-anomalies">✅ No anomalies detected in this window</div>`
    : anomalies.map(a => `
      <div class="sl-anomaly ${escHtml(a.severity)}">
        <div class="sl-anomaly-icon">${ANOMALY_ICON[a.severity] || 'ℹ️'}</div>
        <div class="sl-anomaly-body">
          <div class="sl-anomaly-type">${escHtml(ANOMALY_TYPE_LABEL[a.type] || a.type)}</div>
          <div class="sl-anomaly-msg">${escHtml(a.message)}</div>
          ${a.date ? `<div class="sl-anomaly-date">${fmtDateTime(a.date)}</div>` : ''}
        </div>
      </div>`).join('');

  sections.push(`
    <div class="sl-section">
      <div class="sl-section-title">Anomalies (${anomalies.length})</div>
      ${anomHtml}
    </div>`);

  // ── Timeline ──
  if (events.length === 0) {
    sections.push(`
      <div class="sl-section">
        <div class="sl-section-title">Order Timeline</div>
        <div class="sl-empty" style="padding:30px">
          <div class="sl-empty-text">No orders found for this SKU in the last ${stats.window_days} days</div>
        </div>
      </div>`);
  } else {
    const rows = [...events].reverse().map(ev => {
      const typePill = `<span class="sl-evt-pill ${ev.type}">${ev.type}</span>`;
      const delta    = ev.qty_delta;
      const deltaStr = delta > 0 ? `+${delta}` : (delta < 0 ? String(delta) : '—');
      const deltaCls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero';

      const bal    = ev.running_before ?? '?';
      const balCls = typeof bal === 'number' && bal < 0 ? 'neg' : (bal === 0 ? 'zero' : '');

      const finStatus = ev.financial_status
        ? `<span class="sl-status ${ev.financial_status}">${escHtml(ev.financial_status)}</span>` : '';
      const fulStatus = ev.fulfillment_status
        ? `<span class="sl-status ${ev.fulfillment_status}">${escHtml(ev.fulfillment_status || 'unfulfilled')}</span>` : '';

      let extra = '';
      if (ev.type === 'refund') {
        const rc   = ev.restock_type || 'unknown';
        const rCls = ev.restocked ? 'restocked' : rc === 'cancel' ? 'cancel' : 'no-restock';
        extra = `<span class="sl-restock ${rCls}">${escHtml(rc)}</span>`;
      }
      if (ev.cancel_reason) {
        extra += ` <span style="font-size:0.72rem;color:#94a3b8">reason: ${escHtml(ev.cancel_reason)}</span>`;
      }

      const orderLink = ev.order_name
        ? `<span class="sl-order-link">${escHtml(ev.order_name)}</span>` : '—';
      const emailTxt = ev.email ? `<div style="font-size:0.7rem;color:#94a3b8;margin-top:2px">${escHtml(ev.email)}</div>` : '';

      return `<tr>
        <td style="white-space:nowrap">${fmtDateTime(ev.date)}</td>
        <td>${typePill}</td>
        <td>${orderLink}${emailTxt}</td>
        <td style="text-align:right">${ev.qty || '—'}</td>
        <td style="text-align:right"><span class="sl-delta ${deltaCls}">${deltaStr}</span></td>
        <td style="text-align:right"><span class="sl-balance ${balCls}">${bal}</span></td>
        <td>${finStatus} ${fulStatus} ${extra}</td>
      </tr>`;
    }).join('');

    const noteText = `Inferred balance is reconstructed from orders only — REDO restocks and manual adjustments are not included, so it will drift from actual stock over time.`;

    sections.push(`
      <div class="sl-section">
        <div class="sl-section-title">Order Timeline (${events.length} events, newest first)</div>
        <div class="sl-note">📝 ${escHtml(noteText)}</div>
        <div class="sl-timeline-wrap">
          <table class="sl-timeline">
            <thead><tr>
              <th>Date &amp; Time</th>
              <th>Type</th>
              <th>Order</th>
              <th style="text-align:right">Qty</th>
              <th style="text-align:right">Delta</th>
              <th style="text-align:right">Inferred Balance</th>
              <th>Status / Details</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`);
  }

  return sections.join('');
}
