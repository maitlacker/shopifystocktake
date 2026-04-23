'use strict';

let allVariants   = [];   // full list from server
let activeFilter  = 'ALL';
let settings      = { lowMax: 25, highMin: 50, feedPrefix: 'shopify_AU', feedLabel: 'custom_label_3' };

const btnSync         = document.getElementById('btnSync');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const btnCopyFeed     = document.getElementById('btnCopyFeed');
const statusMsg       = document.getElementById('statusMsg');
const loadingMsg      = document.getElementById('loadingMsg');
const emptyMsg        = document.getElementById('emptyMsg');
const marginTable     = document.getElementById('marginTable');
const marginTbody     = document.getElementById('marginTbody');
const syncedAt        = document.getElementById('syncedAt');
const feedUrlEl       = document.getElementById('feedUrl');

const settingLowMax  = document.getElementById('settingLowMax');
const settingHighMin = document.getElementById('settingHighMin');
const settingPrefix  = document.getElementById('settingPrefix');
const settingLabel   = document.getElementById('settingLabel');

const statHigh = document.getElementById('statHigh');
const statMed  = document.getElementById('statMed');
const statLow  = document.getElementById('statLow');
const statUnk  = document.getElementById('statUnk');

const diagramLow     = document.getElementById('diagramLow');
const diagramLowVal  = document.getElementById('diagramLowVal');
const diagramHigh    = document.getElementById('diagramHigh');
const diagramHighVal = document.getElementById('diagramHighVal');

// ── Boot ──────────────────────────────────────────────────────────
(async function boot() {
  await loadSettings();
  await loadList();
}());

// ── Load settings ─────────────────────────────────────────────────
async function loadSettings() {
  try {
    const r = await fetch('/api/margin/settings');
    if (!r.ok) return;
    settings = await r.json();
    applySettingsToUI();
  } catch (_) {}
}

function applySettingsToUI() {
  settingLowMax.value  = settings.lowMax;
  settingHighMin.value = settings.highMin;
  settingPrefix.value  = settings.feedPrefix;
  settingLabel.value   = settings.feedLabel;
  updateDiagram();
  feedUrlEl.textContent = `${window.location.origin}/api/margin/feed.tsv`;
}

function updateDiagram() {
  const lm = parseFloat(settingLowMax.value)  || 25;
  const hm = parseFloat(settingHighMin.value) || 50;
  diagramLow.textContent     = lm;
  diagramLowVal.textContent  = lm;
  diagramHigh.textContent    = hm;
  diagramHighVal.textContent = hm;
}

settingLowMax.addEventListener('input', updateDiagram);
settingHighMin.addEventListener('input', updateDiagram);

// ── Save settings ─────────────────────────────────────────────────
btnSaveSettings.addEventListener('click', async () => {
  const lm = parseFloat(settingLowMax.value);
  const hm = parseFloat(settingHighMin.value);
  if (isNaN(lm) || isNaN(hm) || lm >= hm) {
    setStatus('LOW max must be less than HIGH min.', true);
    return;
  }

  setAllDisabled(true);
  setStatus('Saving settings and re-tagging…');
  try {
    const r = await fetch('/api/margin/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        lowMax:      lm,
        highMin:     hm,
        feedPrefix:  settingPrefix.value.trim(),
        feedLabel:   settingLabel.value.trim(),
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');
    settings = { lowMax: data.lowMax, highMin: data.highMin,
                 feedPrefix: settingPrefix.value.trim(),
                 feedLabel:  settingLabel.value.trim() };
    setStatus(`Settings saved. ${data.variants} variants re-tagged with new thresholds.`);
    await loadList();
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    setAllDisabled(false);
  }
});

// ── Copy feed URL ─────────────────────────────────────────────────
btnCopyFeed.addEventListener('click', () => {
  const url = feedUrlEl.textContent;
  navigator.clipboard.writeText(url).then(() => {
    const orig = btnCopyFeed.textContent;
    btnCopyFeed.textContent = 'Copied!';
    setTimeout(() => { btnCopyFeed.textContent = orig; }, 1500);
  }).catch(() => {
    prompt('Copy this URL and paste into Google Merchant Center:', url);
  });
});

// ── Sync from Shopify ─────────────────────────────────────────────
btnSync.addEventListener('click', async () => {
  setAllDisabled(true);
  setStatus('Syncing from Shopify… fetching products and costs. This may take a minute.');
  try {
    const r = await fetch('/api/margin/sync', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');
    setStatus(
      `Done. ${data.upserted} variant${data.upserted !== 1 ? 's' : ''} tagged — ` +
      `LOW < $${data.lowMax} | MEDIUM $${data.lowMax}–$${data.highMin} | HIGH ≥ $${data.highMin}`
    );
    await loadList();
  } catch (err) {
    setStatus('Error: ' + err.message, true);
  } finally {
    setAllDisabled(false);
  }
});

// ── Load list ─────────────────────────────────────────────────────
async function loadList() {
  loadingMsg.style.display  = 'block';
  marginTable.style.display = 'none';
  emptyMsg.style.display    = 'none';

  try {
    const r = await fetch('/api/margin/list');
    if (!r.ok) throw new Error(await r.text());
    allVariants = await r.json();
    render();
  } catch (err) {
    loadingMsg.style.display = 'none';
    setStatus('Error loading data: ' + err.message, true);
  }
}

// ── Filter buttons ────────────────────────────────────────────────
document.querySelectorAll('.mt-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeFilter = btn.dataset.tier;
    document.querySelectorAll('.mt-filter-btn').forEach((b) => {
      b.className = 'mt-filter-btn';
    });
    if (activeFilter === 'ALL')    btn.className = 'mt-filter-btn active';
    if (activeFilter === 'HIGH')   btn.className = 'mt-filter-btn active-high';
    if (activeFilter === 'MEDIUM') btn.className = 'mt-filter-btn active-med';
    if (activeFilter === 'LOW')    btn.className = 'mt-filter-btn active-low';
    if (activeFilter === 'UNKNOWN') btn.className = 'mt-filter-btn active-unk';
    render();
  });
});

