// Warehouse Roster — month calendar of who's in the warehouse each day
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let viewYear, viewMonth; // month is 0-based
let isRosterAdmin = false;

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

function fmtT(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = ((h + 11) % 12) + 1;
  return m ? `${hh}:${String(m).padStart(2, '0')}${ap}` : `${hh}${ap}`;
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
    body += (day.casualsIn || []).map(c => {
      const times = c.start && c.end ? ` ${fmtT(c.start)}–${fmtT(c.end)}` : '';
      return person(c.name + times + (c.note ? ` — ${c.note}` : ''), '#3b82f6');
    }).join('');
    if ((day.leave || []).length) {
      body += `<div class="ro-sec">` +
        day.leave.map(n => person(n + ' (leave)', '#94a3b8', 'ro-leave')).join('') + '</div>';
    }
    if (day.pendingCount && isRosterAdmin) {
      body += `<div class="ro-pending-hint">⏳ ${day.pendingCount} request${day.pendingCount !== 1 ? 's' : ''} awaiting approval</div>`;
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

// ── Shift approvals (roster admins only; everyone else gets a 403) ──
async function loadRequests() {
  const box = document.getElementById('ro-approvals');
  try {
    const res = await fetch('/api/roster/requests');
    if (!res.ok) { isRosterAdmin = false; box.innerHTML = ''; return; }
    isRosterAdmin = true;
    const { requests } = await res.json();
    if (!requests.length) { box.innerHTML = ''; return; }

    const byPerson = new Map();
    for (const r of requests) {
      if (!byPerson.has(r.email)) byPerson.set(r.email, { name: r.name, email: r.email, days: [] });
      byPerson.get(r.email).days.push(r);
    }

    box.innerHTML = `<div class="ro-appr">
      <h2>⏳ Shift requests awaiting approval (${requests.length})</h2>
      ${[...byPerson.values()].map(p => `
        <div class="ro-appr-person">
          <div class="ro-appr-name">${escHtml(p.name || p.email)}
            <button class="ro-appr-all"
              onclick='decide(${JSON.stringify(p.email)}, ${JSON.stringify(p.days.map(d => d.date))}, "approve")'>
              ✓ Approve all ${p.days.length}</button>
          </div>
          <div class="ro-appr-days">
            ${p.days.map(d => `
              <span class="ro-appr-day" data-email="${escHtml(p.email)}" data-date="${escHtml(d.date)}">
                ${escHtml(new Date(d.date + 'T00:00:00Z').toLocaleDateString('en-AU',
                  { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }))}
                <input type="time" class="ap-s" value="${escHtml(d.start || '09:00')}"
                  style="border:1px solid #e2e8f0;border-radius:6px;padding:2px 4px;font-size:0.75rem" />–
                <input type="time" class="ap-e" value="${escHtml(d.end || '17:00')}"
                  style="border:1px solid #e2e8f0;border-radius:6px;padding:2px 4px;font-size:0.75rem" />
                ${d.note ? `<span style="color:#94a3b8;font-weight:500">· ${escHtml(d.note)}</span>` : ''}
                <button class="ro-appr-ok" title="Approve with these times"
                  onclick='decide(${JSON.stringify(p.email)}, ${JSON.stringify([d.date])}, "approve")'>✓</button>
                <button class="ro-appr-no" title="Decline"
                  onclick='decide(${JSON.stringify(p.email)}, ${JSON.stringify([d.date])}, "decline")'>✕</button>
              </span>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
  } catch (_) { box.innerHTML = ''; }
}

async function decide(email, dates, action) {
  // Pick up the (possibly adjusted) times from each day's chip
  const entries = dates.map(date => {
    const chip = [...document.querySelectorAll('.ro-appr-day')]
      .find(el => el.dataset.email === email && el.dataset.date === date);
    return {
      date,
      start_time: chip?.querySelector('.ap-s')?.value || null,
      end_time: chip?.querySelector('.ap-e')?.value || null,
    };
  });
  try {
    const res = await fetch('/api/roster/requests/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, entries, action }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error);
    await Promise.all([loadRequests(), load()]);
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}

loadRequests().then(goToday);
