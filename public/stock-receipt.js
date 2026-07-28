'use strict';

let receiptId         = null;
let formData          = {};
let sizesData         = [];
let photosData        = [];
let measurementFields = [];
let suppliersConfig   = [];
let isReadOnly        = false;
let typeVal           = 'restock';
let invoiceVal        = null;
let rackVal           = null;

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(window.location.search);
  receiptId = Number(params.get('id'));
  if (!receiptId) {
    document.getElementById('srf-body').innerHTML = '<div class="error-msg">No receipt ID in URL.</div>';
    return;
  }

  try {
    const [dataRes, configRes] = await Promise.all([
      fetch(`/api/stock-receipts/${receiptId}`),
      fetch('/api/srf/config'),
    ]);
    if (!dataRes.ok) throw new Error(`HTTP ${dataRes.status}`);
    const { receipt, sizes, photos, audit } = await dataRes.json();
    const config = configRes.ok ? await configRes.json() : { formTypes: [], sizeGroups: [] };

    formData   = receipt;
    sizesData  = sizes;
    photosData = photos;
    isReadOnly = receipt.status === 'complete';
    typeVal    = receipt.receipt_type || 'restock';
    invoiceVal = receipt.stock_matches_invoice;
    rackVal    = receipt.on_rack_for_photoshoot;

    const ft = config.formTypes.find(f => f.id === receipt.form_type_id);
    measurementFields = Array.isArray(ft?.measurement_fields) ? ft.measurement_fields
      : (ft?.measurement_fields ? JSON.parse(ft.measurement_fields) : []);
    suppliersConfig = (config.suppliers || []).map(s => s.company_name);

    renderActionBar(receipt);
    renderBody(receipt, sizes, photos, audit);
  } catch (err) {
    document.getElementById('srf-body').innerHTML =
      `<div class="error-msg">Error loading receipt: ${escHtml(err.message)}</div>`;
  }
}

// ── Action bar ────────────────────────────────────────────────────

function renderActionBar(r) {
  const statusHtml = `<span class="srf-status-badge ${r.status}">${statusLabel(r.status)}</span>`;
  const sub = [r.form_type_name, r.size_group_name, r.receipt_type === 'new' ? 'New Product' : 'Restock']
    .filter(Boolean).join(' · ');

  document.getElementById('srf-head-title').textContent = r.style_name || `Receipt #${receiptId}`;
  document.getElementById('srf-head-sub').innerHTML = escHtml(sub) + ' ' + statusHtml;

  document.getElementById('srf-pdf-btn').href          = `/api/stock-receipts/${receiptId}/pdf`;
  document.getElementById('srf-pdf-btn').style.display = 'inline-flex';

  const isArchived = !!r.archived_at;

  const archBtn   = document.getElementById('srf-archive-btn');
  const unarchBtn = document.getElementById('srf-unarchive-btn');
  const delBtn    = document.getElementById('srf-delete-btn');

  if (archBtn)   archBtn.style.display   = (!isArchived) ? 'inline-flex' : 'none';
  if (unarchBtn) unarchBtn.style.display = isArchived    ? 'inline-flex' : 'none';
  if (delBtn)    delBtn.style.display    = (!isArchived && !isReadOnly) ? 'inline-flex' : 'none';

  if (isReadOnly || isArchived) {
    document.getElementById('srf-save-btn').style.display     = 'none';
    document.getElementById('srf-complete-btn').style.display = 'none';
  }
}

