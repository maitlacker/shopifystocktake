// Aisle Allocation — link styles to stable aisle ids (colour is an attribute)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let page = 1;
let aisleById = new Map();
let searchTimer = null;

document.getElementById('aa-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetAndLoad, 300);
});

function resetAndLoad() { page = 1; load(); }
function movePage(d) { page += d; load(); }

function thumb(url) {
  const safe = /^https:\/\/cdn\.shopify\.com\//.test(String(url || '')) ? url : '';
  return safe ? `<img src="${escHtml(safe)}" alt="" loading="lazy" />` : '<span class="aa-noimg"></span>';
}

async function load() {
  const q = document.getElementById('aa-search').value.trim();
  const filter = document.getElementById('aa-filter').value;
  const pageSize = document.getElementById('aa-pagesize').value;
  const list = document.getElementById('aa-list');
  try {
    const res = await fetch(`/api/aisle-allocation/products?filter=${filter}&q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    aisleById = new Map(data.aisles.map(a => [String(a.id), a]));
    page = data.page;

    document.getElementById('aa-progress').textContent =
      `${data.allocated} of ${data.totalProducts} allocated`;
    document.getElementById('aa-pageinfo').textContent = `Page ${data.page} of ${data.pages} · ${data.total} styles`;
    document.getElementById('aa-prev').disabled = data.page <= 1;
    document.getElementById('aa-next').disabled = data.page >= data.pages;

    if (!data.items.length) {
      list.innerHTML = `<div class="aa-empty">${filter === 'unallocated' && !q
        ? '🎉 Every style is allocated to an aisle!' : 'No styles match.'}</div>`;
      return;
    }

    list.innerHTML = data.items.map(p => {
      const selId = p.aisleId || p.guessAisleId || data.aisles[0].id;
      const sel = aisleById.get(String(selId));
      const current = p.aisleId ? aisleById.get(String(p.aisleId)) : null;
      return `
      <div class="aa-row" data-pid="${escHtml(p.productId)}">
        ${thumb(p.image)}
        <div class="aa-info">
          <div class="aa-title">${escHtml(p.title)}</div>
          ${current
            ? `<div class="aa-current" style="color:${escHtml(current.colour)}">● Currently ${escHtml(current.colour_name)} (${escHtml(current.name)})</div>`
            : p.guessAisleId
              ? `<div class="aa-current" style="color:#94a3b8">Suggested from neighbouring styles</div>`
              : `<div class="aa-current" style="color:#94a3b8">No neighbours allocated yet — pick a colour</div>`}
        </div>
        <div class="aa-pick">
          <span class="aa-dot" id="dot-${escHtml(p.productId)}" style="background:${escHtml(sel ? sel.colour : '#e2e8f0')}"></span>
          <select class="aa-select" id="sel-${escHtml(p.productId)}" onchange="dotSync('${escHtml(p.productId)}')">
            ${data.aisles.map(a =>
              `<option value="${a.id}" ${a.id === selId ? 'selected' : ''}>${escHtml(a.colour_name)} — ${escHtml(a.name)}</option>`).join('')}
          </select>
          <button class="aa-save" onclick="saveRow('${escHtml(p.productId)}', this)">Save</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="aa-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

function dotSync(pid) {
  const sel = document.getElementById(`sel-${pid}`);
  const a = aisleById.get(String(sel.value));
  const dot = document.getElementById(`dot-${pid}`);
  if (dot && a) dot.style.background = a.colour;
}

async function saveRow(pid, btn) {
  const sel = document.getElementById(`sel-${pid}`);
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const res = await fetch('/api/aisle-allocation/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: pid, aisleId: Number(sel.value) }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    btn.textContent = '✓';
    btn.classList.add('done');
    // Reload so the rolling guesses pick up this save and the list advances
    setTimeout(load, 220);
  } catch (err) {
    alert(`Save failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

load();
