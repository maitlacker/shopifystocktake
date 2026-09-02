'use strict';

// ── State ──────────────────────────────────────────────────────────
let poId       = null;       // null = new, number = existing
let suppliers  = [];
let lines      = [];         // in-memory line items
let lineIdSeq  = 0;          // local IDs for tracking DOM
let currentPO  = null;

const NUMERIC_SIZES = ['6','8','10','12','14','16','18'];
const ALPHA_SIZES   = ['XS','S','M','L','XL','XXL'];
const PANTS_SIZES   = ['6','7','8','9','10','11','12','14','16','18'];

// ── Boot ──────────────────────────────────────────────────────────
(async function init() {
  const params = new URLSearchParams(window.location.search);
  poId = params.get('id') ? parseInt(params.get('id')) : null;

  // Default order date = today
  document.getElementById('po-order-date').value = new Date().toISOString().slice(0,10);

  await loadSuppliers();
  if (poId) {
    await loadPO(poId);
    loadSpecs();
  } else {
    // New PO — prefill the next sequential number (editable = override)
    try {
      const r = await fetch('/api/production-orders/next-number');
      if (r.ok) {
        const { next } = await r.json();
        const el = document.getElementById('po-number');
        if (!el.value.trim()) el.value = next;
      }
    } catch (_) {}
  }
})();

async function loadSuppliers() {
  try {
    const r = await fetch('/api/suppliers');
    if (!r.ok) return;
    suppliers = await r.json();
    const sel = document.getElementById('po-supplier');
    suppliers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.company_name}${s.location ? ` (${s.location})` : ''}`;
      opt.dataset.currency = s.currency;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

async function loadPO(id) {
  try {
    const r = await fetch(`/api/production-orders/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    currentPO = await r.json();
    populateHeader(currentPO);
    lines = [];
    (currentPO.lines || []).forEach(l => {
      const localId = ++lineIdSeq;
      lines.push({
        _lid:           localId,
        dbId:           l.id,
        lineType:       l.line_type,
        productId:      l.product_id,
        productCode:    l.product_code || '',
        productName:    l.product_name || '',
        sizeSet:        l.size_set || 'numeric',
        quantities:     l.quantities || {},
        totalQty:       l.total_qty || 0,
        unitPrice:      parseFloat(l.unit_price) || 0,
        freightOverride:l.freight_override || '',
      });
    });
    renderLines();
    recalcTotals();
    // Show extra action buttons for existing POs
    const pdfBtn = document.getElementById('btn-pdf');
    pdfBtn.href = `/api/production-orders/${id}/pdf`;
    pdfBtn.style.display = '';
    document.getElementById('btn-delete').style.display = '';
    if (currentPO.status === 'draft') {
      document.getElementById('btn-confirm-po').style.display = '';
    }
    document.getElementById('po-status-badge').style.display = '';
    document.getElementById('po-status-badge').className = `po-status-badge ${currentPO.status}`;
    document.getElementById('po-status-badge').textContent = currentPO.status;
    document.getElementById('po-page-title').textContent = `PO — ${currentPO.po_number}`;
    if (currentPO.status !== 'draft') {
      document.getElementById('btn-save').textContent = 'Update';
    }
  } catch (err) {
    alert('Error loading PO: ' + err.message);
  }
}

function populateHeader(po) {
  document.getElementById('po-number').value        = po.po_number || '';
  document.getElementById('po-order-date').value    = po.order_date ? String(po.order_date).slice(0,10) : '';
  document.getElementById('po-delivery-date').value = po.delivery_date ? String(po.delivery_date).slice(0,10) : '';
  document.getElementById('po-freight').value       = po.freight_mode || 'sea';
  document.getElementById('po-currency').value      = po.currency || 'AUD';
  document.getElementById('po-exchange-rate').value = po.exchange_rate || '1.0000';
  document.getElementById('po-notes').value         = po.notes || '';
  document.getElementById('po-freight-terms').value = po.freight_terms || '';
  document.getElementById('tot-shipping').value     = po.shipping_cost || '0';
  document.getElementById('tot-gst').checked        = !!po.include_gst;
  document.getElementById('po-type').value          = po.po_type || 'restock';
  document.getElementById('po-launch-type').value   = po.launch_type || '';
  onLaunchTypeChange();
  document.getElementById('po-collection-name').value = po.collection_name || '';

  if (po.supplier_id) {
    document.getElementById('po-supplier').value = po.supplier_id;
  }
  updateExRateInfo();
}

function onLaunchTypeChange() {
  const val    = document.getElementById('po-launch-type').value;
  const wrap   = document.getElementById('po-collection-wrap');
  const nameEl = document.getElementById('po-collection-name');
  const show   = val === 'new_collection';
  wrap.style.display = show ? '' : 'none';
  if (nameEl) nameEl.required = show;
}

