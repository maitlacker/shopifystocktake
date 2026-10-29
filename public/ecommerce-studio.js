// Product Data Studio — metafield import, missing-data + reference health
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const REASON_LABEL = {
  sold_out: 'Sold out', low_stock: 'Low stock', inactive: 'Inactive', deleted: 'Deleted',
};

let overview = null;
let healthData = null;
let missingData = null;
let missFieldFilter = '';
let pollTimer = null;

function thumb(url, cls) {
  const safe = /^https:\/\/cdn\.shopify\.com\//.test(String(url || '')) ? url : '';
  return safe ? `<img class="${cls || ''}" src="${escHtml(safe)}" alt="" loading="lazy" />`
              : `<span class="${cls || ''}" style="display:inline-block"></span>`;
}

function adminLink(productId, text) {
  return `<a href="https://admin.shopify.com/store/theselfstyler/products/${encodeURIComponent(productId)}"
             target="_blank" rel="noopener">${escHtml(text)}</a>`;
}

// ── Tabs ───────────────────────────────────────────────────────────
function setTab(tab) {
  document.querySelectorAll('.es-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab));
  for (const p of ['health', 'missing', 'all']) {
    document.getElementById(`panel-${p}`).style.display = p === tab ? '' : 'none';
  }
}

// ── Overview / stat cards ──────────────────────────────────────────
async function loadOverview() {
  try {
    const res = await fetch('/api/ecom/metafields/overview');
    overview = await res.json();
    renderCards();
    renderAll();
    const meta = document.getElementById('es-sync-meta');
    if (overview.lastSync) {
      const d = new Date(overview.lastSync.at);
      meta.innerHTML = `Last sync: <b>${escHtml(d.toLocaleString())}</b><br>` +
        `${overview.lastSync.activeProducts} products · ${overview.lastSync.metafieldRows} metafields`;
    } else {
      meta.textContent = 'Never synced — run the first import';
    }
  } catch (err) {
    document.getElementById('es-sync-meta').textContent = 'Error loading overview';
  }
}

function renderCards() {
  const missingCount = missingData ? missingData.products.length : null;
  const s = healthData ? healthData.summary : null;
  const cards = [
    { v: overview?.activeProducts ?? '—', l: 'Active products' },
    { v: overview?.metafieldRows ?? '—', l: 'Metafield values' },
    { v: overview?.definitions?.length ?? '—', l: 'Distinct metafields' },
    { v: missingCount ?? '—', l: 'Products missing data', cls: missingCount ? 'warn' : '' },
    { v: s ? (s.sold_out + s.deleted + s.inactive) : '—', l: 'Broken / sold-out refs', cls: s && (s.sold_out + s.deleted + s.inactive) ? 'bad' : '' },
    { v: s ? s.low_stock : '—', l: 'Low-stock refs', cls: s && s.low_stock ? 'warn' : '' },
  ];
  document.getElementById('es-cards').innerHTML = cards.map(c =>
    `<div class="es-card ${c.cls || ''}"><div class="v">${escHtml(c.v)}</div><div class="l">${escHtml(c.l)}</div></div>`
  ).join('');
}

// ── Sync ───────────────────────────────────────────────────────────
async function startSync() {
  const btn = document.getElementById('es-sync-btn');
  btn.disabled = true;
  try {
    await fetch('/api/ecom/metafields/sync', { method: 'POST' });
    pollSync();
  } catch { btn.disabled = false; }
}

async function pollSync() {
  clearTimeout(pollTimer);
  const btn = document.getElementById('es-sync-btn');
  const meta = document.getElementById('es-sync-meta');
  try {
    const st = await (await fetch('/api/ecom/metafields/sync-status')).json();
    if (st.running) {
      btn.disabled = true;
      const prog = st.phase === 'products' ? `${st.done} products`
                 : st.phase === 'references' ? `refs ${st.done}/${st.total}`
                 : st.phase;
      meta.innerHTML = `<b>Syncing…</b> ${escHtml(prog)}`;
      pollTimer = setTimeout(pollSync, 1500);
      return;
    }
    btn.disabled = false;
    if (st.phase === 'error') {
      meta.innerHTML = `<span style="color:#b91c1c">Sync failed: ${escHtml(st.error || '')}</span>`;
      return;
    }
    await Promise.all([loadOverview(), loadHealth(), loadMissing()]);
  } catch {
    btn.disabled = false;
  }
}

// ── Reference health ───────────────────────────────────────────────
async function loadHealth() {
  const t = Number(document.getElementById('es-threshold').value) || 0;
  document.getElementById('es-health-list').innerHTML = '<div class="es-empty">Loading…</div>';
  try {
    healthData = await (await fetch(`/api/ecom/metafields/health?threshold=${t}`)).json();
    renderHealth();
    renderCards();
  } catch (err) {
    document.getElementById('es-health-list').innerHTML =
      `<div class="es-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

function renderHealth() {
  if (!healthData) return;
  const s = healthData.summary;
  document.getElementById('es-health-chips').innerHTML =
    `<span class="es-chip chip-sold_out">Sold out ${s.sold_out}</span>
     <span class="es-chip chip-low_stock">Low stock ${s.low_stock}</span>
     <span class="es-chip chip-inactive">Inactive ${s.inactive}</span>
     <span class="es-chip chip-deleted">Deleted ${s.deleted}</span>
     <span class="es-chip" style="background:#f1f5f9;color:#475569">${s.refsChecked} refs checked</span>`;

  const filter = document.getElementById('es-field-filter').value;
  const issues = healthData.issues.filter(i => !filter || i.field === filter);
  if (!issues.length) {
    document.getElementById('es-health-list').innerHTML =
      '<div class="es-empty">✅ No problem references found</div>';
    return;
  }
  document.getElementById('es-health-list').innerHTML = issues.map(i => `
    <div class="es-issue">
      <div class="es-issue-head">
        ${thumb(i.image)}
        <span class="es-issue-title">${adminLink(i.productId, i.title)}</span>
        <span class="es-issue-field">${escHtml(i.fieldLabel)}</span>
        <span style="color:#94a3b8;font-size:0.75rem">${i.refs.length} flagged</span>
      </div>
      <div class="es-refs">
        ${i.refs.map(r => `
          <span class="es-ref">
            ${thumb(r.image)}
            <span>${r.reason === 'deleted' ? escHtml(r.title) : adminLink(r.productId, r.title)}
              ${r.qty != null ? `<span class="q"> · ${Number(r.qty)} units</span>` : ''}
            </span>
            <span class="es-chip chip-${escHtml(r.reason)}">${escHtml(REASON_LABEL[r.reason] || r.reason)}</span>
          </span>`).join('')}
      </div>
    </div>`).join('');
}

// ── Missing data ───────────────────────────────────────────────────
async function loadMissing() {
  try {
    missingData = await (await fetch('/api/ecom/metafields/missing')).json();
    renderFieldChips();
    renderMissing();
    renderCards();
  } catch (err) {
    document.getElementById('es-missing-table').innerHTML =
      `<div class="es-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

function renderFieldChips() {
  document.getElementById('es-field-chips').innerHTML = missingData.fields.map(f =>
    `<span class="es-chip chip-count${missFieldFilter === f.key ? ' sel' : ''}"
           onclick="toggleMissFilter('${escHtml(f.key)}')">${escHtml(f.label)}: ${f.missing}</span>`
  ).join(' ');
}

function toggleMissFilter(key) {
  missFieldFilter = missFieldFilter === key ? '' : key;
  renderFieldChips();
  renderMissing();
}

function renderMissing() {
  if (!missingData) return;
  const q = (document.getElementById('es-miss-search').value || '').trim().toLowerCase();
  const labelOf = Object.fromEntries(missingData.fields.map(f => [f.key, f.label]));
  let rows = missingData.products;
  if (missFieldFilter) rows = rows.filter(p => p.missing.includes(missFieldFilter));
  if (q) rows = rows.filter(p => p.title.toLowerCase().includes(q));

  if (!rows.length) {
    document.getElementById('es-missing-table').innerHTML =
      '<div class="es-empty">✅ Nothing missing for this filter</div>';
    return;
  }
  document.getElementById('es-missing-table').innerHTML = `
    <table class="es-table">
      <thead><tr><th></th><th>Product</th><th>Type</th><th>Missing metafields</th></tr></thead>
      <tbody>
        ${rows.map(p => `
          <tr>
            <td>${thumb(p.image, 'thumb')}</td>
            <td>${adminLink(p.productId, p.title)}</td>
            <td>${escHtml(p.productType || '—')}</td>
            <td>${p.missing.map(k =>
              `<span class="es-miss-badge">${escHtml(labelOf[k] || k)}</span>`).join('')}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="es-note">${rows.length} of ${missingData.totalProducts} active products are missing at least one field.</div>`;
}

// ── All metafields ─────────────────────────────────────────────────
function renderAll() {
  if (!overview) return;
  const total = overview.activeProducts || 0;
  if (!overview.definitions.length) {
    document.getElementById('es-all-table').innerHTML =
      '<div class="es-empty">No metafields imported yet — run a sync.</div>';
    return;
  }
  document.getElementById('es-all-table').innerHTML = `
    <table class="es-table">
      <thead><tr><th>Namespace</th><th>Key</th><th>Name</th><th>Type</th><th>Coverage</th></tr></thead>
      <tbody>
        ${overview.definitions.map(d => {
          const pct = total ? Math.round((d.products_with / total) * 100) : 0;
          return `
          <tr>
            <td>${escHtml(d.namespace)}</td>
            <td><code>${escHtml(d.key)}</code></td>
            <td>${escHtml(d.name || '—')}</td>
            <td>${escHtml(d.type || '—')}</td>
            <td><span class="pct-bar"><span style="width:${pct}%"></span></span>
                ${d.products_with}/${total} (${pct}%)</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

// ── Init ───────────────────────────────────────────────────────────
loadOverview();
loadHealth();
loadMissing();
pollSync();
