// My Warehouse Availability — casual staff mark In / Out per day (instant save)
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let state = {}; // date -> true/false

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

  for (const a of me.availability) state[a.date] = a.available;

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
      return ds >= today && state[ds] === undefined;
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
          <div class="av-btns">
            <button class="av-btn in${v === true ? ' sel' : ''}" onclick="setDay('${ds}', true, this)">✓ In</button>
            <button class="av-btn out${v === false ? ' sel' : ''}" onclick="setDay('${ds}', false, this)">✗ Out</button>
          </div>
        </div>`;
    }
    html += '</div>';
  }
  box.innerHTML = html;
}

async function setDay(date, available, btn) {
  const row = btn.closest('.av-day');
  row.querySelectorAll('.av-btn').forEach(b => b.classList.add('saving'));
  try {
    const res = await fetch('/api/roster/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ date, available }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state[date] = available;
    row.querySelector('.av-btn.in').classList.toggle('sel', available === true);
    row.querySelector('.av-btn.out').classList.toggle('sel', available === false);
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  } finally {
    row.querySelectorAll('.av-btn').forEach(b => b.classList.remove('saving'));
  }
}

init();
