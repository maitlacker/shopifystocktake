'use strict';

let config       = { formTypes: [], sizeGroups: [] };
let debounceTimer = null;

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadConfig() {
  try {
    const r = await fetch('/api/srf/config');
    if (!r.ok) return;
    config = await r.json();

    // Populate form type filter
    const ftSel = document.getElementById('srl-form-type');
    config.formTypes.forEach(ft => {
      const opt = document.createElement('option');
      opt.value = ft.id;
      opt.textContent = ft.name;
      ftSel.appendChild(opt);
    });

    // Populate modal form type + size group
    const nmFt = document.getElementById('nm-form-type');
    const nmSg = document.getElementById('nm-size-group');
    config.formTypes.forEach(ft => {
      const opt = document.createElement('option');
      opt.value = ft.id;
      opt.textContent = ft.name;
      nmFt.appendChild(opt);
    });
    config.sizeGroups.forEach(sg => {
      const opt = document.createElement('option');
      opt.value = sg.id;
      opt.textContent = sg.name;
      if (sg.is_default) opt.selected = true;
      nmSg.appendChild(opt);
    });
  } catch (_) {}
}

function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadReceipts, 300);
}

async function loadReceipts() {
  const q          = document.getElementById('srl-search').value.trim();
  const status     = document.getElementById('srl-status').value;
  const formTypeId = document.getElementById('srl-form-type').value;

  const params = new URLSearchParams({ limit: 60, offset: 0 });
  if (q)          params.set('q', q);
  if (status)     params.set('status', status);
  if (formTypeId) params.set('form_type_id', formTypeId);

  const listEl  = document.getElementById('srl-list');
  const countEl = document.getElementById('srl-count');
  listEl.innerHTML = '<div class="loading-msg">Loading…</div>';

  try {
    const r = await fetch(`/api/stock-receipts?${params}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { receipts, total } = await r.json();

    countEl.textContent = `${total} receipt${total !== 1 ? 's' : ''}`;

    if (!receipts.length) {
      listEl.innerHTML = '<div class="srl-empty">No receipts found. Create one with the button above.</div>';
      return;
    }

    listEl.innerHTML = `<div class="srl-grid">${receipts.map(renderCard).join('')}</div>`;
  } catch (err) {
    listEl.innerHTML = `<div class="error-msg">Error: ${escHtml(err.message)}</div>`;
  }
}

function renderCard(r) {
  const statusLabel = r.status === 'in_progress' ? 'In Progress' : r.status.charAt(0).toUpperCase() + r.status.slice(1);
  const dateStr     = r.receipt_date ? r.receipt_date.slice(0,10) : (r.created_at ? r.created_at.slice(0,10) : '—');

  return `
    <div class="srl-card" onclick="location.href='/stock-receipt.html?id=${r.id}'">
      <div class="srl-card-top">
        <div>
          <div class="srl-card-title">${escHtml(r.style_name || '(no style name)')}</div>
          <div class="srl-card-id">#${r.id} · ${escHtml(r.form_type_name || '')} · ${r.receipt_type === 'new' ? 'New' : 'Restock'}</div>
        </div>
        <span class="srl-badge ${r.status}">${statusLabel}</span>
      </div>
      <div class="srl-card-meta">
        <span><strong>Date</strong> ${escHtml(dateStr)}</span>
        <span><strong>By</strong> ${escHtml(r.processed_by || '—')}</span>
        <span><strong>Supplier</strong> ${escHtml(r.supplier || '—')}</span>
        <span><strong>Invoice</strong> ${escHtml(r.invoice_number || '—')}</span>
        ${r.po_number ? `<span><strong>PO</strong> ${escHtml(r.po_number)}</span>` : ''}
        ${r.size_group_name ? `<span><strong>Sizes</strong> ${escHtml(r.size_group_name)}</span>` : ''}
      </div>
      <div class="srl-card-actions" onclick="event.stopPropagation()">
        <a class="srl-btn-view" href="/stock-receipt.html?id=${r.id}">Open Form</a>
        <a class="srl-btn-pdf"  href="/api/stock-receipts/${r.id}/pdf" target="_blank">↓ PDF</a>
        ${r.status !== 'complete' ? `<button class="srl-btn-del" onclick="deleteReceipt(${r.id})">Delete</button>` : ''}
      </div>
    </div>`;
}

async function deleteReceipt(id) {
  if (!confirm('Delete this stock receipt? This action is tracked and cannot be undone.')) return;
  try {
    const r = await fetch(`/api/stock-receipts/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    loadReceipts();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── New receipt modal ──────────────────────────────────────────────

function openNewModal() {
  document.getElementById('nm-error').style.display = 'none';
  document.getElementById('new-modal').classList.add('open');
}

function closeNewModal() {
  document.getElementById('new-modal').classList.remove('open');
}

document.getElementById('new-modal').addEventListener('click', function (e) {
  if (e.target === this) closeNewModal();
});

async function createReceipt() {
  const formTypeId  = document.getElementById('nm-form-type').value;
  const sizeGroupId = document.getElementById('nm-size-group').value;
  const receiptType = document.getElementById('nm-receipt-type').value;
  const processedBy = document.getElementById('nm-processed-by').value.trim();
  const errEl       = document.getElementById('nm-error');
  const btn         = document.getElementById('nm-create-btn');

  if (!formTypeId) {
    errEl.textContent = 'Please select a form type.';
    errEl.style.display = 'block';
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Creating…';
  errEl.style.display = 'none';

  try {
    const r = await fetch('/api/stock-receipts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ form_type_id: Number(formTypeId), size_group_id: sizeGroupId ? Number(sizeGroupId) : null, receipt_type: receiptType, processed_by: processedBy || null }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    window.location.href = `/stock-receipt.html?id=${data.id}`;
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = 'block';
    btn.disabled    = false;
    btn.textContent = 'Create Form';
  }
}

// ── Init ──────────────────────────────────────────────────────────

loadConfig().then(() => loadReceipts());
