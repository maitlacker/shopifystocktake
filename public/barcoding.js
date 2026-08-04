/* Barcoding — GTIN prep page */
(function () {
  let data          = null;   // { prefixes, products, fetched_at }
  let activeFilter  = 'all';
  let supplierFilter = '';
  let searchTerm    = '';

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmtNum(n) { return Number(n || 0).toLocaleString('en-AU'); }

  const CAT_LABEL = { exclusive: 'Exclusive', off_the_shelf: 'Off The Shelf' };

  /* ── Load ─────────────────────────────────────────────────────── */
  async function load(refresh) {
    document.getElementById('bc-loading').style.display = '';
    document.getElementById('bc-body').style.display = 'none';
    try {
      const res = await fetch(`/api/barcoding/overview${refresh ? '?refresh=1' : ''}`);
      if (res.status === 401) { window.location.href = '/login'; return; }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Load failed');
      data = body;
      renderAll();
      document.getElementById('bc-loading').style.display = 'none';
      document.getElementById('bc-body').style.display = '';
    } catch (err) {
      document.getElementById('bc-loading').textContent = `Failed to load: ${err.message}`;
    }
  }

  function renderAll() {
    renderStats();
    renderSuppliers();
    renderSupplierFilter();
    renderStyles();
    renderExports();
  }

  /* ── Stats ────────────────────────────────────────────────────── */
  function renderStats() {
    const ps = data.products;
    document.getElementById('stat-styles').textContent     = fmtNum(ps.length);
    document.getElementById('stat-skus').textContent       = fmtNum(ps.reduce((s, p) => s + p.sku_count, 0));
    document.getElementById('stat-exclusive').textContent  = fmtNum(ps.filter(p => p.effective === 'exclusive').length);
    document.getElementById('stat-ots').textContent        = fmtNum(ps.filter(p => p.effective === 'off_the_shelf').length);
    document.getElementById('stat-unassigned').textContent = fmtNum(ps.filter(p => !p.effective).length);
    document.getElementById('stat-barcoded').textContent   = fmtNum(ps.reduce((s, p) => s + p.barcode_count, 0));
  }

  /* ── Suppliers table ──────────────────────────────────────────── */
  function renderSuppliers() {
    const tbody = document.getElementById('bc-suppliers-tbody');
    tbody.innerHTML = data.prefixes.map(px => {
      const seg = (val, label, cls) => {
        const on = (px.default_categorisation || null) === val;
        return `<button data-prefix="${escHtml(px.prefix)}" data-val="${val ?? ''}" class="${on ? cls : ''}">${label}</button>`;
      };
      const nameCell = px.crm_supplier_id
        ? `<span style="font-weight:600;color:#1e293b">${escHtml(px.supplier_name)}</span>
           <a href="/suppliers.html" title="Linked from Production → Suppliers"
              style="font-size:0.68rem;color:#15803d;background:#dcfce7;border-radius:99px;padding:2px 8px;margin-left:6px;text-decoration:none;font-weight:700">CRM</a>`
        : `<input class="bc-supplier-input" data-prefix="${escHtml(px.prefix)}"
                  value="${escHtml(px.supplier_name || '')}" placeholder="Supplier name… (or set prefix on the supplier in Production → Suppliers)" />`;
      return `
        <tr>
          <td><span class="bc-prefix-code">${escHtml(px.prefix)}</span></td>
          <td>${nameCell}</td>
          <td style="text-align:center">${fmtNum(px.style_count)}</td>
          <td style="text-align:center">${fmtNum(px.sku_count)}</td>
          <td>
            <span class="bc-seg">
              ${seg('exclusive', 'Exclusive', 'on-exclusive')}
              ${seg('off_the_shelf', 'Off The Shelf', 'on-ots')}
              ${seg(null, 'Mixed', 'on-mixed')}
            </span>
          </td>
          <td style="text-align:center">${px.unassigned_styles ? `<strong style="color:#d97706">${fmtNum(px.unassigned_styles)}</strong>` : '0'}</td>
        </tr>`;
    }).join('');

    // Name inputs — save on change
    tbody.querySelectorAll('.bc-supplier-input').forEach(input => {
      input.addEventListener('change', () => saveSupplier(input.dataset.prefix, { supplier_name: input.value.trim() }, input));
    });

    // Default categorisation segments
    tbody.querySelectorAll('.bc-seg button').forEach(btn => {
      btn.addEventListener('click', () => {
        saveSupplier(btn.dataset.prefix, { default_categorisation: btn.dataset.val || null });
      });
    });
  }

  async function saveSupplier(prefix, patch, inputEl) {
    const px = data.prefixes.find(p => p.prefix === prefix);
    if (!px) return;
    const payload = {
      supplier_name: patch.supplier_name !== undefined ? patch.supplier_name : px.supplier_name,
      default_categorisation: patch.default_categorisation !== undefined ? patch.default_categorisation : px.default_categorisation,
    };
    try {
      const res = await fetch(`/api/barcoding/suppliers/${encodeURIComponent(prefix)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const saved = await res.json();
      if (!res.ok) throw new Error(saved.error || 'Save failed');

      px.supplier_name          = saved.supplier_name;
      px.default_categorisation = saved.default_categorisation;

      // Recompute effective categorisation client-side
      data.products.forEach(p => {
        if (p.prefix === prefix) {
          p.effective = p.manual_categorisation || px.default_categorisation || null;
          p.source    = p.manual_categorisation ? 'manual' : (p.effective ? 'supplier_default' : null);
        }
      });
      recountPrefixes();
      renderAll();
      if (inputEl) {
        const fresh = document.querySelector(`.bc-supplier-input[data-prefix="${CSS.escape(prefix)}"]`);
        if (fresh) { fresh.classList.add('saved'); setTimeout(() => fresh.classList.remove('saved'), 1500); }
      }
    } catch (err) {
      alert(`Failed to save supplier: ${err.message}`);
    }
  }

  function recountPrefixes() {
    data.prefixes.forEach(px => {
      const styles = data.products.filter(p => p.prefix === px.prefix);
      px.exclusive_styles  = styles.filter(p => p.effective === 'exclusive').length;
      px.ots_styles        = styles.filter(p => p.effective === 'off_the_shelf').length;
      px.unassigned_styles = styles.filter(p => !p.effective).length;
    });
  }

  /* ── Supplier filter dropdown ─────────────────────────────────── */
  function renderSupplierFilter() {
    const sel = document.getElementById('bc-supplier-filter');
    const current = supplierFilter;
    sel.innerHTML = '<option value="">All suppliers</option>' + data.prefixes.map(px =>
      `<option value="${escHtml(px.prefix)}" ${px.prefix === current ? 'selected' : ''}>
        ${escHtml(px.prefix)}${px.supplier_name ? ' — ' + escHtml(px.supplier_name) : ''}
      </option>`).join('');
  }

  /* ── Styles table ─────────────────────────────────────────────── */
  function visibleProducts() {
    let ps = data.products;
    if (activeFilter === 'unassigned')        ps = ps.filter(p => !p.effective);
    else if (activeFilter !== 'all')          ps = ps.filter(p => p.effective === activeFilter);
    if (supplierFilter)                       ps = ps.filter(p => p.prefix === supplierFilter);
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      ps = ps.filter(p => p.title.toLowerCase().includes(t) || p.prefix.toLowerCase().includes(t));
    }
    return ps;
  }

  function renderStyles() {
    const tbody = document.getElementById('bc-styles-tbody');
    const ps = visibleProducts();
    document.getElementById('bc-styles-count').textContent =
      `Showing ${fmtNum(ps.length)} of ${fmtNum(data.products.length)} styles`;

    if (!ps.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="bc-empty">No styles match the current filters.</td></tr>';
      return;
    }

    const supplierNames = {};
    data.prefixes.forEach(px => { supplierNames[px.prefix] = px.supplier_name; });

    tbody.innerHTML = ps.map(p => {
      const isEx  = p.effective === 'exclusive';
      const isOts = p.effective === 'off_the_shelf';
      const auto  = p.source === 'supplier_default';
      const exCls  = isEx  ? (auto ? 'ex-auto'  : 'ex-on')  : '';
      const otsCls = isOts ? (auto ? 'ots-auto' : 'ots-on') : '';
      const supplierLabel = supplierNames[p.prefix]
        ? escHtml(supplierNames[p.prefix])
        : `<span style="color:#94a3b8">${escHtml(p.prefix)}</span>`;
      const statusBadge = p.status !== 'active'
        ? `<span class="bc-status-badge ${escHtml(p.status)}">${escHtml(p.status)}</span>` : '';
      return `
        <tr>
          <td>${p.image ? `<img class="bc-thumb" src="${escHtml(p.image)}" alt="" loading="lazy" />` : '<span class="bc-thumb" style="display:inline-block"></span>'}</td>
          <td>
            <div class="bc-style-name">${escHtml(p.title)} ${statusBadge}</div>
            <div class="bc-style-meta">Prefix ${escHtml(p.prefix)}</div>
          </td>
          <td>${supplierLabel}</td>
          <td style="text-align:center">${fmtNum(p.sku_count)}</td>
          <td style="text-align:center">${p.barcode_count ? fmtNum(p.barcode_count) : '—'}</td>
          <td>
            <span class="bc-pills" data-id="${p.product_id}">
              <button class="bc-pill ${exCls}" data-cat="exclusive">Exclusive</button>
              <button class="bc-pill ${otsCls}" data-cat="off_the_shelf">Off The Shelf</button>
            </span>
            ${auto ? '<span class="bc-auto-tag">auto</span>' : ''}
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.bc-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const productId = btn.closest('.bc-pills').dataset.id;
        toggleCategorisation(productId, btn.dataset.cat);
      });
    });
  }

  async function toggleCategorisation(productId, cat) {
    const p = data.products.find(x => String(x.product_id) === String(productId));
    if (!p) return;

    // Clicking the already-manual pill clears the override (falls back to supplier default)
    const newCat = (p.manual_categorisation === cat) ? null : cat;

    try {
      const res = await fetch(`/api/barcoding/products/${productId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ categorisation: newCat, product_title: p.title }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Save failed');

      const px = data.prefixes.find(x => x.prefix === p.prefix);
      p.manual_categorisation = newCat;
      p.effective = newCat || (px && px.default_categorisation) || null;
      p.source    = newCat ? 'manual' : (p.effective ? 'supplier_default' : null);

      recountPrefixes();
      renderStats();
      renderSuppliers();
      renderStyles();
      renderExports();
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    }
  }

  /* ── Exports ──────────────────────────────────────────────────── */
  function renderExports() {
    const wrap = document.getElementById('bc-exports');
    const exclusiveSkus = data.products
      .filter(p => p.effective === 'exclusive')
      .reduce((s, p) => s + p.sku_count, 0);

    let html = `
      <div class="bc-export-row gs1">
        <div class="bc-export-info">
          <div class="bc-export-name">Exclusive — GS1 GTIN creation list</div>
          <div class="bc-export-meta">${fmtNum(exclusiveSkus)} SKUs across all suppliers, ready to work into your GS1 Australia import</div>
        </div>
        <a class="btn btn-primary" href="/api/barcoding/export?type=exclusive" ${exclusiveSkus ? '' : 'style="pointer-events:none;opacity:0.5"'}>Download CSV</a>
      </div>`;

    const otsPrefixes = data.prefixes.filter(px => px.ots_styles > 0);
    if (otsPrefixes.length) {
      html += otsPrefixes.map(px => {
        const skus = data.products
          .filter(p => p.prefix === px.prefix && p.effective === 'off_the_shelf')
          .reduce((s, p) => s + p.sku_count, 0);
        return `
          <div class="bc-export-row">
            <div class="bc-export-info">
              <div class="bc-export-name">${escHtml(px.supplier_name || px.prefix)} — Off The Shelf GTIN request</div>
              <div class="bc-export-meta">${fmtNum(px.ots_styles)} styles · ${fmtNum(skus)} SKUs · blank GTIN column for the supplier to fill in</div>
            </div>
            <a class="btn" href="/api/barcoding/export?type=off_the_shelf&prefix=${encodeURIComponent(px.prefix)}">Download CSV</a>
          </div>`;
      }).join('');
    } else {
      html += '<div class="bc-empty" style="padding:20px">No Off The Shelf styles assigned yet — supplier export buttons appear here once there are.</div>';
    }
    wrap.innerHTML = html;
  }

  /* ── Toolbar events ───────────────────────────────────────────── */
  document.querySelectorAll('.bc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bc-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderStyles();
    });
  });

  document.getElementById('bc-supplier-filter').addEventListener('change', (e) => {
    supplierFilter = e.target.value;
    renderStyles();
  });

  let searchTimer;
  document.getElementById('bc-style-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTerm = e.target.value.trim(); renderStyles(); }, 200);
  });

  document.getElementById('bc-refresh').addEventListener('click', () => load(true));

  load(false);
})();
