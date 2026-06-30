(() => {
  const MAX_SINGLE   = 1;
  const MAX_COLLAGE  = 5;

  let jobType    = 'single';
  let selected   = [];  // array of product objects
  let templates  = [];

  const searchInput  = document.getElementById('searchInput');
  const btnSearch    = document.getElementById('btnSearch');
  const productGrid  = document.getElementById('productGrid');
  const selectedList = document.getElementById('selectedList');
  const selCount     = document.getElementById('selCount');
  const templateSel  = document.getElementById('templateSelect');
  const btnSubmit    = document.getElementById('btnSubmit');
  const hintText     = document.getElementById('hintText');
  const statusBar    = document.getElementById('statusBar');
  const btnSingle    = document.getElementById('btnSingle');
  const btnCollage   = document.getElementById('btnCollage');

  // ── Templates ──────────────────────────────────────────────────────
  async function loadTemplates() {
    try {
      const r = await fetch('/api/creative/templates');
      const data = await r.json();
      templates = data.templates || [];
      templateSel.innerHTML = '<option value="">— choose template —</option>' +
        templates.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    } catch (e) {
      console.error('Failed to load templates', e);
    }
  }

  // ── Job type toggle ────────────────────────────────────────────────
  function setJobType(type) {
    jobType = type;
    btnSingle.classList.toggle('active',  type === 'single');
    btnCollage.classList.toggle('active', type === 'collage');
    // Enforce selection limits
    const max = type === 'single' ? MAX_SINGLE : MAX_COLLAGE;
    if (selected.length > max) {
      selected = selected.slice(0, max);
      renderSelected();
      renderGrid();
    }
    validate();
  }

  btnSingle.addEventListener('click',  () => setJobType('single'));
  btnCollage.addEventListener('click', () => setJobType('collage'));

  // ── Product search ─────────────────────────────────────────────────
  async function doSearch() {
    const q = searchInput.value.trim();
    productGrid.innerHTML = '<div class="cs-loading">Searching…</div>';
    try {
      const r = await fetch('/api/creative/products/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Search failed');
      renderGrid(data.products || []);
    } catch (err) {
      productGrid.innerHTML = `<div class="cs-none">Error: ${err.message}</div>`;
    }
  }

  btnSearch.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  // ── Render product grid ────────────────────────────────────────────
  let currentProducts = [];

  function renderGrid(products) {
    if (products) currentProducts = products;
    if (!currentProducts.length) {
      productGrid.innerHTML = '<div class="cs-none">No products found</div>';
      return;
    }
    const max = jobType === 'single' ? MAX_SINGLE : MAX_COLLAGE;
    productGrid.innerHTML = currentProducts.map(p => {
      const isSelected = selected.some(s => s.shopify_product_id === p.shopify_product_id);
      const canSelect  = isSelected || selected.length < max;
      const imgSrc     = (p.images && p.images.length) ? p.images[0] : null;
      return `
        <div class="cs-product-card ${isSelected ? 'selected' : ''}"
             data-id="${p.shopify_product_id}"
             style="${!canSelect ? 'opacity:0.45; cursor:not-allowed;' : ''}">
          ${imgSrc
            ? `<img class="cs-product-img" src="${imgSrc}" alt="" loading="lazy" />`
            : `<div class="cs-product-img-placeholder">📦</div>`}
          <div class="cs-product-info">
            <div class="cs-product-title">${escHtml(p.title)}</div>
            <div class="cs-product-price">${p.price ? '$' + Number(p.price).toFixed(2) : ''}</div>
            <div class="cs-product-vendor">${escHtml(p.vendor || '')}</div>
          </div>
        </div>`;
    }).join('');

    productGrid.querySelectorAll('.cs-product-card').forEach(card => {
      card.addEventListener('click', () => toggleProduct(card.dataset.id));
    });
  }

  function toggleProduct(id) {
    const max = jobType === 'single' ? MAX_SINGLE : MAX_COLLAGE;
    const idx = selected.findIndex(s => s.shopify_product_id === id);
    if (idx !== -1) {
      selected.splice(idx, 1);
    } else {
      if (selected.length >= max) {
        showStatus(`Max ${max} product${max > 1 ? 's' : ''} for ${jobType} job`, 'info');
        return;
      }
      const product = currentProducts.find(p => p.shopify_product_id === id);
      if (product) selected.push(product);
    }
    renderSelected();
    renderGrid();
    validate();
  }

  // ── Render selected list ───────────────────────────────────────────
  function renderSelected() {
    selCount.textContent = `(${selected.length})`;
    if (!selected.length) {
      selectedList.innerHTML = '<li class="cs-empty-sel">No products selected yet</li>';
      return;
    }
    selectedList.innerHTML = selected.map((p, i) => {
      const img = (p.images && p.images.length) ? p.images[0] : null;
      return `
        <li class="cs-selected-item" data-idx="${i}">
          ${img ? `<img src="${img}" alt="" />` : '<span style="width:32px;height:32px;background:#f1f5f9;border-radius:6px;display:inline-block;"></span>'}
          <span class="cs-selected-item-title">${escHtml(p.title)}</span>
          <button class="cs-selected-remove" data-idx="${i}" title="Remove">×</button>
        </li>`;
    }).join('');

    selectedList.querySelectorAll('.cs-selected-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        selected.splice(Number(btn.dataset.idx), 1);
        renderSelected();
        renderGrid();
        validate();
      });
    });
  }

  // ── Validation ────────────────────────────────────────────────────
  function validate() {
    const ok = selected.length > 0 && templateSel.value;
    btnSubmit.disabled = !ok;
    if (!selected.length) {
      hintText.textContent = 'Select a product and template to begin';
    } else if (!templateSel.value) {
      hintText.textContent = 'Choose a template to continue';
    } else {
      hintText.textContent = `Ready to generate ${jobType === 'collage' ? 'a collage' : 'a creative'} for ${selected.length} product${selected.length > 1 ? 's' : ''}`;
    }
  }

  templateSel.addEventListener('change', validate);

  // ── Submit ────────────────────────────────────────────────────────
  btnSubmit.addEventListener('click', async () => {
    btnSubmit.disabled = true;
    showStatus('Syncing products with Shopify…', 'info');

    const productIds = selected.map(p => p.shopify_product_id);

    // Step 1: sync products to DB
    try {
      const syncRes = await fetch('/api/creative/products/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds }),
      });
      const syncData = await syncRes.json();
      if (!syncRes.ok) throw new Error(syncData.error || 'Sync failed');
    } catch (err) {
      showStatus(`Product sync failed: ${err.message}`, 'error');
      btnSubmit.disabled = false;
      return;
    }

    // Step 2: create job
    showStatus('Submitting generation job…', 'info');
    try {
      const jobRes = await fetch('/api/creative/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productIds,
          templateType: templateSel.value,
          jobType,
        }),
      });
      const jobData = await jobRes.json();
      if (!jobRes.ok) throw new Error(jobData.error || 'Job creation failed');

      const status = jobData.job.status;
      showStatus(
        status === 'generating'
          ? `Job submitted to Arcads — check <a href="/creative-review.html">Creative Review</a> for results`
          : `Job queued (Arcads not configured yet) — check <a href="/creative-review.html">Creative Review</a>`,
        'success'
      );

      // Reset selection
      selected = [];
      renderSelected();
      renderGrid();
      templateSel.value = '';
      validate();
    } catch (err) {
      showStatus(`Job creation failed: ${err.message}`, 'error');
      btnSubmit.disabled = false;
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────
  function showStatus(msg, type) {
    statusBar.innerHTML = msg;
    statusBar.className = `cs-status-bar ${type}`;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────
  loadTemplates();
  validate();
})();