// ── Render ────────────────────────────────────────────────────────
function render() {
  loadingMsg.style.display = 'none';

  // Stats always from full list
  statHigh.textContent = allVariants.filter((v) => v.marginTier === 'HIGH').length;
  statMed.textContent  = allVariants.filter((v) => v.marginTier === 'MEDIUM').length;
  statLow.textContent  = allVariants.filter((v) => v.marginTier === 'LOW').length;
  statUnk.textContent  = allVariants.filter((v) => v.marginTier === 'UNKNOWN').length;

  // Update synced-at from first row
  if (allVariants.length > 0 && allVariants[0].syncedAt) {
    syncedAt.textContent = 'Last synced ' + fmtDateTime(allVariants[0].syncedAt);
  }

  const filtered = activeFilter === 'ALL'
    ? allVariants
    : allVariants.filter((v) => v.marginTier === activeFilter);

  if (allVariants.length === 0) {
    marginTable.style.display = 'none';
    emptyMsg.style.display    = 'block';
    return;
  }

  emptyMsg.style.display    = 'none';
  marginTable.style.display = 'table';

  let lastProductId = null;
  marginTbody.innerHTML = filtered.map((v) => {
    const isNewProduct = v.productId !== lastProductId;
    lastProductId = v.productId;

    const cost    = v.costPrice  != null ? `$${Number(v.costPrice).toFixed(2)}`  : '<span style="color:#94a3b8;">—</span>';
    const price   = v.sellPrice  != null ? `$${Number(v.sellPrice).toFixed(2)}`  : '<span style="color:#94a3b8;">—</span>';
    const markup  = v.markup     != null ? `$${Number(v.markup).toFixed(2)}`     : '<span style="color:#94a3b8;">—</span>';
    const markupNum = v.markup   != null ? Number(v.markup) : null;
    const markupStyle = markupNum != null && markupNum < 0 ? 'color:#b91c1c;' : '';

    const tierBadge = `<span class="tier-badge tier-${escHtml(v.marginTier)}">${escHtml(v.marginTier)}</span>`;
    const productCell = isNewProduct
      ? `<strong style="font-size:0.85rem;">${escHtml(v.productTitle)}</strong>`
      : `<span style="color:#94a3b8; font-size:0.8rem; padding-left:8px;">↳</span>`;

    return `<tr${isNewProduct ? ' class="group-start"' : ''}>
      <td>${productCell}</td>
      <td style="color:#475569; font-size:0.83rem;">${v.variantTitle ? escHtml(v.variantTitle) : '<span style="color:#94a3b8;">Default</span>'}</td>
      <td style="font-family:monospace; font-size:0.8rem; color:#64748b;">${v.sku ? escHtml(v.sku) : '<span style="color:#94a3b8;">—</span>'}</td>
      <td style="text-align:right; color:#64748b;">${cost}</td>
      <td style="text-align:right;">${price}</td>
      <td style="text-align:right; font-weight:600; ${markupStyle}">${markup}</td>
      <td style="text-align:center;">${tierBadge}</td>
    </tr>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()} ` +
         `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function setStatus(msg, isError) {
  statusMsg.textContent = msg;
  statusMsg.className   = isError ? 'is-error' : '';
}

function setAllDisabled(disabled) {
  btnSync.disabled        = disabled;
  btnSaveSettings.disabled = disabled;
}
