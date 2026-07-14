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
  document.getElementById('tot-shipping').value     = po.shipping_cost || '0';
  document.getElementById('tot-gst').checked        = !!po.include_gst;

  if (po.supplier_id) {
    document.getElementById('po-supplier').value = po.supplier_id;
  }
  updateExRateInfo();
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

  // Sum line totals: qty * unitPrice (in supplier currency) * exRate = AUD
  let subtotalForeign = 0;
  let subtotalAud     = 0;
  lines.forEach(l => {
    const lineTotal = (l.totalQty || 0) * (l.unitPrice || 0);
    subtotalForeign += lineTotal;
    subtotalAud     += lineTotal * exRate;
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
    const lineTotal = (l.totalQty || 0) * (l.unitPrice || 0);
    return `<div style="padding:4px 0;border-bottom:1px solid #f1f5f9">
      <span style="color:#64748b;font-size:0.78rem">Line ${i+1}</span>
      <strong style="margin-left:8px">${escHtml(l.productName || 'Unnamed')}</strong>
      <span style="color:#94a3b8;margin-left:8px">${l.totalQty} units</span>
      ${lineTotal > 0 ? `<span style="float:right;font-weight:700">${currency} ${fmt(lineTotal)}${currency!=='AUD'?` = AUD ${fmt(lineTotal*exRate)}`:''}` : ''}
    </div>`;
  }).join('');
}

// ── Save / Confirm / Delete ────────────────────────────────────────
function buildPayload(status) {
  const supplierId = parseInt(document.getElementById('po-supplier').value) || null;
  const supplierOpt = document.getElementById('po-supplier').selectedOptions[0];
  const supplierName = supplierId ? supplierOpt.textContent.replace(/\s*\(.*\)\s*$/, '').trim() : '';

  return {
    poNumber:     document.getElementById('po-number').value.trim(),
    supplierId,
    supplierName,
    orderDate:    document.getElementById('po-order-date').value,
    deliveryDate: document.getElementById('po-delivery-date').value || null,
    freightMode:  document.getElementById('po-freight').value,
    currency:     document.getElementById('po-currency').value,
    exchangeRate: parseFloat(document.getElementById('po-exchange-rate').value) || 1,
    shippingCost: parseFloat(document.getElementById('tot-shipping').value) || 0,
    includeGst:   document.getElementById('tot-gst').checked,
    notes:        document.getElementById('po-notes').value.trim() || null,
    status:       status || undefined,
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
