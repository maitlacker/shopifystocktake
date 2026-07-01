(() => {
  // ── Tab switching ─────────────────────────────────────────────────
  document.querySelectorAll('.la-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.la-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.la-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
      if (btn.dataset.tab === 'pending')   loadPending();
      if (btn.dataset.tab === 'history')   loadHistory();
      if (btn.dataset.tab === 'employees') loadEmployees();
      if (btn.dataset.tab === 'blackouts') loadBlackouts();
      if (btn.dataset.tab === 'holidays')  loadPublicHolidays();
    });
  });

  const statusBar = document.getElementById('statusBar');

  // ── Pending requests ──────────────────────────────────────────────
  document.getElementById('btnRefreshPending').addEventListener('click', loadPending);

  async function loadPending() {
    const tbody = document.getElementById('pendingTbody');
    tbody.innerHTML = `<tr><td colspan="6" class="la-empty">Loading…</td></tr>`;
    try {
      const res  = await fetch('/api/leave/requests?status=pending');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const reqs = data.requests || [];
      document.getElementById('pendingCount').textContent = reqs.length ? `(${reqs.length})` : '';
      if (!reqs.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="la-empty">No pending requests ✓</td></tr>`;
        return;
      }
      tbody.innerHTML = reqs.map(r => pendingRow(r)).join('');
      bindPendingActions(tbody);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="la-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function pendingRow(r) {
    const name   = `${escHtml(r.first_name || '')} ${escHtml(r.last_name || '')}`.trim() || escHtml(r.wms_email);
    const dates  = fmtDateRange(r.start_date, r.end_date);
    const days   = r.days_count || '—';
    const filed  = fmtDate(r.created_at);
    return `
      <tr id="req-${r.id}">
        <td>
          <div style="font-weight:600;">${name}</div>
          <div style="font-size:0.75rem; color:#94a3b8;">${escHtml(r.wms_email)}</div>
        </td>
        <td>${dates}</td>
        <td>${days}</td>
        <td style="max-width:200px; color:#64748b; font-size:0.82rem;">${escHtml(r.notes || '—')}</td>
        <td style="color:#94a3b8; font-size:0.8rem;">${filed}</td>
        <td>
          <button class="la-action-btn approve" data-id="${r.id}" data-action="approve">✓ Approve</button>
          <div class="la-reject-row">
            <input type="text" placeholder="Reason (optional)" id="reason-${r.id}" />
            <button class="la-action-btn reject" data-id="${r.id}" data-action="reject">✗ Reject</button>
          </div>
        </td>
      </tr>`;
  }

  function bindPendingActions(tbody) {
    tbody.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => handleRequestAction(btn.dataset.action, Number(btn.dataset.id)));
    });
  }

  async function handleRequestAction(action, id) {
    const rejectReason = document.getElementById(`reason-${id}`)?.value.trim() || null;
    showStatus(`${action === 'approve' ? 'Approving' : 'Rejecting'}…`, 'info');
    try {
      const res = await fetch(`/api/leave/requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: action === 'approve' ? 'approved' : 'rejected', reject_reason: rejectReason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const msg = action === 'approve'
        ? 'Request approved — creating in Xero in the background…'
        : 'Request rejected.';
      showStatus(msg, 'success');
      loadPending();
    } catch (err) {
      showStatus(`Error: ${err.message}`, 'error');
    }
  }

  // ── All requests history ───────────────────────────────────────────
  document.getElementById('btnRefreshHistory').addEventListener('click', loadHistory);
  document.getElementById('historyFilter').addEventListener('change', loadHistory);

  document.getElementById('btnImportXero').addEventListener('click', async () => {
    if (!confirm('Import all leave applications from Xero? Already-imported records will be skipped.')) return;
    const btn = document.getElementById('btnImportXero');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    showStatus('Importing leave from Xero…', 'info');
    try {
      const res  = await fetch('/api/leave/import-xero', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showStatus(
        `Import complete — ${data.imported} imported, ${data.skipped} already existed, ${data.unmatched} unmatched employees`,
        'success'
      );
      loadHistory();
    } catch (err) {
      showStatus(`Import failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import from Xero';
    }
  });

  async function loadHistory() {
    const tbody  = document.getElementById('historyTbody');
    const status = document.getElementById('historyFilter').value;
    tbody.innerHTML = `<tr><td colspan="7" class="la-empty">Loading…</td></tr>`;
    try {
      const qs  = status ? `?status=${encodeURIComponent(status)}` : '';
      const res = await fetch(`/api/leave/requests${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const reqs = data.requests || [];
      if (!reqs.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="la-empty">No requests found</td></tr>`;
        return;
      }
      tbody.innerHTML = reqs.map(r => historyRow(r)).join('');
      tbody.querySelectorAll('[data-retry]').forEach(btn => {
        btn.addEventListener('click', () => retryXero(Number(btn.dataset.retry)));
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="la-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function historyRow(r) {
    const name  = `${escHtml(r.first_name || '')} ${escHtml(r.last_name || '')}`.trim() || escHtml(r.wms_email);
    const dates = fmtDateRange(r.start_date, r.end_date);
    const filed = fmtDate(r.created_at);
    let xeroBadge = '<span style="color:#cbd5e1;">—</span>';
    if (r.xero_leave_id) {
      xeroBadge = `<span class="la-xero-badge">✓ ${r.xero_leave_id.slice(0,8)}…</span>`;
    } else if (r.xero_status === 'error') {
      xeroBadge = `<span class="la-xero-badge error" title="${escHtml(r.xero_error || '')}">⚠ Failed</span>`;
    }
    const retryBtn = (r.status === 'approved' && !r.xero_leave_id)
      ? `<button class="la-action-btn retry" data-retry="${r.id}">Retry Xero</button>` : '';
    return `
      <tr>
        <td>
          <div style="font-weight:600;">${name}</div>
          <div style="font-size:0.75rem; color:#94a3b8;">${escHtml(r.wms_email)}</div>
        </td>
        <td>${dates}</td>
        <td>${r.days_count || '—'}</td>
        <td><span class="la-pill ${r.status}">${r.status}</span>${r.reject_reason ? `<br><small style="color:#94a3b8;">${escHtml(r.reject_reason)}</small>` : ''}</td>
        <td>${xeroBadge}</td>
        <td style="color:#94a3b8; font-size:0.8rem;">${filed}</td>
        <td>${retryBtn}</td>
      </tr>`;
  }

  async function retryXero(id) {
    showStatus('Retrying Xero write-back…', 'info');
    try {
      const res  = await fetch(`/api/leave/requests/${id}/xero-retry`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showStatus(`Xero leave created: ${data.xero_leave_id}`, 'success');
      loadHistory();
    } catch (err) {
      showStatus(`Xero retry failed: ${err.message}`, 'error');
    }
  }

  // ── Employees ─────────────────────────────────────────────────────
  document.getElementById('btnSyncEmps').addEventListener('click', async () => {
    const syncStatus = document.getElementById('syncStatus');
    syncStatus.textContent = 'Syncing…';
    try {
      const res  = await fetch('/api/leave/employees/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      syncStatus.textContent = `Synced ${data.synced} employees`;
      loadEmployees();
    } catch (err) {
      syncStatus.textContent = `Error: ${err.message}`;
      showStatus(err.message, 'error');
    }
  });

  async function loadEmployees() {
    const tbody = document.getElementById('empTbody');
    tbody.innerHTML = `<tr><td colspan="4" class="la-empty">Loading…</td></tr>`;
    try {
      const res  = await fetch('/api/leave/employees');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const emps = data.employees || [];
      if (!emps.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="la-empty">No employees — click "Sync from Xero" to import</td></tr>`;
        return;
      }
      tbody.innerHTML = emps.map(empRow).join('');
      tbody.querySelectorAll('form[data-emp-id]').forEach(form => {
        form.addEventListener('submit', async e => {
          e.preventDefault();
          const id    = form.dataset.empId;
          const email = form.querySelector('input').value.trim();
          try {
            const res  = await fetch(`/api/leave/employees/${id}/link`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ wms_email: email || null }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            showStatus(`Linked ${data.employee.first_name} ${data.employee.last_name} → ${email || 'unlinked'}`, 'success');
            loadEmployees();
          } catch (err) {
            showStatus(`Link failed: ${err.message}`, 'error');
          }
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="la-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function empRow(e) {
    const name    = `${escHtml(e.first_name)} ${escHtml(e.last_name)}`.trim();
    const active  = e.is_active
      ? '<span style="color:#15803d; font-size:0.75rem; font-weight:600;">Active</span>'
      : '<span style="color:#94a3b8; font-size:0.75rem;">Inactive</span>';
    const linked  = e.wms_email
      ? `<span style="color:#15803d; font-size:0.8rem; font-weight:600;">✓ ${escHtml(e.wms_email)}</span>`
      : '<span style="color:#f59e0b; font-size:0.78rem;">Not linked</span>';
    return `
      <tr>
        <td style="font-weight:600;">${name}</td>
        <td style="color:#64748b; font-size:0.82rem;">${escHtml(e.xero_email || '—')}</td>
        <td>
          ${linked}
          <form class="la-link-form" data-emp-id="${e.id}" style="margin-top:5px;">
            <input type="email" value="${escHtml(e.wms_email || '')}" placeholder="name@theselfstyler.com" />
            <button type="submit" class="la-action-btn link">Save</button>
          </form>
        </td>
        <td>${active}</td>
      </tr>`;
  }

  // ── Blackout dates ────────────────────────────────────────────────
  document.getElementById('blackoutForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name  = document.getElementById('boName').value.trim();
    const start = document.getElementById('boStart').value;
    const end   = document.getElementById('boEnd').value;
    if (new Date(end) < new Date(start)) {
      showStatus('End date must be on or after start date', 'error');
      return;
    }
    try {
      const res  = await fetch('/api/leave/blackouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, start_date: start, end_date: end }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      document.getElementById('boName').value  = '';
      document.getElementById('boStart').value = '';
      document.getElementById('boEnd').value   = '';
      showStatus(`Blackout period "${name}" added`, 'success');
      loadBlackouts();
    } catch (err) {
      showStatus(`Failed: ${err.message}`, 'error');
    }
  });

  async function loadBlackouts() {
    const tbody = document.getElementById('blackoutTbody');
    tbody.innerHTML = `<tr><td colspan="5" class="la-empty">Loading…</td></tr>`;
    try {
      const res  = await fetch('/api/leave/blackouts');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const rows = data.blackouts || [];
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="la-empty">No blackout periods defined</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map(b => {
        const days = countWorkingDays(b.start_date, b.end_date);
        return `<tr>
          <td style="font-weight:600;">${escHtml(b.name)}</td>
          <td>${fmtDate(b.start_date)}</td>
          <td>${fmtDate(b.end_date)}</td>
          <td>${days} day${days !== 1 ? 's' : ''}</td>
          <td><button class="la-action-btn reject" data-del="${b.id}">Remove</button></td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('[data-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this blackout period?')) return;
          try {
            const res = await fetch(`/api/leave/blackouts/${btn.dataset.del}`, { method: 'DELETE' });
            if (!res.ok) throw new Error((await res.json()).error);
            showStatus('Blackout period removed', 'success');
            loadBlackouts();
          } catch (err) {
            showStatus(`Failed: ${err.message}`, 'error');
          }
        });
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" class="la-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  // ── Public holidays ───────────────────────────────────────────────
  // Populate year options
  const holidayYearFilter = document.getElementById('holidayYearFilter');
  const _cy = new Date().getFullYear();
  [_cy - 1, _cy, _cy + 1, _cy + 2].forEach(y => {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === _cy) opt.textContent += ' (current)';
    holidayYearFilter.appendChild(opt);
  });

  holidayYearFilter.addEventListener('change', loadPublicHolidays);

  document.getElementById('btnSyncHolidays').addEventListener('click', async () => {
    const syncStatus = document.getElementById('holidaySyncStatus');
    const btn = document.getElementById('btnSyncHolidays');
    btn.disabled = true;
    syncStatus.textContent = 'Syncing…';
    try {
      const year = holidayYearFilter.value ? Number(holidayYearFilter.value) : null;
      const body = year ? { year } : {};
      const res  = await fetch('/api/leave/public-holidays/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const total = data.results.reduce((s, r) => s + r.upserted, 0);
      syncStatus.textContent = `Synced ${total} holiday${total !== 1 ? 's' : ''}`;
      loadPublicHolidays();
    } catch (err) {
      syncStatus.textContent = `Error: ${err.message}`;
      showStatus(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  async function loadPublicHolidays() {
    const tbody = document.getElementById('holidaysTbody');
    tbody.innerHTML = `<tr><td colspan="4" class="la-empty">Loading…</td></tr>`;
    try {
      const year = holidayYearFilter.value;
      const qs   = year ? `?year=${encodeURIComponent(year)}` : '';
      const res  = await fetch(`/api/leave/public-holidays${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const rows = data.holidays || [];
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="la-empty">No holidays found — click "Sync from Nager.Date" to import</td></tr>`;
        return;
      }
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      tbody.innerHTML = rows.map(h => {
        const dateStr = String(h.date).slice(0, 10);
        const dow     = new Date(dateStr).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const dayCell = `<span style="color:${isWeekend ? '#94a3b8' : '#1e293b'}">${dayNames[dow]}</span>`;
        return `<tr style="${isWeekend ? 'opacity:0.55;' : ''}">
          <td style="font-variant-numeric:tabular-nums;">${fmtDate(dateStr)}</td>
          <td>${dayCell}</td>
          <td style="font-weight:${isWeekend ? '400' : '600'};">${escHtml(h.name)}</td>
          <td style="color:#94a3b8;">${h.year}</td>
        </tr>`;
      }).join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4" class="la-empty">Error: ${escHtml(err.message)}</td></tr>`;
    }
  }

  // ── Slack digest ──────────────────────────────────────────────────
  document.getElementById('btnPreviewSlack').addEventListener('click', async () => {
    const box = document.getElementById('slackPreview');
    box.textContent = 'Loading…';
    try {
      const res  = await fetch('/api/leave/slack-preview');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      box.textContent = data.message;
    } catch (err) {
      box.textContent = `Error: ${err.message}`;
    }
  });

  document.getElementById('btnSendSlack').addEventListener('click', async () => {
    if (!confirm('Send the Slack digest to #annual-leave-updates now?')) return;
    showStatus('Sending…', 'info');
    try {
      const res  = await fetch('/api/leave/slack-send', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      showStatus('Slack message sent to #annual-leave-updates ✓', 'success');
    } catch (err) {
      showStatus(`Send failed: ${err.message}`, 'error');
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────
  function countWorkingDays(startStr, endStr, holidaySet = new Set()) {
    let count = 0;
    const end = new Date(endStr);
    const cur = new Date(startStr);
    while (cur <= end) {
      const day = cur.getDay();
      const dateStr = cur.toISOString().slice(0, 10);
      if (day !== 0 && day !== 6 && !holidaySet.has(dateStr)) count++;
      cur.setDate(cur.getDate() + 1);
    }
    return count;
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtDateRange(s, e) {
    const start = fmtDate(s);
    const end   = fmtDate(e);
    return start === end ? start : `${start} – ${end}`;
  }

  function showStatus(msg, type) {
    statusBar.textContent = msg;
    statusBar.className = `la-status ${type}`;
    if (type === 'success') setTimeout(() => { statusBar.className = 'la-status'; }, 5000);
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Init ──────────────────────────────────────────────────────────
  loadPending();
})();
