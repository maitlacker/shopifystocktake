'use strict';

let pollTimer = null;

// ── Boot ──────────────────────────────────────────────────────────
(async function init() {
  await refreshStatus();
  await loadAssets();
})();

// ── Trigger manual sync ───────────────────────────────────────────
async function triggerSync() {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';

  try {
    const r = await fetch('/api/ads-assets/sync', { method: 'POST' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${r.status}`);
    }
    // Start polling immediately
    startPolling();
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'Run Sync Now';
  }
}

// ── Poll status every 2 s while isRunning ─────────────────────────
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const status = await refreshStatus();
    if (status && !status.isRunning) {
      stopPolling();
      await loadAssets(); // reload table once sync completes
      document.getElementById('syncBtn').disabled = false;
      document.getElementById('syncBtn').textContent = 'Run Sync Now';
    }
  }, 2000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ── Fetch + render status card ────────────────────────────────────
async function refreshStatus() {
  try {
    const r = await fetch('/api/ads-assets/status');
    if (!r.ok) return null;
    const s = await r.json();
    renderStatus(s);
    return s;
  } catch (err) {
    return null;
  }
}

function renderStatus(s) {
  const badge    = document.getElementById('statusBadge');
  const lastRun  = document.getElementById('lastRunText');
  const errorEl  = document.getElementById('errorMsg');
  const btn      = document.getElementById('syncBtn');

  // Badge + button state
  if (s.isRunning) {
    setBadge(badge, 'running', '⟳ Running…');
    btn.disabled = true;
    btn.textContent = 'Running…';
  } else if (s.error) {
    setBadge(badge, 'error', 'Error');
    btn.disabled = false;
    btn.textContent = 'Run Sync Now';
  } else if (s.lastRun) {
    setBadge(badge, 'ok', 'OK');
    btn.disabled = false;
    btn.textContent = 'Run Sync Now';
  } else {
    setBadge(badge, 'idle', 'Idle');
    btn.disabled = false;
    btn.textContent = 'Run Sync Now';
  }

  // Last run time
  if (s.lastRun) {
    lastRun.textContent = 'Last run: ' + fmtDateTime(s.lastRun);
  } else {
    lastRun.textContent = 'Never run';
  }

  // Stats
  document.getElementById('statUploaded').textContent = s.uploaded ?? '–';
  document.getElementById('statSkipped').textContent  = s.skipped  ?? '–';
  document.getElementById('statFailed').textContent   = s.failed   ?? '–';

  // Error message
  if (s.error) {
    errorEl.textContent = s.error;
    errorEl.style.display = 'block';
  } else {
    errorEl.style.display = 'none';
  }

  // Selected products panel
  const panel      = document.getElementById('productsPanel');
  const countEl    = document.getElementById('productCount');
  const listEl     = document.getElementById('productList');
  const titles     = s.selectedProductTitles || [];
  const numSelected = s.productsSelected || 0;

  if (titles.length > 0) {
    countEl.textContent = numSelected;
    listEl.innerHTML = titles.map((t) =>
      `<span class="aa-product-chip">${escHtml(t)}</span>`
    ).join('');
    panel.style.display = 'block';
  } else {
    panel.style.display = 'none';
  }
}

function setBadge(el, cls, text) {
  el.className = 'aa-badge ' + cls;
  el.textContent = text;
}

// ── Load + render assets table ────────────────────────────────────
async function loadAssets() {
  try {
    const r = await fetch('/api/ads-assets/list');
    if (!r.ok) return;
    const rows = await r.json();
    renderTable(rows);
  } catch (err) {
    console.error('loadAssets error:', err);
  }
}

function renderTable(rows) {
  const countTag  = document.getElementById('assetCount');
  const tableArea = document.getElementById('tableArea');

  countTag.textContent = rows.length + (rows.length === 1 ? ' asset' : ' assets');

  if (rows.length === 0) {
    tableArea.innerHTML = `
      <div class="aa-empty">
        <div class="aa-empty-icon">🖼️</div>
        <div class="aa-empty-title">No assets synced yet</div>
        <div class="aa-empty-sub">Click <strong>Run Sync Now</strong> to import new-arrivals images into your Google Ads Asset Library.</div>
      </div>`;
    return;
  }

  const rowsHtml = rows.map((row) => {
    const thumb = row.imageUrl
      ? `<img src="${escHtml(row.imageUrl)}" class="aa-thumb" alt="" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const placeholder = `<div class="aa-thumb-placeholder" ${row.imageUrl ? 'style="display:none"' : ''}>🖼️</div>`;

    const rolePill = row.imageRole
      ? `<span class="role-pill role-${escHtml(row.imageRole)}">${escHtml(row.imageRole)}</span>`
      : '<span style="color:#94a3b8; font-size:0.78rem;">—</span>';

    return `<tr>
      <td style="width:60px;">${thumb}${placeholder}</td>
      <td style="font-weight:600;">${escHtml(row.productTitle || '—')}</td>
      <td>${rolePill}</td>
      <td style="font-size:0.82rem; color:#475569;">${escHtml(row.assetName || '—')}</td>
      <td class="aa-resource">${row.resourceName ? escHtml(row.resourceName) : '<span style="color:#94a3b8;">—</span>'}</td>
      <td style="white-space:nowrap; color:#64748b; font-size:0.82rem;">${fmtDateTime(row.syncedAt)}</td>
    </tr>`;
  }).join('');

  tableArea.innerHTML = `
    <table class="aa-table">
      <thead>
        <tr>
          <th>Image</th>
          <th>Product</th>
          <th>Role</th>
          <th>Asset Name</th>
          <th>Resource Name</th>
          <th>Synced</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function showError(msg) {
  const errorEl = document.getElementById('errorMsg');
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
  setBadge(document.getElementById('statusBadge'), 'error', 'Error');
}

// ── Helpers ───────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