// ── Supplier change ────────────────────────────────────────────────
function onSupplierChange() {
  const sel   = document.getElementById('po-supplier');
  const opt   = sel.options[sel.selectedIndex];
  const curr  = opt?.dataset?.currency || 'AUD';
  document.getElementById('po-currency').value = curr;
  if (curr !== 'AUD') {
    fetchExchangeRate(curr);
  } else {
    document.getElementById('po-exchange-rate').value = '1.0000';
    document.getElementById('po-exrate-info').textContent = '';
    recalcTotals();
  }
}

async function fetchExchangeRate(currency) {
  try {
    const r = await fetch(`/api/exchange-rate?base=${currency}`);
    if (!r.ok) return;
    const data = await r.json();
    const rateToAud = data.rates?.AUD;
    if (rateToAud) {
      document.getElementById('po-exchange-rate').value = rateToAud.toFixed(4);
      updateExRateInfo();
      recalcTotals();
    }
  } catch (_) {}
}

function updateExRateInfo() {
  const currency = document.getElementById('po-currency').value;
  const rate = parseFloat(document.getElementById('po-exchange-rate').value) || 1;
  const info = document.getElementById('po-exrate-info');
  if (currency !== 'AUD') {
    info.innerHTML = `1 ${currency} = <span>${rate.toFixed(4)} AUD</span> (edit to override)`;
  } else {
    info.textContent = '';
  }
}

