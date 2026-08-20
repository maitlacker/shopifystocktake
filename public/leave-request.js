(() => {
  let linkedEmployee = null;

  const startDate  = document.getElementById('startDate');
  const endDate    = document.getElementById('endDate');
  const daysHint   = document.getElementById('daysHint');
  const notes      = document.getElementById('notes');
  const btnSubmit  = document.getElementById('btnSubmit');
  const leaveForm  = document.getElementById('leaveForm');
  const statusBar  = document.getElementById('statusBar');
  const tbody      = document.getElementById('requestsTbody');
  const btnRefresh = document.getElementById('btnRefresh');

  // Set min date to today
  const today = new Date().toISOString().slice(0, 10);
  startDate.min = today;
  endDate.min   = today;

  // ── Public holidays ────────────────────────────────────────────────
  let publicHolidaySet  = new Set();   // Set of 'YYYY-MM-DD' strings
  let publicHolidayList = [];          // full objects for display

  async function loadPublicHolidays() {
    try {
      const res  = await fetch('/api/leave/public-holidays');
      const data = await res.json();
      publicHolidayList = data.holidays || [];
      publicHolidaySet  = new Set(publicHolidayList.map(h => String(h.date).slice(0, 10)));

      // Show upcoming holidays (next 12 months)
      const upcoming = publicHolidayList.filter(h => String(h.date).slice(0, 10) >= today).slice(0, 8);
      if (!upcoming.length) return;
      const lines = upcoming.map(h =>
        `<strong>${escHtml(h.name)}</strong>: ${fmtDate(h.date)}`
      ).join('<br>');
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px 18px;margin-bottom:18px;font-size:0.85rem;color:#1e3a8a;';
      banner.innerHTML = `<strong style="display:block;margin-bottom:6px;">📅 Queensland Public Holidays</strong>${lines}`;
      document.getElementById('statusBar').insertAdjacentElement('afterend', banner);
    } catch (e) { /* non-fatal */ }
  }

  // ── Load & display blackout periods ───────────────────────────────
  let blackouts = [];

  async function loadBlackouts() {
    try {
      const res  = await fetch('/api/leave/blackouts');
      const data = await res.json();
      blackouts = data.blackouts || [];
      if (!blackouts.length) return;
      const lines = blackouts.map(b =>
        `<strong>${escHtml(b.name)}</strong>: ${fmtDate(b.start_date)} – ${fmtDate(b.end_date)}`
      ).join('<br>');
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#fef2f2;border:1px solid #fca5a5;border-radius:12px;padding:14px 18px;margin-bottom:18px;font-size:0.85rem;color:#7f1d1d;';
      banner.innerHTML = `<strong style="display:block;margin-bottom:6px;">🚫 Annual Leave Blackout Periods</strong>${lines}`;
      document.getElementById('statusBar').insertAdjacentElement('afterend', banner);
    } catch (e) { /* non-fatal */ }
  }

  // Check if selected dates overlap any blackout
  function checkBlackoutOverlap() {
    const s = startDate.value;
    const e = endDate.value;
    if (!s || !e || !blackouts.length) return null;
    return blackouts.find(b =>
      new Date(b.start_date) <= new Date(e) && new Date(b.end_date) >= new Date(s)
    ) || null;
  }

  // ── Check if user is linked ────────────────────────────────────────
  async function checkLinked() {
    try {
      const res  = await fetch('/api/leave/me');
      const data = await res.json();
      linkedEmployee = data.employee;
      if (!linkedEmployee) {
        document.getElementById('unlinkedBanner').style.display = 'block';
        btnSubmit.disabled = true;
        startDate.disabled = true;
        endDate.disabled   = true;
        notes.disabled     = true;
        return;
      }
      renderBalances(linkedEmployee);
      // Relabel the form for casual staff
      if (linkedEmployee.is_casual) {
        document.getElementById('pageTitle').textContent    = 'Unavailability Notice';
        document.getElementById('pageSubtitle').textContent = 'Mark the dates you are unavailable — recorded instantly on the team calendar, no approval needed.';
        document.getElementById('formTitle').textContent    = 'New Entry';
        btnSubmit.textContent = 'Mark as Unavailable';
        // Casual badge next to history heading
        const histHeading = document.querySelector('[style*="My Requests"], .lr-table-wrap');
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:0.7rem;background:#ede9fe;color:#6d28d9;font-weight:700;padding:2px 8px;border-radius:10px;margin-left:6px;text-transform:uppercase;letter-spacing:0.04em;';
        badge.textContent = 'Casual';
        document.querySelector('[style*="My Requests"]')?.appendChild(badge);
      }
    } catch (e) {
      console.error('Failed to check employee link', e);
    }
  }

  // ── Leave balances (from Xero via /api/leave/me) ───────────────────
  function renderBalances(emp) {
    if (!emp || emp.is_casual) return; // casuals don't accrue leave
    const hoursPerDay = parseFloat(emp.hours_per_day) || 7.6; // admin override, else AU standard
    const balances = emp.leave_balances || [];
    if (!balances.length) return;
    const rows = balances
      .filter(b => b.units !== null && b.units !== undefined)
      .map(b => {
        const units = parseFloat(b.units) || 0;
        const isHours = String(b.type_of_units || 'Hours').toLowerCase().startsWith('hour');
        const detail = isHours
          ? `<strong>${units.toFixed(1)} hrs</strong> <span style="color:#64748b">(~${(units / hoursPerDay).toFixed(1)} days)</span>`
          : `<strong>${units.toFixed(1)} ${escHtml(b.type_of_units || '')}</strong>`;
        return `<div style="display:flex;justify-content:space-between;gap:12px">
          <span>${escHtml(b.name)}</span><span>${detail}</span></div>`;
      });
    if (!rows.length) return;
    document.getElementById('balanceRows').innerHTML = rows.join('');
    document.getElementById('balanceMeta').textContent =
      `From Xero payroll${emp.balances_synced_at ? ' · updated ' + fmtDate(emp.balances_synced_at) : ''}. ` +
      `Days based on a ${hoursPerDay}-hour day${emp.hours_per_day ? ' (set for you by admin)' : ''}. ` +
      `Accrued balance — approved future leave isn't deducted until it's paid.`;
    document.getElementById('balanceCard').style.display = '';
  }

  function renderBookedAhead(requests) {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = (requests || []).filter(r =>
      (r.status === 'approved' || r.status === 'pending') && String(r.start_date).slice(0, 10) >= today
    );
    const days = upcoming.reduce((s, r) => s + (parseFloat(r.days_count) || 0), 0);
    const el = document.getElementById('balanceBooked');
    if (el && days > 0) {
      el.innerHTML = `📅 You already have <strong>${days} day${days !== 1 ? 's' : ''}</strong> booked or pending ahead — factor that in.`;
    }
  }

  // ── Days calculation ───────────────────────────────────────────────
  function updateDays() {
    const s = startDate.value;
    const e = endDate.value;
    if (!s || !e) { daysHint.textContent = ''; btnSubmit.disabled = !linkedEmployee; return; }
    if (new Date(e) < new Date(s)) {
      daysHint.textContent = '⚠ End date must be on or after start date';
      daysHint.style.color = '#b91c1c';
      btnSubmit.disabled = true;
      return;
    }
    const overlap = checkBlackoutOverlap();
    if (overlap) {
      daysHint.textContent = `⛔ Blackout period: ${overlap.name}`;
      daysHint.style.color = '#b91c1c';
      btnSubmit.disabled = true;
      return;
    }
    const days = countWorkingDays(s, e);

    // Check for public holidays within the selected range
    const holidaysInRange = publicHolidayList.filter(h => {
      const d = String(h.date).slice(0, 10);
      return d >= s && d <= e;
    });
    // Only count weekday holidays (weekends are already excluded)
    const weekdayHolidays = holidaysInRange.filter(h => {
      const dow = new Date(String(h.date).slice(0, 10)).getDay();
      return dow !== 0 && dow !== 6;
    });

    let hint = `${days} working day${days !== 1 ? 's' : ''}`;
    if (weekdayHolidays.length) {
      hint += ` <span style="color:#64748b;font-size:0.8em;">(excl. ${weekdayHolidays.length} public holiday${weekdayHolidays.length !== 1 ? 's' : ''}: ${weekdayHolidays.map(h => escHtml(h.name)).join(', ')})</span>`;
    }
    daysHint.innerHTML = hint;
    daysHint.style.color = '#6366f1';
    btnSubmit.disabled = !linkedEmployee;
  }

  startDate.addEventListener('change', () => {
    if (endDate.value && endDate.value < startDate.value) endDate.value = startDate.value;
    endDate.min = startDate.value;
    updateDays();
  });
  endDate.addEventListener('change', updateDays);

  // ── Submit ────────────────────────────────────────────────────────
  leaveForm.addEventListener('submit', async e => {
    e.preventDefault();
    btnSubmit.disabled = true;
    showStatus('Submitting…', 'info');
    try {
      const res = await fetch('/api/leave/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_date: startDate.value,
          end_date:   endDate.value,
          notes:      notes.value.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed');
      const msg = data.isCasual
        ? 'Unavailability recorded — visible on the team calendar.'
        : 'Request submitted — you will be notified once approved.';
      showStatus(msg, 'success');
      startDate.value = '';
      endDate.value   = '';
      notes.value     = '';
      daysHint.textContent = '';
      loadRequests();
    } catch (err) {
      showStatus(err.message, 'error');
      btnSubmit.disabled = false;
    }
  });

  // ── Load my requests ───────────────────────────────────────────────
  async function loadRequests() {
    try {
      const res  = await fetch('/api/leave/requests');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      renderRequests(data.requests || []);
      renderBookedAhead(data.requests || []);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="lr-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderRequests(requests) {
    if (!requests.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="lr-empty">No requests yet</td></tr>`;
      return;
    }
    tbody.innerHTML = requests.map(r => {
      const start  = fmtDate(r.start_date);
      const end    = fmtDate(r.end_date);
      const dates  = start === end ? start : `${start} – ${end}`;
      const days   = r.days_count || '—';
      const filed  = fmtDate(r.created_at);
      let xeroBadge = '';
      if (r.xero_leave_id) {
        xeroBadge = `<span class="lr-xero-badge">✓ Xero</span>`;
      } else if (r.xero_status === 'error') {
        xeroBadge = `<span class="lr-xero-badge error" title="${escHtml(r.xero_error || '')}">⚠ Xero</span>`;
      }
      return `<tr>
        <td>${escHtml(dates)}</td>
        <td>${days}</td>
        <td><span class="lr-pill ${r.status}">${r.status}</span>${r.status === 'rejected' && r.reject_reason ? `<br><small style="color:#94a3b8;">${escHtml(r.reject_reason)}</small>` : ''}</td>
        <td>${xeroBadge || '<span style="color:#cbd5e1;">—</span>'}</td>
        <td style="color:#94a3b8; font-size:0.8rem;">${filed}</td>
      </tr>`;
    }).join('');
  }

  btnRefresh.addEventListener('click', loadRequests);

  // ── Helpers ───────────────────────────────────────────────────────
  function countWorkingDays(startStr, endStr, holidays = publicHolidaySet) {
    let count = 0;
    const end = new Date(endStr);
    const cur = new Date(startStr);
    while (cur <= end) {
      const day = cur.getDay();
      const dateStr = cur.toISOString().slice(0, 10);
      if (day !== 0 && day !== 6 && !holidays.has(dateStr)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function showStatus(msg, type) {
    statusBar.textContent = msg;
    statusBar.className = `lr-status ${type}`;
    if (type === 'success') setTimeout(() => { statusBar.className = 'lr-status'; }, 6000);
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────
  loadPublicHolidays();
  loadBlackouts();
  checkLinked();
  loadRequests();
})();
