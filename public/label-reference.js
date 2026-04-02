// ── State ──────────────────────────────────────────────────────────
let refSummary  = [];          // [{sku, productTitle, variantTitle, count}]
let refMap      = {};          // sku → summary row (for fast lookup)
let pendingMeta = null;        // SKU/product info for the open upload modal
let pendingDataUrl = null;     // compressed image data URL ready to upload

// ── Init ───────────────────────────────────────────────────────────
async function init() {
  await loadExisting();
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchProducts();
  });
}

// ── Load existing reference image summary ─────────────────────────
async function loadExisting() {
  const container = document.getElementById('existing-refs');
  try {
    const res  = await fetch('/api/label/references');
    refSummary = await res.json();
    if (!res.ok) throw new Error(refSummary.error || 'Failed');

    // Build lookup map
    refMap = {};
    for (const row of refSummary) refMap[row.sku] = row;

    renderStats();
    renderExisting();
  } catch (err) {
    container.innerHTML = `<div class="state-msg" style="color:#b91c1c">Error: ${escHtml(err.message)}</div>`;
  }
}

// ── Stats bar ─────────────────────────────────────────────────────
function renderStats() {
  const ready   = refSummary.filter(r => r.count >= 3).length;
  const partial = refSummary.filter(r => r.count > 0 && r.count < 3).length;
  const total   = refSummary.reduce((s, r) => s + r.count, 0);
  const skus    = refSummary.length;

  document.getElementById('stat-ready').textContent   = ready;
  document.getElementById('stat-partial').textContent = partial;
  document.getElementById('stat-total').textContent   = total;
  document.getElementById('stat-skus').textContent    = skus;
  document.getElementById('stats-row').style.display  = 'flex';
}

// ── Render existing SKUs ───────────────────────────────────────────
function renderExisting() {
  const container = document.getElementById('existing-refs');
  const title     = document.getElementById('existing-title');

  if (!refSummary.length) {
    container.innerHTML = `
      <div class="ref-empty">
        No reference images yet.<br>
        Search for a product above to start adding label photos.
      </div>`;
    title.textContent = 'Existing Reference Images';
    return;
  }

  title.textContent = `Existing Reference Images (${refSummary.length} SKU${refSummary.length !== 1 ? 's' : ''})`;

  // Group by productTitle
  const byProduct = {};
  for (const row of refSummary) {
    const key = row.productTitle || '(Unknown Product)';
    if (!byProduct[key]) byProduct[key] = [];
    byProduct[key].push(row);
  }

  container.innerHTML = Object.entries(byProduct).map(([title, variants]) => `
    <div class="ref-product-block">
      <div class="ref-product-title">${escHtml(title)}</div>
      ${variants.map(v => renderVariantRow(v, false)).join('')}
    </div>
  `).join('');

  // Attach expand listeners to load actual thumbnails
  container.querySelectorAll('[data-expand-sku]').forEach(btn => {
    btn.addEventListener('click', () => expandSku(btn.dataset.expandSku));
  });
}

// ── Variant row (used in both existing + search results) ───────────
function renderVariantRow(variant, showImages) {
  const { sku, variantTitle, count = 0 } = variant;
  const badgeClass = count >= 3 ? 'ref-badge--ready' : count > 0 ? 'ref-badge--partial' : 'ref-badge--missing';
  const badgeText  = count >= 3 ? `${count} images ✓` : count > 0 ? `${count} image${count > 1 ? 's' : ''} — add more` : 'No images';

  return `
    <div class="ref-variant-row" id="vrow-${escAttr(sku)}">
      <div class="ref-variant-info">
        <div class="ref-variant-name">${escHtml(variantTitle || 'Default')}</div>
        <div class="ref-sku-chip">${escHtml(sku || '—')}</div>
      </div>
      <span class="ref-badge ${badgeClass}">
        <span class="ref-badge-dot"></span>${escHtml(badgeText)}
      </span>
      <div class="ref-thumb-strip" id="thumbs-${escAttr(sku)}">
        ${showImages ? '' : `
          <button class="btn btn-secondary" style="font-size:0.78rem;padding:6px 12px"
                  data-expand-sku="${escAttr(sku)}">
            View / Add
          </button>
        `}
      </div>
    </div>
  `;
}

// ── Expand a SKU to show thumbnails ───────────────────────────────
async function expandSku(sku) {
  const strip = document.getElementById(`thumbs-${CSS.escape(sku)}`);
  if (!strip) return;
  strip.innerHTML = '<span style="font-size:0.8rem;color:#94a3b8">Loading…</span>';

  try {
    const res    = await fetch(`/api/label/references/images?sku=${encodeURIComponent(sku)}`);
    const images = await res.json();
    renderThumbStrip(sku, images, strip);
  } catch (err) {
    strip.innerHTML = `<span style="color:#b91c1c;font-size:0.8rem">${escHtml(err.message)}</span>`;
  }
}

