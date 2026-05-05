/* ── State ─────────────────────────────────────────────────────── */
const state = {
  loaded: false,
  initials: '',
  searchResults: [],
  counts: {},
  submitted: new Set(), // productIds submitted this session
};

/* ── DOM refs ──────────────────────────────────────────────────── */
const searchInput    = document.getElementById('search-input');
const searchHint     = document.getElementById('search-hint');
const resultsEl      = document.getElementById('results');
const btnPdf         = document.getElementById('btn-pdf');
const cacheStatus    = document.getElementById('cache-status');
const userBadge      = document.getElementById('user-badge');

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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ── Auto-derive initials from logged-in Google account ─────────── */
fetch('/api/me')
  .then((r) => r.ok ? r.json() : null)
  .then((user) => {
    if (!user) return;
    const name = user.displayName || user.email || '';
    // "Jane Smith" → "JS", "Mary Jane Watson" → "MJW"
    const initials = name.trim().split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
    state.initials = initials || name.slice(0, 4).toUpperCase();
    userBadge.textContent = name;
  })
  .catch(() => {});


/* ── Search ────────────────────────────────────────────────────── */
const doSearch = debounce(async (query) => {
  if (query.length < 2) {
    resultsEl.innerHTML = `<div class="state-msg">Type at least 2 characters to search.</div>`;
    state.searchResults = [];
    return;
  }

  resultsEl.innerHTML = `<div class="state-msg"><div class="spinner"></div></div>`;

  try {
    const res  = await fetch(`/api/products/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    state.searchResults = data;

    if (data.length === 0) {
      resultsEl.innerHTML = `<div class="state-msg">No active products found matching "<strong>${escHtml(query)}</strong>".</div>`;
      return;
    }

    renderResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<div class="state-msg" style="color:#b91c1c">Search error: ${err.message}</div>`;
  }
}, 300);

searchInput.addEventListener('input', (e) => doSearch(e.target.value.trim()));

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
    const systemQty = v.inventory_quantity ?? 0;
    const counted   = state.counts[v.id] ?? '';
    const d         = diff(systemQty, counted);
    const rowClass  = d !== null && d !== 0 ? ' class="discrepancy"' : '';

    return `
      <tr${rowClass} data-variant-id="${v.id}" data-product-id="${product.id}">
        <td>${escHtml(v.title === 'Default Title' ? '—' : v.title)}</td>
        <td><code>${escHtml(v.sku || '—')}</code></td>
        <td style="text-align:center">${systemQty}</td>
        <td style="text-align:center">
          <input
            class="count-input"
            type="number"
            min="0"
            step="1"
            data-variant-id="${v.id}"
            data-system-qty="${systemQty}"
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
            <th style="text-align:center">System Qty</th>
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
  const input      = e.target;
  const variantId  = input.dataset.variantId;
  const systemQty  = Number(input.dataset.systemQty);
  const counted    = input.value.trim();

  if (counted === '') {
    delete state.counts[variantId];
  } else {
    state.counts[variantId] = counted;
  }

  const d    = diff(systemQty, counted);
  const row  = input.closest('tr');
  const cell = row.querySelector('.diff-cell');
  cell.innerHTML = diffBadge(d);

  if (d !== null && d !== 0) {
    row.classList.add('discrepancy');
  } else {
    row.classList.remove('discrepancy');
  }
}

/* ── Submit handler ────────────────────────────────────────────── */
async function handleSubmit(e) {
  const btn          = e.currentTarget;
  const productId    = Number(btn.dataset.productId);
  const productTitle = btn.dataset.productTitle;

  btn.disabled = true;
  btn.textContent = 'Saving…';

  // Collect all filled-in variant counts for this product
  const product  = state.searchResults.find((p) => p.id === productId);
  const variants = product ? product.variants.flatMap((v) => {
    const counted = state.counts[v.id];
    if (counted === undefined || counted === '') return [];
    return [{
      variantId:    v.id,
      variantTitle: v.title,
      sku:          v.sku || '',
      systemQty:    v.inventory_quantity ?? 0,
      countedQty:   Number(counted),
    }];
  }) : [];

  try {
    const res = await fetch('/api/stocktake/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, productTitle, initials: state.initials, variants }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    state.submitted.add(productId);

    // Update card UI
    const card = document.querySelector(`.product-card[data-product-id="${productId}"]`);
    if (card) {
      card.classList.add('submitted');
      btn.textContent = '✓ Submitted';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-submitted');
      card.querySelectorAll('.count-input').forEach((i) => (i.disabled = true));

      // Update last-check label
      const lc = card.querySelector('.last-check');
      if (lc) {
        lc.classList.remove('never');
        lc.innerHTML = `Last checked: ${formatDate(data.entry.timestamp)} by <strong>${escHtml(data.entry.initials)}</strong>`;
      }
    }
  } catch (err) {
    btn.disabled = false;
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

  const rows = [];

  for (const product of state.searchResults) {
    for (const v of product.variants) {
      const counted = state.counts[v.id];
      if (counted === undefined || counted === '') continue;

      const systemQty = v.inventory_quantity ?? 0;
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

  if (rows.length === 0) {
    doc.setFontSize(12);
    doc.setTextColor(21, 128, 61);
    doc.text('No discrepancies found — all counted quantities match system inventory.', 14, 40);
  } else {
    doc.autoTable({
      startY: 32,
      head: [['Style Name', 'Variant', 'SKU', 'System Qty', 'Counted Qty', 'Difference']],
      body: rows,
      headStyles: { fillColor: [26, 26, 46], textColor: 255, fontStyle: 'bold', fontSize: 9 },
      bodyStyles: { fontSize: 9 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        3: { halign: 'center' },
        4: { halign: 'center' },
        5: { halign: 'center', fontStyle: 'bold' },
      },
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

/* ── Init: check cache status on load ─────────────────────────── */
(async () => {
  try {
    const res  = await fetch('/api/products/status');
    const data = await res.json();
    if (data.count > 0) {
      state.loaded           = true;
      cacheStatus.textContent = `${data.count} active products — loaded ${formatDate(data.lastFetched)}`;
      searchInput.disabled   = false;
      searchHint.textContent = 'Type at least 2 characters to search';
      btnPdf.disabled        = false;
      resultsEl.innerHTML    = `<div class="state-msg">Search for a style or SKU above.</div>`;
    } else {
      cacheStatus.innerHTML = `Inventory not loaded — <a href="/syncing.html" class="toolbar-link">go to Syncing</a>`;
    }
  } catch (_) {}
})();
