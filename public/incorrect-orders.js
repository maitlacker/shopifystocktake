/* global escHtml */
(function () {
  'use strict';

  let allRows   = [];
  let activeTab = 'all';

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' });
  }

  function weekLabel(dateStr) {
    if (!dateStr) return 'Unknown Week';
    const d   = new Date(dateStr);
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((day + 6) % 7));   // Monday
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const opts = { day: 'numeric', month: 'short' };
    return `${mon.toLocaleDateString('en-AU', opts)} – ${sun.toLocaleDateString('en-AU', opts)}`;
  }

  function weekKey(dateStr) {
    if (!dateStr) return 'unknown';
    const d   = new Date(dateStr);
    const day = d.getDay();
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((day + 6) % 7));
    return mon.toISOString().split('T')[0];
  }

  function statusBadge(status) {
    const labels = { open: 'Open', replacement_sent: 'Replacement Sent', resolved: 'Resolved' };
    return `<span class="io-badge ${escHtml(status)}">${escHtml(labels[status] || status)}</span>`;
  }

  function stockDot(checked) {
    return checked
      ? `<span class="io-stock-dot yes">✓</span>`
      : `<span class="io-stock-dot no">–</span>`;
  }

  function renderRows(rows) {
    const tbody = document.getElementById('io-tbody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="io-empty">
        <div class="io-empty-icon">✅</div>
        No incorrect order cases ${activeTab !== 'all' ? 'with this status' : 'yet'}.
      </td></tr>`;
      return;
    }

    // Group by week (Monday-based)
    const groups = new Map();
    rows.forEach(r => {
      const k = weekKey(r.reported_date);
      if (!groups.has(k)) groups.set(k, { label: weekLabel(r.reported_date), rows: [] });
      groups.get(k).rows.push(r);
    });

    let html = '';
    groups.forEach(({ label, rows: wrows }) => {
      html += `<tr class="io-week-row"><td colspan="8">Week of ${escHtml(label)} <span style="color:#94a3b8;font-weight:400">(${wrows.length})</span></td></tr>`;
      wrows.forEach(r => {
        const cItem = r.correct_item
          ? `<div class="io-item-name">${escHtml(r.correct_item)}</div>`
          : `<div class="io-item-empty">Not set</div>`;
        const rItem = r.received_item
          ? `<div class="io-item-name">${escHtml(r.received_item)}</div>`
          : `<div class="io-item-empty">Not set</div>`;
        html += `
          <tr class="io-data-row" onclick="window.location='/incorrect-order.html?id=${r.id}'">
            <td>
              <div class="io-order-num">${escHtml(r.order_number)}</div>
              ${r.customer_name ? `<div class="io-customer">${escHtml(r.customer_name)}</div>` : ''}
            </td>
            <td>${cItem}</td>
            <td style="text-align:center">${stockDot(r.correct_stock_counted)}</td>
            <td>${rItem}</td>
            <td style="text-align:center">${stockDot(r.received_stock_counted)}</td>
            <td>${statusBadge(r.status)}</td>
            <td class="io-date">${fmtDate(r.reported_date)}</td>
            <td><a class="io-open-btn" href="/incorrect-order.html?id=${r.id}" onclick="event.stopPropagation()">Open →</a></td>
          </tr>`;
      });
    });

    tbody.innerHTML = html;
  }

  function updateStats(rows) {
    document.getElementById('stat-open').textContent        = rows.filter(r => r.status === 'open').length;
    document.getElementById('stat-replacement').textContent = rows.filter(r => r.status === 'replacement_sent').length;
    document.getElementById('stat-resolved').textContent    = rows.filter(r => r.status === 'resolved').length;
    document.getElementById('stat-stock-pending').textContent = rows.filter(
      r => r.status !== 'resolved' && (!r.correct_stock_counted || !r.received_stock_counted)
    ).length;
    const total = rows.length;
    document.getElementById('io-total-count').textContent = total ? `(${total})` : '';
  }

  function applyFilter() {
    const filtered = activeTab === 'all'
      ? allRows
      : allRows.filter(r => r.status === activeTab);
    renderRows(filtered);
  }

  async function load() {
    try {
      const r = await fetch('/api/incorrect-orders');
      if (r.status === 401) { window.location.href = '/login'; return; }
      allRows = await r.json();
      updateStats(allRows);
      applyFilter();
    } catch (err) {
      document.getElementById('io-tbody').innerHTML =
        `<tr><td colspan="8" class="io-empty">Error loading cases: ${escHtml(err.message)}</td></tr>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Tab clicks
    document.querySelectorAll('.io-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.io-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.status;
        applyFilter();
      });
    });

    load();
  });
})();
