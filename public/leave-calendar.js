(() => {
  // toISOString() converts to UTC — in AEST (UTC+10) that shifts midnight to
  // the previous day. Use local year/month/day for calendar grid keys instead.
  function localDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const n = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${n}`;
  }

  const today = localDateStr(new Date());
  let currentYear  = new Date().getFullYear();
  let currentMonth = new Date().getMonth() + 1;

  const calGrid    = document.getElementById('calGrid');
  const calTitle   = document.getElementById('calTitle');
  const calOverlay = document.getElementById('calOverlay');

  // ── Navigation ────────────────────────────────────────────────────
  document.getElementById('btnPrev').addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 1) { currentMonth = 12; currentYear--; }
    loadCalendar();
  });
  document.getElementById('btnNext').addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    loadCalendar();
  });
  document.getElementById('btnToday').addEventListener('click', () => {
    currentYear  = new Date().getFullYear();
    currentMonth = new Date().getMonth() + 1;
    loadCalendar();
  });

  // ── Load & render ─────────────────────────────────────────────────
  async function loadCalendar() {
    calOverlay.style.display = 'flex';
    calTitle.textContent = new Date(currentYear, currentMonth - 1, 1)
      .toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

    try {
      const res  = await fetch(`/api/leave/calendar?year=${currentYear}&month=${currentMonth}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      renderCalendar(data);
    } catch (err) {
      calOverlay.textContent = `Error loading calendar: ${err.message}`;
      return;
    }
    calOverlay.style.display = 'none';
  }

  // ── Calendar start: Monday on or before the 1st of the month ──────
  function calendarStart(year, month) {
    const first = new Date(year, month - 1, 1);
    const dow   = first.getDay(); // 0=Sun … 6=Sat
    const offset = (dow + 6) % 7; // days back to reach Monday
    const start = new Date(first);
    start.setDate(start.getDate() - offset);
    return start;
  }

  // ── Render ────────────────────────────────────────────────────────
  function renderCalendar(data) {
    // Build a day-indexed map: 'YYYY-MM-DD' -> [{type, label, title}]
    const dayMap = {};

    function add(dateStr, ev) {
      (dayMap[dateStr] || (dayMap[dateStr] = [])).push(ev);
    }

    // Holidays (single day each)
    data.holidays.forEach(h => {
      add(h.date.slice(0, 10), { type: 'holiday', label: h.name, title: h.name });
    });

    // Blackouts (expand day by day)
    data.blackouts.forEach(b => {
      const end = new Date(b.end_date);
      const cur = new Date(b.start_date);
      while (cur <= end) {
        add(cur.toISOString().slice(0, 10), { type: 'blackout', label: b.name, title: `Blackout: ${b.name}` });
        cur.setDate(cur.getDate() + 1);
      }
    });

    // Leave (expand day by day, weekdays only)
    data.leave.forEach(l => {
      const firstName = (l.first_name || '').trim();
      const lastName  = (l.last_name  || '').trim();
      const fullName  = firstName && lastName ? `${firstName} ${lastName}` : firstName || l.wms_email.split('@')[0];
      const shortName = firstName ? `${firstName}${lastName ? ' ' + lastName[0] + '.' : ''}` : fullName;
      const end = new Date(l.end_date);
      const cur = new Date(l.start_date);
      while (cur <= end) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) {
          add(cur.toISOString().slice(0, 10), { type: 'leave', label: shortName, title: `${fullName} — Annual Leave` });
        }
        cur.setDate(cur.getDate() + 1);
      }
    });

    // Remove old day cells (keep the 7 header cells)
    const allCells = calGrid.querySelectorAll('.lc-day');
    allCells.forEach(c => c.remove());

    // Render 42 day cells (6 weeks × 7 days), starting from Monday
    const start = calendarStart(data.year, data.month);

    for (let i = 0; i < 42; i++) {
      const date    = new Date(start);
      date.setDate(date.getDate() + i);
      const dateStr  = localDateStr(date); // local date — toISOString() would give UTC (wrong in AEST)
      const inMonth  = date.getMonth() === data.month - 1;
      const dow      = date.getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isToday   = dateStr === today;

      const cell = document.createElement('div');
      cell.className = 'lc-day' +
        (inMonth  ? '' : ' other-month') +
        (isWeekend ? ' weekend'     : '') +
        (isToday   ? ' today'       : '');

      // Day number
      const numEl = document.createElement('div');
      numEl.className = 'lc-day-num';
      const numSpan = document.createElement('span');
      numSpan.textContent = date.getDate();
      numEl.appendChild(numSpan);
      cell.appendChild(numEl);

      // Events
      const eventsEl = document.createElement('div');
      eventsEl.className = 'lc-events';

      const events  = dayMap[dateStr] || [];
      const MAX_VIS = 4;
      events.slice(0, MAX_VIS).forEach(ev => {
        const chip = document.createElement('div');
        chip.className = `lc-chip ${ev.type}`;
        chip.textContent = ev.label;
        chip.title = ev.title || ev.label;
        eventsEl.appendChild(chip);
      });
      if (events.length > MAX_VIS) {
        const more = document.createElement('div');
        more.className = 'lc-chip more';
        more.textContent = `+${events.length - MAX_VIS} more`;
        eventsEl.appendChild(more);
      }

      cell.appendChild(eventsEl);
      calGrid.appendChild(cell);
    }
  }

  // ── Init ──────────────────────────────────────────────────────────
  loadCalendar();
})();
