// ── Helpers ────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtTime(secs) {
  if (secs == null || secs < 0) return '—';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function fmtDatetime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-AU', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// ── State ──────────────────────────────────────────────────────────
let currentDays = 1;
let records     = [];

// ── Load ───────────────────────────────────────────────────────────
async function loadReport(days) {
  currentDays = days;
  document.getElementById('pr-loading').style.display  = 'block';
  document.getElementById('pr-content').style.display  = 'none';

  try {
    const res  = await fetch(`/api/packing/report?days=${days}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load');
    records = data;
    renderReport();
  } catch (err) {
    document.getElementById('pr-loading').textContent = 'Error: ' + err.message;
  }
}

// ── Render ─────────────────────────────────────────────────────────
function renderReport() {
  document.getElementById('pr-loading').style.display = 'none';
  document.getElementById('pr-content').style.display = 'block';

  const rows = records;

  // ── Summary stats ──
  const totalOrders = rows.length;
  const totalItems  = rows.reduce((s, r) => s + (r.total_items || 0), 0);

  // Only include records with a valid time (started_at and packed_at make sense)
  const timedRows = rows.filter(r => r.time_seconds >= 0 && r.time_seconds < 7200); // cap at 2h
  const avgTime   = timedRows.length
    ? Math.round(timedRows.reduce((s, r) => s + r.time_seconds, 0) / timedRows.length)
    : null;
  const avgSecPerItem = (timedRows.length && totalItems > 0)
    ? (timedRows.reduce((s, r) => s + r.time_seconds, 0) / totalItems).toFixed(1)
    : null;

  const packers = new Set(rows.map(r => r.initials).filter(Boolean)).size;

  document.getElementById('st-orders').textContent       = totalOrders;
  document.getElementById('st-items').textContent        = totalItems;
  document.getElementById('st-avg-time').textContent     = avgTime != null ? fmtTime(avgTime) : '—';
  document.getElementById('st-sec-per-item').textContent = avgSecPerItem != null ? `${avgSecPerItem}s` : '—';
  document.getElementById('st-packers').textContent      = packers || '—';

  // ── Per-person breakdown ──
  const byPerson = {};
  for (const r of rows) {
    const key = r.initials || '—';
    if (!byPerson[key]) byPerson[key] = { orders: 0, items: 0, times: [] };
    byPerson[key].orders++;
    byPerson[key].items += r.total_items || 0;
    if (r.time_seconds >= 0 && r.time_seconds < 7200) byPerson[key].times.push(r.time_seconds);
  }

  const peopleHtml = Object.entries(byPerson)
    .sort(([, a], [, b]) => b.orders - a.orders)
    .map(([name, stats]) => {
      const avgT = stats.times.length
        ? Math.round(stats.times.reduce((s, t) => s + t, 0) / stats.times.length) : null;
      const fastest = stats.times.length ? Math.min(...stats.times) : null;
      return `
        <div class="pr-person-card">
          <div class="pr-person-avatar">${escHtml(name)}</div>
          <div class="pr-person-info">
            <div class="pr-person-name">${escHtml(name)}</div>
            <div class="pr-person-stats">
              ${stats.orders} order${stats.orders !== 1 ? 's' : ''}
              &nbsp;·&nbsp; ${stats.items} item${stats.items !== 1 ? 's' : ''}
              ${avgT != null ? `&nbsp;·&nbsp; avg ${fmtTime(avgT)}` : ''}
              ${fastest != null ? `&nbsp;·&nbsp; fastest ${fmtTime(fastest)}` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

  document.getElementById('pr-people').innerHTML = peopleHtml ||
    '<p style="color:#94a3b8;font-size:0.85rem">No packer data yet.</p>';

  // ── Audit table ──
  // Compute median time for colour-coding fast/slow
  const allTimes = timedRows.map(r => r.time_seconds).sort((a, b) => a - b);
  const median   = allTimes.length
    ? allTimes[Math.floor(allTimes.length / 2)] : null;

  const tbody = document.getElementById('pr-tbody');
  const empty = document.getElementById('pr-empty');

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = rows.map(r => {
    const t       = r.time_seconds;
    const timeStr = fmtTime(t);
    let   timeCls = '';
    if (median != null && t >= 0) {
      if (t < median * 0.6)      timeCls = 'fast';
      else if (t > median * 1.6) timeCls = 'slow';
    }

    const initials = r.initials
      ? `<span class="col-initials">${escHtml(r.initials)}</span>` : '<span style="color:#cbd5e1">—</span>';

    return `<tr>
      <td class="col-order">${escHtml(r.order_name)}</td>
      <td>${escHtml(r.customer_name || '—')}</td>
      <td>${r.total_items ?? '—'}</td>
      <td>${initials}</td>
      <td class="col-time ${timeCls}">${timeStr}</td>
      <td class="col-taps">${r.pack_taps ?? 0}</td>
      <td class="col-taps">${r.nav_events ?? 0}</td>
      <td style="color:#64748b;font-size:0.8rem">${fmtDatetime(r.packed_at)}</td>
    </tr>`;
  }).join('');
}

// ── Tab switching ──────────────────────────────────────────────────
document.querySelectorAll('.pr-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pr-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadReport(parseInt(btn.dataset.days));
  });
});

// ── Init ───────────────────────────────────────────────────────────
loadReport(1);
