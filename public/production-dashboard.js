'use strict';

let DATA = null;
let page = 0;
const PAGE_SIZE = 50;

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m) - 1]} '${y.slice(2)}`;
}
function thumb(src, el) {
  if (!src) return `<span class="pd-thumb"></span>`;
  const small = src.replace(/(\.[a-z]+)(\?.*)?$/i, '_80x104_crop_center$1$2');
  return `<img class="${el || 'pd-thumb'}" src="${small}" loading="lazy" onerror="this.style.visibility='hidden'" />`;
}
function fmtDate(x) {
  if (!x) return '—';
  const d = new Date(x);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

async function loadDashboard() {
  try {
    const r = await fetch('/api/production-dashboard');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
    document.getElementById('pd-generated').textContent = DATA.generatedAt
      ? `Restock analysis: ${new Date(DATA.generatedAt).toLocaleString('en-AU')}` : 'No restock analysis yet — run one on the Restock Planner';
    renderColumns();
    renderGapAnalysis(DATA.gapAnalysis);
    renderGrid();
  } catch (err) {
    document.getElementById('col-alerts').innerHTML = `<div class="pd-empty">Failed: ${escHtml(err.message)}</div>`;
  }
}

// ── Columns ─────────────────────────────────────────────────────────

function renderColumns() {
  const alerts = DATA.alerts || [];
  document.getElementById('n-alerts').textContent = alerts.length;
  document.getElementById('col-alerts').innerHTML = alerts.length ? alerts.map(a => `
    <div class="pd-card">
      ${thumb(a.image)}
      <div class="pd-card-main">
        <div class="pd-card-title">${escHtml(a.title)}</div>
        <div class="pd-card-sub">
          <span class="pd-rating ${a.rating === 'AA+' ? 'aap' : 'a'}">${a.rating}</span>
          ${a.velocity ? a.velocity.toFixed(1) + '/day · ' : ''}needs ${a.shortfall} more
          ${a.incoming ? ` (${a.incoming} incoming)` : ' (nothing incoming)'}
        </div>
      </div>
      <div class="pd-card-right">
        <div class="pd-days ${a.runwayDays <= 14 ? 'red' : 'orange'}">${a.runwayDays}d</div>
        <a class="pd-addpo" href="/restock.html?addpo=${a.productId}">+ Add to PO</a>
      </div>
    </div>`).join('')
    : '<div class="pd-empty">No AA+/A styles short on incoming stock 🎉</div>';

  const drafts = DATA.drafts || [];
  document.getElementById('n-drafts').textContent = drafts.length;
  document.getElementById('col-drafts').innerHTML = drafts.length ? drafts.map(d => `
    <a class="pd-card" href="/production-order.html?id=${d.id}">
      <div class="pd-card-main">
        <div class="pd-card-title">PO ${escHtml(d.po_number)} — ${escHtml(d.supplier_name || 'no supplier set')}</div>
        <div class="pd-card-sub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(d.styles || '—')}</div>
        <div class="pd-card-sub">${d.line_count} style${d.line_count !== 1 ? 's' : ''} · ${d.total_qty} units · ${d.freight_mode === 'air' ? '✈️ air' : '🚢 sea'} · created ${fmtDate(d.created_at)}</div>
      </div>
      <div class="pd-card-right"><span style="font-size:0.7rem;font-weight:800;background:#fef3c7;color:#92400e;border-radius:8px;padding:2px 8px">CONFIRM →</span></div>
    </a>`).join('')
    : '<div class="pd-empty">No drafts waiting — all POs confirmed ✓</div>';

  const forms = DATA.recentForms || [];
  document.getElementById('n-forms').textContent = forms.length;
  document.getElementById('col-forms').innerHTML = forms.length ? forms.map(f => `
    <a class="pd-card" href="/production-order.html?id=${f.order_id}">
      <div class="pd-card-main">
        <div class="pd-card-title">${escHtml(f.product_name || f.product_code)}</div>
        <div class="pd-card-sub">${f.line_type === 'new' ? 'New Order Form' : 'Restock Order Form'} · PO ${escHtml(f.po_number)}</div>
        <div class="pd-card-sub">${f.action === 'downloaded' ? '⬇ downloaded' : '💾 saved'} ${fmtDate(f.at)}${f.by_email ? ' · ' + escHtml(String(f.by_email).split('@')[0]) : ''}</div>
      </div>
      <div class="pd-card-right">
        <a class="pd-addpo" style="border-color:#bbf7d0;color:#15803d"
          href="/api/production-orders/${f.order_id}/supplier-order/${encodeURIComponent(f.product_code)}"
          onclick="event.stopPropagation()" target="_blank">⬇ PDF</a>
      </div>
    </a>`).join('')
    : '<div class="pd-empty">No order forms saved or downloaded yet</div>';
}

// ── AI gap analysis ─────────────────────────────────────────────────

// Minimal markdown → HTML (headings, bold, lists, paragraphs)
function mdToHtml(md) {
  const esc = escHtml(md);
  const lines = esc.split('\n');
  let html = '', inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^###\s+/.test(t)) { if (inList) { html += '</ul>'; inList = false; } html += `<h3>${t.replace(/^###\s+/, '')}</h3>`; }
    else if (/^[-*]\s+/.test(t)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${t.replace(/^[-*]\s+/, '')}</li>`; }
    else if (t === '') { if (inList) { html += '</ul>'; inList = false; } }
    else { if (inList) { html += '</ul>'; inList = false; } html += `<p style="margin:6px 0">${t}</p>`; }
  }
  if (inList) html += '</ul>';
  return html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderGapAnalysis(g) {
  if (!g || !g.content) return;
  document.getElementById('pd-ai-when').textContent =
    `Last run ${new Date(g.generatedAt).toLocaleString('en-AU')}`;
  document.getElementById('pd-ai-content').innerHTML = mdToHtml(g.content);
}

async function runGapAnalysis() {
  const btn = document.getElementById('pd-ai-btn');
  btn.disabled = true;
  btn.textContent = 'Analysing… (~20s)';
  try {
    const r = await fetch('/api/production-dashboard/gap-analysis', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    renderGapAnalysis(data);
  } catch (err) {
    alert('Gap analysis failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Analysis';
  }
}

// ── Incoming-by-month grid ──────────────────────────────────────────

function filteredProducts() {
  const q = (document.getElementById('pd-search').value || '').toLowerCase().trim();
  let list = DATA.products || [];
  if (q) list = list.filter(p => (p.title || '').toLowerCase().includes(q));
  // Favourites always float to the top (stable within each group)
  return [...list.filter(p => p.favourite), ...list.filter(p => !p.favourite)];
}

async function toggleFavourite(productId, e) {
  if (e) e.stopPropagation();
  const p = (DATA.products || []).find(x => x.productId === productId);
  if (!p) return;
  const want = !p.favourite;
  p.favourite = want;        // optimistic — revert on failure
  renderGrid();
  try {
    const r = await fetch('/api/production-dashboard/favourite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id: productId, favourite: want }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    p.favourite = !want;
    renderGrid();
    alert('Could not save favourite: ' + err.message);
  }
}

function renderGrid() {
  const months = DATA.months || [];
  document.getElementById('pd-grid-head').innerHTML =
    `<th>Product</th><th>Rating</th><th>Stock</th><th>Runway</th>` +
    months.map(m => `<th>${monthLabel(m)}</th>`).join('') +
    `<th>Later</th>`;

  const list = filteredProducts();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page >= totalPages) page = totalPages - 1;
  const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  document.getElementById('pg-info').textContent = `${list.length} products · page ${page + 1}/${totalPages}`;
  document.getElementById('pg-prev').disabled = page === 0;
  document.getElementById('pg-next').disabled = page >= totalPages - 1;

  const tbody = document.getElementById('pd-grid-body');
  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="${5 + months.length}" class="pd-empty">No products match</td></tr>`;
    return;
  }
  tbody.innerHTML = slice.map(p => {
    const ratingCls = p.rating === 'AA+' ? 'aap' : p.rating === 'A' ? 'a' : '';
    const ratingHtml = p.rating
      ? `<span class="pd-rating ${ratingCls}" style="${!ratingCls ? 'background:#f1f5f9;color:#64748b' : ''}">${p.rating}</span>` : '—';
    // Gap hint: AA+/A with short runway and zero incoming anywhere
    const gap = !p.isFinalSale && (p.rating === 'AA+' || p.rating === 'A')
      && p.runwayDays !== null && p.runwayDays <= 60 && p.incomingTotal === 0;
    return `
    <tr class="${p.isFinalSale ? 'pd-fs-row' : ''}">
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <button onclick="toggleFavourite(${p.productId}, event)" title="${p.favourite ? 'Remove favourite' : 'Pin to top'}"
            style="border:none;background:none;cursor:pointer;font-size:1.05rem;padding:0;line-height:1;color:${p.favourite ? '#f59e0b' : '#d7dde5'}">${p.favourite ? '★' : '☆'}</button>
          ${thumb(p.image)}
          <span style="font-weight:600;color:#1e293b">${escHtml(p.title)}</span>
          ${p.isFinalSale ? '<span class="pd-fs-badge">FINAL SALE</span>' : ''}
          ${gap ? '<span class="pd-gap">⚠ GAP</span>' : ''}
        </div>
      </td>
      <td>${ratingHtml}</td>
      <td>${p.stock ?? '—'}</td>
      <td>${p.runwayDays !== null ? `<span style="font-weight:700;color:${p.runwayDays <= 28 ? '#dc2626' : p.runwayDays <= 60 ? '#d97706' : '#15803d'}">${p.runwayDays}d</span>` : '—'}</td>
      ${(DATA.months).map(m => {
        const q = p.incoming[m] || 0;
        return `<td><span class="pd-qty ${q ? '' : 'zero'}">${q || '·'}</span></td>`;
      }).join('')}
      <td><span class="pd-qty ${p.incomingLater ? '' : 'zero'}">${p.incomingLater || '·'}</span></td>
    </tr>`;
  }).join('');
}

let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { page = 0; renderGrid(); }, 200);
}

function setPage(delta) {
  page += delta;
  if (page < 0) page = 0;
  renderGrid();
  document.querySelector('.pd-grid-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

loadDashboard();
