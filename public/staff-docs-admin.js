/* Staff Documents — admin (accounts@ only) */
(function () {
  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const fmtD = (d) => d ? new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /* ── Load everything ──────────────────────────────────────────── */
  async function load() {
    try {
      const [docsRes, regRes] = await Promise.all([
        fetch('/api/staff-docs'),
        fetch('/api/staff-docs/register'),
      ]);
      if (docsRes.status === 401) { window.location.href = '/login'; return; }
      if (docsRes.status === 403) {
        document.querySelector('main').innerHTML =
          '<div class="sda-card"><div class="sda-empty">This area is restricted.</div></div>';
        return;
      }
      const docs = await docsRes.json();
      const reg  = await regRes.json();
      renderEmailNote(docs.email_configured);
      renderDocs(docs.documents || []);
      renderRegister(reg.current || [], reg.history || []);
    } catch (err) {
      document.getElementById('sda-docs').innerHTML =
        `<tr><td colspan="8" class="sda-empty">Failed: ${escHtml(err.message)}</td></tr>`;
    }
  }

  function renderEmailNote(configured) {
    document.getElementById('sda-email-note').innerHTML = configured
      ? '<div class="sda-email-note ok">✓ Email sending is configured — staff receive individual sign-off prompts automatically.</div>'
      : '<div class="sda-email-note bad">⚠ Email is NOT configured — set GMAIL_USER and GMAIL_APP_PASSWORD in Railway. Documents still work in the WMS, but staff won\'t receive email prompts.</div>';
  }

  /* ── Documents table ──────────────────────────────────────────── */
  function renderDocs(docs) {
    const tbody = document.getElementById('sda-docs');
    if (!docs.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="sda-empty">No documents yet — upload your first one above.</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map(d => {
      const s = d.stats;
      const isDraft = d.status === 'draft';
      const statusBadge = isDraft
        ? '<span class="sda-badge warn">DRAFT — not visible to staff</span>'
        : d.status === 'archived' ? '<span class="sda-badge grey">archived</span>' : '';
      const actions = [
        `<a class="sda-mini-btn" href="/api/staff-docs/${d.id}/file" target="_blank" style="text-decoration:none">Preview</a>`,
        `<button class="sda-mini-btn" data-act="test" data-id="${d.id}">Email Me a Test</button>`,
        `<button class="sda-mini-btn" data-act="recipients" data-id="${d.id}" data-audience="${d.audience}">Recipients</button>`,
        isDraft
          ? `<button class="sda-mini-btn" data-act="issue" data-id="${d.id}" data-title="${escHtml(d.title)}" style="background:#4f46e5;color:#fff;border-color:#4f46e5">Issue &amp; Send</button>`
          : '',
        !isDraft && d.status === 'active' ? `<button class="sda-mini-btn" data-act="remind" data-id="${d.id}">Send Reminders</button>` : '',
        `<button class="sda-mini-btn" data-act="newver" data-id="${d.id}">New Version</button>`,
        d.status !== 'draft' ? `<button class="sda-mini-btn" data-act="${d.status === 'archived' ? 'unarchive' : 'archive'}" data-id="${d.id}">${d.status === 'archived' ? 'Unarchive' : 'Archive'}</button>` : '',
      ].filter(Boolean).join(' ');
      return `
      <tr data-id="${d.id}" ${d.status === 'archived' ? 'style="opacity:0.5"' : ''}>
        <td>
          <div style="font-weight:600">${escHtml(d.title)} ${statusBadge}</div>
          <div style="font-size:0.78rem;color:#94a3b8">${escHtml(d.filename || '')}</div>
        </td>
        <td>${d.recur_days ? `Every ${d.recur_days}d` : 'Once'}${d.allow_decline ? ' · declinable' : ''}</td>
        <td>${d.audience === 'all' ? 'All staff' : 'Selected'}</td>
        <td style="text-align:center">v${d.version_number || '—'}</td>
        <td style="text-align:center"><span class="sda-badge ok">${s.acknowledged}</span></td>
        <td style="text-align:center"><span class="sda-badge ${s.outstanding ? 'warn' : 'grey'}">${isDraft ? '—' : s.outstanding}</span></td>
        <td style="text-align:center"><span class="sda-badge ${s.declined ? 'bad' : 'grey'}">${s.declined}</span></td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>
      <tr class="sda-recipients-row" data-for="${d.id}" style="display:none"><td colspan="8"></td></tr>`;
    }).join('');

    tbody.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleAction(btn));
    });
  }

  async function handleAction(btn) {
    const id  = btn.dataset.id;
    const act = btn.dataset.act;

    if (act === 'test') {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/staff-docs/${id}/test-send`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        alert(`Test sent to ${data.sent_to} — that's exactly what staff will receive (marked [TEST]).`);
      } catch (err) { alert(`Failed: ${err.message}`); }
      btn.disabled = false;
      return;
    }

    if (act === 'issue') {
      btn.disabled = true;
      try {
        // Resolve exactly who will receive it before asking for confirmation
        const rRes = await fetch(`/api/staff-docs/${id}/recipients`);
        const emps = await rRes.json();
        if (!rRes.ok) throw new Error(emps.error);
        const row = btn.closest('tr');
        const audience = row.querySelector('[data-act="recipients"]')?.dataset.audience || 'all';
        const targets = (audience === 'all' ? emps : emps.filter(e => e.selected))
          .filter(e => e.wms_email);
        if (!targets.length) {
          alert('No recipients resolved — check the audience/recipient selection and that staff have WMS emails linked.');
          btn.disabled = false;
          return;
        }
        const names = targets.map(e => `${e.first_name || ''} ${e.last_name || ''}`.trim());
        const preview = names.slice(0, 12).join(', ') + (names.length > 12 ? ` … and ${names.length - 12} more` : '');
        if (!confirm(`Issue "${btn.dataset.title}" to ${targets.length} staff and email them now?\n\n${preview}`)) {
          btn.disabled = false;
          return;
        }
        const res = await fetch(`/api/staff-docs/${id}/issue`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        alert(`Issued — ${data.emailed} of ${data.outstanding} recipients emailed.`);
        await load();
      } catch (err) { alert(`Failed: ${err.message}`); btn.disabled = false; }
      return;
    }

    if (act === 'recipients') {
      await toggleRecipients(id, btn.dataset.audience);
      return;
    }

    if (act === 'remind') {
      btn.disabled = true;
      try {
        const res = await fetch(`/api/staff-docs/${id}/remind`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        alert(`Reminders sent: ${data.emailed} of ${data.outstanding} outstanding.`);
      } catch (err) { alert(`Failed: ${err.message}`); }
      btn.disabled = false;
      return;
    }

    if (act === 'archive' || act === 'unarchive') {
      if (act === 'archive' && !confirm('Archive this document? Staff will no longer be asked to sign it. The sign-off history is kept permanently.')) return;
      await fetch(`/api/staff-docs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: act === 'archive' ? 'archived' : 'active' }),
      });
      await load();
      return;
    }

    if (act === 'newver') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf';
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        if (!confirm(`Upload "${file.name}" as a NEW VERSION?\n\nEveryone will need to sign again. No emails are sent automatically — use "Send Reminders" when you're ready to notify staff.`)) return;
        btn.disabled = true;
        try {
          const res = await fetch(`/api/staff-docs/${id}/version`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              mime: file.type || 'application/pdf',
              data_base64: await fileToBase64(file),
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          alert(`Version ${data.version} uploaded. Prior sign-offs are invalidated; hit "Send Reminders" to email staff.`);
          await load();
        } catch (err) { alert(`Failed: ${err.message}`); }
        btn.disabled = false;
      };
      input.click();
    }
  }

  /* ── Recipients picker (audience = selected) ──────────────────── */
  async function toggleRecipients(id, audience) {
    const row = document.querySelector(`.sda-recipients-row[data-for="${id}"]`);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    const cell = row.querySelector('td');
    cell.innerHTML = '<div class="sda-empty">Loading staff…</div>';
    row.style.display = '';
    try {
      const res = await fetch(`/api/staff-docs/${id}/recipients`);
      const emps = await res.json();
      if (!res.ok) throw new Error(emps.error);
      const withEmail = emps.filter(e => e.wms_email).length;
      cell.innerHTML = `
        <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;padding:14px">
          <div style="font-size:0.8rem;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:10px">Who must sign this document</div>
          <div style="display:flex;gap:18px;margin-bottom:12px;font-size:0.9rem;color:#334155">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="sda-aud-${id}" value="all" ${audience !== 'selected' ? 'checked' : ''} style="accent-color:#4f46e5" />
              All active staff (${withEmail} with WMS emails)
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
              <input type="radio" name="sda-aud-${id}" value="selected" ${audience === 'selected' ? 'checked' : ''} style="accent-color:#4f46e5" />
              Only the staff ticked below
            </label>
          </div>
          <div class="sda-rec-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;margin-bottom:12px;${audience !== 'selected' ? 'opacity:0.45;pointer-events:none' : ''}">
            ${emps.map(e => `
              <label style="display:flex;align-items:center;gap:7px;font-size:0.88rem;color:#334155;cursor:pointer">
                <input type="checkbox" class="sda-rec-check" value="${e.id}" ${e.selected ? 'checked' : ''} ${e.wms_email ? '' : 'disabled'} style="accent-color:#4f46e5" />
                ${escHtml(`${e.first_name || ''} ${e.last_name || ''}`.trim())}
                <span style="color:${e.wms_email ? '#94a3b8' : '#dc2626'};font-size:0.76rem">${escHtml(e.wms_email || 'no WMS email — link on Leave Admin')}</span>
              </label>`).join('')}
          </div>
          <button class="sda-mini-btn sda-rec-save" data-id="${id}" style="background:#4f46e5;color:#fff;border-color:#4f46e5">Save Audience</button>
        </div>`;

      // Radio toggles the grid on/off
      cell.querySelectorAll(`input[name="sda-aud-${id}"]`).forEach(radio => {
        radio.addEventListener('change', () => {
          const grid = cell.querySelector('.sda-rec-grid');
          const sel = radio.value === 'selected' && radio.checked;
          grid.style.opacity = sel ? '' : '0.45';
          grid.style.pointerEvents = sel ? '' : 'none';
        });
      });

      cell.querySelector('.sda-rec-save').addEventListener('click', async (ev) => {
        const aud = cell.querySelector(`input[name="sda-aud-${id}"]:checked`).value;
        const ids = [...cell.querySelectorAll('.sda-rec-check:checked')].map(c => Number(c.value));
        if (aud === 'selected' && !ids.length) { alert('Tick at least one staff member, or switch back to All.'); return; }
        ev.target.disabled = true;
        try {
          const r1 = await fetch(`/api/staff-docs/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audience: aud }),
          });
          if (!r1.ok) throw new Error((await r1.json()).error);
          const r2 = await fetch(`/api/staff-docs/${id}/recipients`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employee_ids: aud === 'selected' ? ids : [] }),
          });
          if (!r2.ok) throw new Error((await r2.json()).error);
          row.style.display = 'none';
          await load();
        } catch (err) { alert(`Failed: ${err.message}`); ev.target.disabled = false; }
      });
    } catch (err) {
      cell.innerHTML = `<div class="sda-empty">Failed: ${escHtml(err.message)}</div>`;
    }
  }

  /* ── Create document ──────────────────────────────────────────── */
  document.getElementById('nd-create').addEventListener('click', async () => {
    const title = document.getElementById('nd-title').value.trim();
    const file  = document.getElementById('nd-file').files[0];
    if (!title) { alert('Title required'); return; }
    if (!file)  { alert('Choose a PDF file'); return; }
    const btn = document.getElementById('nd-create');
    btn.disabled = true;
    btn.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/staff-docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: document.getElementById('nd-desc').value.trim() || null,
          recur_days: document.getElementById('nd-recur').value || null,
          allow_decline: document.getElementById('nd-decline').checked,
          audience: document.getElementById('nd-audience').value,
          filename: file.name,
          mime: file.type || 'application/pdf',
          data_base64: await fileToBase64(file),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      document.getElementById('nd-title').value = '';
      document.getElementById('nd-desc').value = '';
      document.getElementById('nd-file').value = '';
      alert(`"${data.title}" uploaded as a DRAFT.\n\nStaff can't see it yet — preview it, email yourself a test, set recipients if needed, then click "Issue & Send" when you're ready.`);
      await load();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Upload as Draft';
    }
  });

  /* ── Register ─────────────────────────────────────────────────── */
  function renderRegister(current, history) {
    const cur = document.getElementById('sda-current');
    if (!current.length) {
      cur.innerHTML = '<tr><td colspan="5" class="sda-empty">Nothing assigned yet.</td></tr>';
    } else {
      current.sort((a, b) => {
        const oa = (a.status === 'pending' || a.status === 'renewal_due') ? 0 : 1;
        const ob = (b.status === 'pending' || b.status === 'renewal_due') ? 0 : 1;
        if (oa !== ob) return oa - ob;
        return String(a.first_name).localeCompare(String(b.first_name));
      });
      cur.innerHTML = current.map(r => {
        const badge = r.status === 'acknowledged' ? '<span class="sda-badge ok">Signed</span>'
          : r.status === 'declined' ? '<span class="sda-badge bad">Declined</span>'
          : r.status === 'renewal_due' ? '<span class="sda-badge warn">Renewal due</span>'
          : '<span class="sda-badge warn">Outstanding</span>';
        return `<tr>
          <td>${escHtml(`${r.first_name || ''} ${r.last_name || ''}`.trim())} <span style="color:#94a3b8;font-size:0.78rem">${escHtml(r.wms_email)}</span></td>
          <td>${escHtml(r.title)}</td>
          <td style="text-align:center">v${r.version_number}</td>
          <td>${badge}</td>
          <td>${r.status === 'acknowledged' || r.status === 'declined' ? fmtD(r.ack_at) : 'due ' + fmtD(r.due_at)}</td>
        </tr>`;
      }).join('');
    }

    const hist = document.getElementById('sda-history');
    hist.innerHTML = history.length
      ? history.map(a => `<tr>
          <td style="white-space:nowrap">${new Date(a.created_at).toLocaleString('en-AU')}</td>
          <td>${escHtml(a.employee_name || a.wms_email)}</td>
          <td>${escHtml(a.document_title || '')}</td>
          <td style="text-align:center">v${a.version_number}</td>
          <td><span class="sda-badge ${a.response === 'acknowledged' ? 'ok' : 'bad'}">${a.response === 'acknowledged' ? 'Signed' : 'Declined'}</span></td>
          <td>${escHtml(a.typed_name)}</td>
          <td style="font-size:0.78rem;color:#94a3b8">${escHtml(a.ip || '')}</td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="sda-empty">No sign-offs recorded yet.</td></tr>';
  }

  /* ── Test email ───────────────────────────────────────────────── */
  document.getElementById('sda-test-email').addEventListener('click', async () => {
    const btn = document.getElementById('sda-test-email');
    btn.disabled = true;
    try {
      const res = await fetch('/api/staff-docs/test-email', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      alert(`Test email sent to ${data.sent_to} — check your inbox.`);
    } catch (err) { alert(`Failed: ${err.message}`); }
    btn.disabled = false;
  });

  load();
})();
