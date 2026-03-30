const btnRun       = document.getElementById('btn-run');
const btnPdf       = document.getElementById('btn-pdf');
const resultsEl    = document.getElementById('results');
const reportSummary = document.getElementById('report-summary');

let reportData = [];

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderReport(products) {
  if (products.length === 0) {
    resultsEl.innerHTML = `<div class="state-msg" style="color:#15803d">
      ✓ No draft products with available stock found.
    </div>`;
    return;
  }

  const cards = products.map((product) => {
    const imgHtml = product.image
      ? `<img class="product-thumb" src="${escHtml(product.image)}" alt="" loading="lazy" />`
      : `<div class="product-thumb-placeholder">📦</div>`;

    const rows = product.variants.map((v) => `
      <tr>
        <td>${escHtml(v.title === 'Default Title' ? '—' : v.title)}</td>
        <td><code>${escHtml(v.sku || '—')}</code></td>
        <td style="text-align:center">
          <span class="diff-badge diff-under">${v.inventory_quantity}</span>
        </td>
      </tr>`).join('');

    return `
      <div class="product-card">
        <div class="product-header">
          ${imgHtml}
          <div class="product-header-info">
            <span class="product-title">${escHtml(product.title)}</span>
            <span class="last-check">Total stock on hand: <strong>${product.totalStock}</strong></span>
          </div>
          <span class="draft-badge ${product.status}">${product.status.toUpperCase()}</span>
          <span class="variant-count">${product.variants.length} variant${product.variants.length !== 1 ? 's' : ''} with stock</span>
        </div>
        <table class="variants-table">
          <thead>
            <tr>
              <th>Variant</th>
              <th>SKU</th>
              <th style="text-align:center">Stock on Hand</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });

  resultsEl.innerHTML = cards.join('');
}

btnRun.addEventListener('click', async () => {
  btnRun.disabled = true;
  btnPdf.disabled = true;
  reportSummary.textContent = 'Fetching…';
  resultsEl.innerHTML = `<div class="state-msg"><div class="spinner"></div><br>Checking Shopify for draft products with stock…</div>`;

  try {
    const res  = await fetch('/api/reports/draft-with-stock');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    reportData = data.products;
    reportSummary.textContent = `${data.count} product${data.count !== 1 ? 's' : ''} found`;
    renderReport(data.products);
    if (data.count > 0) btnPdf.disabled = false;
  } catch (err) {
    reportSummary.textContent = 'Error';
    resultsEl.innerHTML = `<div class="state-msg" style="color:#b91c1c">Error: ${err.message}</div>`;
  } finally {
    btnRun.disabled = false;
  }
});

btnPdf.addEventListener('click', () => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const now     = new Date();
  const dateStr = now.toLocaleDateString();
  const timeStr = now.toLocaleTimeString();

  const rows = [];
  reportData.forEach((product) => {
    product.variants.forEach((v) => {
      rows.push([
        product.title,
        product.status.toUpperCase(),
        v.title === 'Default Title' ? '—' : v.title,
        v.sku || '—',
        v.inventory_quantity,
      ]);
    });
  });

  doc.setFontSize(18);
  doc.setTextColor(26, 26, 46);
  doc.text('Draft Products with Available Stock', 14, 18);

  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated: ${dateStr} at ${timeStr}   |   ${reportData.length} product${reportData.length !== 1 ? 's' : ''} found`, 14, 26);

  doc.autoTable({
    startY: 32,
    head: [['Style Name', 'Status', 'Variant', 'SKU', 'Stock on Hand']],
    body: rows,
    headStyles: { fillColor: [26, 26, 46], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 4: { halign: 'center', fontStyle: 'bold', textColor: [185, 28, 28] } },
  });

  doc.save(`draft-with-stock-${dateStr.replace(/\//g, '-')}.pdf`);
});
