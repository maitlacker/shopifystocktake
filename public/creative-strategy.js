// ── Creative Strategy report ───────────────────────────────────────

let DATA = null;
let syncPoll = null;

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt$ = n => n == null ? '—' : '$' + Math.round(n).toLocaleString();
const fmt$2 = n => n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtX = n => n == null ? '—' : Number(n).toFixed(2) + 'x';
const fmtPct = n => n == null ? '—' : (n * 100).toFixed(1) + '%';
const fmtN = n => n == null ? '—' : Math.round(n).toLocaleString();
const fmtF = n => n == null ? '—' : Number(n).toFixed(2);

function isoDaysAgo(d) { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString().slice(0, 10); }
function todayIso() { return new Date().toISOString().slice(0, 10); }

// ── Heat mapping: green = better, CPA inverted ─────────────────────
// Returns a background colour for value v within [min,max] of its column.
function heatColor(v, min, max, invert) {
  if (v == null || min == null || max == null || min === max) return '';
  let t = (v - min) / (max - min);       // 0 = min, 1 = max
  if (invert) t = 1 - t;                  // now 1 = better always
  // red #F2ABA2 → white → green #9AD3A0
  const lerp = (a, b, u) => Math.round(a + (b - a) * u);
  let r, g, b;
  if (t < 0.5) { const u = t * 2; r = lerp(242, 255, u); g = lerp(171, 255, u); b = lerp(162, 255, u); }
  else { const u = (t - 0.5) * 2; r = lerp(255, 154, u); g = lerp(255, 211, u); b = lerp(255, 160, u); }
  return `background:rgb(${r},${g},${b})`;
}

// Standard metric columns for every table
const COLS = [
  { key: 'spend', label: 'Spend', fmt: fmt$ },
  { key: 'cpa', label: 'CPA', fmt: fmt$, heat: true, invert: true },
  { key: 'roas', label: 'ROAS', fmt: fmtX, heat: true },
  { key: 'ctr', label: 'CTR', fmt: fmtPct, heat: true },
  { key: 'purchases', label: 'Purch', fmt: fmtN },
  { key: 'frequency', label: 'Freq', fmt: fmtF },
  { key: 'reach', label: 'Reach', fmt: fmtN },
  { key: 'cost_per_k_reach', label: '$/1k Reach', fmt: fmt$2 },
];

