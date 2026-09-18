// ── PO Reconciliation ──────────────────────────────────────────────
// Receipt-first matching of completed stock receipts against
// confirmed-but-unreceived POs.
//   1. Receipts that have a PO number entered
//   2. Receipts with no PO at all
//   3. Whatever is left (no name match found) → smart/fuzzy matching
//   4. Remaining confirmed POs (mark received without a receipt)

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

function norm(s)  { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1); }

function receiptName(sr) { return sr.style_name || sr.shopify_product_title || `Receipt #${sr.id}`; }

// ── Matching ───────────────────────────────────────────────────────

// Strict name match: receipt name appears in a PO line name or vice versa
function poNameMatches(sr, po) {
  const rName = norm(receiptName(sr));
  const rCode = norm(sr.product_code);
  for (const l of (po.lines || [])) {
    const pName = norm(l.name);
    if (rName.length >= 5 && pName.length >= 5 &&
        (pName.includes(rName) || rName.includes(pName))) return true;
    const pCode = norm(l.code);
    if (rCode.length >= 4 && pCode.length >= 4 &&
        (pCode.startsWith(rCode) || rCode.startsWith(pCode))) return true;
  }
  return false;
}

// Fuzzy score 0..1: best word-overlap between receipt name and PO line names
function poSimScore(sr, po) {
  const rWords = new Set(words(receiptName(sr)));
  if (!rWords.size) return 0;
  let best = 0;
  for (const l of (po.lines || [])) {
    const pWords = words(l.name);
    if (!pWords.length) continue;
    let shared = 0;
    for (const w of pWords) if (rWords.has(w)) shared++;
    best = Math.max(best, shared / Math.max(rWords.size, pWords.length));
  }
  return best;
}

function exactPoNumberMatch(sr) {
  const n = norm(sr.po_number);
  if (!n) return null;
  return POS.find(po => norm(po.po_number) === n) || null;
}

// ── Data ───────────────────────────────────────────────────────────

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

// ── Rendering ──────────────────────────────────────────────────────

function render() {
  // Receipts still needing attention: PO number that matches nothing, PO
  // number matching a still-open PO (one click to receive), or no PO at all
  const open = RECEIPTS.filter(x =>
    x.po_state === 'none' || x.po_state === 'unmatched' || x.po_state === 'linked_open');

  const withPo = [];
  const noPo   = [];
  const fuzzy  = [];

  for (const sr of open) {
    const exact   = exactPoNumberMatch(sr);
    const byName  = POS.filter(po => poNameMatches(sr, po));
    const hasPoNum = sr.po_number && String(sr.po_number).trim();
    if (exact || byName.length) {
      (hasPoNum ? withPo : noPo).push({ sr, exact, byName });
    } else {
      fuzzy.push({ sr, hasPoNum });
    }
  }

  document.getElementById('rec-chips').innerHTML = `
    <div class="rec-chip blue"><div class="n">${POS.length}</div><div class="l">Confirmed POs not received</div></div>
    <div class="rec-chip amber"><div class="n">${withPo.length}</div><div class="l">Receipts with a PO # to match</div></div>
    <div class="rec-chip purple"><div class="n">${noPo.length}</div><div class="l">Receipts with no PO — name matched</div></div>
    <div class="rec-chip red"><div class="n">${fuzzy.length}</div><div class="l">Left over — smart match</div></div>`;

  renderWithPo(withPo);
  renderNoPo(noPo);
  renderFuzzy(fuzzy);
  renderPos();
}

function poOption(po, { star = false, hint = '' } = {}) {
  const names = (po.lines || []).map(l => l.name).filter(Boolean);
  const label = `PO ${po.po_number} · ${names.join(', ') || po.supplier_name || '—'}${hint ? ` (${hint})` : ''}`;
  return { id: po.id, label: (star ? '★ ' : '') + label };
}

function selectHtml(id, opts, selectedId) {
  return `<select class="rec-select" id="${id}">
    <option value="">— select PO —</option>
    ${opts.map(o => `<option value="${o.id}"${o.id === selectedId ? ' selected' : ''}>${escHtml(o.label)}</option>`).join('')}
  </select>`;
}

function nameCell(sr) {
  return `<a href="/stock-receipt.html?id=${sr.id}" class="rec-style"
    style="text-decoration:none;color:#1e293b">${escHtml(receiptName(sr))}</a>`;
}