// ── Lines ──────────────────────────────────────────────────────────
function addLine() {
  const lid = ++lineIdSeq;
  lines.push({
    _lid: lid, dbId: null,
    lineType: 'restock', productId: null, productCode: '', productName: '',
    sizeSet: 'numeric', quantities: {}, totalQty: 0,
    unitPrice: 0, freightOverride: '',
  });
  renderLines();
  // Scroll to new line
  const el = document.getElementById(`line-${lid}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function removeLine(lid) {
  lines = lines.filter(l => l._lid !== lid);
  renderLines();
  recalcTotals();
}

function renderLines() {
  const container = document.getElementById('po-lines-container');
  if (!lines.length) {
    container.innerHTML = `<p style="color:#94a3b8;font-size:0.88rem;text-align:center;padding:20px 0">
      Click <strong>+ Add Line</strong> to add your first product.</p>`;
    return;
  }
  container.innerHTML = lines.map(l => renderLine(l)).join('');

  // Re-attach event listeners for all lines
  lines.forEach(l => bindLineEvents(l._lid));
}

function renderLine(l) {
  const sizeGrid = buildSizeGrid(l);
  const freightSel = `
    <select id="l-freight-${l._lid}" onchange="updateLineField(${l._lid},'freightOverride',this.value)">
      <option value="">Use PO default</option>
      <option value="sea" ${l.freightOverride==='sea'?'selected':''}>🚢 Sea</option>
      <option value="air" ${l.freightOverride==='air'?'selected':''}>✈️ Air</option>
    </select>`;

  return `
  <div class="po-line${l._lid === lineIdSeq ? ' new-line' : ''}" id="line-${l._lid}">
    <div class="po-line-top">
      <div class="po-field" style="margin:0">
        <label>Type</label>
        <select id="l-type-${l._lid}" onchange="onLineTypeChange(${l._lid})">
          <option value="restock" ${l.lineType==='restock'?'selected':''}>Restock</option>
          <option value="new"     ${l.lineType==='new'    ?'selected':''}>New Style</option>
        </select>
      </div>
      <div class="po-field po-autocomplete" style="margin:0" id="autocomplete-wrap-${l._lid}">
        <label>Product Code / SKU</label>
        <input type="text" id="l-code-${l._lid}" value="${escHtml(l.productCode)}"
               placeholder="${l.lineType==='restock' ? 'Search by title or SKU…' : 'Enter product code'}"
               autocomplete="off" />
        <div class="po-autocomplete-list" id="autocomplete-list-${l._lid}" style="display:none"></div>
      </div>
      <div class="po-field" style="margin:0">
        <label>Product Name</label>
        <input type="text" id="l-name-${l._lid}" value="${escHtml(l.productName)}"
               placeholder="Product name" ${l.lineType==='restock'&&l.productId?'readonly':''} />
      </div>
      <button class="po-line-delete" title="Remove line" onclick="removeLine(${l._lid})">✕</button>
    </div>

    <div class="po-line-mid">
      <div class="po-field" style="margin:0">
        <label>Size Set</label>
        <select id="l-sizeset-${l._lid}" onchange="onSizeSetChange(${l._lid})">
          <option value="numeric" ${l.sizeSet==='numeric'?'selected':''}>Numeric (6–18)</option>
          <option value="alpha"   ${l.sizeSet==='alpha'  ?'selected':''}>Alpha (XS–XXL)</option>
          <option value="pants"   ${l.sizeSet==='pants'  ?'selected':''}>Pants/Jeans (6–18)</option>
        </select>
      </div>
      <div class="po-field" style="margin:0">
        <label>Unit Price (${document.getElementById('po-currency').value || 'AUD'})</label>
        <input type="number" id="l-price-${l._lid}" value="${l.unitPrice||''}"
               min="0" step="0.01" placeholder="0.00" oninput="onPriceChange(${l._lid})" />
        <div id="l-aud-${l._lid}" style="font-size:0.72rem;color:#6366f1;font-weight:600;margin-top:3px"></div>
      </div>
      <div class="po-field" style="margin:0">
        <label>Freight Override</label>
        ${freightSel}
      </div>
    </div>

    <div>
      <label style="font-size:0.72rem;font-weight:700;color:#475569;text-transform:uppercase;
                    letter-spacing:0.04em;display:block;margin-bottom:8px">Quantities by Size</label>
      <div class="po-size-grid" id="size-grid-${l._lid}">
        ${sizeGrid}
      </div>
    </div>
  </div>`;
}

function buildSizeGrid(l) {
  const sizes = l.sizeSet === 'alpha' ? ALPHA_SIZES : l.sizeSet === 'pants' ? PANTS_SIZES : NUMERIC_SIZES;
  const cells = sizes.map(sz => `
    <div class="po-size-cell">
      <label>${sz}</label>
      <input type="number" id="sz-${l._lid}-${sz}" min="0" value="${l.quantities[sz]||''}"
             placeholder="0" oninput="onQtyChange(${l._lid})" />
    </div>`).join('');
  return cells + `<div class="po-size-total" id="sz-total-${l._lid}">Total: <strong>${l.totalQty||0}</strong></div>`;
}

function bindLineEvents(lid) {
  const codeInput = document.getElementById(`l-code-${lid}`);
  if (!codeInput) return;
  const line = lines.find(l => l._lid === lid);
  if (!line) return;

  // Autocomplete for restock lines
  if (line.lineType === 'restock') {
    let debounce;
    codeInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => searchProducts(lid, codeInput.value), 300);
    });
    codeInput.addEventListener('blur', () => {
      setTimeout(() => hideAutocomplete(lid), 200);
    });
  }

  // Update productCode on change for new-style lines
  codeInput.addEventListener('change', () => {
    updateLineField(lid, 'productCode', codeInput.value);
  });

  // Name field
  const nameInput = document.getElementById(`l-name-${lid}`);
  if (nameInput) {
    nameInput.addEventListener('change', () => {
      updateLineField(lid, 'productName', nameInput.value);
    });
  }
}

function onLineTypeChange(lid) {
  const type = document.getElementById(`l-type-${lid}`).value;
  updateLineField(lid, 'lineType', type);
  // Clear product info when switching type
  updateLineField(lid, 'productId', null);
  updateLineField(lid, 'productCode', '');
  updateLineField(lid, 'productName', '');
  const codeInput = document.getElementById(`l-code-${lid}`);
  const nameInput = document.getElementById(`l-name-${lid}`);
  if (codeInput) { codeInput.value = ''; codeInput.placeholder = type === 'restock' ? 'Search by title or SKU…' : 'Enter product code'; }
  if (nameInput) { nameInput.value = ''; nameInput.removeAttribute('readonly'); }
  // Re-bind events (autocomplete depends on type)
  bindLineEvents(lid);
}

function onSizeSetChange(lid) {
  const sizeSet = document.getElementById(`l-sizeset-${lid}`).value;
  updateLineField(lid, 'sizeSet', sizeSet);
  updateLineField(lid, 'quantities', {});
  updateLineField(lid, 'totalQty', 0);
  // Re-render just the size grid
  const gridEl = document.getElementById(`size-grid-${lid}`);
  const line = lines.find(l => l._lid === lid);
  if (gridEl && line) gridEl.innerHTML = buildSizeGrid(line);
}

function onQtyChange(lid) {
  const line = lines.find(l => l._lid === lid);
  if (!line) return;
  const sizes = line.sizeSet === 'alpha' ? ALPHA_SIZES : line.sizeSet === 'pants' ? PANTS_SIZES : NUMERIC_SIZES;
  const qtys = {};
  let total = 0;
  sizes.forEach(sz => {
    const v = parseInt(document.getElementById(`sz-${lid}-${sz}`)?.value) || 0;
    if (v > 0) qtys[sz] = v;
    total += v;
  });
  line.quantities = qtys;
  line.totalQty   = total;
  const totEl = document.getElementById(`sz-total-${lid}`);
  if (totEl) totEl.innerHTML = `Total: <strong>${total}</strong>`;
  recalcTotals();
}

function onPriceChange(lid) {
  const val = parseFloat(document.getElementById(`l-price-${lid}`)?.value) || 0;
  updateLineField(lid, 'unitPrice', val);
  recalcTotals();
}

function updateLineField(lid, field, value) {
  const line = lines.find(l => l._lid === lid);
  if (line) line[field] = value;
}

// ── Product Autocomplete ────────────────────────────────────────────
async function searchProducts(lid, query) {
  if (query.length < 2) { hideAutocomplete(lid); return; }
  try {
    const r = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`);
    if (!r.ok) return;
    const results = await r.json();
    showAutocomplete(lid, results);
  } catch (_) {}
}

