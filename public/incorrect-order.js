(function () {
  'use strict';

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function fmtDate(d) {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Toast ────────────────────────────────────────────────────────
  let toastTimer;
  function showToast(msg, type) {
    const el = document.getElementById('io-toast');
    el.textContent = msg;
    el.className = `io-toast show ${type || ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ── State ────────────────────────────────────────────────────────
  const params   = new URLSearchParams(window.location.search);
  const caseId   = params.get('id') || null;
  let   caseData = null;

  let correctStockCounted  = false;
  let receivedStockCounted = false;
  let currentStatus = 'open';

  // ── Helpers ──────────────────────────────────────────────────────
  function setStockBtn(side, val) {
    const yesBtn = document.getElementById(`io-${side}-stock-yes`);
    const noBtn  = document.getElementById(`io-${side}-stock-no`);
    yesBtn.classList.toggle('active-yes', val === true);
    noBtn.classList.toggle('active-no',   val === false);
    if (side === 'correct')  correctStockCounted  = val;
    if (side === 'received') receivedStockCounted = val;
  }

  function setStatus(val) {
    currentStatus = val;
    document.querySelectorAll('.io-status-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.val === val);
    });
    updateStatusBadge(val);
    updateResolutionVisibility();
  }

  function updateStatusBadge(status) {
    const labels = { open: 'Open', replacement_sent: 'Replacement Sent', resolved: 'Resolved' };
    const el = document.getElementById('io-status-badge');
    if (caseId) {
      el.innerHTML = `<span class="io-badge ${escHtml(status)}">${escHtml(labels[status] || status)}</span>`;
    }
  }

  function updateResolutionVisibility() {
    const wrap = document.getElementById('io-resolution-wrap');
    const replacementWrap = document.getElementById('io-replacement-order-wrap');
    const res = document.getElementById('io-resolution').value;
    wrap.style.display = (currentStatus === 'replacement_sent' || currentStatus === 'resolved') ? '' : 'none';
    replacementWrap.style.display = (res === 'replacement') ? '' : 'none';
  }

  function setLinkedProduct(side, id, title) {
    document.getElementById(`io-${side}-product-id`).value = id || '';
    const linkEl = document.getElementById(`io-${side}-linked`);
    if (id && title) {
      linkEl.style.display = '';
      linkEl.innerHTML = `<div class="io-linked-tag">🔗 Linked: ${escHtml(title)} <button data-side="${escHtml(side)}" class="io-unlink-btn" title="Unlink">✕</button></div>`;
    } else {
      linkEl.style.display = 'none';
      linkEl.innerHTML = '';
    }
  }

  // ── Product search ───────────────────────────────────────────────
  let searchTimers = {};

  function setupProductSearch(side) {
    const input    = document.getElementById(`io-${side}-item`);
    const dropdown = document.getElementById(`io-${side}-dropdown`);

    input.addEventListener('input', () => {
      clearTimeout(searchTimers[side]);
      const q = input.value.trim();
      if (q.length < 2) { dropdown.style.display = 'none'; return; }
      searchTimers[side] = setTimeout(async () => {
        try {
          const r = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`);
          if (!r.ok) return;
          const products = await r.json();
          if (!products.length) { dropdown.style.display = 'none'; return; }
          dropdown.innerHTML = products.slice(0, 12).map(p => {
            const variant = p.variants && p.variants[0];
            const sku = variant ? (variant.sku || '') : '';
            return `<div class="io-product-option" data-id="${p.id}" data-title="${escHtml(p.title)}">
              ${escHtml(p.title)}
              ${sku ? `<div class="io-product-sku">SKU: ${escHtml(sku)}</div>` : ''}
            </div>`;
          }).join('');
          dropdown.style.display = '';
        } catch (_) { dropdown.style.display = 'none'; }
      }, 280);
    });

    dropdown.addEventListener('mousedown', e => {
      const opt = e.target.closest('.io-product-option');
      if (!opt) return;
      e.preventDefault();
      input.value = opt.dataset.title;
      setLinkedProduct(side, opt.dataset.id, opt.dataset.title);
      dropdown.style.display = 'none';
    });

    input.addEventListener('blur', () => {
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });
  }

  // ── Order lookup ─────────────────────────────────────────────────
  async function lookupOrder() {
    const num = document.getElementById('io-order-num').value.trim();
    if (!num) return;
    const btn = document.getElementById('io-lookup-btn');
    btn.disabled = true;
    btn.textContent = 'Looking up…';
    try {
      const r = await fetch(`/api/incorrect-orders/shopify-order?num=${encodeURIComponent(num)}`);
      const data = await r.json();
      if (!data) {
        showToast('Order not found in Shopify', 'error');
        return;
      }
      // Populate customer
      const custEl = document.getElementById('io-customer-name');
      custEl.textContent = data.customer_name || '—';

      // Populate & show order note → pre-fill pick/pack notes field
      const noteRow = document.getElementById('io-note-row');
      if (data.note) {
        document.getElementById('io-order-note-val').textContent = data.note;
        noteRow.style.display = '';
        const ppField = document.getElementById('io-pick-pack-notes');
        if (!ppField.value) ppField.value = data.note;
      } else {
        noteRow.style.display = 'none';
      }

      // Populate line items
      const liWrap = document.getElementById('io-line-items-wrap');
      const liEl   = document.getElementById('io-line-items');
      if (data.line_items && data.line_items.length) {
        liEl.innerHTML = data.line_items.map(li => {
          const label = li.variant_title && li.variant_title !== 'Default Title'
            ? `${li.title} – ${li.variant_title}`
            : li.title;
          return `<div class="io-line-item">
            <span>${escHtml(label)} × ${li.quantity}</span>
            <button class="io-use-btn" data-title="${escHtml(label)}" data-pid="${li.product_id || ''}">Use as Correct Item</button>
          </div>`;
        }).join('');
        liWrap.style.display = '';
        liEl.querySelectorAll('.io-use-btn').forEach(b => {
          b.addEventListener('click', () => {
            document.getElementById('io-correct-item').value = b.dataset.title;
            setLinkedProduct('correct', b.dataset.pid, b.dataset.title);
          });
        });
      } else {
        liWrap.style.display = 'none';
      }

      // Store Shopify order id (hidden)
      document.getElementById('io-order-num').dataset.shopifyId = data.id || '';
      document.getElementById('io-order-num').dataset.shopifyNote = data.note || '';

      document.getElementById('io-order-info').style.display = '';
      showToast('Order found — details loaded', 'success');
    } catch (err) {
      showToast('Lookup failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Look Up in Shopify';
    }
  }

  // ── Load existing case ───────────────────────────────────────────
  async function loadCase() {
    try {
      const r = await fetch(`/api/incorrect-orders/${caseId}`);
      if (r.status === 404) { showToast('Case not found', 'error'); return; }
      caseData = await r.json();
      populateForm(caseData);
    } catch (err) {
      showToast('Error loading case: ' + err.message, 'error');
    }
  }

  function populateForm(d) {
    document.getElementById('io-page-title').textContent = `Incorrect Order ${d.order_number}`;
    document.getElementById('io-page-sub').textContent   =
      `Reported ${d.reported_date ? new Date(d.reported_date).toLocaleDateString('en-AU') : '—'}` +
      (d.customer_name ? ` · ${d.customer_name}` : '') +
      (d.created_by ? ` · Created by ${d.created_by}` : '');

    document.getElementById('io-order-num').value        = d.order_number || '';
    document.getElementById('io-reported-date').value    = d.reported_date ? d.reported_date.split('T')[0] : '';

    if (d.customer_name || d.shopify_order_note) {
      document.getElementById('io-customer-name').textContent = d.customer_name || '—';
      const noteRow = document.getElementById('io-note-row');
      if (d.shopify_order_note) {
        document.getElementById('io-order-note-val').textContent = d.shopify_order_note;
        noteRow.style.display = '';
      }
      document.getElementById('io-order-info').style.display = '';
    }

    document.getElementById('io-correct-item').value  = d.correct_item || '';
    document.getElementById('io-received-item').value = d.received_item || '';
    if (d.correct_product_id)  setLinkedProduct('correct',  d.correct_product_id,  d.correct_item);
    if (d.received_product_id) setLinkedProduct('received', d.received_product_id, d.received_item);

    setStockBtn('correct',  d.correct_stock_counted  === true);
    setStockBtn('received', d.received_stock_counted === true);

    setStatus(d.status || 'open');
    document.getElementById('io-resolution').value        = d.resolution || '';
    document.getElementById('io-replacement-order').value = d.replacement_order || '';
    updateResolutionVisibility();

    document.getElementById('io-pick-pack-notes').value = d.pick_pack_notes || '';
    document.getElementById('io-notes').value           = d.notes || '';

    renderTimeline(d.timeline || []);

    document.getElementById('io-delete-btn').style.display = '';
    document.getElementById('io-timeline-card').style.display = '';
    if (d.slack_notified_at) {
      const btn = document.getElementById('io-slack-btn');
      btn.classList.add('io-slack-sent');
      btn.innerHTML = `<span>✅</span> Stock Check Sent (${new Date(d.slack_notified_at).toLocaleDateString('en-AU')})`;
    } else {
      document.getElementById('io-slack-btn').disabled = false;
    }

    // Store for Shopify IDs
    document.getElementById('io-order-num').dataset.shopifyId   = d.shopify_order_id   || '';
    document.getElementById('io-order-num').dataset.shopifyNote = d.shopify_order_note || '';
  }

  function renderTimeline(entries) {
    const el = document.getElementById('io-timeline');
    if (!entries.length) { el.innerHTML = `<div style="color:#94a3b8;font-size:0.85rem;padding:8px 0">No notes yet.</div>`; return; }
    el.innerHTML = entries.map(n => `
      <div class="io-timeline-entry">
        <div class="io-tl-dot"></div>
        <div class="io-tl-body">
          ${escHtml(n.note)}
          <div class="io-tl-meta">${escHtml(n.added_by)} · ${fmtDate(n.added_at)}</div>
        </div>
      </div>`).join('');
  }

  // ── Save ─────────────────────────────────────────────────────────
  function buildPayload() {
    const numEl = document.getElementById('io-order-num');
    return {
      order_number:          numEl.value.trim(),
      shopify_order_id:      numEl.dataset.shopifyId  || null,
      shopify_order_note:    numEl.dataset.shopifyNote || null,
      customer_name:         (() => { const v = document.getElementById('io-customer-name').textContent.trim(); return (v && v !== '—') ? v : null; })(),
      reported_date:         document.getElementById('io-reported-date').value || null,
      correct_item:          document.getElementById('io-correct-item').value.trim()  || null,
      correct_product_id:    document.getElementById('io-correct-product-id').value  || null,
      correct_stock_counted:  correctStockCounted,
      received_item:         document.getElementById('io-received-item').value.trim() || null,
      received_product_id:   document.getElementById('io-received-product-id').value || null,
      received_stock_counted: receivedStockCounted,
      pick_pack_notes:       document.getElementById('io-pick-pack-notes').value.trim() || null,
      notes:                 document.getElementById('io-notes').value.trim()           || null,
      status:                currentStatus,
      resolution:            document.getElementById('io-resolution').value || null,
      replacement_order:     document.getElementById('io-replacement-order').value.trim() || null,
    };
  }

  async function saveCase() {
    const btn = document.getElementById('io-save-btn');
    const payload = buildPayload();
    if (!payload.order_number) { showToast('Order number is required', 'error'); return; }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      let r, data;
      if (caseId) {
        r    = await fetch(`/api/incorrect-orders/${caseId}`, { method: 'PUT',  headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        data = await r.json();
      } else {
        r    = await fetch('/api/incorrect-orders',          { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        data = await r.json();
        if (data.id) window.history.replaceState({}, '', `/incorrect-order.html?id=${data.id}`);
      }
      if (!r.ok) throw new Error(data.error || 'Save failed');
      caseData = data;
      populateForm(data);
      showToast('Saved ✓', 'success');
    } catch (err) {
      showToast('Save failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  // ── Delete ───────────────────────────────────────────────────────
  async function deleteCase() {
    if (!caseId) return;
    if (!confirm(`Delete case for order ${document.getElementById('io-order-num').value}? This cannot be undone.`)) return;
    try {
      await fetch(`/api/incorrect-orders/${caseId}`, { method: 'DELETE' });
      window.location.href = '/incorrect-orders.html';
    } catch (err) {
      showToast('Delete failed: ' + err.message, 'error');
    }
  }

  // ── Slack notify ─────────────────────────────────────────────────
  async function sendSlack() {
    const id = caseId || (caseData && caseData.id);
    if (!id) { showToast('Save the case first', 'error'); return; }
    const btn = document.getElementById('io-slack-btn');
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> Sending…';
    try {
      const r = await fetch(`/api/incorrect-orders/${id}/notify`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      btn.classList.add('io-slack-sent');
      btn.innerHTML = '<span>✅</span> Stock Check Sent';
      showToast('Slack alert sent ✓', 'success');
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = '<span>🔔</span> Send Urgent Stock Check to Slack';
      showToast('Slack failed: ' + err.message, 'error');
    }
  }

  // ── Add timeline note ─────────────────────────────────────────────
  async function addNote() {
    const id = caseId || (caseData && caseData.id);
    if (!id) { showToast('Save the case first', 'error'); return; }
    const inp  = document.getElementById('io-new-note');
    const note = inp.value.trim();
    if (!note) return;
    const btn = document.getElementById('io-add-note-btn');
    btn.disabled = true;
    try {
      const r = await fetch(`/api/incorrect-orders/${id}/notes`, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ note }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      inp.value = '';
      // Reload to get fresh timeline
      const cr = await fetch(`/api/incorrect-orders/${id}`);
      const cd = await cr.json();
      renderTimeline(cd.timeline || []);
      showToast('Note added', 'success');
    } catch (err) {
      showToast('Failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ── Init ─────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    // Set default reported date to today
    const today = new Date().toISOString().split('T')[0];
    const dateInput = document.getElementById('io-reported-date');
    if (!dateInput.value) dateInput.value = today;

    // Hide resolution wrap initially for new cases
    document.getElementById('io-resolution-wrap').style.display = 'none';

    // Setup product search for both sides
    setupProductSearch('correct');
    setupProductSearch('received');

    // Order lookup
    document.getElementById('io-lookup-btn').addEventListener('click', lookupOrder);
    document.getElementById('io-order-num').addEventListener('keydown', e => {
      if (e.key === 'Enter') lookupOrder();
    });

    // Stock count toggles
    document.querySelectorAll('.io-stock-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const side = btn.dataset.side;
        const val  = btn.dataset.val === 'true';
        setStockBtn(side, val);
      });
    });

    // Status buttons
    document.querySelectorAll('.io-status-btn').forEach(btn => {
      btn.addEventListener('click', () => setStatus(btn.dataset.val));
    });

    // Resolution type change → show/hide replacement order field
    document.getElementById('io-resolution').addEventListener('change', updateResolutionVisibility);

    // Unlink product (delegated)
    document.addEventListener('click', e => {
      const btn = e.target.closest('.io-unlink-btn');
      if (!btn) return;
      const side = btn.dataset.side;
      setLinkedProduct(side, null, null);
    });

    // Save / Delete / Slack / Add note
    document.getElementById('io-save-btn').addEventListener('click', saveCase);
    document.getElementById('io-delete-btn').addEventListener('click', deleteCase);
    document.getElementById('io-slack-btn').addEventListener('click', sendSlack);
    document.getElementById('io-add-note-btn').addEventListener('click', addNote);
    document.getElementById('io-new-note').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addNote();
    });

    // Load existing case or prep for new
    if (caseId) {
      loadCase();
    } else {
      document.getElementById('io-timeline-card').style.display = 'none';
    }
  });
})();
