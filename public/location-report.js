const AISLE_COLORS = ['#6366f1','#22c55e','#f97316','#ef4444','#0ea5e9','#8b5cf6','#14b8a6','#f59e0b'];
const AISLE_LABELS = ['A1','A2','A3','A4','A5','A6','A7','A8'];

let allLocated   = [];
let allNoLocation = [];
let activeTab    = 'by-aisle';

function aisleColor(n) { return (n >= 1 && n <= 8) ? AISLE_COLORS[n - 1] : '#94a3b8'; }
function aisleLabel(n) { return (n >= 1 && n <= 8) ? AISLE_LABELS[n - 1] : (n != null ? 'A' + n : '—'); }

function thumb(url, size = 80) {
  if (!url) return null;
  return url.replace(/(\.[a-z]+)(\?.*)?$/i, `_${size}x${size}_crop_center$1$2`);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function imgHtml(url) {
  const t = thumb(url, 80);
  return t
    ? `<img class="lr-thumb" src="${t}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'lr-thumb-ph\\'>&#128230;</div>'">`
    : `<div class="lr-thumb-ph">&#128230;</div>`;
}

// ── Data building ──────────────────────────────────────────────────
function buildData(products, locationData) {
  allLocated    = [];
  allNoLocation = [];

  for (const product of products) {
    const loc   = locationData[product.id];
    const ploc  = (loc && (loc.aisle != null || loc.bay != null)) ? loc : null;

    // Collect variant-level overrides
    const overrides = [];
    if (loc?.variants) {
      for (const [vid, vloc] of Object.entries(loc.variants)) {
        if (vloc.aisle == null && vloc.bay == null) continue;
        const v = product.variants.find(x => x.id === vid);
        if (!v) continue;
        overrides.push({
          variantId:    vid,
          variantTitle: (v.title && v.title !== 'Default Title') ? v.title : null,
          sku:          v.sku || '',
          aisle:        vloc.aisle,
          bay:          vloc.bay,
        });
      }
    }

    if (ploc) {
      // Product-level location — one row; variant overrides shown as sub-rows
      allLocated.push({
        type:         'product',
        productId:    product.id,
        title:        product.title,
        image:        product.image,
        variantCount: product.variants.length,
        aisle:        ploc.aisle,
        bay:          ploc.bay,
        excess_loc:   ploc.excess_loc || null,
        overrides,
      });
    } else if (overrides.length) {
      // No product-level location; each variant override becomes its own row
      for (const ov of overrides) {
        allLocated.push({
          type:         'variant',
          productId:    product.id,
          title:        product.title,
          variantTitle: ov.variantTitle,
          sku:          ov.sku,
          image:        product.image,
          variantCount: product.variants.length,
          aisle:        ov.aisle,
          bay:          ov.bay,
          overrides:    [],
        });
      }
    } else {
      allNoLocation.push({
        productId:    product.id,
        title:        product.title,
        image:        product.image,
        variantCount: product.variants.length,
      });
    }
  }

  // Sort located items: aisle asc, bay asc (nulls last)
  allLocated.sort((a, b) => {
    const da = (a.aisle ?? 999) - (b.aisle ?? 999);
    return da !== 0 ? da : (a.bay ?? 999) - (b.bay ?? 999);
  });

  allNoLocation.sort((a, b) => a.title.localeCompare(b.title));
}

// ── Row rendering ──────────────────────────────────────────────────
function itemRowHtml(item) {
  const sub = item.type === 'variant'
    ? [item.variantTitle, item.sku].filter(Boolean).join(' · ') || 'Variant'
    : `${item.variantCount} variant${item.variantCount !== 1 ? 's' : ''}${item.overrides?.length ? ` · ${item.overrides.length} override${item.overrides.length !== 1 ? 's' : ''}` : ''}`;

  const bayText   = item.bay  != null ? `Bay ${item.bay}` : 'No bay';
  const excessHtml = item.excess_loc
    ? `<span class="lr-excess" title="Excess stock location">${escHtml(item.excess_loc)}</span>` : '';

  const overridesHtml = item.overrides?.length
    ? `<div class="lr-overrides">${item.overrides.map(ov => `
        <div class="lr-ov-row">
          <span class="lr-ov-tag">override</span>
          <span class="lr-ov-name">${escHtml(ov.variantTitle || ov.sku || 'Variant')}</span>
          <span class="lr-ov-loc">${escHtml(aisleLabel(ov.aisle))} / Bay ${ov.bay ?? '—'}</span>
        </div>`).join('')}</div>`
    : '';

  return `
    <div class="lr-item-wrap">
      <div class="lr-item">
        ${imgHtml(item.image)}
        <div class="lr-info">
          <div class="lr-title">${escHtml(item.title)}</div>
          <div class="lr-sub">${escHtml(sub)}</div>
        </div>
        <div class="lr-right">
          ${excessHtml}
          <div class="lr-bay-badge">${escHtml(bayText)}</div>
        </div>
      </div>
      ${overridesHtml}
    </div>`;
}

// ── Tab renderers ──────────────────────────────────────────────────
function renderByAisle() {
  if (!allLocated.length) {
    return `<div class="lr-empty">No products have locations assigned yet.<br><a href="/locations.html" style="color:#4f46e5">Assign locations &#8594;</a></div>`;
  }

  // Group by aisle
  const groups = {};
  for (const item of allLocated) {
    const key = item.aisle ?? 0;
    (groups[key] = groups[key] || []).push(item);
  }

  return Object.entries(groups)
    .sort(([a], [b]) => +a - +b)
    .map(([a, items]) => {
      const n = +a;
      return `
        <div class="lr-aisle">
          <div class="lr-aisle-hdr" style="background:${aisleColor(n)}">
            <span class="lr-aisle-label">${escHtml(aisleLabel(n))}</span>
            <span class="lr-aisle-count">${items.length} product${items.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="lr-items">${items.map(itemRowHtml).join('')}</div>
        </div>`;
    }).join('');
}

function renderByAisleBay() {
  if (!allLocated.length) {
    return `<div class="lr-empty">No products have locations assigned yet.<br><a href="/locations.html" style="color:#4f46e5">Assign locations &#8594;</a></div>`;
  }

  // Group by aisle → bay
  const aisleMap = {};
  for (const item of allLocated) {
    const ak = item.aisle ?? 0;
    const bk = item.bay   ?? 0;
    if (!aisleMap[ak]) aisleMap[ak] = {};
    (aisleMap[ak][bk] = aisleMap[ak][bk] || []).push(item);
  }

  return Object.entries(aisleMap)
    .sort(([a], [b]) => +a - +b)
    .map(([a, bays]) => {
      const n = +a;
      const total = Object.values(bays).reduce((s, arr) => s + arr.length, 0);

      const baysHtml = Object.entries(bays)
        .sort(([a], [b]) => +a - +b)
        .map(([b, items]) => {
          const bayLabel = +b > 0 ? `Bay ${b}` : 'No Bay Assigned';
          return `
            <div>
              <div class="lr-bay-hdr">${escHtml(bayLabel)}</div>
              <div class="lr-items">${items.map(itemRowHtml).join('')}</div>
            </div>`;
        }).join('');

      return `
        <div class="lr-aisle">
          <div class="lr-aisle-hdr" style="background:${aisleColor(n)}">
            <span class="lr-aisle-label">${escHtml(aisleLabel(n))}</span>
            <span class="lr-aisle-count">${total} product${total !== 1 ? 's' : ''}</span>
          </div>
          ${baysHtml}
        </div>`;
    }).join('');
}

function renderNoLocation() {
  if (!allNoLocation.length) {
    return `<div class="lr-empty" style="color:#15803d">&#10003; Every product has a location assigned!</div>`;
  }

  const rows = allNoLocation.map(p => `
    <div class="lr-noloc-item">
      ${imgHtml(p.image)}
      <span class="lr-noloc-title">${escHtml(p.title)}</span>
      <span class="lr-noloc-count">${p.variantCount} variant${p.variantCount !== 1 ? 's' : ''}</span>
      <a class="lr-noloc-link" href="/locations.html">Assign &#8594;</a>
    </div>`).join('');

  return `
    <p style="font-size:0.83rem;color:#64748b;margin-bottom:12px">
      ${allNoLocation.length} product${allNoLocation.length !== 1 ? 's' : ''} without any location assignment
    </p>
    ${rows}`;
}

// ── Main render ────────────────────────────────────────────────────
function renderAll() {
  document.getElementById('tab-by-aisle').innerHTML = renderByAisle();
  document.getElementById('tab-by-bay').innerHTML   = renderByAisleBay();
  document.getElementById('tab-no-loc').innerHTML   = renderNoLocation();

  // Show active panel
  ['by-aisle','by-bay','no-loc'].forEach(id => {
    document.getElementById('tab-' + id).style.display = id === activeTab ? 'block' : 'none';
  });
}

function renderSummary() {
  const el = document.getElementById('lr-summary');
  el.style.display = 'flex';
  el.innerHTML = `
    <div class="lr-stat"><strong>${allLocated.length}</strong><span>Products located</span></div>
    <div class="lr-stat"><strong>${allNoLocation.length}</strong><span>Without location</span></div>`;

  document.getElementById('b-aisle').textContent = allLocated.length;
  document.getElementById('b-bay').textContent   = allLocated.length;
  document.getElementById('b-noloc').textContent  = allNoLocation.length;

  // Warn badge on No Location tab if there are unassigned products
  if (allNoLocation.length > 0) {
    document.querySelector('[data-tab="no-loc"]').classList.add('warn');
  }
}

// ── Load ───────────────────────────────────────────────────────────
async function loadReport() {
  try {
    const [pRes, lRes] = await Promise.all([
      fetch('/api/locations/products'),
      fetch('/api/locations'),
    ]);
    if (!pRes.ok || !lRes.ok) throw new Error('Failed to load data');
    const products      = await pRes.json();
    const locationData  = await lRes.json();

    buildData(products, locationData);
    renderSummary();
    renderAll();
  } catch (err) {
    document.getElementById('lr-loading').textContent = 'Error: ' + err.message;
    return;
  }
  document.getElementById('lr-loading').style.display = 'none';
}

// ── Tab switching ──────────────────────────────────────────────────
document.querySelectorAll('.lr-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document.querySelectorAll('.lr-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['by-aisle','by-bay','no-loc'].forEach(id => {
      document.getElementById('tab-' + id).style.display = id === activeTab ? 'block' : 'none';
    });
  });
});

loadReport();
