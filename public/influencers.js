/* Influencer Campaigns — list page */
(function () {
  let allRows   = [];
  let activeTab = 'all';

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtMoney(n) {
    const v = parseFloat(n || 0);
    return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function fmtNum(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('en-AU');
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function monthKey(dateStr) {
    if (!dateStr) return 'Unscheduled';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  }

  function renderStats(rows) {
    const by = (s) => rows.filter(r => r.status === s).length;
    document.getElementById('stat-live').textContent      = by('live');
    document.getElementById('stat-planned').textContent   = by('planned');
    document.getElementById('stat-completed').textContent = by('completed');
    const invested = rows.reduce((sum, r) => sum + parseFloat(r.influencer_fee || 0), 0);
    document.getElementById('stat-invested').textContent  = fmtMoney(invested);
    document.getElementById('inf-total-count').textContent = `(${rows.length})`;
  }

  function productsCell(products) {
    if (!products || !products.length) return '<span class="inf-no-products">None yet</span>';
    const shown = products.slice(0, 4);
    let html = '<div class="inf-products">';
    shown.forEach(p => {
      html += p.image_url
        ? `<img class="inf-product-thumb" src="${escHtml(p.image_url)}" title="${escHtml(p.product_title)}" alt="" />`
        : `<span class="inf-product-more" title="${escHtml(p.product_title)}">📦</span>`;
    });
    if (products.length > 4) html += `<span class="inf-product-more">+${products.length - 4}</span>`;
    html += '</div>';
    return html;
  }

  function render() {
    const tbody = document.getElementById('inf-tbody');
    const rows = activeTab === 'all' ? allRows : allRows.filter(r => r.status === activeTab);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="inf-empty"><div class="inf-empty-icon">📣</div>No campaigns${activeTab !== 'all' ? ' with this status' : ' yet — create your first one'}.</td></tr>`;
      return;
    }

    let html = '';
    let lastMonth = null;
    rows.forEach(r => {
      const mk = monthKey(r.post_datetime);
      if (mk !== lastMonth) {
        html += `<tr class="inf-month-row"><td colspan="9">${escHtml(mk)}</td></tr>`;
        lastMonth = mk;
      }
      const org = r.latest_organic || {};
      html += `
        <tr class="inf-data-row" data-id="${r.id}">
          <td>
            <div class="inf-creator">${escHtml(r.creator_name)}</div>
            ${r.creator_handle ? `<div class="inf-handle">@${escHtml(r.creator_handle.replace(/^@/, ''))}</div>` : ''}
          </td>
          <td class="inf-date">${fmtDate(r.post_datetime)}</td>
          <td>${productsCell(r.products)}</td>
          <td class="inf-metric">${escHtml(r.content_type || '—')}</td>
          <td class="inf-fee">${fmtMoney(r.influencer_fee)}</td>
          <td class="inf-metric">${fmtNum(org.reach)}</td>
          <td class="inf-metric">${org.engagement_rate != null ? org.engagement_rate + '%' : '—'}</td>
          <td><span class="inf-badge ${escHtml(r.status)}">${escHtml(r.status)}</span></td>
          <td><a class="inf-open-btn" href="/influencer-campaign.html?id=${r.id}" onclick="event.stopPropagation()">Open →</a></td>
        </tr>`;
    });
    tbody.innerHTML = html;

    tbody.querySelectorAll('.inf-data-row').forEach(tr => {
      tr.addEventListener('click', () => {
        window.location.href = `/influencer-campaign.html?id=${tr.dataset.id}`;
      });
    });
  }

  async function load() {
    try {
      const res = await fetch('/api/influencer-campaigns');
      if (res.status === 401) { window.location.href = '/login'; return; }
      allRows = await res.json();
      renderStats(allRows);
      render();
    } catch (err) {
      document.getElementById('inf-tbody').innerHTML =
        `<tr><td colspan="9" class="inf-empty">Failed to load: ${escHtml(err.message)}</td></tr>`;
    }
  }

  document.querySelectorAll('.inf-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.inf-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.status;
      render();
    });
  });

  load();
})();
