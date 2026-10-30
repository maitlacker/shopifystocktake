// Warehouse Roster — month calendar of who's in the warehouse each day
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let viewYear, viewMonth; // month is 0-based

function todayBrisbane() {
  const d = new Date(Date.now() + 10 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
           iso: d.toISOString().slice(0, 10) };
}

function iso(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function goToday() {
  const t = todayBrisbane();
  viewYear = t.y; viewMonth = t.m;
  load();
}

function moveMonth(delta) {
  viewMonth += delta;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  load();
}

function person(name, color, cls) {
  return `<div class="ro-person ${cls || ''}">
    <span class="ro-dot" style="background:${color}"></span>${escHtml(name)}</div>`;
}

async function load() {
  const first = new Date(Date.UTC(viewYear, viewMonth, 1));
  const last = new Date(Date.UTC(viewYear, viewMonth + 1, 0));
  document.getElementById('ro-month').textContent =
    first.toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const grid = document.getElementById('ro-grid');
  grid.innerHTML = '<div style="grid-column:1/-1;color:#64748b;text-align:center;padding:30px">Loading…</div>';

  let data;
  try {
    const res = await fetch(`/api/roster/calendar?start=${iso(viewYear, viewMonth, 1)}&end=${iso(viewYear, viewMonth, last.getUTCDate())}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error);
  } catch (err) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:#b91c1c;text-align:center;padding:30px">Error: ${escHtml(err.message)}</div>`;
    return;
  }

  document.getElementById('ro-staffline').textContent =
    `${data.staff.fullTime} full-time + ${data.staff.casual} casual warehouse staff`;

  const t = todayBrisbane();
  const byDate = new Map(data.days.map(d => [d.date, d]));
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let html = DOW.map(d => `<div class="ro-dow">${d}</div>`).join('');

  // leading blanks (Monday-first grid)
  const firstDow = (first.getUTCDay() + 6) % 7; // 0 = Monday
  for (let i = 0; i < firstDow; i++) html += '<div class="ro-cell other"></div>';

  for (let dayN = 1; dayN <= last.getUTCDate(); dayN++) {
    const ds = iso(viewYear, viewMonth, dayN);
    const day = byDate.get(ds) || {};
    const dow = (new Date(ds + 'T00:00:00Z').getUTCDay() + 6) % 7;
    const weekend = dow >= 5;
    const isToday = ds === t.iso;
    const count = day.headcount || 0;

    let body = '';
    if (day.holiday) body += `<div class="ro-holiday">🎉 ${escHtml(day.holiday)}</div>`;
    body += (day.fullTime || []).map(n => person(n, '#16a34a')).join('');
    body += (day.casualsIn || []).map(c =>
      person(c.name + (c.note ? ` — ${c.note}` : ''), '#3b82f6')).join('');
    if ((day.casualsUnknown || []).length && !weekend && !day.holiday) {
      body += `<div class="ro-sec">` +
        day.casualsUnknown.map(n => person(n + ' ?', '#f59e0b', 'ro-unknown')).join('') + '</div>';
    }
    if ((day.leave || []).length) {
      body += `<div class="ro-sec">` +
        day.leave.map(n => person(n + ' (leave)', '#94a3b8', 'ro-leave')).join('') + '</div>';
    }
    if ((day.casualsOut || []).length) {
      body += `<div class="ro-sec">` +
        day.casualsOut.map(n => person(n + ' (out)', '#94a3b8', 'ro-muted')).join('') + '</div>';
    }
    if (!body) body = '<div class="ro-empty">—</div>';

    html += `
      <div class="ro-cell${weekend ? ' weekend' : ''}${isToday ? ' today' : ''}">
        <div class="ro-cell-top">
          <span class="ro-daynum">${dayN}</span>
          ${(!weekend && !day.holiday) || count ? `<span class="ro-count${count ? '' : ' zero'}">${count} in</span>` : ''}
        </div>
        ${body}
      </div>`;
  }
  grid.innerHTML = html;
}

goToday();
