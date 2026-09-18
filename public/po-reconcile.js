// ── PO Reconciliation ──────────────────────────────────────────────
// Matches completed stock receipts against confirmed-but-unreceived POs.

let POS = [];       // confirmed, not received, not archived
let RECEIPTS = [];  // all completed receipts (with po_state)

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Does this receipt look like it belongs to this PO?
function isSuggested(receipt, po) {
  const rCode = norm(receipt.product_code);
  if (rCode && rCode.length >= 4) {
    for (const l of (po.lines || [])) {
      const pCode = norm(l.code);
      if (pCode && pCode.length >= 4 &&
          (pCode.startsWith(rCode) || rCode.startsWith(pCode))) return true;
    }
  }
  const rStyle = norm(receipt.style_name || receipt.shopify_product_title);
  if (rStyle && rStyle.length >= 6) {
    for (const l of (po.lines || [])) {
      const pName = norm(l.name);
      if (pName && pName.length >= 6 &&
          (pName.includes(rStyle) || rStyle.includes(pName))) return true;
    }
  }
  return false;
}

function showMsg(text, ok) {
  const el = document.getElementById('rec-msg');
  el.textContent = text;
  el.className = 'rec-msg ' + (ok ? 'ok' : 'err');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadData() {
  try {
    const r = await fetch('/api/po-reconcile');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    POS = data.pos || [];
    RECEIPTS = data.receipts || [];
    render();
  } catch (err) {
    showMsg('Failed to load: ' + err.message, false);
  }
}

function unlinkedReceipts() {
  return RECEIPTS.filter(x => x.po_state === 'none' || x.po_state === 'unmatched');
}

function render() {
  const unlinked = unlinkedReceipts();
  const noneCount      = unlinked.filter(x => x.po_state === 'none').length;
  const unmatchedCount = unlinked.filter(x => x.po_state === 'unmatched').length;

  document.getElementById('rec-chips').innerHTML = `
    <div class="rec-chip blue"><div class="n">${POS.length}</div><div class="l">Confirmed POs not received</div></div>
    <div class="rec-chip amber"><div class="n">${noneCount}</div><div class="l">Receipts with no PO</div></div>
    <div class="rec-chip purple"><div class="n">${unmatchedCount}</div><div class="l">Receipts — PO # not found</div></div>`;

  renderPos(unlinked);
  renderReceipts(unlinked);
}

function receiptOptionLabel(sr) {
  const bits = [];
  bits.push(sr.style_name || sr.shopify_product_title || `Receipt #${sr.id}`);
  if (sr.product_code) bits.push(sr.product_code);
  bits.push(`${sr.counted_qty} pcs`);
  bits.push(fmtDate(sr.completed_at || sr.receipt_date));
  return bits.join(' · ');
}

function poOptionLabel(po) {
  const codes = (po.lines || []).map(l => l.code).filter(Boolean).join(', ');
  return `PO ${po.po_number} · ${po.supplier_name || '—'}${codes ? ' · ' + codes : ''} · ${po.total_qty} pcs`;
}

function renderPos(unlinked) {
  const tbody = document.getElementById('po-tbody');
  if (!POS.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">No confirmed POs awaiting receipt 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = POS.map(po => {
    const suggestions = unlinked.filter(sr => isSuggested(sr, po));
    const suggestedIds = new Set(suggestions.map(s => s.id));
    const options = [...suggestions, ...unlinked.filter(sr => !suggestedIds.has(sr.id))];
    const finalOptHtml = ['<option value="">— select receipt —</option>']
      .concat(options.map(sr =>
        `<option value="${sr.id}"${suggestions.length === 1 && suggestedIds.has(sr.id) ? ' selected' : ''}>` +
        `${suggestedIds.has(sr.id) ? '★ ' : ''}${escHtml(receiptOptionLabel(sr))}</option>`))
      .join('');
    const linesHtml = (po.lines || []).map(l =>
      `<div class="rec-line"><span class="rec-style">${escHtml(l.name || '—')}</span>
        <div class="rec-code">${escHtml(l.code || '')}${l.qty ? ` · ${l.qty} pcs` : ''}</div></div>`).join('') || '—';
    return `
      <tr class="${suggestions.length ? 'suggested' : ''}">
        <td><span class="po-num">${escHtml(po.po_number || '#' + po.id)}</span>
          ${suggestions.length ? '<div><span class="rec-badge suggest">match found</span></div>' : ''}</td>
        <td>${escHtml(po.supplier_name || '—')}</td>
        <td>${linesHtml}</td>
        <td style="text-align:center;font-weight:700">${po.total_qty}</td>
        <td style="white-space:nowrap">${fmtDate(po.order_date)}</td>
        <td style="white-space:nowrap">${fmtDate(po.delivery_date)}</td>
        <td>
          <div class="rec-actions">
            <select class="rec-select" id="po-sel-${po.id}">${finalOptHtml}</select>
            <button class="btn-link-po" onclick="linkFromPo(${po.id}, this)">Link &amp; Receive</button>
            <button class="btn-mark-rec" onclick="markReceived(${po.id}, '${escHtml(po.po_number || '')}', this)">Received (no receipt)</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

function renderReceipts(unlinked) {
  const tbody = document.getElementById('sr-tbody');
  if (!unlinked.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-cell">Every completed receipt is linked to a PO 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = unlinked.map(sr => {
    const suggestions = POS.filter(po => isSuggested(sr, po));
    const suggestedIds = new Set(suggestions.map(p => p.id));
    const options = [...suggestions, ...POS.filter(po => !suggestedIds.has(po.id))];
    let optHtml = ['<option value="">— select PO —</option>']
      .concat(options.map(po =>
        `<option value="${po.id}"${suggestions.length === 1 && suggestedIds.has(po.id) ? ' selected' : ''}>` +
        `${suggestedIds.has(po.id) ? '★ ' : ''}${escHtml(poOptionLabel(po))}</option>`))
      .join('');
    const badge = sr.po_state === 'none'
      ? '<span class="rec-badge none">no po</span>'
      : `<span class="rec-badge unmatched">${escHtml(sr.po_number)}</span>`;
    return `
      <tr class="${suggestions.length ? 'suggested' : ''}">
        <td style="white-space:nowrap">${fmtDate(sr.completed_at || sr.receipt_date)}</td>
        <td><a href="/stock-receipt.html?id=${sr.id}" class="rec-style" style="text-decoration:none;color:#1e293b">
          ${escHtml(sr.style_name || sr.shopify_product_title || 'Receipt #' + sr.id)}</a></td>
        <td class="rec-code" style="font-size:0.82rem">${escHtml(sr.product_code || '—')}</td>
        <td>${escHtml(sr.supplier || '—')}</td>
        <td style="text-align:center;font-weight:700">${sr.counted_qty}</td>
        <td>${badge}</td>
        <td>
          <div class="rec-actions">
            <select class="rec-select" id="sr-sel-${sr.id}">${optHtml}</select>
            <button class="btn-link-po" onclick="linkFromReceipt(${sr.id}, this)">Link &amp; Receive</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function doLink(receiptId, poId, btn) {
  btn.disabled = true;
  try {
    const r = await fetch('/api/po-reconcile/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt_id: receiptId, po_id: poId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    showMsg(`Receipt linked to PO ${data.po_number}` +
      (data.po_marked_received ? ' — PO marked as Received ✓' : ' (PO was already received)'), true);
    await loadData();
  } catch (err) {
    showMsg('Link failed: ' + err.message, false);
    btn.disabled = false;
  }
}

function linkFromPo(poId, btn) {
  const sel = document.getElementById(`po-sel-${poId}`);
  const receiptId = Number(sel && sel.value);
  if (!receiptId) { showMsg('Select a receipt to link first.', false); return; }
  doLink(receiptId, poId, btn);
}

function linkFromReceipt(receiptId, btn) {
  const sel = document.getElementById(`sr-sel-${receiptId}`);
  const poId = Number(sel && sel.value);
  if (!poId) { showMsg('Select a PO to link first.', false); return; }
  doLink(receiptId, poId, btn);
}

async function markReceived(poId, poNumber, btn) {
  if (!confirm(`Mark PO ${poNumber || poId} as Received without linking a stock receipt?`)) return;
  btn.disabled = true;
  try {
    const r = await fetch('/api/po-reconcile/mark-received', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ po_id: poId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    showMsg(`PO ${data.po_number} marked as Received ✓`, true);
    await loadData();
  } catch (err) {
    showMsg('Failed: ' + err.message, false);
    btn.disabled = false;
  }
}

loadData();