function showAutocomplete(lid, results) {
  const list = document.getElementById(`autocomplete-list-${lid}`);
  if (!list) return;
  if (!results.length) { list.style.display = 'none'; return; }
  list.innerHTML = results.slice(0, 15).map(p =>
    `<div class="po-autocomplete-item" onmousedown="selectProduct(${lid}, ${p.id}, '${escJs(p.title)}', '${escJs(p.variants?.[0]?.sku||'')}')">
      ${escHtml(p.title)}
      <div class="sku">${escHtml(p.variants?.[0]?.sku || '')}</div>
    </div>`
  ).join('');
  list.style.display = 'block';
}

function hideAutocomplete(lid) {
  const list = document.getElementById(`autocomplete-list-${lid}`);
  if (list) list.style.display = 'none';
}

function selectProduct(lid, productId, title, sku) {
  updateLineField(lid, 'productId',   productId);
  updateLineField(lid, 'productCode', sku);
  updateLineField(lid, 'productName', title);

  const codeEl = document.getElementById(`l-code-${lid}`);
  const nameEl = document.getElementById(`l-name-${lid}`);
  if (codeEl) codeEl.value = sku;
  if (nameEl) { nameEl.value = title; nameEl.setAttribute('readonly', true); }
  hideAutocomplete(lid);
}

// ── Totals ─────────────────────────────────────────────────────────
function recalcTotals() {
  const currency    = document.getElementById('po-currency').value || 'AUD';
  const exRate      = parseFloat(document.getElementById('po-exchange-rate').value) || 1;
  const shipping    = parseFloat(document.getElementById('tot-shipping').value) || 0;
  const includeGst  = document.getElementById('tot-gst').checked;

  // Sum line totals: qty * (unitPrice * exRate) = AUD per line
  let subtotalForeign = 0;
  let subtotalAud     = 0;
  lines.forEach(l => {
    const audUnit  = (l.unitPrice || 0) * exRate;
    const audTotal = (l.totalQty  || 0) * audUnit;
    subtotalForeign += (l.totalQty || 0) * (l.unitPrice || 0);
    subtotalAud     += audTotal;

    // Update per-line AUD display
    const audEl = document.getElementById(`l-aud-${l._lid}`);
    if (audEl) {
      if (currency !== 'AUD' && l.unitPrice > 0) {
        audEl.textContent = `AUD ${audUnit.toFixed(2)} / unit  ·  AUD ${audTotal.toFixed(2)} total`;
      } else {
        audEl.textContent = '';
      }
    }
  });

  const subtotalWithShipping = subtotalAud + shipping;
  const gstAmount = includeGst ? subtotalWithShipping * 0.1 : 0;
  const grand     = subtotalWithShipping + gstAmount;

  const fmt = (n) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  document.getElementById('tot-subtotal').textContent = `AUD ${fmt(subtotalAud)}`;
  document.getElementById('tot-gst-amount').textContent = includeGst ? `AUD ${fmt(gstAmount)}` : '—';
  document.getElementById('tot-gst-amount').style.color = includeGst ? '#1e293b' : '#94a3b8';
  document.getElementById('tot-grand').textContent = `AUD ${fmt(grand)}`;

  // Show foreign currency total if not AUD
  const foreignEl = document.getElementById('tot-foreign');
  if (currency !== 'AUD' && subtotalForeign > 0) {
    foreignEl.textContent = `(${currency} ${fmt(subtotalForeign)} × ${exRate.toFixed(4)})`;
  } else {
    foreignEl.textContent = '';
  }

  updateExRateInfo();
  updateLinesSummary();
}

function updateLinesSummary() {
  const el = document.getElementById('po-lines-summary');
  if (!lines.length) { el.textContent = ''; return; }
  const currency = document.getElementById('po-currency').value || 'AUD';
  const exRate   = parseFloat(document.getElementById('po-exchange-rate').value) || 1;
  const fmt = (n) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  el.innerHTML = lines.map((l, i) => {
    const audUnit  = (l.unitPrice || 0) * exRate;
    const audTotal = (l.totalQty  || 0) * audUnit;
    return `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9">
      <span style="color:#64748b;font-size:0.78rem">Line ${i+1}</span>
      <strong style="margin-left:8px">${escHtml(l.productName || 'Unnamed')}</strong>
      <span style="color:#94a3b8;margin-left:8px">${l.totalQty} units</span>
      ${audTotal > 0 ? `<span style="float:right;font-weight:700">AUD ${fmt(audTotal)}</span>` : ''}
    </div>`;
  }).join('');
}

