// BF Discount Planner — GA demand vs stock on hand → suggested discount tiers
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt$ = (n) => '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (n) => Number(n || 0).toLocaleString('en-AU');
const TIERS = [20, 30, 40, 50];

let report = null;

async function load() {
  const meta = document.getElementById('bf-upload-meta');
  try {
    const res = await fetch('/api/bf/report');
    report = await res.json();
    if (!res.ok) throw new Error(report.error);
  } catch (err) {
    meta.textContent = `Error: ${err.message}`;
    return;
  }

  if (report.upload) {
    const d = new Date(report.upload.at).toLocaleString('en-AU',
      { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    meta.innerHTML = `Current data: <b>${escHtml(report.upload.filename || report.upload.kind)}</b>
      (${fmtN(report.upload.rows)} styles, uploaded ${escHtml(d)}). Upload again any time to refresh.`;
  } else {
    meta.innerHTML = '<b>No GA report uploaded yet</b> — styles below are ranked on stock only. ' +
      'In GA4 open Ecommerce purchases → Item name, then Share → Download CSV (preferred) or Download PDF.';
  }
  render();
}

function effectiveTier(p) { return p.override ?? p.suggested; }

function render() {
  if (!report) return;
  const q = (document.getElementById('bf-q').value || '').toLowerCase();
  const tierF = document.getElementById('bf-tier-filter').value;
  const sort = document.getElementById('bf-sort').value;
  const flaggedOnly = document.getElementById('bf-only-flagged').checked;

  // summary cards
  const mix = TIERS.map(t => report.products.filter(p => effectiveTier(p) === t).length);
  const units = report.products.reduce((s, p) => s + p.stock, 0);
  const matched = report.products.filter(p => p.inGa).length;
  document.getElementById('bf-cards').innerHTML = `
    <div class="bf-card"><div class="n">${fmtN(report.products.length)}</div><div class="l">Styles with stock</div></div>
    <div class="bf-card"><div class="n">${fmtN(units)}</div><div class="l">Units on hand</div></div>
    <div class="bf-card"><div class="n">${fmtN(matched)}</div><div class="l">Matched to GA</div></div>
    <div class="bf-card t20"><div class="n">${fmtN(mix[0])}</div><div class="l">at 20%</div></div>
    <div class="bf-card t30"><div class="n">${fmtN(mix[1])}</div><div class="l">at 30%</div></div>
    <div class="bf-card t40"><div class="n">${fmtN(mix[2])}</div><div class="l">at 40%</div></div>
    <div class="bf-card t50"><div class="n">${fmtN(mix[3])}</div><div class="l">at 50%</div></div>`;

  let rows = report.products.filter(p =>
    (!q || p.title.toLowerCase().includes(q)) &&
    (!tierF || effectiveTier(p) === Number(tierF)) &&
    (!flaggedOnly || p.sellOut || p.dead));

  const cmp = {
    atc: (a, b) => b.atc - a.atc || b.stock - a.stock,
    stock: (a, b) => b.stock - a.stock,
    spa: (a, b) => (b.unitsPerAtc ?? Infinity) - (a.unitsPerAtc ?? Infinity) || b.stock - a.stock,
    tier: (a, b) => effectiveTier(b) - effectiveTier(a) || b.stock - a.stock,
    title: (a, b) => a.title.localeCompare(b.title),
  }[sort];
  rows = rows.slice().sort(cmp);

  const tbl = document.getElementById('bf-tbl');
  const empty = document.getElementById('bf-empty');
  document.getElementById('bf-controls').style.display = '';
  if (!rows.length) {
    tbl.style.display = 'none';
    empty.style.display = '';
    empty.textContent = 'No styles match the current filters.';
  } else {
    empty.style.display = 'none';
    tbl.style.display = '';
    document.getElementById('bf-body').innerHTML = rows.map(p => {
      const t = effectiveTier(p);
      const sale = p.price * (1 - t / 100);
      const flags =
        (p.sellOut ? '<span class="bf-flag sellout">⚡ sell-out risk</span>' : '') +
        (p.dead ? '<span class="bf-flag dead">🧊 dead stock</span>' : '') +
        (!p.inGa ? '<span class="bf-flag noga">not in GA</span>' : '');
      const opts = TIERS.map(x =>
        `<option value="${x}" ${x === t ? 'selected' : ''}>${x}%</option>`).join('');
      return `<tr>
        <td style="width:40px">${p.image ? `<img class="bf-thumb" src="${escHtml(p.image)}" loading="lazy" alt="" />` : '<div class="bf-thumb"></div>'}</td>
        <td><span class="bf-title">${escHtml(p.title)}</span>${flags}</td>
        <td class="num">${p.inGa ? fmtN(p.atc) : '—'}</td>
        <td class="num hide-m">${p.inGa ? fmtN(p.views) : '—'}</td>
        <td class="num">${fmtN(p.stock)}</td>
        <td class="num hide-m">${p.unitsPerAtc == null ? '—' : p.unitsPerAtc}</td>
        <td class="num hide-m">${fmtN(p.vel30)}</td>
        <td>
          <select class="bf-tier t${t}${p.override != null ? ' overridden' : ''}"
            title="${escHtml(p.reason)}"
            onchange="setTier('${escHtml(p.productId)}', this.value)">${opts}</select>
          ${p.override != null ? `<span class="bf-sugg">suggested ${p.suggested}%</span>` : ''}
        </td>
        <td class="num"><span class="bf-old">${fmt$(p.price)}</span><br />
          <span class="bf-sale">${fmt$(sale)}</span></td>
      </tr>`;
    }).join('');
  }

  // unmatched GA rows
  const un = document.getElementById('bf-unmatched');
  if ((report.unmatchedGa || []).length) {
    const top = report.unmatchedGa.slice(0, 40);
    un.style.display = '';
    un.innerHTML = `<h3>⚠ ${report.unmatchedGa.length} GA styles didn't match an active in-stock Shopify product</h3>
      <div style="color:#64748b">Usually sold-out, draft or renamed styles — listed by add-to-carts so you can sanity-check nothing important is missing:</div>
      <div style="margin-top:6px;line-height:1.8">${top.map(u =>
        `${escHtml(u.name)} <span style="color:#94a3b8">(${fmtN(u.atc)})</span>`).join(' · ')}
        ${report.unmatchedGa.length > top.length ? ` · +${report.unmatchedGa.length - top.length} more` : ''}</div>`;
  } else {
    un.style.display = 'none';
  }
}

async function setTier(productId, val) {
  const p = report.products.find(x => x.productId === productId);
  if (!p) return;
  const tier = Number(val);
  const send = tier === p.suggested ? null : tier; // choosing the suggestion clears the override
  try {
    const res = await fetch('/api/bf/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, tier: send }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    p.override = send;
    render();
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
}

async function upload() {
  const input = document.getElementById('bf-file');
  const btn = document.getElementById('bf-upload-btn');
  const file = input.files && input.files[0];
  if (!file) { alert('Choose the GA CSV or PDF export first.'); return; }
  const isPdf = /\.pdf$/i.test(file.name);
  btn.disabled = true;
  btn.textContent = '⏳ Parsing…';
  try {
    const content = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error('Could not read the file'));
      if (isPdf) {
        r.onload = () => resolve(String(r.result).split(',')[1]); // strip data: prefix
        r.readAsDataURL(file);
      } else {
        r.onload = () => resolve(r.result);
        r.readAsText(file);
      }
    });
    const res = await fetch('/api/bf/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, kind: isPdf ? 'pdf' : 'csv', content }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    input.value = '';
    await load();
    alert(`Uploaded ✓ — ${out.rows} styles parsed from the GA report.`);
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '⬆ Upload GA report';
  }
}

load();
