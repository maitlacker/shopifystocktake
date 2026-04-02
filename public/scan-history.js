'use strict';

let allScans = [];

const daysSelect   = document.getElementById('daysSelect');
const searchInput  = document.getElementById('searchInput');
const methodFilter = document.getElementById('methodFilter');
const loadingMsg   = document.getElementById('loadingMsg');
const scanTable    = document.getElementById('scanTable');
const scanTbody    = document.getElementById('scanTbody');
const emptyMsg     = document.getElementById('emptyMsg');

const statTotal     = document.getElementById('statTotal');
const statMatched   = document.getElementById('statMatched');
const statConfirmed = document.getElementById('statConfirmed');
const statNoMatch   = document.getElementById('statNoMatch');

// ── Load data ─────────────────────────────────────────────────────────────────
async function load() {
  loadingMsg.style.display = 'block';
  scanTable.style.display  = 'none';
  emptyMsg.style.display   = 'none';

  try {
    const days = daysSelect.value || 30;
    const r    = await fetch(`/api/scan/history?days=${days}`);
    if (!r.ok) throw new Error(await r.text());
    allScans = await r.json();
    render();
  } catch (err) {
    loadingMsg.textContent = 'Error loading scans: ' + err.message;
  }
}

// ── Render table ──────────────────────────────────────────────────────────────
function render() {
  const query  = (searchInput.value  || '').toLowerCase().trim();
  const method = (methodFilter.value || '').toLowerCase();

  const filtered = allScans.filter(s => {
    if (method) {
      if (method === 'no_match' && s.method !== 'no_match') return false;
      if (method === 'text'     && !s.method?.startsWith('text')) return false;
      if (method === 'visual'   && s.method !== 'visual') return false;
    }
    if (query) {
      const haystack = [s.sku, s.productTitle, s.variantTitle, s.userName]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // Summary stats (on full allScans, not filtered)
  statTotal.textContent     = allScans.length;
  statMatched.textContent   = allScans.filter(s => s.sku && s.method !== 'no_match').length;
  statConfirmed.textContent = allScans.filter(s => s.confirmed).length;
  statNoMatch.textContent   = allScans.filter(s => s.method === 'no_match').length;

  loadingMsg.style.display = 'none';

  if (filtered.length === 0) {
    scanTable.style.display = 'none';
    emptyMsg.style.display  = 'block';
    emptyMsg.textContent    = allScans.length === 0
      ? 'No scans recorded in this period.'
      : 'No scans match your filters.';
    return;
  }

  emptyMsg.style.display  = 'none';
  scanTable.style.display = 'table';

  scanTbody.innerHTML = filtered.map(s => {
    const pct = s.confidence != null ? Math.round(Number(s.confidence) * 100) : null;

    let confHtml = '<span class="conf-pill conf-none">—</span>';
    if (pct !== null) {
      const cls = pct >= 80 ? 'conf-high' : pct >= 60 ? 'conf-mid' : 'conf-low';
      confHtml = `<span class="conf-pill ${cls}">${pct}%</span>`;
    }

    let methodHtml = '—';
    if (s.method) {
      let cls = 'mb-no', label = s.method;
      if (s.method === 'text')           { cls = 'mb-text';   label = 'Text'; }
      if (s.method === 'text_unmatched') { cls = 'mb-partial'; label = 'Text (new)'; }
      if (s.method === 'visual')         { cls = 'mb-visual';  label = 'Visual'; }
      if (s.method === 'no_match')       { cls = 'mb-no';      label = 'No match'; }
      methodHtml = `<span class="method-badge ${cls}">${escHtml(label)}</span>`;
    }

    const when = fmtDateTime(s.scannedAt);
    const confirmed = s.confirmed
      ? '<span class="conf-tick" title="Confirmed">✓</span>'
      : '';

    return `<tr>
      <td style="color:#64748b; white-space:nowrap; font-size:0.82rem;">${escHtml(when)}</td>
      <td>${escHtml(s.userName || s.userEmail)}</td>
      <td style="font-family:monospace; font-weight:700;">${s.sku ? escHtml(s.sku) : '<span style="color:#94a3b8;">—</span>'}</td>
      <td>${s.productTitle
            ? `<div style="font-weight:600;">${escHtml(s.productTitle)}</div>
               ${s.variantTitle ? `<div style="color:#64748b; font-size:0.8rem;">${escHtml(s.variantTitle)}</div>` : ''}`
            : '<span style="color:#94a3b8;">—</span>'}</td>
      <td>${confHtml}</td>
      <td>${methodHtml}</td>
      <td style="text-align:center;">${confirmed}</td>
    </tr>`;
  }).join('');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Events ────────────────────────────────────────────────────────────────────
daysSelect.addEventListener('change',  load);
methodFilter.addEventListener('change', render);
searchInput.addEventListener('input',   render);

// ── Boot ──────────────────────────────────────────────────────────────────────
load();