// ── Save / Confirm / Delete ────────────────────────────────────────
function buildPayload(status) {
  const supplierId = parseInt(document.getElementById('po-supplier').value) || null;
  const supplierOpt = document.getElementById('po-supplier').selectedOptions[0];
  const supplierName = supplierId ? supplierOpt.textContent.replace(/\s*\(.*\)\s*$/, '').trim() : '';

  return {
    poNumber:       document.getElementById('po-number').value.trim(),
    supplierId,
    supplierName,
    orderDate:      document.getElementById('po-order-date').value,
    deliveryDate:   document.getElementById('po-delivery-date').value || null,
    freightMode:    document.getElementById('po-freight').value,
    currency:       document.getElementById('po-currency').value,
    exchangeRate:   parseFloat(document.getElementById('po-exchange-rate').value) || 1,
    shippingCost:   parseFloat(document.getElementById('tot-shipping').value) || 0,
    includeGst:     document.getElementById('tot-gst').checked,
    notes:          document.getElementById('po-notes').value.trim() || null,
    freightTerms:   document.getElementById('po-freight-terms').value.trim() || null,
    poType:         document.getElementById('po-type').value || 'restock',
    launchType:     document.getElementById('po-launch-type').value || '',
    collectionName: document.getElementById('po-collection-name').value.trim() || null,
    status:         status || undefined,
    lines: lines.map(l => ({
      lineType:        l.lineType,
      productId:       l.productId || null,
      productCode:     l.productCode || null,
      productName:     l.productName || '',
      sizeSet:         l.sizeSet,
      quantities:      l.quantities,
      totalQty:        l.totalQty,
      unitPrice:       l.unitPrice,
      freightOverride: l.freightOverride || null,
    })),
  };
}

