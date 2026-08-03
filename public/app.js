/* ── State ─────────────────────────────────────────────────────── */
const state = {
  initials:      '',
  searchResults: [],
  counts:        {},
  submitted:     new Set(),
  shelfData:     {},   // productId → { variants: [{id, available, committed, wms_picked, true_shelf}] }
};

/* ── DOM refs ──────────────────────────────────────────────────── */
const searchInput = document.getElementById('search-input');
const resultsEl   = document.getElementById('results');
const btnPdf      = document.getElementById('btn-pdf');

/* ── Helpers ───────────────────────────────────────────────────── */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleString();
}

function diff(systemQty, counted) {
  if (counted === '' || counted === null || counted === undefined) return null;
  return Number(counted) - Number(systemQty);
}

function diffBadge(d) {
  if (d === null) return `<span class="diff-badge diff-none">—</span>`;
  if (d === 0)   return `<span class="diff-badge diff-ok">✓ 0</span>`;
  if (d > 0)     return `<span class="diff-badge diff-over">+${d}</span>`;
  return             `<span class="diff-badge diff-under">${d}</span>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getShelfQty(productId, variantId, fallback) {
  const sd = state.shelfData[productId];
  if (!sd) return fallback;
  const v = sd.variants.find(v => v.id === variantId);
  return v ? v.true_shelf : fallback;
}

/* ── Initials (persisted) ─────────────────────────────────────── */
(function () {
  const el    = document.getElementById('initials-input');
  const saved = localStorage.getItem('stocktake_initials');
  if (saved) { el.value = saved; state.initials = saved; }
  el.addEventListener('input', () => {
    el.value       = el.value.toUpperCase();
    state.initials = el.value.trim();
    localStorage.setItem('stocktake_initials', state.initials);
  });
  el.addEventListener('focus', () => { el.style.borderColor = '#4f46e5'; });
  el.addEventListener('blur',  () => { el.style.borderColor = '#e2e8f0'; });
}());

/* ── Search ────────────────────────────────────────────────────── */
const doSearch = debounce(async (query) => {
  if (query.length < 2) {
    resultsEl.innerHTML = `<div class="state-msg">Type at least 2 characters to search.</div>`;
    state.searchResults = [];
    return;
  }

  resultsEl.innerHTML = `<div class="state-msg"><div class="spinner"></div></div>`;

  try {
    const res = await fetch(`/api/stocktake/search-live?q=${encodeURIComponent(query)}`);
    if (res.status === 401) { window.location.href = '/login'; return; }
    const data = await res.json();
    state.searchResults = data;

    if (!data.length) {
      resultsEl.innerHTML = `<div class="state-msg">No products found matching "<strong>${escHtml(query)}</strong>".</div>`;
      return;
    }

    renderResults(data);

    // Fetch committed/picked breakdown for each result (runs in background)
    data.forEach(p => fetchShelfCount(p.id));

  } catch (err) {
    resultsEl.innerHTML = `<div class="state-msg" style="color:#b91c1c">Search error: ${err.message}</div>`;
  }
}, 300);

searchInput.addEventListener('input', (e) => doSearch(e.target.value.trim()));

/* ── Shelf-count fetch (background, per product) ──────────────── */
async function fetchShelfCount(productId) {
  try {
    const r = await fetch(`/api/products/${productId}/shelf-count`);
    if (!r.ok) return;
    const data = await r.json();
    state.shelfData[productId] = data;
    applyShelfToCard(productId, data.variants);
  } catch (_) {}
}

function applyShelfToCard(productId, variants) {
  variants.forEach(v => {
    // Update the shelf cell
    const cell = document.querySelector(`.shelf-cell[data-variant-shelf-id="${v.id}"]`);
    if (cell) {
      cell.innerHTML =
        `<span class="shelf-true">${v.true_shelf}</span>` +
        `<div class="shelf-breakdown">${v.available} avail · ${v.committed} committed · ${v.wms_picked} picked</div>`;
    }

    // Update the count input's reference qty and recalc diff
    const input = document.querySelector(`.count-input[data-variant-id="${v.id}"]`);
    if (input) {
      input.dataset.trueShelf = v.true_shelf;
      const counted = input.value.trim();
      if (counted !== '') {
        const d     = diff(v.true_shelf, counted);
        const row   = input.closest('tr');
        const dcell = row.querySelector('.diff-cell');
        if (dcell) dcell.innerHTML = diffBadge(d);
        row.classList.toggle('discrepancy', d !== null && d !== 0);
      }
    }
  });
}

/* ── Render ────────────────────────────────────────────────────── */
function renderResults(products) {
  resultsEl.innerHTML = products.map(renderProductCard).join('');

  resultsEl.querySelectorAll('.count-input').forEach((input) => {
    input.value = state.counts[input.dataset.variantId] ?? '';
    input.addEventListener('input', handleCountInput);
  });

  resultsEl.querySelectorAll('.btn-submit').forEach((btn) => {
    btn.addEventListener('click', handleSubmit);
  });
}

function renderProductCard(product) {
  const imgHtml = product.image
    ? `<img class="product-thumb" src="${escHtml(product.image)}" alt="" loading="lazy" />`
    : `<div class="product-thumb-placeholder">📦</div>`;

  const isSubmitted = state.submitted.has(product.id);

  const lastCheckHtml = product.lastCheck
    ? `<span class="last-check">Last checked: ${formatDate(product.lastCheck.timestamp)} by <strong>${escHtml(product.lastCheck.initials)}</strong></span>`
    : `<span class="last-check never">Never checked</span>`;

  const rows = product.variants.map((v) => {
    // Use shelf data if already loaded, otherwise show inventory_quantity with a loading indicator
    const sd      = state.shelfData[product.id];
    const sv      = sd ? sd.variants.find(sv => sv.id === v.id) : null;
    const trueShelf = sv ? sv.true_shelf : v.inventory_quantity;
    const counted   = state.counts[v.id] ?? '';
    const d         = diff(trueShelf, counted);
    const rowClass  = d !== null && d !== 0 ? ' class="discrepancy"' : '';

    const shelfCell = sv
      ? `<span class="shelf-true">${sv.true_shelf}</span>
         <div class="shelf-breakdown">${sv.available} avail · ${sv.committed} committed · ${sv.wms_picked} picked</div>`
      : `<span class="shelf-loading">${v.inventory_quantity} <span class="spin">↻</span></span>`;

    return `
      <tr${rowClass} data-variant-id="${v.id}" data-product-id="${product.id}">
        <td>${escHtml(v.title === 'Default Title' ? '—' : v.title)}</td>
        <td><code>${escHtml(v.sku || '—')}</code></td>
        <td style="text-align:center" class="shelf-cell" data-variant-shelf-id="${v.id}">${shelfCell}</td>
        <td style="text-align:center">
          <input
            class="count-input"
            type="number"
            min="0"
            step="1"
            data-variant-id="${v.id}"
            data-true-shelf="${trueShelf}"
            value="${counted}"
            placeholder="—"
            ${isSubmitted ? 'disabled' : ''}
          />
        </td>
        <td style="text-align:center" class="diff-cell">${diffBadge(d)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="product-card ${isSubmitted ? 'submitted' : ''}" data-product-id="${product.id}">
      <div class="product-header">
        ${imgHtml}
        <div class="product-header-info">
          <span class="product-title">${escHtml(product.title)}</span>
          ${lastCheckHtml}
        </div>
        <span class="variant-count">${product.variants.length} variant${product.variants.length !== 1 ? 's' : ''}</span>
        <button
          class="btn btn-submit ${isSubmitted ? 'btn-submitted' : 'btn-primary'}"
          data-product-id="${product.id}"
          data-product-title="${escHtml(product.title)}"
          ${isSubmitted ? 'disabled' : ''}
        >${isSubmitted ? '✓ Submitted' : 'Submit'}</button>
      </div>
      <table class="variants-table">
        <thead>
          <tr>
            <th>Variant</th>
            <th>SKU</th>
            <th style="text-align:center">True Shelf</th>
            <th style="text-align:center">Counted Qty</th>
            <th style="text-align:center">Difference</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ── Count input handler ───────────────────────────────────────── */
function handleCountInput(e) {
  const input     = e.target;
  const variantId = input.dataset.variantId;
  const trueShelf = Number(input.dataset.trueShelf);
  const counted   = input.value.trim();

  if (counted === '') {
    delete state.counts[variantId];
  } else {
    state.counts[variantId] = counted;
  }

  const d    = diff(trueShelf, counted);
  const row  = input.closest('tr');
  const cell = row.querySelector('.diff-cell');
  cell.innerHTML = diffBadge(d);

  row.classList.toggle('discrepancy', d !== null && d !== 0);
}

/* ── Submit handler ────────────────────────────────────────────── */
async function handleSubmit(e) {
  const btn          = e.currentTarget;
  const productId    = Number(btn.dataset.productId);
  const productTitle = btn.dataset.productTitle;

  btn.disabled    = true;
  btn.textContent = 'Saving…';

  const product     = state.searchResults.find((p) => p.id === productId);
  const shelfVars   = (state.shelfData[productId] || {}).variants || [];

  const variants = product ? product.variants.flatMap((v) => {
    const counted = state.counts[v.id];
    if (counted === undefined || counted === '') return [];
    const sv        = shelfVars.find(sv => sv.id === v.id);
    const systemQty = sv ? sv.true_shelf : (v.inventory_quantity ?? 0);
    return [{ variantId: v.id, variantTitle: v.title, sku: v.sku || '', systemQty, countedQty: Number(counted) }];
  }) : [];

  try {
    const res = await fetch('/api/stocktake/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ productId, productTitle, initials: state.initials, variants }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    state.submitted.add(productId);

    const card = document.querySelector(`.product-card[data-product-id="${productId}"]`);
    if (card) {
      card.classList.add('submitted');
      btn.textContent = '✓ Submitted';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-submitted');
      card.querySelectorAll('.count-input').forEach((i) => (i.disabled = true));
      const lc = card.querySelector('.last-check');
      if (lc) {
        lc.classList.remove('never');
        lc.innerHTML = `Last checked: ${formatDate(data.entry.timestamp)} by <strong>${escHtml(data.entry.initials)}</strong>`;
      }
    }
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = 'Submit';
    alert(`Failed to submit: ${err.message}`);
  }
}

/* ── PDF Export ────────────────────────────────────────────────── */
btnPdf.addEventListener('click', generatePdf);

function generatePdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const now     = new Date();
  const dateStr = now.toLocaleDateString();
  const timeStr = now.toLocaleTimeString();
  const rows    = [];

  for (const product of state.searchResults) {
    const shelfVars = (state.shelfData[product.id] || {}).variants || [];
    for (const v of product.variants) {
      const counted = state.counts[v.id];
      if (counted === undefined || counted === '') continue;
      const sv        = shelfVars.find(sv => sv.id === v.id);
      const systemQty = sv ? sv.true_shelf : (v.inventory_quantity ?? 0);
      const d         = Number(counted) - systemQty;
      if (d !== 0) {
        rows.push([
          product.title,
          v.title === 'Default Title' ? '—' : v.title,
          v.sku || '—',
          systemQty,
          Number(counted),
          d > 0 ? `+${d}` : String(d),
        ]);
      }
    }
  }

  doc.setFontSize(18);
  doc.setTextColor(26, 26, 46);
  doc.text('Stocktake Discrepancy Report', 14, 18);
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated: ${dateStr} at ${timeStr}   |   Stocktaker: ${state.initials}`, 14, 26);

  if (!rows.length) {
    doc.setFontSize(12);
    doc.setTextColor(21, 128, 61);
    doc.text('No discrepancies found — all counted quantities match true shelf inventory.', 14, 40);
  } else {
    doc.autoTable({
      startY: 32,
      head: [['Style Name', 'Variant', 'SKU', 'True Shelf', 'Counted Qty', 'Difference']],
      body: rows,
      headStyles: { fillColor: [26, 26, 46], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: { 3: { halign: 'center' }, 4: { halign: 'center' }, 5: { halign: 'center', fontStyle: 'bold' } },
      didParseCell(data) {
        if (data.column.index === 5 && data.section === 'body') {
          const val = String(data.cell.raw);
          if (val.startsWith('+')) data.cell.styles.textColor = [29, 78, 216];
          else if (val.startsWith('-')) data.cell.styles.textColor = [185, 28, 28];
        }
      },
    });
    const finalY = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(`Total discrepancies: ${rows.length}`, 14, finalY);
  }

  doc.save(`stocktake-report-${dateStr.replace(/\//g, '-')}.pdf`);
}
