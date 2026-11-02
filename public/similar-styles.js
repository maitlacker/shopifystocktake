// You May Also Like — co-purchase suggestion preview (no Shopify writes)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let data = null;

function thumb(url) {
  const safe = /^https:\/\/cdn\.shopify\.com\//.test(String(url || '')) ? url : '';
  return safe ? `<img src="${escHtml(safe)}" alt="" loading="lazy" />`
              : '<span style="width:30px;height:40px;background:#f1f5f9;border-radius:5px;display:inline-block"></span>';
}

function adminLink(productId, text) {
  return `<a href="https://admin.shopify.com/store/theselfstyler/products/${encodeURIComponent(productId)}"
             target="_blank" rel="noopener">${escHtml(text)}</a>`;
}

async function load() {
  try {
    data = await (await fetch('/api/ecom/similar/suggestions')).json();
    render();
  } catch (err) {
    document.getElementById('ss-list').innerHTML =
      `<div class="ss-loading">Error: ${escHtml(err.message)}</div>`;
  }
}

async function generateBatch(productIds) {
  const btn = document.getElementById('ss-gen-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Analysing orders…';
  try {
    const res = await fetch('/api/ecom/similar/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(productIds ? { productIds } : {}),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    await load();
  } catch (err) {
    alert(`Generation failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Generate next 5';
  }
}

function render() {
  document.getElementById('ss-progress').textContent =
    `${data.generated} of ${data.candidates} products analysed`;
  const list = document.getElementById('ss-list');

  if (!data.items.length) {
    list.innerHTML = `<div class="ss-loading">No suggestions yet — click
      <b>Generate next 5</b> to analyse your 5 best sellers first.</div>`;
    return;
  }

  list.innerHTML = data.items.map(item => {
    const suggestedIds = new Set(item.suggestions.map(s => String(s.productId)));
    const currentIds = new Set(item.current.map(c => String(c.productId)));

    const sugHtml = item.suggestions.length ? item.suggestions.map((s, i) => `
      <div class="ss-item">
        <span class="ss-rank">${i + 1}</span>
        ${thumb(s.image)}
        <div>
          <div class="t">${adminLink(s.productId, s.title)}</div>
          <div class="m">bought together in ${Number(s.coOrders)} orders · ${Number(s.coQty)} units
            ${s.totalInventory != null ? `· ${Number(s.totalInventory)} in stock` : ''}</div>
        </div>
        <span class="ss-pill ${currentIds.has(String(s.productId)) ? 'pill-keep' : 'pill-new'}">
          ${currentIds.has(String(s.productId)) ? 'Already set' : 'New'}</span>
      </div>`).join('')
      : '<div class="ss-empty-col">Not enough order history to suggest anything yet.</div>';

    const curHtml = item.current.length ? item.current.map(c => `
      <div class="ss-item">
        ${thumb(c.image)}
        <div><div class="t">${adminLink(c.productId, c.title)}</div></div>
        <span class="ss-pill ${!c.ok ? 'pill-bad' : suggestedIds.has(String(c.productId)) ? 'pill-keep' : 'pill-drop'}">
          ${!c.ok ? 'Problem' : suggestedIds.has(String(c.productId)) ? 'Matches' : 'Would drop'}</span>
      </div>`).join('')
      : '<div class="ss-empty-col">Nothing set in Shopify yet.</div>';

    return `
      <div class="ss-card">
        <div class="ss-card-head">
          ${thumb(item.image)}
          <div>
            <div class="ss-card-title">${adminLink(item.productId, item.title)}</div>
            <div class="ss-card-meta">${Number(item.ordersAnalysed)} orders analysed ·
              generated ${escHtml(new Date(item.generatedAt).toLocaleString())}</div>
          </div>
          <button class="btn btn-secondary ss-regen"
                  onclick="generateBatch([${Number(item.productId)}])">↻ Regenerate</button>
        </div>
        <div class="ss-cols">
          <div>
            <div class="ss-col-title">✨ Suggested (top 4 co-purchased)</div>
            <div class="ss-list">${sugHtml}</div>
          </div>
          <div>
            <div class="ss-col-title">Currently in Shopify</div>
            <div class="ss-list">${curHtml}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

load();