// 1. Receipts that have a PO number entered
function renderWithPo(items) {
  const tbody = document.getElementById('withpo-tbody');
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">Nothing here — no receipts with a PO number waiting to be matched 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(({ sr, exact, byName }) => {
    const seen = new Set();
    const opts = [];
    if (exact) { opts.push(poOption(exact, { star: true, hint: 'PO # matches' })); seen.add(exact.id); }
    for (const po of byName) if (!seen.has(po.id)) { opts.push(poOption(po, { star: !exact })); seen.add(po.id); }
    const selectedId = exact ? exact.id : (byName.length === 1 ? byName[0].id : undefined);
    return `
      <tr class="${exact ? 'suggested' : ''}">
        <td>${nameCell(sr)}</td>
        <td><span class="rec-badge ${exact ? 'suggest' : 'unmatched'}">${escHtml(sr.po_number)}</span></td>
        <td style="text-align:center;font-weight:700">${sr.counted_qty}</td>
        <td style="white-space:nowrap">${fmtDate(sr.completed_at || sr.receipt_date)}</td>
        <td><div class="rec-actions">
          ${selectHtml(`sel-${sr.id}`, opts, selectedId)}
          <button class="btn-link-po" onclick="linkReceipt(${sr.id}, this)">Link &amp; Receive</button>
        </div></td>
      </tr>`;
  }).join('');
}

// 2. Receipts with no PO at all
function renderNoPo(items) {
  const tbody = document.getElementById('nopo-tbody');
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-cell">No receipts without a PO have a matching product name — check the smart-match list below</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(({ sr, byName }) => {
    const opts = byName.map(po => poOption(po, { star: true }));
    const selectedId = byName.length === 1 ? byName[0].id : undefined;
    return `
      <tr>
        <td>${nameCell(sr)}</td>
        <td style="text-align:center;font-weight:700">${sr.counted_qty}</td>
        <td style="white-space:nowrap">${fmtDate(sr.receipt_date || sr.completed_at)}</td>
        <td><div class="rec-actions">
          ${selectHtml(`sel-${sr.id}`, opts, selectedId)}
          <button class="btn-link-po" onclick="linkReceipt(${sr.id}, this)">Link &amp; Receive</button>
        </div></td>
      </tr>`;
  }).join('');
}

// 3. Left over — smart matching on similar (not identical) names
function renderFuzzy(items) {
  const tbody = document.getElementById('fuzzy-tbody');
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">Nothing left over — every receipt found a name match 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map(({ sr }) => {
    const scored = POS
      .map(po => ({ po, score: poSimScore(sr, po) }))
      .sort((a, b) => b.score - a.score);
    const good = scored.filter(x => x.score >= 0.4);
    const rest = scored.filter(x => x.score < 0.4);
    const opts = [
      ...good.map(x => poOption(x.po, { star: true, hint: `${Math.round(x.score * 100)}% similar` })),
      ...rest.map(x => poOption(x.po)),
    ];
    const selectedId = good.length === 1 ? good[0].po.id : undefined;
    return `
      <tr class="${good.length ? 'suggested' : ''}">
        <td>${nameCell(sr)}</td>
        <td>${sr.po_number && String(sr.po_number).trim()
              ? `<span class="rec-badge unmatched">${escHtml(sr.po_number)}</span>`
              : '<span class="rec-badge none">no po</span>'}</td>
        <td style="text-align:center;font-weight:700">${sr.counted_qty}</td>
        <td style="white-space:nowrap">${fmtDate(sr.completed_at || sr.receipt_date)}</td>
        <td><div class="rec-actions">
          ${selectHtml(`sel-${sr.id}`, opts, selectedId)}
          <button class="btn-link-po" onclick="linkReceipt(${sr.id}, this)">Link &amp; Receive</button>
        </div></td>
      </tr>`;
  }).join('');
}

// 4. Remaining confirmed POs — compact view + received-without-receipt
function renderPos() {
  const tbody = document.getElementById('po-tbody');
  if (!POS.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No confirmed POs awaiting receipt 🎉</td></tr>`;
    return;
  }
  tbody.innerHTML = POS.map(po => {
    const linesHtml = (po.lines || []).map(l =>
      `<div class="rec-line"><span class="rec-style">${escHtml(l.name || '—')}</span>
        <span class="rec-code">${escHtml(l.code || '')}${l.qty ? ` · ${l.qty} pcs` : ''}</span></div>`).join('') || '—';
    return `
      <tr>
        <td><span class="po-num">${escHtml(po.po_number || '#' + po.id)}</span></td>
        <td>${escHtml(po.supplier_name || '—')}</td>
        <td>${linesHtml}</td>
        <td style="text-align:center;font-weight:700">${po.total_qty}</td>
        <td style="white-space:nowrap">${fmtDate(po.delivery_date)}</td>
        <td><button class="btn-mark-rec" onclick="markReceived(${po.id}, '${escHtml(po.po_number || '')}', this)">Received (no receipt)</button></td>
      </tr>`;
  }).join('');
}

// ── Actions ────────────────────────────────────────────────────────

function linkReceipt(receiptId, btn) {
  const sel = document.getElementById(`sel-${receiptId}`);
  const poId = Number(sel && sel.value);
  if (!poId) { showMsg('Select a PO to link first.', false); return; }
  doLink(receiptId, poId, btn);
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