function statusLabel(s) {
  return s === 'in_progress' ? 'In Progress' : s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Main form ─────────────────────────────────────────────────────

function renderBody(r, sizes, photos, audit) {
  const ro = isReadOnly;
  const features = Array.isArray(r.product_features) ? r.product_features
    : (r.product_features ? JSON.parse(r.product_features) : []);
  while (features.length < 7) features.push('');

  const ro_attr   = ro ? ' readonly' : '';
  const ro_dis    = ro ? ' disabled' : '';
  const v = (s) => `value="${escHtml(String(s ?? ''))}"`;

  document.getElementById('srf-body').innerHTML = `

    <!-- Details -->
    <div class="srf-section">
      <div class="srf-section-title">Details</div>
      <div class="srf-row cols-2">
        <div class="srf-field srf-ac-wrap" id="style-wrap">
          <label>Style Name</label>
          <input type="text" id="f-style-name" ${v(r.style_name)} placeholder="e.g. Luna Dress"${ro_attr}
            ${!ro ? 'oninput="onStyleSearch(this.value)" onblur="hideAc(\'style-ac\')"' : ''} />
          <div class="srf-ac-list" id="style-ac"></div>
          <div id="linked-product-strip" style="${r.shopify_product_id ? '' : 'display:none'}">
            ${r.shopify_product_id ? linkedProductHtml(r.shopify_product_title, ro) : ''}
          </div>
          <div id="shelf-count-results"></div>
        </div>
        <div class="srf-field">
          <label>Supplier</label>
          ${ro
            ? `<input type="text" id="f-supplier" ${v(r.supplier)} readonly />`
            : `<select id="f-supplier"${ro_dis}>
                <option value="">— Select supplier —</option>
                ${suppliersConfig.map(s =>
                  `<option value="${escHtml(s)}"${r.supplier === s ? ' selected' : ''}>${escHtml(s)}</option>`
                ).join('')}
                ${r.supplier && !suppliersConfig.includes(r.supplier)
                  ? `<option value="${escHtml(r.supplier)}" selected>${escHtml(r.supplier)}</option>`
                  : ''}
              </select>`
          }
        </div>
      </div>
      <div class="srf-row cols-4">
        <div class="srf-field">
          <label>Receipt Date</label>
          <input type="date" id="f-receipt-date" value="${r.receipt_date ? String(r.receipt_date).slice(0,10) : ''}"${ro_attr} />
        </div>
        <div class="srf-field">
          <label>Processed By</label>
          <input type="text" id="f-processed-by" ${v(r.processed_by)} placeholder="Name or initials" maxlength="40"${ro_attr} />
        </div>
        <div class="srf-field srf-ac-wrap">
          <label>PO Number</label>
          <input type="text" id="f-po-number" ${v(r.po_number)} placeholder="PO-001"${ro_attr}
            ${!ro ? 'oninput="onPoSearch(this.value)" onblur="hideAc(\'po-ac\')"' : ''} />
          <div class="srf-ac-list" id="po-ac"></div>
        </div>
        <div class="srf-field">
          <label>Invoice #</label>
          <input type="text" id="f-invoice-number" ${v(r.invoice_number)} placeholder="INV-0001"${ro_attr} />
        </div>
      </div>
      <div class="srf-row cols-2">
        <div class="srf-field">
          <label>Product Code</label>
          <input type="text" id="f-product-code" ${v(r.product_code)} placeholder="e.g. LUN-DR-BLU"${ro_attr} />
        </div>
        <div class="srf-field">
          <label>Receipt Type</label>
          <div class="srf-type-btns">
            <button class="srf-type-btn" id="type-restock" onclick="setType('restock')"${ro_dis}>Restock</button>
            <button class="srf-type-btn" id="type-new"     onclick="setType('new')"${ro_dis}>New Product</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Pricing -->
    <div class="srf-section">
      <div class="srf-section-title">Pricing</div>
      <div class="srf-row cols-4">
        <div class="srf-field">
          <label>Cost Price ($)</label>
          <input type="number" id="f-cost-price" value="${r.cost_price ?? ''}" placeholder="0.00" step="0.01" min="0"${ro_attr} oninput="calcFinal()" />
        </div>
        <div class="srf-field">
          <label>Discount (%)</label>
          <input type="number" id="f-discount-percent" value="${r.discount_percent ?? ''}" placeholder="0" step="0.01" min="0" max="100"${ro_attr} oninput="calcFinal()" />
        </div>
        <div class="srf-field">
          <label>Freight ($)</label>
          <input type="number" id="f-freight-price" value="${r.freight_price ?? ''}" placeholder="0.00" step="0.01" min="0"${ro_attr} oninput="calcFinal()" />
        </div>
        <div class="srf-field">
          <label>Final Price ($) <span style="font-weight:400;color:#94a3b8;font-size:0.72rem">per unit</span></label>
          <input type="number" id="f-final-price" value="${r.final_price ?? ''}" placeholder="auto" step="0.01" min="0"${ro_attr} />
        </div>
      </div>
    </div>

    <!-- Product Info -->
    <div class="srf-section">
      <div class="srf-section-title">Product Info</div>
      <div class="srf-row cols-2">
        <div class="srf-field">
          <label>Fabric</label>
          <input type="text" id="f-fabric" ${v(r.fabric)} placeholder="e.g. 100% Polyester"${ro_attr} />
        </div>
        <div class="srf-field">
          <label>Stretch Allowance</label>
          <input type="text" id="f-stretch-allowance" ${v(r.stretch_allowance)} placeholder="e.g. 4-way stretch"${ro_attr} />
        </div>
      </div>
      <div class="srf-row cols-2">
        <div class="srf-field">
          <label>Stock Matches Invoice?</label>
          <div class="srf-toggle-row">
            <button class="srf-toggle" id="tog-inv-yes" onclick="setToggle('invoice',true)"${ro_dis}>Yes</button>
            <button class="srf-toggle" id="tog-inv-no"  onclick="setToggle('invoice',false)"${ro_dis}>No</button>
          </div>
        </div>
        <div class="srf-field">
          <label>On Rack for Photoshoot?</label>
          <div class="srf-toggle-row">
            <button class="srf-toggle" id="tog-rack-yes" onclick="setToggle('rack',true)"${ro_dis}>Yes</button>
            <button class="srf-toggle" id="tog-rack-no"  onclick="setToggle('rack',false)"${ro_dis}>No</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Size Grid -->
    <div class="srf-section">
      <div class="srf-section-title">Size Grid</div>
      <div class="srf-size-grid-wrap" id="size-grid-wrap"></div>
    </div>

    <!-- Product Features -->
    <div class="srf-section">
      <div class="srf-section-title">Product Features <span style="font-weight:400;text-transform:none;font-size:0.72rem;color:#94a3b8">(up to 7)</span></div>
      <div class="srf-features-list">
        ${features.map((f, i) => `
          <div class="srf-feature-row">
            <span class="srf-feature-num">${i+1}.</span>
            <input type="text" class="feature-input" data-idx="${i}" value="${escHtml(f)}" placeholder="Feature ${i+1}…" maxlength="120"${ro_attr} />
          </div>`).join('')}
      </div>
    </div>

    <!-- Shopify product link (only show when unlinked + editable) -->
    <div class="srf-section" id="shopify-link-section" style="${(r.shopify_product_id || ro) ? 'display:none' : ''}">
      <div class="srf-section-title">Link to Shopify Product <span style="font-weight:400;text-transform:none;font-size:0.72rem;color:#94a3b8">(optional — enables shelf count)</span></div>
      <div class="srf-field srf-ac-wrap">
        <label>Search by style name</label>
        <input type="text" id="shopify-search" placeholder="Start typing…"
          oninput="onShopifySearch(this.value)" onblur="hideAc('shopify-ac')" />
        <div class="srf-ac-list" id="shopify-ac"></div>
      </div>
    </div>

    <!-- Notes -->
    <div class="srf-section">
      <div class="srf-section-title">Notes</div>
      <textarea id="f-notes" placeholder="Any additional notes…"${ro_attr}>${escHtml(r.notes || '')}</textarea>
    </div>

    <!-- Photos -->
    <div class="srf-section">
      <div class="srf-section-title">Photos <span style="font-weight:400;text-transform:none;font-size:0.72rem;color:#94a3b8">(up to 3)</span></div>
      <div class="srf-photos-row" id="photos-row"></div>
      <input type="file" id="photo-input" accept="image/*" style="display:none" onchange="handlePhotoFile(this)" />
    </div>

    <!-- Audit Trail -->
    <div class="srf-section">
      <button class="srf-audit-toggle" onclick="toggleAudit()">
        <span id="audit-arrow">▶</span>&nbsp; Audit Trail (${audit.length})
      </button>
      <div class="srf-audit-body" id="audit-body">
        ${renderAuditHtml(audit)}
      </div>
    </div>
  `;

  // Apply initial toggle + type states
  applyTypeButtons();
  applyToggleButtons();
  renderSizeGrid(sizes);
  renderPhotos(photos);
}

function linkedProductHtml(title, ro) {
  return `<div class="srf-linked-product">
    <span class="srf-lp-title">Linked: ${escHtml(title || '')}</span>
    ${!ro ? '<button onclick="unlinkProduct()">Unlink</button>' : ''}
    <button onclick="loadShelfCount()">Check Stock</button>
  </div>`;
}

// ── Type toggle ───────────────────────────────────────────────────

function setType(type) {
  typeVal = type;
  applyTypeButtons();
}

function applyTypeButtons() {
  const rs = document.getElementById('type-restock');
  const nw = document.getElementById('type-new');
  if (!rs || !nw) return;
  rs.classList.toggle('active', typeVal === 'restock');
  nw.classList.toggle('active', typeVal === 'new');
}

// ── Yes/No toggles ────────────────────────────────────────────────

function setToggle(which, val) {
  if (which === 'invoice') invoiceVal = val;
  else                     rackVal    = val;
  applyToggleButtons();
}

function applyToggleButtons() {
  applyToggle('tog-inv-yes',  'tog-inv-no',  invoiceVal);
  applyToggle('tog-rack-yes', 'tog-rack-no', rackVal);
}

function applyToggle(yesId, noId, val) {
  const y = document.getElementById(yesId);
  const n = document.getElementById(noId);
  if (!y || !n) return;
  y.className = 'srf-toggle' + (val === true  ? ' active-yes' : '');
  n.className = 'srf-toggle' + (val === false ? ' active-no'  : '');
}

// ── Price calc ────────────────────────────────────────────────────

function calcFinal() {
  const cost     = parseFloat(document.getElementById('f-cost-price')?.value)     || 0;
  const discount = parseFloat(document.getElementById('f-discount-percent')?.value) || 0;
  const freight  = parseFloat(document.getElementById('f-freight-price')?.value)   || 0;
  if (!cost) return;
  const el = document.getElementById('f-final-price');
  if (el) el.value = ((cost * (1 - discount / 100)) + freight).toFixed(2);
}

// ── Size grid ─────────────────────────────────────────────────────

function renderSizeGrid(sizes) {
  const wrap = document.getElementById('size-grid-wrap');
  if (!wrap) return;
  if (!sizes.length) {
    wrap.innerHTML = '<div style="color:#94a3b8;font-size:0.9rem">No sizes configured.</div>';
    return;
  }

  const ro     = isReadOnly;
  const mFields = measurementFields;
  let totalQty  = 0;
  sizes.forEach(s => { totalQty += s.qty || 0; });

  const headerCols = ['Size', 'Qty', ...mFields].map(c => `<th>${escHtml(c)}</th>`).join('');

  const rows = sizes.map((s, idx) => {
    const m = typeof s.measurements === 'string' ? JSON.parse(s.measurements) : (s.measurements || {});
    const mCells = mFields.map(field => {
      const mv = m[field] != null ? m[field] : '';
      return ro
        ? `<td><input type="number" value="${escHtml(String(mv))}" readonly /></td>`
        : `<td><input type="number" class="meas-input" data-sidx="${idx}" data-field="${escHtml(field)}" value="${escHtml(String(mv))}" step="0.1" min="0" /></td>`;
    }).join('');

    const qtyCell = ro
      ? `<input type="number" value="${s.qty ?? ''}" readonly />`
      : `<input type="number" class="qty-input" data-sidx="${idx}" value="${s.qty ?? ''}" min="0" step="1" oninput="updateTotal()" />`;

    return `<tr>
      <td class="srf-size-label">${escHtml(s.size_label)}</td>
      <td>${qtyCell}</td>
      ${mCells}
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <table class="srf-size-grid">
      <thead><tr>${headerCols}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td id="size-total" style="font-weight:700">${totalQty}</td>
          ${mFields.map(() => '<td></td>').join('')}
        </tr>
      </tfoot>
    </table>`;
}

function updateTotal() {
  let t = 0;
  document.querySelectorAll('.qty-input').forEach(i => { t += Number(i.value) || 0; });
  const el = document.getElementById('size-total');
  if (el) el.textContent = t;
}

function buildSizeGridData() {
  return sizesData.map((s, idx) => {
    const qEl = document.querySelector(`.qty-input[data-sidx="${idx}"]`);
    const qty = qEl ? (qEl.value !== '' ? Number(qEl.value) : null) : s.qty;
    const measurements = {};
    measurementFields.forEach(field => {
      const el = document.querySelector(`.meas-input[data-sidx="${idx}"][data-field="${field}"]`);
      if (el && el.value !== '') measurements[field] = Number(el.value);
    });
    return { size_label: s.size_label, qty, measurements };
  });
}

// ── PO autocomplete ───────────────────────────────────────────────

let poTimer = null;
function onPoSearch(q) {
  clearTimeout(poTimer);
  if (!q) { hideAc('po-ac'); return; }
  poTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/srf/po-search?q=${encodeURIComponent(q)}`);
      const rows = await r.json();
      const list = document.getElementById('po-ac');
      if (!list) return;
      if (!rows.length) { list.style.display = 'none'; return; }
      list.innerHTML = rows.map(po =>
        `<div class="srf-ac-item" data-po="${escHtml(po.po_number)}" onmousedown="selectPo(this)">
          ${escHtml(po.po_number)}
          <div class="srf-ac-sub">${escHtml(po.supplier_name || '')} · ${po.order_date ? String(po.order_date).slice(0,10) : ''}</div>
        </div>`
      ).join('');
      list.style.display = 'block';
    } catch (_) {}
  }, 280);
}

function selectPo(el) {
  const inp = document.getElementById('f-po-number');
  if (inp) inp.value = el.dataset.po;
  hideAc('po-ac');
}

// ── Style name → Shopify link autocomplete ────────────────────────

let styleTimer = null;
function onStyleSearch(q) {
  clearTimeout(styleTimer);
  if (!q || q.length < 2) { hideAc('style-ac'); return; }
  styleTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/srf/style-search?q=${encodeURIComponent(q)}`);
      const results = await r.json();
      const list = document.getElementById('style-ac');
      if (!list || !results.length) { if (list) list.style.display = 'none'; return; }
      list.innerHTML = results.map(p =>
        `<div class="srf-ac-item" data-id="${p.id}" data-title="${escHtml(p.title)}" onmousedown="selectStyleProduct(this)">
          ${escHtml(p.title)}
          ${p.sku ? `<div class="srf-ac-sub">SKU: ${escHtml(p.sku)}</div>` : ''}
        </div>`
      ).join('');
      list.style.display = 'block';
    } catch (_) {}
  }, 300);
}