function renderThumbStrip(sku, images, strip) {
  const meta = refMap[sku] || {};

  const thumbsHtml = images.map(img => `
    <div style="display:flex;flex-direction:column;align-items:center">
      <div class="ref-thumb-wrap">
        <img class="ref-thumb" src="${escAttr(img.imageData)}" alt="" />
        <button class="ref-thumb-del" onclick="deleteRef(${img.id}, '${escAttr(sku)}')"
                title="Delete this image">&#10005;</button>
      </div>
      ${img.imageLabel ? `<div class="ref-thumb-label">${escHtml(img.imageLabel)}</div>` : ''}
    </div>
  `).join('');

  strip.innerHTML = `
    ${thumbsHtml}
    <div style="display:flex;flex-direction:column;align-items:center">
      <button class="ref-add-btn"
              onclick="openModal('${escAttr(sku)}','${escAttr(meta.productTitle||'')}','${escAttr(meta.variantTitle||'')}','${escAttr(meta.productId||'')}')"
              title="Add reference image">+</button>
      <div style="font-size:0.65rem;color:#94a3b8;margin-top:2px;width:60px;text-align:center">Add</div>
    </div>
  `;
}

// ── Search products ───────────────────────────────────────────────
async function searchProducts() {
  const q       = document.getElementById('search-input').value.trim();
  const btn     = document.getElementById('btn-search');
  const results = document.getElementById('search-results');

  if (!q) { results.innerHTML = ''; return; }

  btn.disabled = true; btn.textContent = 'Searching…';
  results.innerHTML = '<div class="pick-state" style="padding:16px 0">Searching…</div>';

  try {
    const res      = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`);
    const products = await res.json();

    if (!products.length) {
      results.innerHTML = '<div class="pick-state" style="padding:16px 0;color:#94a3b8">No products found.</div>';
      return;
    }

    results.innerHTML = products.slice(0, 20).map(product => {
      const variants = (product.variants || []).filter(v => v.sku);
      if (!variants.length) return '';

      const variantRowsHtml = variants.map(v => {
        const existing = refMap[v.sku];
        const count    = existing?.count || 0;
        const row = renderVariantRow({
          sku: v.sku,
          variantTitle: v.title !== 'Default Title' ? v.title : null,
          productTitle: product.title,
          productId: String(product.id),
          count,
        }, false);
        return row;
      }).join('');

      if (!variantRowsHtml) return '';

      return `
        <div class="ref-product-block">
          <div class="ref-product-title">${escHtml(product.title)}</div>
          ${variantRowsHtml}
        </div>
      `;
    }).join('');

    // Wire expand buttons in search results
    results.querySelectorAll('[data-expand-sku]').forEach(btn => {
      btn.addEventListener('click', () => expandSkuInContext(btn, btn.dataset.expandSku,
        btn.closest('.ref-product-block')?.querySelector('.ref-product-title')?.textContent || '',
        products));
    });

  } catch (err) {
    results.innerHTML = `<div class="state-msg" style="color:#b91c1c">Error: ${escHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Search';
  }
}

// Expand within search results (needs product context for the modal)
async function expandSkuInContext(btn, sku, productTitle, products) {
  // Find the matching product/variant to get IDs
  let productId = '', variantTitle = '';
  for (const p of products) {
    const v = (p.variants || []).find(v => v.sku === sku);
    if (v) {
      productId    = String(p.id);
      variantTitle = v.title !== 'Default Title' ? v.title : '';
      productTitle = p.title;
      break;
    }
  }
  // Update refMap so the modal has the right context
  if (!refMap[sku]) {
    refMap[sku] = { sku, productTitle, variantTitle, productId, count: 0 };
  }
  await expandSku(sku);
}

// ── Upload modal ───────────────────────────────────────────────────
function openModal(sku, productTitle, variantTitle, productId) {
  pendingMeta    = { sku, productTitle, variantTitle, productId };
  pendingDataUrl = null;

  document.getElementById('modal-title').textContent = 'Add Reference Image';
  document.getElementById('modal-sku').textContent   =
    `${productTitle || ''}${variantTitle ? ' — ' + variantTitle : ''}  ·  SKU: ${sku}`;
  document.getElementById('preview-img').style.display       = 'none';
  document.getElementById('preview-img').src                 = '';
  document.getElementById('preview-placeholder').style.display = 'block';
  document.getElementById('label-input').value               = '';
  document.getElementById('btn-upload').disabled             = true;
  document.getElementById('modal-progress').textContent      = '';
  document.getElementById('modal-error').textContent         = '';
  document.getElementById('file-input').value                = '';

  document.getElementById('upload-overlay').classList.add('active');
}

function closeModal() {
  document.getElementById('upload-overlay').classList.remove('active');
  pendingMeta    = null;
  pendingDataUrl = null;
}

function triggerFileInput() {
  document.getElementById('file-input').click();
}

async function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  document.getElementById('modal-progress').textContent = 'Compressing image…';
  document.getElementById('modal-error').textContent    = '';
  document.getElementById('btn-upload').disabled        = true;

  try {
    pendingDataUrl = await compressImage(file, 800, 0.82);

    document.getElementById('preview-img').src                  = pendingDataUrl;
    document.getElementById('preview-img').style.display        = 'block';
    document.getElementById('preview-placeholder').style.display = 'none';
    document.getElementById('btn-upload').disabled              = false;
    document.getElementById('modal-progress').textContent       =
      `Ready — ${Math.round(pendingDataUrl.length * 0.75 / 1024)}KB`;
  } catch (err) {
    document.getElementById('modal-error').textContent    = `Could not read image: ${err.message}`;
    document.getElementById('modal-progress').textContent = '';
  }
}

