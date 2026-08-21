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
      return `
      <tr data-id="${d.id}" ${d.status === 'archived' ? 'style="opacity:0.5"' : ''}>
        <td>
          <div style="font-weight:600">${escHtml(d.title)}</div>
          <div style="font-size:0.78rem;color:#94a3b8">${escHtml(d.filename || '')}${d.status === 'archived' ? ' · archived' : ''}</div>
        </td>
        <td>${d.recur_days ? `Every ${d.recur_days}d` : 'Once'}${d.allow_decline ? ' · declinable' : ''}</td>
        <td>${d.audience === 'all' ? 'All staff' : 'Selected'}</td>
        <td style="text-align:center">v${d.version_number || '—'}</td>
        <td style="text-align:center"><span class="sda-badge ok">${s.acknowledged}</span></td>
        <td style="text-align:center"><span class="sda-badge ${s.outstanding ? 'warn' : 'grey'}">${s.outstanding}</span></td>
        <td style="text-align:center"><span class="sda-badge ${s.declined ? 'bad' : 'grey'}">${s.declined}</span></td>
        <td style="white-space:nowrap">
          <a class="sda-mini-btn" href="/api/staff-docs/${d.id}/file" target="_blank" style="text-decoration:none">View</a>
          <button class="sda-mini-btn" data-act="newver" data-id="${d.id}">New Version</button>
          <button class="sda-mini-btn" data-act="remind" data-id="${d.id}">Send Reminders</button>
          <button class="sda-mini-btn" data-act="${d.status === 'archived' ? 'unarchive' : 'archive'}" data-id="${d.id}">${d.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
        </td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => handleAction(btn));
    });
  }

  async function handleAction(btn) {
    const id  = btn.dataset.id;
    const act = btn.dataset.act;

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
        if (!confirm(`Upload "${file.name}" as a NEW VERSION? Everyone will need to sign again and will be emailed immediately.`)) return;
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
          alert(`Version ${data.version} issued — sign-off requests are going out.`);
          await load();
        } catch (err) { alert(`Failed: ${err.message}`); }
        btn.disabled = false;
      };
      input.click();
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
      alert(`"${data.title}" uploaded and issued — sign-off emails are going out now.`);
      await load();
    } catch (err) {
      alert(`Failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Upload & Issue';
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
