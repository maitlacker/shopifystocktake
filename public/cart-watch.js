// Cart Watch — what's sitting in customers' carts (abandoned-checkout mirror)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt$ = (n) => '$' + Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });
const fmtN = (n) => Number(n || 0).toLocaleString('en-AU');

let openDetail = null;   // productId of the expanded row
let cartsVisible = false;

function days() { return document.getElementById('cw-days').value; }

function ago(ts) {
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hr${h !== 1 ? 's' : ''} ago`;
  return `${Math.round(h / 24)} days ago`;
}

function stockBadge(s) {
  if (s.status && s.status !== 'ACTIVE') return `<span class="cw-badge na">${escHtml(s.status.toLowerCase())}</span>`;
  if (s.totalInventory == null) return '';
  if (s.totalInventory <= 0) return '<span class="cw-badge out">out of stock</span>';
  if (s.totalInventory <= 10) return '<span class="cw-badge low">low stock</span>';
  return '';
}

async function load() {
  const body = document.getElementById('cw-body');
  const tbl = document.getElementById('cw-tbl');
  const empty = document.getElementById('cw-empty');
  const cards = document.getElementById('cw-cards');
  openDetail = null;
  cards.innerHTML = '<div class="cw-card"><div class="n">…</div><div class="l">Loading</div></div>';

  let data;
  try {
    const res = await fetch(`/api/cart-watch/summary?days=${days()}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error);
  } catch (err) {
    cards.innerHTML = `<div class="cw-card"><div class="n" style="color:#b91c1c">Error</div><div class="l">${escHtml(err.message)}</div></div>`;
    return;
  }

  const t = data.totals || {};
  cards.innerHTML = `
    <div class="cw-card"><div class="n">${fmtN(t.carts)}</div><div class="l">Carts with items</div></div>
    <div class="cw-card"><div class="n">${fmtN(t.units)}</div><div class="l">Units in carts</div></div>
    <div class="cw-card"><div class="n">${fmt$(t.item_value)}</div><div class="l">Item value in carts</div></div>
    <div class="cw-card"><div class="n">${fmtN((data.styles || []).length)}</div><div class="l">Styles in carts</div></div>`;

  const ls = document.getElementById('cw-lastsync');
  ls.textContent = data.lastSync
    ? (data.syncing ? 'syncing now…' : `synced ${ago(data.lastSync.at)}`)
    : 'never synced — press Sync now';

  if (!(data.styles || []).length) {
    tbl.style.display = 'none';
    empty.style.display = '';
    empty.textContent = data.lastSync
      ? 'No cart activity in this window.'
      : 'No data yet — press “Sync now” to pull carts from Shopify.';
    document.getElementById('cw-carts-h').style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  tbl.style.display = '';

  body.innerHTML = data.styles.map((s, i) => `
    <tr class="cw-row" onclick="toggleDetail('${escHtml(s.productId)}')">
      <td class="cw-rank">${i + 1}</td>
      <td style="width:44px">${s.image ? `<img class="cw-thumb" src="${escHtml(s.image)}" loading="lazy" alt="" />` : '<div class="cw-thumb"></div>'}</td>
      <td><span class="cw-title">${escHtml(s.title)}</span>${stockBadge(s)}</td>
      <td class="num cw-carts-n">${fmtN(s.carts)}</td>
      <td class="num">${fmtN(s.units)}</td>
      <td class="num hide-m">${fmt$(s.value)}</td>
      <td class="num hide-m">${s.totalInventory == null ? '—' : fmtN(s.totalInventory)}</td>
    </tr>
    <tr class="cw-detail" id="cw-det-${escHtml(s.productId)}" style="display:none">
      <td colspan="7" id="cw-det-body-${escHtml(s.productId)}"></td>
    </tr>`).join('');

  window._cwStyles = new Map(data.styles.map(s => [String(s.productId), s]));
  document.getElementById('cw-carts-h').style.display = '';
  if (cartsVisible) loadCarts();
}

async function toggleDetail(pid) {
  const row = document.getElementById(`cw-det-${pid}`);
  if (!row) return;
  if (openDetail === pid) {
    row.style.display = 'none';
    openDetail = null;
    return;
  }
  if (openDetail) {
    const prev = document.getElementById(`cw-det-${openDetail}`);
    if (prev) prev.style.display = 'none';
  }
  openDetail = pid;
  row.style.display = '';
  const cell = document.getElementById(`cw-det-body-${pid}`);
  const s = window._cwStyles.get(String(pid));

  const chips = (s?.variants || [])
    .map(v => `<span class="cw-chip">${escHtml(v.variant || '—')} <span>×${fmtN(v.units)}</span></span>`)
    .join('');
  cell.innerHTML = `<div class="cw-chips">${chips || '<span style="color:#94a3b8">No variant data</span>'}</div>
    <div style="color:#94a3b8;font-size:0.76rem">Loading carts…</div>`;

  try {
    const res = await fetch(`/api/cart-watch/carts?days=${days()}&product_id=${encodeURIComponent(pid)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const carts = (data.carts || []).slice(0, 25);
    cell.innerHTML = `<div class="cw-chips">${chips}</div>` +
      (carts.map(c => miniCart(c, pid)).join('') || '<div style="color:#94a3b8">No carts found.</div>') +
      (data.carts.length > 25 ? `<div class="cw-more">+ ${data.carts.length - 25} more carts contain this style</div>` : '');
  } catch (err) {
    cell.innerHTML += `<div style="color:#b91c1c">${escHtml(err.message)}</div>`;
  }
}

function miniCart(c, highlightPid) {
  const who = c.customer_name || c.email || 'Guest';
  const items = (c.items || [])
    .map(it => `${escHtml(it.title)}${it.variant ? ` / ${escHtml(it.variant)}` : ''}${it.qty > 1 ? ` ×${it.qty}` : ''}`)
    .join(' · ');
  return `<div class="cw-minicart">
    <span class="who">${escHtml(who)}</span>
    <span class="when">— ${ago(c.updated_at)} — ${fmt$(c.total_price)}</span><br />${items}</div>`;
}

function toggleCarts() {
  cartsVisible = !cartsVisible;
  document.getElementById('cw-carts-toggle').textContent = cartsVisible ? 'hide' : 'show';
  if (cartsVisible) loadCarts();
  else document.getElementById('cw-carts').innerHTML = '';
}

async function loadCarts() {
  const box = document.getElementById('cw-carts');
  box.innerHTML = '<div style="color:#94a3b8;font-size:0.8rem">Loading carts…</div>';
  try {
    const res = await fetch(`/api/cart-watch/carts?days=${days()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    box.innerHTML = (data.carts || []).map(c => miniCart(c)).join('') ||
      '<div style="color:#94a3b8">No carts in this window.</div>';
  } catch (err) {
    box.innerHTML = `<div style="color:#b91c1c">${escHtml(err.message)}</div>`;
  }
}

async function syncNow(btn) {
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⟳ Syncing…';
  try {
    const res = await fetch('/api/cart-watch/sync', { method: 'POST' });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    if (out.skipped) alert('A sync is already running — try again in a minute.');
    await load();
  } catch (err) {
    alert(`Sync failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

load();