function selectStyleProduct(el) {
  const inp = document.getElementById('f-style-name');
  if (inp) inp.value = el.dataset.title;
  hideAc('style-ac');
  linkProduct(Number(el.dataset.id), el.dataset.title);
}

// ── Standalone Shopify search section ────────────────────────────

let shopifyTimer = null;
function onShopifySearch(q) {
  clearTimeout(shopifyTimer);
  if (!q || q.length < 2) { hideAc('shopify-ac'); return; }
  shopifyTimer = setTimeout(async () => {
    try {
      const r = await fetch(`/api/srf/style-search?q=${encodeURIComponent(q)}`);
      const results = await r.json();
      const list = document.getElementById('shopify-ac');
      if (!list || !results.length) { if (list) list.style.display = 'none'; return; }
      list.innerHTML = results.map(p =>
        `<div class="srf-ac-item" data-id="${p.id}" data-title="${escHtml(p.title)}" onmousedown="selectShopifyProd(this)">
          ${escHtml(p.title)}
          ${p.sku ? `<div class="srf-ac-sub">SKU: ${escHtml(p.sku)}</div>` : ''}
        </div>`
      ).join('');
      list.style.display = 'block';
    } catch (_) {}
  }, 300);
}

function selectShopifyProd(el) {
  const id = Number(el.dataset.id);
  const t  = el.dataset.title;
  const inp = document.getElementById('shopify-search');
  if (inp) inp.value = '';
  hideAc('shopify-ac');
  linkProduct(id, t);
  const sec = document.getElementById('shopify-link-section');
  if (sec) sec.style.display = 'none';
}