async function savePO(statusOverride) {
  const payload = buildPayload(statusOverride);
  if (!payload.poNumber)   { alert('PO Number is required.'); return; }
  if (!payload.orderDate)  { alert('Order Date is required.'); return; }
  if (payload.launchType === 'new_collection' && !payload.collectionName) {
    alert('Collection Name is required when Launch Type is "New Collection".');
    document.getElementById('po-collection-name').focus();
    return;
  }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = 'Saving…';

  try {
    const url    = poId ? `/api/production-orders/${poId}` : '/api/production-orders';
    const method = poId ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Save failed');
    }
    const saved = await res.json();
    if (!poId) {
      // Redirect to edit URL so refresh doesn't create another PO
      window.history.replaceState({}, '', `/production-order.html?id=${saved.id}`);
      poId = saved.id;
      document.getElementById('btn-delete').style.display = '';
      document.getElementById('btn-confirm-po').style.display = '';
    }
    currentPO = saved;
    loadSpecs();
    document.getElementById('po-page-title').textContent = `PO — ${saved.po_number}`;
    document.getElementById('po-status-badge').style.display = '';
    document.getElementById('po-status-badge').className = `po-status-badge ${saved.status}`;
    document.getElementById('po-status-badge').textContent = saved.status;
    showToast('PO saved ✓');
  } catch (err) {
    alert('Error saving: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function confirmPO() {
  if (!confirm('Mark this PO as Confirmed? This signals the order has been placed with the supplier.')) return;
  await savePO('confirmed');
  document.getElementById('btn-confirm-po').style.display = 'none';
  document.getElementById('btn-save').textContent = 'Update';
}

async function deletePO() {
  if (!confirm('Permanently delete this production order? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/production-orders/${poId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.location.href = '/production-orders.html';
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Toast ──────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  let el = document.getElementById('po-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'po-toast';
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

// ── Helpers ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escJs(str) {
  return String(str ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

// ── Supplier Order Specs (new styles) ──────────────────────────────
let specsData = {};       // product_code → saved spec (incl. images meta)
const specOpen = {};      // product_code → editor expanded?

function specSizes(sizeSet) {
  return sizeSet === 'alpha' ? ALPHA_SIZES : sizeSet === 'pants' ? PANTS_SIZES : NUMERIC_SIZES;
}

async function loadSpecs() {
  const section = document.getElementById('po-specs-section');
  if (!section) return;
  const newLines = lines.filter(l => l.lineType === 'new' && (l.productCode || '').trim());
  if (!poId || !newLines.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  try {
    const r = await fetch(`/api/production-orders/${poId}/specs`);
    const data = await r.json();
    specsData = {};
    (data.specs || []).forEach(s => { specsData[s.product_code] = s; });
  } catch (_) { specsData = {}; }
  renderSpecs(newLines);
}

function renderSpecs(newLines) {
  const wrap = document.getElementById('po-specs-container');
  wrap.innerHTML = newLines.map(l => {
    const code = l.productCode.trim();
    const spec = specsData[code];
    const open = !!specOpen[code];
    const hasSpec = !!(spec && (spec.fabric || spec.fit_notes || (spec.images || []).length));
    return `
      <div style="border:1.5px solid #e2e8f0;border-radius:12px;margin-bottom:12px;background:#fff">
        <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <span style="font-weight:700;color:#1e293b">${escHtml(l.productName || code)}</span>
            <span style="font-family:ui-monospace,monospace;font-size:0.8rem;color:#64748b;margin-left:8px">${escHtml(code)}</span>
            ${hasSpec ? '<span style="font-size:0.7rem;font-weight:700;background:#dcfce7;color:#15803d;border-radius:99px;padding:2px 8px;margin-left:8px">SPEC ✓</span>'
                      : '<span style="font-size:0.7rem;font-weight:700;background:#fef3c7;color:#92400e;border-radius:99px;padding:2px 8px;margin-left:8px">NO SPEC YET</span>'}
          </div>
          <button class="btn btn-secondary" style="padding:6px 14px;font-size:0.82rem"
            onclick="toggleSpec('${escJs(code)}')">${open ? 'Close' : 'Edit Spec'}</button>
          <a class="btn" style="padding:6px 14px;font-size:0.82rem;background:#4f46e5;color:#fff;text-decoration:none"
            href="/api/production-orders/${poId}/supplier-order/${encodeURIComponent(code)}" target="_blank">⬇ Supplier Order PDF</a>
        </div>
        ${open ? specEditor(l, code, spec || {}) : ''}
      </div>`;
  }).join('');
}

function toggleSpec(code) {
  specOpen[code] = !specOpen[code];
  renderSpecs(lines.filter(l => l.lineType === 'new' && (l.productCode || '').trim()));
}

function specEditor(l, code, s) {
  const sizes = specSizes(l.sizeSet);
  const pt = s.pretreatment || {};
  const bom = Array.isArray(s.bom) && s.bom.length ? s.bom
    : [{ component: 'MAIN', material: '', supplier: '', colour: '' }];
  const chart = Array.isArray(s.spec_chart) && s.spec_chart.length ? s.spec_chart
    : [{ point: '', values: {} }];
  const imgs = s.images || [];
  const front = imgs.find(i => i.kind === 'front');
  const back  = imgs.find(i => i.kind === 'back');
  const refs  = imgs.filter(i => i.kind === 'reference');
  const fld = (label, id, val, ph) => `
    <div>
      <label style="display:block;font-size:0.72rem;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:4px">${label}</label>
      <input type="text" id="${id}" value="${escHtml(val || '')}" placeholder="${escHtml(ph || '')}"
        style="width:100%;padding:8px 11px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.9rem;box-sizing:border-box" />
    </div>`;
  const imgSlot = (kind, img) => `
    <div style="text-align:center">
      <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">${kind}</div>
      <div style="width:130px;height:150px;border:1.5px dashed #cbd5e1;border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#f8fafc">
        ${img ? `<img src="/api/spec-images/${img.id}" style="max-width:100%;max-height:100%;object-fit:contain" />` : '<span style="color:#cbd5e1;font-size:0.8rem">empty</span>'}
      </div>
      <button class="btn btn-secondary" style="padding:4px 10px;font-size:0.75rem;margin-top:6px"
        onclick="uploadSpecImage('${escJs(code)}','${kind.toLowerCase()}')">${img ? 'Replace' : 'Upload'}</button>
    </div>`;

  return `
  <div style="border-top:1.5px solid #e2e8f0;padding:16px" id="spec-ed-${cssId(code)}">
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:14px">
      ${fld('Season', `sp-season-${cssId(code)}`, s.season, 'e.g. Spring/Summer')}
      ${fld('Fabric', `sp-fabric-${cssId(code)}`, s.fabric, 'e.g. Mid Blue Denim Wash (as per sample)')}
      ${fld('Colour', `sp-colour-${cssId(code)}`, s.colour, 'e.g. Chocolate')}
      ${fld('Colour Code', `sp-colourcode-${cssId(code)}`, s.colour_code, 'e.g. CT46')}
    </div>
    <div style="display:flex;gap:18px;margin-bottom:14px;flex-wrap:wrap">
      ${imgSlot('FRONT', front)}
      ${imgSlot('BACK', back)}
      <div style="flex:1;min-width:240px">
        <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Reference Images (buttons, zips, details…)</div>
        ${refs.map(r => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
            <img src="/api/spec-images/${r.id}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0" />
            <span style="flex:1;font-size:0.82rem;color:#334155">${escHtml(r.caption || '(no caption)')}</span>
            <button style="border:none;background:none;color:#ef4444;cursor:pointer;font-weight:700" onclick="deleteSpecImage(${r.id})">✕</button>
          </div>`).join('')}
        <div style="display:flex;gap:6px;margin-top:6px">
          <input type="text" id="sp-refcap-${cssId(code)}" placeholder="Caption for next image…"
            style="flex:1;padding:7px 10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.84rem" />
          <button class="btn btn-secondary" style="padding:6px 12px;font-size:0.8rem" onclick="uploadSpecImage('${escJs(code)}','reference')">+ Add</button>
        </div>
      </div>
    </div>

    <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Fit Notes (one per line — printed on the PDF as written)</div>
    <textarea id="sp-fit-${cssId(code)}" rows="6" style="width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.88rem;font-family:inherit;margin-bottom:12px"
      placeholder="1. Sample size 8 is our production size 12&#10;2. Please reduce the length of size 12 to be 86cm from HSP">${escHtml(s.fit_notes || '')}</textarea>

    <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">Questions for the Factory (optional)</div>
    <textarea id="sp-q-${cssId(code)}" rows="3" style="width:100%;box-sizing:border-box;padding:10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:0.88rem;font-family:inherit;margin-bottom:14px">${escHtml(s.questions || '')}</textarea>

    <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:6px">Spec Sheet — Garment Measurements (cm)</div>
    <div style="overflow-x:auto;margin-bottom:8px">
      <table style="border-collapse:collapse;font-size:0.84rem" id="sp-chart-${cssId(code)}">
        <thead><tr>
          <th style="text-align:left;padding:5px 8px;color:#64748b;font-size:0.72rem;border-bottom:2px solid #e2e8f0;min-width:180px">MEASUREMENT POINT</th>
          ${sizes.map(sz => `<th style="padding:5px 6px;color:#64748b;font-size:0.72rem;border-bottom:2px solid #e2e8f0">${sz}</th>`).join('')}
          <th></th>
        </tr></thead>
        <tbody>
          ${chart.map(row => specChartRow(row, sizes)).join('')}
        </tbody>
      </table>
    </div>
    <button class="btn btn-secondary" style="padding:5px 12px;font-size:0.78rem;margin-bottom:16px" onclick="addChartRow('${escJs(code)}')">+ Add Measurement</button>

    <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:6px">Bill of Material</div>
    <div style="overflow-x:auto;margin-bottom:8px">
      <table style="border-collapse:collapse;font-size:0.84rem;width:100%" id="sp-bom-${cssId(code)}">
        <thead><tr>
          ${['COMPONENT','MATERIAL','SUPPLIER','COLOUR',''].map(h => `<th style="text-align:left;padding:5px 8px;color:#64748b;font-size:0.72rem;border-bottom:2px solid #e2e8f0">${h}</th>`).join('')}
        </tr></thead>
        <tbody>${bom.map(r => bomRow(r)).join('')}</tbody>
      </table>
    </div>
    <button class="btn btn-secondary" style="padding:5px 12px;font-size:0.78rem;margin-bottom:16px" onclick="addBomRow('${escJs(code)}')">+ Add Component</button>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:14px">
      ${fld('Pre-Wash / Shrunk Required', `sp-prewash-${cssId(code)}`, pt.prewash, 'e.g. If shrinkage likely please pre-wash')}
      ${fld('Wash Type', `sp-washtype-${cssId(code)}`, pt.wash_type, 'n/a')}
      ${fld('Shrinkage Allowance', `sp-shrink-${cssId(code)}`, pt.shrinkage, 'n/a')}
      ${fld('Colourfastness', `sp-colourfast-${cssId(code)}`, pt.colourfastness, 'n/a')}
      ${fld('Hand Feel Target', `sp-handfeel-${cssId(code)}`, pt.hand_feel, 'n/a')}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:16px">
      ${fld('Swing Tag — Code', `sp-tagcode-${cssId(code)}`, s.tag_code, code)}
      ${fld('Swing Tag — Colour', `sp-tagcolour-${cssId(code)}`, s.tag_colour, s.colour || '')}
      ${fld('Swing Tag — Name', `sp-tagname-${cssId(code)}`, s.tag_name, l.productName || '')}
    </div>

    <button class="btn" style="background:#4f46e5;color:#fff" onclick="saveSpec('${escJs(code)}')">Save Spec</button>
    <span id="sp-status-${cssId(code)}" style="margin-left:10px;font-size:0.85rem;color:#15803d"></span>
  </div>`;
}

function cssId(code) { return code.replace(/[^a-zA-Z0-9]/g, '_'); }

function specChartRow(row, sizes) {
  return `<tr class="sp-chart-row">
    <td style="padding:3px 4px"><input type="text" class="sp-point" value="${escHtml(row.point || '')}" placeholder="e.g. Length from HSP"
      style="width:100%;box-sizing:border-box;padding:6px 8px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.84rem" /></td>
    ${sizes.map(sz => `<td style="padding:3px 2px"><input type="text" class="sp-val" data-size="${sz}" value="${escHtml(row.values && row.values[sz] !== undefined ? row.values[sz] : '')}"
      style="width:52px;padding:6px 4px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.84rem;text-align:center" /></td>`).join('')}
    <td><button style="border:none;background:none;color:#ef4444;cursor:pointer;font-weight:700" onclick="this.closest('tr').remove()">✕</button></td>
  </tr>`;
}

function bomRow(r) {
  const cell = (cls, val, ph, w) => `<td style="padding:3px 4px"><input type="text" class="${cls}" value="${escHtml(val || '')}" placeholder="${ph}"
    style="width:${w};box-sizing:border-box;padding:6px 8px;border:1.5px solid #e2e8f0;border-radius:6px;font-size:0.84rem" /></td>`;
  return `<tr class="sp-bom-row">
    ${cell('sp-bcomp', r.component, 'MAIN', '110px')}
    ${cell('sp-bmat',  r.material, 'e.g. Denim (as per sample)', '100%')}
    ${cell('sp-bsup',  r.supplier, 'e.g. Wilkins', '110px')}
    ${cell('sp-bcol',  r.colour, 'e.g. Mid Blue Wash', '130px')}
    <td><button style="border:none;background:none;color:#ef4444;cursor:pointer;font-weight:700" onclick="this.closest('tr').remove()">✕</button></td>
  </tr>`;
}

function addChartRow(code) {
  const l = lines.find(x => (x.productCode || '').trim() === code);
  document.querySelector(`#sp-chart-${cssId(code)} tbody`)
    .insertAdjacentHTML('beforeend', specChartRow({ point: '', values: {} }, specSizes(l ? l.sizeSet : 'numeric')));
}

function addBomRow(code) {
  document.querySelector(`#sp-bom-${cssId(code)} tbody`)
    .insertAdjacentHTML('beforeend', bomRow({}));
}

async function saveSpec(code) {
  const id = cssId(code);
  const v = (fid) => (document.getElementById(fid)?.value || '').trim() || null;
  const chart = [...document.querySelectorAll(`#sp-chart-${id} .sp-chart-row`)].map(tr => {
    const point = tr.querySelector('.sp-point').value.trim();
    const values = {};
    tr.querySelectorAll('.sp-val').forEach(inp => { if (inp.value.trim() !== '') values[inp.dataset.size] = inp.value.trim(); });
    return { point, values };
  }).filter(r => r.point);
  const bom = [...document.querySelectorAll(`#sp-bom-${id} .sp-bom-row`)].map(tr => ({
    component: tr.querySelector('.sp-bcomp').value.trim(),
    material:  tr.querySelector('.sp-bmat').value.trim(),
    supplier:  tr.querySelector('.sp-bsup').value.trim(),
    colour:    tr.querySelector('.sp-bcol').value.trim(),
  })).filter(r => r.component || r.material);

  const payload = {
    season: v(`sp-season-${id}`), fabric: v(`sp-fabric-${id}`),
    colour: v(`sp-colour-${id}`), colour_code: v(`sp-colourcode-${id}`),
    fit_notes: (document.getElementById(`sp-fit-${id}`)?.value || '').trim() || null,
    questions: (document.getElementById(`sp-q-${id}`)?.value || '').trim() || null,
    spec_chart: chart, bom,
    pretreatment: {
      prewash: v(`sp-prewash-${id}`), wash_type: v(`sp-washtype-${id}`),
      shrinkage: v(`sp-shrink-${id}`), colourfastness: v(`sp-colourfast-${id}`),
      hand_feel: v(`sp-handfeel-${id}`),
    },
    tag_code: v(`sp-tagcode-${id}`), tag_colour: v(`sp-tagcolour-${id}`), tag_name: v(`sp-tagname-${id}`),
  };
  try {
    const r = await fetch(`/api/production-orders/${poId}/specs/${encodeURIComponent(code)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    const st = document.getElementById(`sp-status-${id}`);
    st.textContent = '✓ Saved';
    setTimeout(() => { st.textContent = ''; }, 2000);
    const fresh = await fetch(`/api/production-orders/${poId}/specs`).then(x => x.json());
    specsData = {};
    (fresh.specs || []).forEach(sp => { specsData[sp.product_code] = sp; });
  } catch (err) {
    alert('Failed to save spec: ' + err.message);
  }
}

function uploadSpecImage(code, kind) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) { alert('JPEG or PNG only.'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('Image too large — keep under 8MB.'); return; }
    const caption = kind === 'reference'
      ? (document.getElementById(`sp-refcap-${cssId(code)}`)?.value || '').trim() || null
      : null;
    const b64 = await new Promise((res2, rej) => {
      const fr = new FileReader();
      fr.onload = () => res2(String(fr.result).split(',')[1]);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
    try {
      const r = await fetch(`/api/production-orders/${poId}/specs/${encodeURIComponent(code)}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, caption, mime: file.type, data_base64: b64 }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      await loadSpecs();
    } catch (err) { alert('Upload failed: ' + err.message); }
  };
  input.click();
}

async function deleteSpecImage(imgId) {
  if (!confirm('Remove this image?')) return;
  await fetch(`/api/spec-images/${imgId}`, { method: 'DELETE' });
  await loadSpecs();
}