function renderTable(rows, firstCol, opts = {}) {
  if (!rows || !rows.length) return `<div class="cs-none">${escHtml(opts.emptyText || 'No qualifying rows')}</div>`;
  // column min/max for heat (data rows only)
  const ranges = {};
  for (const c of COLS) {
    if (!c.heat) continue;
    const vals = rows.map(r => r[c.key]).filter(v => v != null);
    if (vals.length >= 2) ranges[c.key] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  // Net results (blended) row
  const net = { spend: 0, purchases: 0, purchase_value: 0, impressions: 0, clicksEst: 0, reach: 0 };
  for (const r of rows) {
    net.spend += r.spend || 0; net.purchases += r.purchases || 0;
    net.purchase_value += r.purchase_value || 0; net.reach += r.reach || 0;
    if (r.ctr != null && r.spend != null) net.clicksEst += 0; // ctr can't be re-derived; blended ctr omitted
  }
  const netRow = {
    spend: net.spend,
    cpa: net.purchases > 0 ? net.spend / net.purchases : null,
    roas: net.spend > 0 ? net.purchase_value / net.spend : null,
    ctr: null,
    purchases: net.purchases,
    frequency: null,
    reach: net.reach,
    cost_per_k_reach: net.reach > 0 ? net.spend / net.reach * 1000 : null,
  };
  const body = rows.map(r => `
    <tr>
      <td title="${escHtml(r.label)}">${escHtml(r.label)}${r.ad_count ? ` <span style="color:#94a3b8;font-weight:400">(${r.ad_count})</span>` : ''}</td>
      ${COLS.map(c => `<td style="${c.heat && ranges[c.key] ? heatColor(r[c.key], ranges[c.key].min, ranges[c.key].max, c.invert) : ''}">${c.fmt(r[c.key])}</td>`).join('')}
    </tr>`).join('');
  return `<div class="cs-table-wrap"><table class="cs-table">
    <thead><tr><th>${escHtml(firstCol)}</th>${COLS.map(c => `<th>${c.label}</th>`).join('')}</tr></thead>
    <tbody>${body}
      <tr class="net"><td>Net Results</td>${COLS.map(c => `<td>${c.fmt(netRow[c.key])}</td>`).join('')}</tr>
    </tbody></table></div>`;
}

function segBlock(bySeg, firstCol) {
  let html = '';
  for (const seg of ['new', 'engaged', 'existing']) {
    const rows = bySeg[seg] || [];
    html += `<div class="cs-seg-label ${seg}">${seg}</div>`;
    html += renderTable(rows, firstCol, { emptyText: `No spend in ${seg}` });
  }
  if ((bySeg.unclassified || []).length) {
    html += `<div class="cs-seg-label unclassified">unclassified segment</div>`;
    html += renderTable(bySeg.unclassified, firstCol);
  }
  return html;
}

// ── Main render ────────────────────────────────────────────────────

function render() {
  const d = DATA;
  const el = document.getElementById('cs-content');
  if (!d) { el.innerHTML = '<div class="empty-cell">No data</div>'; return; }

  const c = d.coverage;
  let html = '';

  // Coverage chips — always lead with attribution coverage
  html += `<div class="cs-chips">
    <div class="cs-chip"><div class="n">${fmt$(c.total_spend)}</div><div class="l">Total spend</div></div>
    <div class="cs-chip ${c.attributed_pct >= 70 ? 'good' : 'warn'}"><div class="n">${c.attributed_pct}%</div><div class="l">Spend attributed</div></div>
    <div class="cs-chip"><div class="n">${c.attributed_ads}/${c.total_ads}</div><div class="l">Ads parseable</div></div>
    <div class="cs-chip warn"><div class="n">${fmt$(c.unattributed_spend)}</div><div class="l">Unattributed spend</div></div>
  </div>`;
  if (c.attributed_pct < 100 && c.total_spend > 0) {
    html += `<p class="cs-sec-sub">⚠ The rankings below speak for the <b>${c.attributed_pct}%</b> of spend whose ad names carry the
      naming convention (persona / angle / creative style parseable) — not the whole account.</p>`;
  }

  if (!d.ranking.length && !d.insufficient_volume.length) {
    html += `<div class="empty-cell">No attributed ads in this range yet. As ad names are corrected to the
      naming convention they will start appearing here.${c.total_ads === 0 ? '<br/><br/>No synced ad data in this range — run a sync above.' : ''}</div>`;
  } else {
    // Persona ranking
    html += `<h2 class="cs-sec">Persona ranking</h2>
      <p class="cs-sec-sub">Material personas only (spend ≥ $${d.thresholds.persona_min_spend} and ≥ ${d.thresholds.persona_min_purchases} purchases).
      Ranked on CPA, ROAS and volume break ties.</p>`;
    html += renderTable(d.ranking, 'Persona', { emptyText: 'No persona clears the materiality threshold in this range' });
    if (d.insufficient_volume.length) {
      html += `<p class="cs-sec-sub">Insufficient volume (not ranked): ${d.insufficient_volume.map(p =>
        `<b>${escHtml(p.label)}</b> (${fmt$(p.spend)}, ${fmtN(p.purchases)} purch)`).join(' · ')}</p>`;
    }

    // Account-level dimensions
    html += `<h2 class="cs-sec">Full account breakdowns</h2>
      <p class="cs-sec-sub">Whole-account view, no segment split.</p>
      <div class="cs-grid2">
        <div><div class="cs-seg-label" style="color:#6366f1">Creative style</div>${renderTable(d.account.style, 'Style')}</div>
        <div><div class="cs-seg-label" style="color:#6366f1">Angle</div>${renderTable(d.account.angle, 'Angle')}</div>
        <div><div class="cs-seg-label" style="color:#6366f1">Creative source</div>${renderTable(d.account.source, 'Source')}</div>
        <div><div class="cs-seg-label" style="color:#6366f1">Ad format</div>${renderTable(d.account.format, 'Format')}</div>
        <div><div class="cs-seg-label" style="color:#6366f1">URL / landing page</div>${renderTable(d.account.url, 'URL')}</div>
        <div><div class="cs-seg-label" style="color:#6366f1">Product category</div>${renderTable(d.account.category, 'Category')}</div>
      </div>`;

    // Per-persona deep dives
    html += `<h2 class="cs-sec">Persona deep dives</h2>
      <p class="cs-sec-sub">Creative compared within each segment — new / engaged / existing are read on their own terms,
      never against each other.</p>`;
    const rankIndex = new Map(d.ranking.map((p, i) => [p.label, i + 1]));
    for (const p of d.personas) {
      const rank = rankIndex.get(p.summary.label);
      const s = p.summary;
      html += `<details class="cs-persona">
        <summary>
          ${rank ? `<span class="cs-p-rank">#${rank}</span>` : '<span class="cs-badge low">low volume</span>'}
          <span class="cs-p-name">${escHtml(p.persona)}</span>
          <div class="cs-p-stats">
            <span class="cs-p-stat">Spend <b>${fmt$(s.spend)}</b></span>
            <span class="cs-p-stat">CPA <b>${fmt$(s.cpa)}</b></span>
            <span class="cs-p-stat">ROAS <b>${fmtX(s.roas)}</b></span>
            <span class="cs-p-stat">Purchases <b>${fmtN(s.purchases)}</b></span>
          </div>
        </summary>
        <div class="cs-p-body">
          <div class="cs-grid2">
            <div><h2 class="cs-sec" style="margin-top:0">Creative style by segment</h2>${segBlock(p.style_by_segment, 'Style')}</div>
            <div><h2 class="cs-sec" style="margin-top:0">Angle by segment</h2>${segBlock(p.angle_by_segment, 'Angle')}</div>
          </div>
          <h2 class="cs-sec">Best style × angle pairings by segment</h2>
          ${['new', 'engaged', 'existing'].map(seg => {
            const rows = p.best_pairings[seg] || [];
            let out = `<div class="cs-seg-label ${seg}">${seg}</div>`;
            if (!rows.length) return out + `<div class="cs-none">No qualifying pairing in ${seg} (needs ≥ $${d.thresholds.table_min_spend} spend and a purchase)</div>`;
            out += `<div class="cs-lead">Lead pairing for ${seg}: <b>${escHtml(rows[0].label)}</b> — CPA ${fmt$(rows[0].cpa)}, ROAS ${fmtX(rows[0].roas)}</div>`;
            return out + renderTable(rows, 'Style × Angle');
          }).join('')}
          <details style="margin-top:10px">
            <summary style="cursor:pointer;font-size:0.82rem;font-weight:700;color:#6366f1">More dimensions (source, URL, format, category, product)</summary>
            <div class="cs-grid2" style="margin-top:10px">
              <div><h2 class="cs-sec" style="margin-top:0">Creative source by segment</h2>${segBlock(p.source_by_segment, 'Source')}</div>
              <div><h2 class="cs-sec" style="margin-top:0">URL by segment</h2>${segBlock(p.url_by_segment, 'URL')}</div>
              <div><h2 class="cs-sec" style="margin-top:0">Ad format by segment</h2>${segBlock(p.format_by_segment, 'Format')}</div>
              <div><h2 class="cs-sec" style="margin-top:0">Product category by segment</h2>${segBlock(p.category_by_segment, 'Category')}</div>
              <div><h2 class="cs-sec" style="margin-top:0">Product by segment</h2>${segBlock(p.product_by_segment, 'Product')}</div>
            </div>
          </details>
        </div>
      </details>`;
    }
  }

  // Unmapped segment names — so the mapping can be extended
  if ((d.unmapped_segment_names || []).length) {
    html += `<h2 class="cs-sec">Ad sets / campaigns with unclassified segment</h2>
      <p class="cs-sec-sub">These names didn't match the new / engaged / existing synonym map — tell Claude which
      segment each belongs to and the map gets extended.</p>
      <div class="cs-mini-list">${d.unmapped_segment_names.map(u =>
        `• ${escHtml(u.name)} <span style="color:#94a3b8">(${fmt$(u.spend)})</span>`).join('<br/>')}</div>`;
  }

  // Unattributed ads
  if ((d.unattributed || []).length) {
    html += `<details style="margin-top:18px">
      <summary style="cursor:pointer;font-size:0.85rem;font-weight:700;color:#64748b">
        Unattributed ads (${d.coverage.unattributed_ads}) — names not carrying the convention</summary>
      <div class="cs-mini-list" style="margin-top:8px">${d.unattributed.map(u =>
        `• ${escHtml(u.ad_name || '(unnamed)')} <span style="color:#94a3b8">(${fmt$(u.spend)})</span>`).join('<br/>')}</div>
    </details>`;
  }

  html += `<div class="cs-notes">${(d.notes || []).map(n => '• ' + escHtml(n)).join('<br/>')}</div>`;
  el.innerHTML = html;
}

// ── Data loading ───────────────────────────────────────────────────

async function loadReport() {
  const since = document.getElementById('cs-since').value;
  const until = document.getElementById('cs-until').value;
  const el = document.getElementById('cs-content');
  el.innerHTML = '<div class="empty-cell">Crunching…</div>';
  try {
    const r = await fetch(`/api/creative-strategy?since=${since}&until=${until}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    DATA = data;
    const ds = data.data_status || {};
    document.getElementById('cs-status').textContent = ds.newest
      ? `Synced data: ${ds.oldest} → ${ds.newest} · ${ds.ad_count} ads · last sync ${ds.last_synced ? new Date(ds.last_synced).toLocaleString('en-AU') : '—'}`
      : 'No ad-level data synced yet — run a sync';
    render();
  } catch (err) {
    el.innerHTML = `<div class="empty-cell">Failed: ${escHtml(err.message)}</div>`;
  }
}

function setPreset(btn) {
  document.querySelectorAll('.cs-preset').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const days = Number(btn.dataset.days);
  document.getElementById('cs-since').value = isoDaysAgo(days);
  document.getElementById('cs-until').value = todayIso();
  loadReport();
}

function customRange() {
  document.querySelectorAll('.cs-preset').forEach(b => b.classList.remove('active'));
  if (document.getElementById('cs-since').value && document.getElementById('cs-until').value) loadReport();
}

// ── Sync ───────────────────────────────────────────────────────────

function showMsg(text, ok) {
  const el = document.getElementById('cs-msg');
  el.textContent = text;
  el.className = 'cs-msg ' + (ok ? 'ok' : 'err');
}

async function startSync(days) {
  try {
    const r = await fetch('/api/creative-strategy/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    showMsg(`Sync started (${days} days)…`, true);
    pollSync();
  } catch (err) { showMsg('Sync failed to start: ' + err.message, false); }
}

function pollSync() {
  clearInterval(syncPoll);
  syncPoll = setInterval(async () => {
    try {
      const r = await fetch('/api/creative-strategy/sync-status');
      const s = await r.json();
      if (s.isRunning) {
        const p = s.progress || {};
        showMsg(`Syncing… chunk ${p.chunksDone || 0}/${p.chunksTotal || '?'} · ${p.rows || 0} rows`, true);
      } else {
        clearInterval(syncPoll);
        if (s.lastError) showMsg('Sync failed: ' + s.lastError, false);
        else { showMsg('Sync complete ✓', true); loadReport(); }
      }
    } catch (_) {}
  }, 2500);
}

// ── Init ───────────────────────────────────────────────────────────
document.getElementById('cs-since').value = isoDaysAgo(1);
document.getElementById('cs-until').value = todayIso();
loadReport();