function linkProduct(id, title) {
  formData.shopify_product_id    = id;
  formData.shopify_product_title = title;
  const strip = document.getElementById('linked-product-strip');
  if (strip) {
    strip.style.display = '';
    strip.innerHTML = linkedProductHtml(title, false);
  }
}

function unlinkProduct() {
  formData.shopify_product_id    = null;
  formData.shopify_product_title = null;
  const strip = document.getElementById('linked-product-strip');
  if (strip) { strip.style.display = 'none'; strip.innerHTML = ''; }
  const sc = document.getElementById('shelf-count-results');
  if (sc) sc.innerHTML = '';
  const sec = document.getElementById('shopify-link-section');
  if (sec) sec.style.display = '';
}

// ── Shelf count ───────────────────────────────────────────────────

async function loadShelfCount() {
  const el = document.getElementById('shelf-count-results');
  if (!el) return;
  el.innerHTML = '<div style="color:#64748b;font-size:0.85rem;padding:8px 0">Loading shelf count…</div>';
  try {
    const productId = formData.shopify_product_id || null;
    const qs = productId ? `?product_id=${productId}` : '';
    const r    = await fetch(`/api/stock-receipts/${receiptId}/shelf-count${qs}`);
    const data = await r.json();
    if (data.note) {
      el.innerHTML = `<div style="color:#94a3b8;font-size:0.85rem;padding:8px 0">${escHtml(data.note)}</div>`;
      return;
    }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const t = data.totals;
    el.innerHTML = `
      <div class="srf-shelf-results">
        <div class="srf-shelf-title">Stock on Shelf — ${escHtml(data.product_title || '')}</div>
        <table>
          <thead>
            <tr>
              <th>Variant</th><th>SKU</th>
              <th title="Shopify available qty">Available</th>
              <th title="Qty in unfulfilled orders">Committed</th>
              <th title="WMS picks not yet fulfilled">WMS Picked</th>
              <th title="Available + Committed − WMS Picked" style="color:#4f46e5">On Shelf</th>
            </tr>
          </thead>
          <tbody>${data.variants.map(v => `
            <tr>
              <td>${escHtml(v.title)}</td>
              <td style="color:#94a3b8;font-size:0.82rem">${escHtml(v.sku || '—')}</td>
              <td>${v.available}</td>
              <td>${v.committed > 0 ? v.committed : '<span style="color:#94a3b8">0</span>'}</td>
              <td>${v.wms_picked > 0 ? `<span style="color:#dc2626">${v.wms_picked}</span>` : '<span style="color:#94a3b8">0</span>'}</td>
              <td style="font-weight:700;color:${v.true_shelf > 0 ? '#15803d' : '#dc2626'}">${v.true_shelf}</td>
            </tr>`).join('')}
          </tbody>
          ${t ? `<tfoot>
            <tr style="font-weight:700;border-top:2px solid #e2e8f0">
              <td colspan="2">Total</td>
              <td>${t.available}</td>
              <td>${t.committed}</td>
              <td>${t.wms_picked > 0 ? `<span style="color:#dc2626">${t.wms_picked}</span>` : '0'}</td>
              <td style="color:#4f46e5">${t.true_shelf}</td>
            </tr>
          </tfoot>` : ''}
        </table>
        <div class="srf-shelf-note">On Shelf = Available + Committed − WMS Picked (not yet fulfilled)</div>
      </div>`;
  } catch (err) {
    el.innerHTML = `<div style="color:#dc2626;font-size:0.85rem;padding:8px 0">Error: ${escHtml(err.message)}</div>`;
  }
}