async function submitUpload() {
  if (!pendingDataUrl || !pendingMeta) return;

  const btn = document.getElementById('btn-upload');
  btn.disabled = true;
  document.getElementById('modal-progress').textContent = 'Uploading…';
  document.getElementById('modal-error').textContent    = '';

  try {
    const res  = await fetch('/api/label/references', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        sku:          pendingMeta.sku,
        productId:    pendingMeta.productId,
        productTitle: pendingMeta.productTitle,
        variantTitle: pendingMeta.variantTitle,
        imageData:    pendingDataUrl,
        imageLabel:   document.getElementById('label-input').value.trim() || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    document.getElementById('modal-progress').textContent = '✓ Uploaded!';

    // Refresh full summary from server so counts are accurate
    const sumRes  = await fetch('/api/label/references');
    const sumData = await sumRes.json();
    if (sumRes.ok) {
      refSummary = sumData;
      refMap = {};
      for (const row of refSummary) refMap[row.sku] = row;
    } else {
      // Fallback: increment locally
      if (refMap[pendingMeta.sku]) {
        refMap[pendingMeta.sku].count++;
      } else {
        refMap[pendingMeta.sku] = { ...pendingMeta, count: 1 };
        refSummary.push(refMap[pendingMeta.sku]);
      }
    }

    renderStats();

    // Rebuild the existing-refs section with correct counts, then expand this SKU
    const uploadedSku = pendingMeta.sku;
    renderExisting();
    // Re-wire listeners (renderExisting does this but we also expand immediately)
    await expandSku(uploadedSku);

    // Also update badge in search results if that section has this SKU
    updateBadge(uploadedSku, refMap[uploadedSku]?.count || 0);

    setTimeout(() => closeModal(), 800);
  } catch (err) {
    document.getElementById('modal-error').textContent    = err.message;
    document.getElementById('modal-progress').textContent = '';
    btn.disabled = false;
  }
}

// ── Delete ─────────────────────────────────────────────────────────
async function deleteRef(id, sku) {
  if (!confirm('Delete this reference image? This cannot be undone.')) return;

  try {
    const res = await fetch(`/api/label/references/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Delete failed');
    }

    // Decrement local count
    if (refMap[sku]) {
      refMap[sku].count = Math.max(0, refMap[sku].count - 1);
      if (refMap[sku].count === 0) {
        refSummary = refSummary.filter(r => r.sku !== sku);
        delete refMap[sku];
      }
    }

    // Reload the strip
    const strip = document.getElementById(`thumbs-${CSS.escape(sku)}`);
    if (strip) await expandSku(sku);

    updateBadge(sku, refMap[sku]?.count || 0);
    renderStats();
    if (!refSummary.length) renderExisting();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ── Update the coverage badge on a variant row ────────────────────
function updateBadge(sku, count) {
  const row = document.getElementById(`vrow-${CSS.escape(sku)}`);
  if (!row) return;
  const badge     = row.querySelector('.ref-badge');
  if (!badge) return;
  const badgeClass = count >= 3 ? 'ref-badge--ready' : count > 0 ? 'ref-badge--partial' : 'ref-badge--missing';
  const badgeText  = count >= 3 ? `${count} images ✓` : count > 0 ? `${count} image${count > 1 ? 's' : ''} — add more` : 'No images';
  badge.className = `ref-badge ${badgeClass}`;
  badge.innerHTML = `<span class="ref-badge-dot"></span>${escHtml(badgeText)}`;
}

// ── Image compression ─────────────────────────────────────────────
function compressImage(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxPx || height > maxPx) {
          if (width >= height) {
            height = Math.round((height / width) * maxPx);
            width  = maxPx;
          } else {
            width  = Math.round((width / height) * maxPx);
            height = maxPx;
          }
        }
        const canvas  = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Helpers ────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) {
  return String(str ?? '').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
}

// Close modal on overlay click
document.getElementById('upload-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

// Boot
init();
