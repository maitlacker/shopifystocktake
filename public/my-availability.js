// My Warehouse Availability — casual staff mark In / Out per day (instant save)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let state = {}; // date -> { available: true/false, status: 'pending'|'approved'|'declined' }

function statusBadge(ds) {
  const v = state[ds];
  if (!v || v.available !== true) return '';
  const map = {
    pending:  ['⏳ Awaiting approval', '#92400e', '#fffbeb', '#fde68a'],
    approved: ['✓ Approved',          '#15803d', '#dcfce7', '#86efac'],
    declined: ['✗ Declined',          '#b91c1c', '#fee2e2', '#fca5a5'],
  };
  const [label, color, bg, border] = map[v.status] || map.pending;
  return `<span style="font-size:0.68rem;font-weight:700;border-radius:999px;padding:2px 8px;
    color:${color};background:${bg};border:1px solid ${border};white-space:nowrap">${label}</span>`;
}

function addDaysIso(isoStr, n) {
  const d = new Date(isoStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function init() {
  const box = document.getElementById('av-content');
  let me;
  try {
    me = await (await fetch('/api/roster/me')).json();
  } catch {
    box.innerHTML = '<div class="av-msg">Could not load your profile — try refreshing.</div>';
    return;
  }

  if (!me.employee) {
    box.innerHTML = `<div class="av-msg">Your login isn't linked to a staff record yet.<br><br>
      Ask admin to link your email on the <b>Leave Admin</b> page, then come back here.</div>`;
    return;
  }
  if (!me.isCasualWarehouse) {
    box.innerHTML = `<div class="av-msg">Availability is only needed from <b>casual warehouse staff</b>.<br><br>
      Full-time staff are rostered automatically (minus approved leave) — see the
      <a href="/roster.html">Warehouse Roster</a>.</div>`;
    return;
  }

  for (const a of me.availability) {
    state[a.date] = { available: a.available, status: a.status || 'pending',
                      start: a.start || '09:00', end: a.end || '17:00' };
  }

  // 4 weeks starting from the Monday of the current week (Brisbane)
  const today = me.today;
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7; // 0 = Mon
  const thisMonday = addDaysIso(today, -dow);

  let html = '';
  for (let w = 0; w < 4; w++) {
    const weekStart = addDaysIso(thisMonday, w * 7);
    const label = w === 0 ? 'This week' : w === 1 ? 'Next week' :
      `Week of ${new Date(weekStart + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
    const missing = [...Array(7)].some((_, i) => {
      const ds = addDaysIso(weekStart, i);
      return ds >= today && !state[ds];
    });
    html += `<div class="av-week">
      <div class="av-week-head"><span>${escHtml(label)}</span>
        ${missing && w <= 1 ? '<span class="hint">⚠ days not answered</span>' : ''}</div>`;
    for (let i = 0; i < 7; i++) {
      const ds = addDaysIso(weekStart, i);
      if (ds < today) continue;
      const d = new Date(ds + 'T00:00:00Z');
      const dayLabel = d.toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' });
      const dateLabel = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
      const v = state[ds];
      html += `
        <div class="av-day" data-date="${ds}">
          <div class="av-date">${escHtml(dayLabel)} <small>${escHtml(dateLabel)}</small></div>
          <span id="av-st-${ds}">${statusBadge(ds)}</span>
          <span class="av-timewrap" id="av-tm-${ds}" style="${v && v.available === true ? '' : 'display:none'}">
            <input type="time" class="av-time" id="av-s-${ds}" value="${escHtml((v && v.start) || '09:00')}"
              onchange="timesChanged('${ds}')" />–<input type="time" class="av-time" id="av-e-${ds}"
              value="${escHtml((v && v.end) || '17:00')}" onchange="timesChanged('${ds}')" />
          </span>
          <div class="av-btns">
            <button class="av-btn in${v && v.available === true ? ' sel' : ''}" onclick="setDay('${ds}', true, this)">✓ In</button>
            <button class="av-btn out${v && v.available === false ? ' sel' : ''}" onclick="setDay('${ds}', false, this)">✗ Out</button>
          </div>
        </div>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

async function saveEntry(date, available, row) {
  row.querySelectorAll('.av-btn').forEach(b => b.classList.add('saving'));
  const start = document.getElementById(`av-s-${date}`)?.value || '09:00';
  const end   = document.getElementById(`av-e-${date}`)?.value || '17:00';
  try {
    const res = await fetch('/api/roster/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ date, available, start_time: start, end_time: end }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const prev = state[date];
    state[date] = {
      available, start, end,
      // identical re-submits keep their status; any change goes back to pending
      status: prev && prev.available === available && prev.start === start && prev.end === end
        ? prev.status : 'pending',
    };
    row.querySelector('.av-btn.in').classList.toggle('sel', available === true);
    row.querySelector('.av-btn.out').classList.toggle('sel', available === false);
    const tm = document.getElementById(`av-tm-${date}`);
    if (tm) tm.style.display = available === true ? '' : 'none';
    const st = document.getElementById(`av-st-${date}`);
    if (st) st.innerHTML = statusBadge(date);
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  } finally {
    row.querySelectorAll('.av-btn').forEach(b => b.classList.remove('saving'));
  }
}

function setDay(date, available, btn) {
  return saveEntry(date, available, btn.closest('.av-day'));
}

function timesChanged(date) {
  const row = document.querySelector(`.av-day[data-date="${date}"]`);
  const s = document.getElementById(`av-s-${date}`);
  const e = document.getElementById(`av-e-${date}`);
  if (s && e && s.value && e.value && s.value >= e.value) {
    alert('End time must be after start time');
    return;
  }
  if (row && state[date] && state[date].available === true) saveEntry(date, true, row);
}

init();
