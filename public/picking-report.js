function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtSecs(s) {
  if (s == null || s === '') return '—';
  const n = Number(s);
  if (n < 60) return `${n.toFixed(1)}s`;
  const m = Math.floor(n / 60);
  const sec = Math.round(n % 60);
  return `${m}m ${sec}s`;
}

function fmtActive(s) {
  if (s == null) return '—';
  const n = Number(s);
  if (n < 60) return `${n}s`;
  const m = Math.floor(n / 60);
  const sec = n % 60;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

function timeClass(secs) {
  if (secs == null) return '';
  const n = Number(secs);
  if (n <= 15) return 'pr-time-good';
  if (n <= 30) return 'pr-time-mid';
  return 'pr-time-slow';
}

async function load() {
  const loading  = document.getElementById('pr-loading');
  const denied   = document.getElementById('pr-denied');
  const content  = document.getElementById('pr-content');

  try {
    const res  = await fetch('/api/picking/report');

    if (res.status === 403) {
      loading.style.display = 'none';
      denied.style.display  = 'block';
      return;
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load');

    loading.style.display = 'none';
    content.style.display = 'block';

    // ── Picker cards ────────────────────────────────────────────────
    document.getElementById('pr-picker-grid').innerHTML = data.users.length
      ? data.users.map(u => {
          const initialsHtml = u.initials
            ? `<div class="pr-initials-badge">${escHtml(u.initials)}</div>`
            : '';
          const avgClass = u.avgPickSeconds ? timeClass(u.avgPickSeconds) : '';
          const bestClass = u.bestPickSeconds ? timeClass(u.bestPickSeconds) : '';
          return `
            <div class="pr-picker-card">
              <div class="pr-picker-name">${escHtml(u.userName)}</div>
              <div class="pr-picker-email">${escHtml(u.userEmail)}</div>
              ${initialsHtml}
              <div class="pr-picker-stats">
                <div class="pr-stat">
                  <div class="pr-stat-val highlight">${u.sessions}</div>
                  <div class="pr-stat-lbl">Sessions</div>
                </div>
                <div class="pr-stat">
                  <div class="pr-stat-val">${u.totalPicks ?? '—'}</div>
                  <div class="pr-stat-lbl">Items Picked</div>
                </div>
                <div class="pr-stat">
                  <div class="pr-stat-val ${avgClass}">${fmtSecs(u.avgPickSeconds)}</div>
                  <div class="pr-stat-lbl">Avg / Item</div>
                </div>
                <div class="pr-stat">
                  <div class="pr-stat-val ${bestClass}">${fmtSecs(u.bestPickSeconds)}</div>
                  <div class="pr-stat-lbl">Best Session</div>
                </div>
              </div>
            </div>
          `;
        }).join('')
      : '<p style="color:#64748b">No picking sessions recorded yet.</p>';

    // ── Sessions table ───────────────────────────────────────────────
    document.getElementById('pr-sessions-tbody').innerHTML = data.sessions.length
      ? data.sessions.map(s => `
          <tr>
            <td style="white-space:nowrap">${fmtDate(s.createdAt)}</td>
            <td style="font-weight:500">${escHtml(s.userName)}</td>
            <td>${s.initials ? `<span class="pr-badge">${escHtml(s.initials)}</span>` : '—'}</td>
            <td style="text-align:right">#${s.orderStart}–${s.orderEnd}</td>
            <td style="text-align:right">${s.itemCount}</td>
            <td style="text-align:right">${s.picksCompleted}</td>
            <td style="text-align:right" class="${timeClass(s.avgPickSeconds)}">${fmtSecs(s.avgPickSeconds)}</td>
            <td style="text-align:right">${fmtActive(s.activeSeconds)}</td>
            <td style="text-align:right;color:#94a3b8">${s.excludedGaps > 0 ? s.excludedGaps : '—'}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="9" style="text-align:center;color:#64748b;padding:24px">No sessions yet.</td></tr>';

  } catch (err) {
    document.getElementById('pr-loading').textContent = `Error: ${err.message}`;
  }
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

load();