async function archiveReceipt() {
  if (!confirm('Archive this receipt? It will be hidden from the main list but can be restored anytime.')) return;
  try {
    const r = await fetch(`/api/stock-receipts/${receiptId}/archive`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    window.location.reload();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function unarchiveReceipt() {
  try {
    const r = await fetch(`/api/stock-receipts/${receiptId}/unarchive`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    window.location.reload();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteReceipt() {
  if (!confirm('Delete this stock receipt? This action is tracked and cannot be undone.')) return;
  try {
    const r = await fetch(`/api/stock-receipts/${receiptId}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    window.location.href = '/stock-receipts.html';
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Photos ────────────────────────────────────────────────────────

function renderPhotos(photos) {
  const row = document.getElementById('photos-row');
  if (!row) return;
  row.innerHTML = '';

  photos.forEach(p => {
    const wrap = document.createElement('div');
    wrap.className = 'srf-photo-thumb';
    wrap.innerHTML = `
      <img id="photo-img-${p.id}" src="" alt="${escHtml(p.filename || 'photo')}" />
      ${!isReadOnly ? `<button class="srf-photo-del" onclick="deletePhoto(${p.id})" title="Remove">×</button>` : ''}`;
    row.appendChild(wrap);
    loadPhotoThumb(p.id);
  });

  if (!isReadOnly && photos.length < 3) {
    const add = document.createElement('div');
    add.className = 'srf-photo-add';
    add.innerHTML = '<span>📷</span>Add Photo';
    add.onclick   = () => document.getElementById('photo-input').click();
    row.appendChild(add);
  }
}

async function loadPhotoThumb(photoId) {
  try {
    const r = await fetch(`/api/stock-receipts/${receiptId}/photos/${photoId}/data`);
    if (!r.ok) return;
    const { data } = await r.json();
    const img = document.getElementById(`photo-img-${photoId}`);
    if (img) img.src = data;
  } catch (_) {}
}

async function handlePhotoFile(input) {
  const file = input.files[0];
  if (!file) return;
  input.value = '';

  const data = await new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });

  setSaveStatus('saving', 'Uploading photo…');
  try {
    const r = await fetch(`/api/stock-receipts/${receiptId}/photos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, data }),
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || `HTTP ${r.status}`);
    photosData.push(result.photo);
    renderPhotos(photosData);
    setSaveStatus('saved', '✓ Photo added');
  } catch (err) {
    setSaveStatus('error', err.message);
  }
}

async function deletePhoto(photoId) {
  if (!confirm('Remove this photo?')) return;
  try {
    const r = await fetch(`/api/stock-receipts/${receiptId}/photos/${photoId}`, { method: 'DELETE' });
    if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
    photosData = photosData.filter(p => p.id !== photoId);
    renderPhotos(photosData);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Audit trail ───────────────────────────────────────────────────

function renderAuditHtml(entries) {
  if (!entries.length) return '<div style="color:#94a3b8;font-size:0.85rem;padding:8px 0">No changes recorded.</div>';
  return entries.map(e => {
    const t = new Date(e.changed_at).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    let what = `<span>${escHtml(e.action)}</span>`;
    if (e.field_name) {
      what = `<span>${escHtml(e.action)} <strong>${escHtml(e.field_name)}</strong></span>`;
      if (e.old_value != null) what += ` <span class="old">${escHtml(e.old_value.slice(0,50))}</span>`;
      if (e.new_value != null) what += ` → <span class="new">${escHtml(e.new_value.slice(0,50))}</span>`;
    }
    return `<div class="srf-audit-entry">
      <span class="srf-audit-time">${t}</span>
      <span class="srf-audit-who">${escHtml((e.changed_by || '?').split('@')[0])}</span>
      <span class="srf-audit-what">${what}</span>
    </div>`;
  }).join('');
}

function toggleAudit() {
  const body  = document.getElementById('audit-body');
  const arrow = document.getElementById('audit-arrow');
  if (!body) return;
  body.classList.toggle('open');
  if (arrow) arrow.textContent = body.classList.contains('open') ? '▼' : '▶';
}

// ── Autocomplete helper ───────────────────────────────────────────

function hideAc(id) {
  setTimeout(() => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }, 180);
}

// ── Save ──────────────────────────────────────────────────────────

function setSaveStatus(state, msg) {
  const el = document.getElementById('srf-save-status');
  if (!el) return;
  el.textContent = msg;
  el.className   = `srf-save-status ${state}`;
  if (state === 'saved') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

function collectFields() {
  const features = Array.from(document.querySelectorAll('.feature-input')).map(i => i.value.trim());
  const num = s => { const n = parseFloat(s); return isNaN(n) ? null : n; };
  return {
    style_name:             document.getElementById('f-style-name')?.value.trim()          || null,
    supplier:               document.getElementById('f-supplier')?.value.trim()            || null,
    receipt_date:           document.getElementById('f-receipt-date')?.value               || null,
    processed_by:           document.getElementById('f-processed-by')?.value.trim()        || null,
    po_number:              document.getElementById('f-po-number')?.value.trim()           || null,
    invoice_number:         document.getElementById('f-invoice-number')?.value.trim()      || null,
    product_code:           document.getElementById('f-product-code')?.value.trim()        || null,
    receipt_type:           typeVal,
    cost_price:             num(document.getElementById('f-cost-price')?.value),
    discount_percent:       num(document.getElementById('f-discount-percent')?.value),
    freight_price:          num(document.getElementById('f-freight-price')?.value),
    final_price:            num(document.getElementById('f-final-price')?.value),
    fabric:                 document.getElementById('f-fabric')?.value.trim()              || null,
    stretch_allowance:      document.getElementById('f-stretch-allowance')?.value.trim()   || null,
    stock_matches_invoice:  invoiceVal,
    on_rack_for_photoshoot: rackVal,
    product_features:       features,
    notes:                  document.getElementById('f-notes')?.value.trim()               || null,
    shopify_product_id:     formData.shopify_product_id    || null,
    shopify_product_title:  formData.shopify_product_title || null,
  };
}

async function saveForm() {
  if (isReadOnly) return;
  setSaveStatus('saving', 'Saving…');
  const btn = document.getElementById('srf-save-btn');
  if (btn) btn.disabled = true;

  try {
    const body = { ...collectFields(), sizes: buildSizeGridData() };
    const r    = await fetch(`/api/stock-receipts/${receiptId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    formData  = { ...formData, ...body };
    sizesData = body.sizes.map((s, i) => ({ ...s, sort_order: i }));

    setSaveStatus('saved', '✓ Saved');
    // Update header title if style name changed
    if (body.style_name) {
      const titleEl = document.getElementById('srf-head-title');
      if (titleEl) titleEl.textContent = body.style_name;
    }
  } catch (err) {
    setSaveStatus('error', 'Error: ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Complete ──────────────────────────────────────────────────────

function openCompleteConfirm() {
  document.getElementById('srf-confirm-overlay').classList.add('open');
}
function closeCompleteConfirm() {
  document.getElementById('srf-confirm-overlay').classList.remove('open');
}

// Close overlay on backdrop click
document.getElementById('srf-confirm-overlay').addEventListener('click', function (e) {
  if (e.target === this) closeCompleteConfirm();
});

async function completeForm() {
  const btn = document.getElementById('srf-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Completing…'; }

  try {
    // Save any unsaved changes first
    const body = { ...collectFields(), sizes: buildSizeGridData() };
    await fetch(`/api/stock-receipts/${receiptId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const r    = await fetch(`/api/stock-receipts/${receiptId}/complete`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    window.location.reload();
  } catch (err) {
    alert('Error completing: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Yes, Complete'; }
    closeCompleteConfirm();
  }
}

// ── Init ──────────────────────────────────────────────────────────

init();
