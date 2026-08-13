/* Influencer Campaign — detail page */
(function () {
  const params  = new URLSearchParams(window.location.search);
  let campaignId = params.get('id') ? parseInt(params.get('id'), 10) : null;
  let campaign   = null;

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtNum(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toLocaleString('en-AU');
  }

  function fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-AU', {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ── Form <-> payload ─────────────────────────────────────────── */
  const F = (id) => document.getElementById(id);

  function buildPayload() {
    return {
      creator_name:          F('f-creator-name').value.trim(),
      creator_handle:        F('f-creator-handle').value.trim() || null,
      post_datetime:         F('f-post-datetime').value || null,
      content_type:          F('f-content-type').value || null,
      cta_used:              F('f-cta').value.trim() || null,
      hook:                  F('f-hook').value.trim() || null,
      ad_live_start:         F('f-ad-start').value || null,
      ad_live_end:           F('f-ad-ongoing').checked ? null : (F('f-ad-end').value || null),
      ad_live_ongoing:       F('f-ad-ongoing').checked,
      influencer_fee:        parseFloat(F('f-fee').value || 0),
      discount_code:         F('f-code').value.trim() || null,
      reporting_window_days: parseInt(F('f-window').value || 14, 10),
      post_url:              F('f-post-url').value.trim() || null,
      notes:                 F('f-notes').value.trim() || null,
      status:                campaign ? campaign.status : 'planned',
    };
  }

  function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function populateForm(c) {
    F('f-creator-name').value  = c.creator_name || '';
    F('f-creator-handle').value = c.creator_handle || '';
    F('f-post-datetime').value = toLocalInputValue(c.post_datetime);
    F('f-content-type').value  = c.content_type || '';
    F('f-cta').value           = c.cta_used || '';
    F('f-hook').value          = c.hook || '';
    F('f-ad-start').value      = c.ad_live_start ? c.ad_live_start.split('T')[0] : '';
    F('f-ad-end').value        = c.ad_live_end ? c.ad_live_end.split('T')[0] : '';
    F('f-ad-ongoing').checked  = !!c.ad_live_ongoing;
    syncOngoing();
    F('f-fee').value           = c.influencer_fee || '';
    F('f-code').value          = c.discount_code || '';
    F('f-window').value        = c.reporting_window_days || 14;
    F('f-post-url').value      = c.post_url || '';
    F('f-notes').value         = c.notes || '';

    F('ic-title').textContent = c.creator_name || 'Campaign';
    const badge = F('ic-status-badge');
    badge.textContent = c.status;
    badge.className   = `ic-badge ${c.status}`;
    badge.style.display = '';

    F('ic-status-btns').style.display = '';
    document.querySelectorAll('.ic-status-btn').forEach(b => {
      b.className = 'ic-status-btn' + (b.dataset.status === c.status ? ` active-${c.status}` : '');
    });

    F('ic-delete').style.display = '';
    F('ic-products-locked').style.display = 'none';
    F('ic-products-body').style.display = '';
    F('ic-organic-card').style.display = '';
    F('ic-sales-card').style.display = '';

    renderProducts(c.products || []);
    renderOrganic(c.organic_metrics || []);

    if (!salesLoaded) { salesLoaded = true; loadSales(false); }
  }

  /* ── Ongoing ads toggle ───────────────────────────────────────── */
  function syncOngoing() {
    const ongoing = F('f-ad-ongoing').checked;
    const endEl = F('f-ad-end');
    endEl.disabled = ongoing;
    if (ongoing) endEl.value = '';
    endEl.style.opacity = ongoing ? '0.45' : '';
  }
  F('f-ad-ongoing').addEventListener('change', syncOngoing);

  /* ── Save / delete ────────────────────────────────────────────── */
  async function save() {
    const payload = buildPayload();
    if (!payload.creator_name) { alert('Creator name is required'); return; }

    const btn = F('ic-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const res = await fetch(
        campaignId ? `/api/influencer-campaigns/${campaignId}` : '/api/influencer-campaigns',
        {
          method:  campaignId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      if (!campaignId) {
        campaignId = data.id;
        history.replaceState(null, '', `/influencer-campaign.html?id=${campaignId}`);
        await loadCampaign();
      } else {
        campaign = Object.assign(campaign || {}, data);
        populateForm(Object.assign({}, campaign, {
          products: campaign.products, organic_metrics: campaign.organic_metrics,
        }));
      }
      flashSaved();
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Campaign';
    }
  }

  function flashSaved() {
    const el = F('ic-saved-flash');
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
  }

  F('ic-save').addEventListener('click', save);

  F('ic-delete').addEventListener('click', async () => {
    if (!campaignId) return;
    if (!confirm('Delete this campaign? This cannot be undone from the UI.')) return;
    const res = await fetch(`/api/influencer-campaigns/${campaignId}`, { method: 'DELETE' });
    if (res.ok) window.location.href = '/influencers.html';
    else alert('Delete failed');
  });

  /* ── Status workflow ──────────────────────────────────────────── */
  document.querySelectorAll('.ic-status-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!campaign) return;
      campaign.status = btn.dataset.status;
      await save();
    });
  });

  /* ── Product picker ───────────────────────────────────────────── */
  const searchInput = F('ic-product-search');
  const dropdown    = F('ic-product-dropdown');

  const doSearch = debounce(async (q) => {
    if (q.length < 2) { dropdown.classList.remove('open'); return; }
    dropdown.innerHTML = '<div class="ic-dd-msg">Searching…</div>';
    dropdown.classList.add('open');
    try {
      const res  = await fetch(`/api/stocktake/search-live?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!data.length) {
        dropdown.innerHTML = '<div class="ic-dd-msg">No products found</div>';
        return;
      }
      dropdown.innerHTML = data.map(p => `
        <div class="ic-dd-option" data-id="${p.id}" data-title="${escHtml(p.title)}" data-image="${escHtml(p.image || '')}">
          ${p.image ? `<img class="ic-dd-thumb" src="${escHtml(p.image)}" alt="" />` : '<span class="ic-dd-thumb"></span>'}
          <span class="ic-dd-title">${escHtml(p.title)}</span>
        </div>`).join('');
      dropdown.querySelectorAll('.ic-dd-option').forEach(opt => {
        opt.addEventListener('click', () => addProduct(opt.dataset));
      });
    } catch (err) {
      dropdown.innerHTML = `<div class="ic-dd-msg">Search error: ${escHtml(err.message)}</div>`;
    }
  }, 300);

  searchInput.addEventListener('input', (e) => doSearch(e.target.value.trim()));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.ic-search-wrap')) dropdown.classList.remove('open');
  });

  async function addProduct(ds) {
    dropdown.classList.remove('open');
    searchInput.value = '';
    try {
      const res = await fetch(`/api/influencer-campaigns/${campaignId}/products`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          product_id:    parseInt(ds.id, 10),
          product_title: ds.title,
          image_url:     ds.image || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Add failed');
      await loadCampaign();
    } catch (err) {
      alert(`Failed to add product: ${err.message}`);
    }
  }

  function renderProducts(products) {
    const list = F('ic-product-list');
    if (!products.length) {
      list.innerHTML = '<div class="ic-products-hint">No products added yet — search above to add the featured products.</div>';
      return;
    }
    const startInv = campaign?.starting_inventory || [];
    list.innerHTML = products.map(p => {
      const variants = startInv.filter(s => String(s.product_id) === String(p.product_id));
      const totalStart = variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
      const invLabel = variants.length
        ? `Starting inventory: <strong>${fmtNum(totalStart)}</strong> units across ${variants.length} variant${variants.length !== 1 ? 's' : ''} (snapshot ${variants[0].snapshot_date ? new Date(variants[0].snapshot_date).toLocaleDateString('en-AU') : ''})`
        : 'No inventory snapshot yet';
      return `
        <div class="ic-product-row">
          ${p.image_url ? `<img src="${escHtml(p.image_url)}" alt="" />` : '<span style="width:44px;height:44px;border-radius:8px;background:#fff;display:inline-flex;align-items:center;justify-content:center">📦</span>'}
          <div class="ic-product-info">
            <div class="ic-product-name">${escHtml(p.product_title)}</div>
            <div class="ic-product-inv">${invLabel}</div>
          </div>
          <label class="ic-size-worn">
            <span>Size worn</span>
            <input type="text" maxlength="10" data-id="${p.product_id}" value="${escHtml(p.size_worn || '')}" placeholder="e.g. 14" />
          </label>
          <button class="ic-product-remove" data-id="${p.product_id}" title="Remove">✕</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.ic-size-worn input').forEach(input => {
      input.addEventListener('change', async () => {
        try {
          const res = await fetch(`/api/influencer-campaigns/${campaignId}/products/${input.dataset.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size_worn: input.value }),
          });
          if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
          const p = (campaign.products || []).find(x => String(x.product_id) === String(input.dataset.id));
          if (p) p.size_worn = input.value.trim() || null;
          input.style.borderColor = '#86efac';
          setTimeout(() => { input.style.borderColor = ''; }, 1500);
        } catch (err) {
          alert(`Failed to save size: ${err.message}`);
        }
      });
    });

    list.querySelectorAll('.ic-product-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this product from the campaign?')) return;
        await fetch(`/api/influencer-campaigns/${campaignId}/products/${btn.dataset.id}`, { method: 'DELETE' });
        await loadCampaign();
      });
    });
  }

  /* ── Organic metrics ──────────────────────────────────────────── */
  F('ic-toggle-organic-form').addEventListener('click', () => {
    const form = F('ic-organic-form');
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });

  F('ic-save-organic').addEventListener('click', async () => {
    const val = (id) => F(id).value.trim();
    const payload = {
      source:         'manual',
      reach:          val('m-reach'),
      views:          val('m-views'),
      likes:          val('m-likes'),
      comments:       val('m-comments'),
      shares:         val('m-shares'),
      saves:          val('m-saves'),
      profile_visits: val('m-profile-visits'),
      link_clicks:    val('m-link-clicks'),
    };
    const hasAny = Object.entries(payload).some(([k, v]) => k !== 'source' && v !== '');
    if (!hasAny) { alert('Enter at least one metric'); return; }

    const btn = F('ic-save-organic');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/influencer-campaigns/${campaignId}/organic`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      ['m-reach','m-views','m-likes','m-comments','m-shares','m-saves','m-profile-visits','m-link-clicks']
        .forEach(id => { F(id).value = ''; });
      F('ic-organic-form').style.display = 'none';
      await loadCampaign();
    } catch (err) {
      alert(`Failed to save snapshot: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  function renderOrganic(entries) {
    const grid  = F('ic-metrics-grid');
    const table = F('ic-history-table');
    const tbody = F('ic-history-tbody');

    if (!entries.length) {
      grid.innerHTML = '<div class="ic-products-hint" style="grid-column:1/-1">No organic metrics recorded yet — click “+ Record Snapshot” to add the post’s performance.</div>';
      table.style.display = 'none';
      return;
    }

    const latest = entries[0];
    const tiles = [
      ['Reach', latest.reach], ['Views', latest.views],
      ['Likes', latest.likes], ['Comments', latest.comments], ['Shares', latest.shares],
      ['Saves', latest.saves], ['Profile Visits', latest.profile_visits],
      ['Link Clicks', latest.link_clicks],
      ['Eng. Rate', latest.engagement_rate != null ? latest.engagement_rate + '%' : null],
    ];
    grid.innerHTML = tiles
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([label, v]) => `
        <div class="ic-metric-tile">
          <div class="ic-metric-num">${typeof v === 'number' ? fmtNum(v) : escHtml(String(v))}</div>
          <div class="ic-metric-label">${label}</div>
        </div>`).join('');

    table.style.display = '';
    tbody.innerHTML = entries.map(m => `
      <tr>
        <td>${fmtDateTime(m.captured_at)}</td>
        <td><span class="ic-source-tag">${escHtml(m.source)}</span></td>
        <td>${fmtNum(m.reach)}</td>
        <td>${fmtNum(m.views)}</td>
        <td>${fmtNum(m.likes)}</td>
        <td>${fmtNum(m.comments)}</td>
        <td>${fmtNum(m.shares)}</td>
        <td>${fmtNum(m.saves)}</td>
        <td>${fmtNum(m.profile_visits)}</td>
        <td>${fmtNum(m.link_clicks)}</td>
        <td>${m.engagement_rate != null ? m.engagement_rate + '%' : '—'}</td>
        <td><button class="ic-history-del" data-id="${m.id}" title="Delete snapshot">✕</button></td>
      </tr>`).join('');

    tbody.querySelectorAll('.ic-history-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this snapshot?')) return;
        await fetch(`/api/influencer-campaigns/${campaignId}/organic/${btn.dataset.id}`, { method: 'DELETE' });
        await loadCampaign();
      });
    });
  }

  /* ── Sales performance ────────────────────────────────────────── */
  let salesLoaded = false;

  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function sizeSort(a, b) {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    const order = ['XXS','XS','S','M','L','XL','XXL','XXXL'];
    const ia = order.indexOf(String(a).toUpperCase()), ib = order.indexOf(String(b).toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    return String(a).localeCompare(String(b));
  }

  async function loadSales(force) {
    if (!campaignId) return;
    const body = F('ic-sales-body');
    body.innerHTML = '<div class="ic-products-hint">Loading sales data — scanning orders…</div>';
    try {
      const res = await fetch(`/api/influencer-campaigns/${campaignId}/sales${force ? '?refresh=1' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      renderSales(data);
    } catch (err) {
      body.innerHTML = `<div class="ic-products-hint" style="color:#b91c1c">Failed to load sales: ${escHtml(err.message)}</div>`;
    }
  }

  function renderSales(d) {
    const winEl = F('ic-sales-window');
    const body  = F('ic-sales-body');

    if (d.no_products) {
      winEl.textContent = '';
      body.innerHTML = '<div class="ic-products-hint">Add featured products to see sales data.</div>';
      return;
    }
    if (d.no_window) {
      winEl.textContent = '';
      body.innerHTML = '<div class="ic-products-hint">Set a post date (or ad live start) to define the reporting window.</div>';
      return;
    }

    const fd = (iso) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    winEl.innerHTML =
      `Window: <strong>${fd(d.window_start)}</strong> → <strong>${d.window_ongoing ? 'now (ongoing)' : fd(d.window_end)}</strong>` +
      ` · ${Number(d.orders_scanned).toLocaleString('en-AU')} orders scanned` +
      (d.window_capped ? ' · <span style="color:#d97706">capped at 90 days</span>' : '') +
      (d.cached ? ` · cached ${new Date(d.computed_at).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}` : '');

    let html = '';

    /* Direct — influencer code */
    html += '<div class="ic-sales-section-title">Direct Sales — Influencer Code' +
      (d.discount_code ? ` (${escHtml(d.discount_code)})` : '') + '</div>';
    if (!d.discount_code) {
      html += '<div class="ic-products-hint">No influencer code set on this campaign — add one in Campaign Details to track direct sales.</div>';
    } else {
      const dir = d.direct;
      const aov = dir.order_count ? dir.revenue / dir.order_count : 0;
      html += `
        <div class="ic-metrics-grid" style="margin-bottom:6px">
          <div class="ic-metric-tile"><div class="ic-metric-num">${dir.order_count}</div><div class="ic-metric-label">Orders</div></div>
          <div class="ic-metric-tile"><div class="ic-metric-num">${fmtMoney(dir.revenue)}</div><div class="ic-metric-label">Revenue</div></div>
          <div class="ic-metric-tile"><div class="ic-metric-num">${dir.units}</div><div class="ic-metric-label">Units</div></div>
          <div class="ic-metric-tile"><div class="ic-metric-num">${fmtMoney(aov)}</div><div class="ic-metric-label">Avg Order</div></div>
        </div>`;
      if (dir.orders.length) {
        html += `<div style="overflow-x:auto"><table class="ic-direct-orders">
          <thead><tr><th>Order</th><th>Date</th><th>Items</th><th style="text-align:right">Total</th></tr></thead>
          <tbody>${dir.orders.map(o => `
            <tr>
              <td style="font-weight:600">${escHtml(o.name)}</td>
              <td style="white-space:nowrap">${fd(o.created_at)}</td>
              <td>${escHtml(o.items)}</td>
              <td style="text-align:right;white-space:nowrap">${fmtMoney(o.total)}</td>
            </tr>`).join('')}
          </tbody></table></div>`;
        if (dir.order_count > dir.orders.length) {
          html += `<div class="ic-products-hint" style="margin-top:6px">Showing first ${dir.orders.length} of ${dir.order_count} orders.</div>`;
        }
      } else {
        html += '<div class="ic-products-hint">No orders used this code in the window.</div>';
      }
    }

    /* Indirect — featured garments by size */
    html += '<div class="ic-sales-section-title">All Sales of Featured Garments — by Size</div>';
    for (const p of d.products) {
      const sizes = Object.keys(p.sizes).sort(sizeSort);
      const worn  = (p.size_worn || '').trim().toUpperCase();
      html += `
        <div class="ic-sales-product">
          <div class="ic-sales-product-head">
            ${p.image_url ? `<img src="${escHtml(p.image_url)}" alt="" />` : ''}
            <span class="name">${escHtml(p.title)}</span>
            ${p.size_worn ? `<span class="ic-worn-tag">wearing ${escHtml(p.size_worn)}</span>` : ''}
          </div>`;
      if (!sizes.length) {
        html += '<div class="ic-products-hint">No sales in the window.</div></div>';
        continue;
      }
      html += `<div style="overflow-x:auto"><table class="ic-size-table">
        <thead><tr><th>Size</th><th style="text-align:right">Units</th><th style="text-align:right">Revenue</th></tr></thead>
        <tbody>${sizes.map(s => {
          const row = p.sizes[s];
          const isWorn = worn && s.trim().toUpperCase() === worn;
          return `<tr${isWorn ? ' class="worn"' : ''}>
            <td>${escHtml(s)}${isWorn ? '<span class="ic-worn-tag">size worn</span>' : ''}</td>
            <td style="text-align:right">${row.units}</td>
            <td style="text-align:right">${fmtMoney(row.revenue)}</td>
          </tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td>Total</td><td style="text-align:right">${p.total_units}</td><td style="text-align:right">${fmtMoney(p.total_revenue)}</td></tr></tfoot>
      </table></div></div>`;
    }

    body.innerHTML = html;
  }

  F('ic-refresh-sales').addEventListener('click', () => loadSales(true));

  /* ── Load ─────────────────────────────────────────────────────── */
  async function loadCampaign() {
    const res = await fetch(`/api/influencer-campaigns/${campaignId}`);
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) { alert('Campaign not found'); window.location.href = '/influencers.html'; return; }
    campaign = await res.json();
    populateForm(campaign);
  }

  if (campaignId) loadCampaign();
})();
