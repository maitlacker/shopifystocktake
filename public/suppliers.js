'use strict';

let suppliers = [];

(async function init() {
  await loadSuppliers();
})();

async function loadSuppliers() {
  try {
    const r = await fetch('/api/suppliers');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    suppliers = await r.json();
    renderTable();
  } catch (err) {
    document.getElementById('sup-tbody').innerHTML =
      `<tr class="empty-row"><td colspan="10">Error loading suppliers: ${escHtml(err.message)}</td></tr>`;
  }
}

function renderTable() {
  const tbody = document.getElementById('sup-tbody');
  if (!suppliers.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">No suppliers yet — click <strong>+ Add Supplier</strong> to get started.</td></tr>`;
    return;
  }
  tbody.innerHTML = suppliers.map(s => `
    <tr>
      <td><strong>${escHtml(s.company_name)}</strong></td>
      <td>${s.sku_prefixes
        ? s.sku_prefixes.split(',').map(px => `<span style="font-family:ui-monospace,monospace;font-weight:700;background:#f1f5f9;border-radius:6px;padding:2px 8px;margin-right:4px;white-space:nowrap;display:inline-block;margin-bottom:2px">${escHtml(px)}</span>`).join('')
        : '—'}</td>
      <td>${escHtml(s.location || '—')}</td>
      <td><span class="sup-currency-badge">${escHtml(s.currency)}</span></td>
      <td>${escHtml(s.contact_name || '—')}</td>
      <td>${s.email ? `<a href="mailto:${escHtml(s.email)}" style="color:#6366f1">${escHtml(s.email)}</a>` : '—'}</td>
      <td>${escHtml(s.phone || '—')}</td>
      <td style="text-align:center">${s.lead_time_sea != null ? `<strong>${s.lead_time_sea}</strong> wks` : '—'}</td>
      <td style="text-align:center">${s.lead_time_air != null ? `<strong>${s.lead_time_air}</strong> wks` : '—'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary" style="padding:5px 10px;font-size:0.75rem;margin-right:4px"
          onclick="openModal(${s.id})">Edit</button>
        <button class="btn" style="padding:5px 10px;font-size:0.75rem;background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5"
          onclick="deleteSupplier(${s.id})">Delete</button>
      </td>
    </tr>
  `).join('');
}

function openModal(id) {
  const s = id ? suppliers.find(x => x.id === id) : null;
  document.getElementById('modal-title').textContent = s ? 'Edit Supplier' : 'Add Supplier';
  document.getElementById('sup-id').value        = s ? s.id : '';
  document.getElementById('sup-company').value   = s ? s.company_name  : '';
  document.getElementById('sup-location').value  = s ? (s.location || '') : '';
  document.getElementById('sup-currency').value  = s ? s.currency : 'AUD';
  document.getElementById('sup-contact').value   = s ? (s.contact_name || '') : '';
  document.getElementById('sup-phone').value     = s ? (s.phone || '') : '';
  document.getElementById('sup-email').value     = s ? (s.email || '') : '';
  document.getElementById('sup-lead-sea').value  = s && s.lead_time_sea != null ? s.lead_time_sea : '';
  document.getElementById('sup-lead-air').value  = s && s.lead_time_air != null ? s.lead_time_air : '';
  document.getElementById('sup-sku-prefixes').value = s ? (s.sku_prefixes || '') : '';
  document.getElementById('sup-notes').value     = s ? (s.notes || '') : '';
  document.getElementById('sup-modal').classList.add('open');
  document.getElementById('sup-company').focus();
}

function closeModal() {
  document.getElementById('sup-modal').classList.remove('open');
}

async function saveSupplier() {
  const id = document.getElementById('sup-id').value;
  const companyName = document.getElementById('sup-company').value.trim();
  if (!companyName) { alert('Company name is required.'); return; }

  const rawSea = document.getElementById('sup-lead-sea').value.trim();
  const rawAir = document.getElementById('sup-lead-air').value.trim();
  const payload = {
    companyName,
    location:    document.getElementById('sup-location').value.trim() || null,
    currency:    document.getElementById('sup-currency').value,
    contactName: document.getElementById('sup-contact').value.trim() || null,
    phone:       document.getElementById('sup-phone').value.trim() || null,
    email:       document.getElementById('sup-email').value.trim() || null,
    notes:       document.getElementById('sup-notes').value.trim() || null,
    skuPrefixes: document.getElementById('sup-sku-prefixes').value.trim() || null,
    leadTimeSea: rawSea ? parseInt(rawSea) : null,
    leadTimeAir: rawAir ? parseInt(rawAir) : null,
  };

  const btn = document.getElementById('sup-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch(id ? `/api/suppliers/${id}` : '/api/suppliers', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Save failed');
    }
    closeModal();
    await loadSuppliers();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Supplier';
  }
}

async function deleteSupplier(id) {
  const s = suppliers.find(x => x.id === id);
  if (!confirm(`Delete supplier "${s?.company_name}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/suppliers/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadSuppliers();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Close modal on overlay click
document.getElementById('sup-modal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
