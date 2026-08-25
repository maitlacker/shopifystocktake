/* My Documents — staff sign-off page */
(function () {
  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  const STATUS_LABEL = {
    pending: 'Needs your sign-off',
    renewal_due: 'Re-confirmation due',
    acknowledged: 'Signed',
    declined: 'Declined',
    draft_preview: 'Draft — staff can\'t see this yet',
  };

  async function load() {
    try {
      const res = await fetch('/api/staff-docs/mine');
      if (res.status === 401) { window.location.href = '/login'; return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      renderDocs(data.documents || []);
      renderHistory(data.history || []);
    } catch (err) {
      document.getElementById('md-list').innerHTML =
        `<div class="md-empty">Failed to load: ${escHtml(err.message)}</div>`;
    }
  }

  function renderDocs(docs) {
    const wrap = document.getElementById('md-list');
    if (!docs.length) {
      wrap.innerHTML = '<div class="md-card"><div class="md-empty">No documents assigned to you yet.</div></div>';
      return;
    }
    // Outstanding first
    docs.sort((a, b) => {
      const oa = (a.status === 'pending' || a.status === 'renewal_due') ? 0 : 1;
      const ob = (b.status === 'pending' || b.status === 'renewal_due') ? 0 : 1;
      return oa - ob;
    });

    wrap.innerHTML = docs.map(d => {
      if (d.status === 'draft_preview') {
        return `
          <div class="md-card" data-doc="${d.document_id}" style="border-style:dashed">
            <div class="md-doc-head">
              <div>
                <div class="md-doc-title">${escHtml(d.title)}</div>
                <div class="md-doc-meta">Version ${d.version_number} · Admin preview — this is what staff will see once issued.</div>
              </div>
              <span class="md-badge pending">DRAFT PREVIEW</span>
            </div>
            <a class="md-view-btn" href="/api/staff-docs/${d.document_id}/file" target="_blank">📄 Open &amp; Read the Document</a>
            <div class="md-fineprint">Sign-off is disabled on drafts. Issue it from <a href="/staff-docs-admin.html">Staff Documents admin</a> to send it out.</div>
          </div>`;
      }
      const outstanding = d.status === 'pending' || d.status === 'renewal_due';
      const recurNote = d.recur_days
        ? `Re-confirmation required every ${d.recur_days} days.`
        : 'One-off sign-off.';
      const statusNote = d.status === 'acknowledged'
        ? `Signed ${fmtDate(d.last_response_at)}${d.recur_days ? ` · next due ${fmtDate(d.due_at)}` : ''}`
        : d.status === 'declined'
          ? `You declined this on ${fmtDate(d.last_response_at)} — you can change your response below.`
          : recurNote;

      return `
        <div class="md-card ${outstanding ? 'due' : ''}" data-doc="${d.document_id}">
          <div class="md-doc-head">
            <div>
              <div class="md-doc-title">${escHtml(d.title)}</div>
              <div class="md-doc-meta">Version ${d.version_number} · ${statusNote}</div>
            </div>
            <span class="md-badge ${escHtml(d.status)}">${STATUS_LABEL[d.status] || d.status}</span>
          </div>
          <a class="md-view-btn" href="/api/staff-docs/${d.document_id}/file" target="_blank">📄 Open &amp; Read the Document</a>
          ${(outstanding || d.status === 'declined') ? signBox(d) : ''}
        </div>`;
    }).join('');

    wrap.querySelectorAll('.md-sign-submit').forEach(btn => {
      btn.addEventListener('click', () => submitAck(btn, 'acknowledged'));
    });
    wrap.querySelectorAll('.md-sign-decline').forEach(btn => {
      btn.addEventListener('click', () => submitAck(btn, 'declined'));
    });
  }

  function signBox(d) {
    return `
      <div class="md-sign-box">
        <label>
          <input type="checkbox" class="md-agree-check" />
          <span>I confirm I have read and understood <strong>${escHtml(d.title)}</strong> (version ${d.version_number}) in full.</span>
        </label>
        <input type="text" class="md-name-input" maxlength="80" placeholder="Type your full name to sign" autocomplete="name" />
        <div class="md-sign-actions">
          <button class="btn btn-primary md-sign-submit">I Agree — Sign Off</button>
          ${d.allow_decline ? '<button class="btn md-decline-btn md-sign-decline">Decline</button>' : ''}
        </div>
        <div class="md-fineprint">Your sign-off is recorded with your name, login email, the exact document version, date/time and IP address.</div>
      </div>`;
  }

  async function submitAck(btn, response) {
    const card  = btn.closest('.md-card');
    const docId = card.dataset.doc;
    const check = card.querySelector('.md-agree-check');
    const name  = card.querySelector('.md-name-input').value.trim();

    if (response === 'acknowledged' && !check.checked) {
      alert('Please tick the confirmation box first.');
      return;
    }
    if (name.length < 3) {
      alert('Please type your full name to sign.');
      return;
    }
    if (response === 'declined' && !confirm('Record your response as DECLINED for this document?')) return;

    card.querySelectorAll('button').forEach(b => (b.disabled = true));
    try {
      const res = await fetch(`/api/staff-docs/${docId}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response, typed_name: name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      await load();
    } catch (err) {
      alert(`Failed to record: ${err.message}`);
      card.querySelectorAll('button').forEach(b => (b.disabled = false));
    }
  }

  function renderHistory(history) {
    const tbody = document.getElementById('md-history');
    if (!history.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="md-empty">No sign-offs yet.</td></tr>';
      return;
    }
    tbody.innerHTML = history.map(h => `
      <tr>
        <td>${escHtml(h.document_title || '')}</td>
        <td>v${h.version_number}</td>
        <td><span class="md-badge ${escHtml(h.response)}">${h.response === 'acknowledged' ? 'Signed' : 'Declined'}</span></td>
        <td>${escHtml(h.typed_name)}</td>
        <td>${new Date(h.created_at).toLocaleString('en-AU')}</td>
      </tr>`).join('');
  }

  load();
})();
