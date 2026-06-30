(() => {
  let currentFilter = '';
  let jobs = [];
  let pollTimer = null;

  const container   = document.getElementById('jobsContainer');
  const filterBtns  = document.getElementById('filterBtns');
  const btnRefresh  = document.getElementById('btnRefresh');
  const refreshInfo = document.getElementById('refreshInfo');
  const statusBar   = document.getElementById('statusBar');

  // ── Filter buttons ─────────────────────────────────────────────────
  filterBtns.addEventListener('click', e => {
    const btn = e.target.closest('.cr-filter-btn');
    if (!btn) return;
    filterBtns.querySelectorAll('.cr-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.status;
    loadJobs();
  });

  btnRefresh.addEventListener('click', loadJobs);

  // ── Load jobs ──────────────────────────────────────────────────────
  async function loadJobs() {
    container.innerHTML = '<div class="cr-loading">Loading…</div>';
    try {
      const qs  = currentFilter ? `?status=${encodeURIComponent(currentFilter)}` : '';
      const res = await fetch(`/api/creative/jobs${qs}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Load failed');
      jobs = data.jobs || [];
      refreshInfo.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      renderJobs();
      scheduleAutoRefresh();
    } catch (err) {
      container.innerHTML = `<div class="cr-empty"><div class="cr-empty-icon">⚠️</div><div class="cr-empty-text">Error: ${escHtml(err.message)}</div></div>`;
    }
  }

  // Auto-refresh if any jobs are still generating
  function scheduleAutoRefresh() {
    clearTimeout(pollTimer);
    const hasActive = jobs.some(j => j.status === 'generating' || j.status === 'queued');
    if (hasActive) {
      pollTimer = setTimeout(loadJobs, 30_000); // re-check in 30s
    }
  }

  // ── Render all jobs ────────────────────────────────────────────────
  function renderJobs() {
    if (!jobs.length) {
      container.innerHTML = `
        <div class="cr-empty">
          <div class="cr-empty-icon">🎬</div>
          <div class="cr-empty-text">No jobs found${currentFilter ? ` with status "${currentFilter}"` : ''}</div>
        </div>`;
      return;
    }
    container.innerHTML = `<div class="cr-job-grid">${jobs.map(jobCard).join('')}</div>`;

    // Bind action buttons
    container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => handleAction(btn.dataset.action, Number(btn.dataset.id)));
    });

    // Brief toggles
    container.querySelectorAll('.cr-brief-toggle').forEach(toggle => {
      toggle.addEventListener('click', () => {
        const body = toggle.nextElementSibling;
        const open = body.classList.toggle('open');
        toggle.textContent = open ? '▲ Hide brief' : '▼ Show brief';
      });
    });
  }

  // ── Build a job card ───────────────────────────────────────────────
  function jobCard(job) {
    const brief       = job.brief || {};
    const products    = brief.products || (brief.product ? [brief.product] : []);
    const title       = products.map(p => p.title || p.shopify_product_id || '?').join(' + ') || `Job #${job.id}`;
    const templateLbl = templateLabel(job.template_type);
    const createdAt   = new Date(job.created_at).toLocaleString();
    const resultUrls  = Array.isArray(job.result_urls) ? job.result_urls : [];

    return `
      <div class="cr-job-card" id="job-${job.id}">
        <div class="cr-job-header">
          <div class="cr-job-title" title="${escHtml(title)}">${escHtml(truncate(title, 48))}</div>
          <div class="cr-status-pill ${job.status}">${job.status}</div>
        </div>

        <div class="cr-job-meta">
          <span>🎬 ${escHtml(templateLbl)}</span>
          <span>📦 ${job.job_type}</span>
          <span>🕐 ${createdAt}</span>
          ${job.created_by ? `<span>👤 ${escHtml(job.created_by)}</span>` : ''}
          ${job.arcads_job_id ? `<span style="color:#6366f1">ID: ${escHtml(job.arcads_job_id)}</span>` : ''}
        </div>

        <div class="cr-job-preview">
          ${previewHtml(job, resultUrls)}
          ${job.error_message ? `<div style="font-size:0.75rem;color:#b91c1c;margin-top:6px;">⚠ ${escHtml(job.error_message)}</div>` : ''}
          <span class="cr-brief-toggle">▼ Show brief</span>
          <div class="cr-brief-body">${escHtml(JSON.stringify(brief, null, 2))}</div>
        </div>

        <div class="cr-job-actions">
          ${actionButtons(job, resultUrls)}
        </div>
      </div>`;
  }

  function previewHtml(job, resultUrls) {
    if (!resultUrls.length) {
      const icons = { queued: '⏳', generating: '⚙️', error: '⚠️' };
      const msgs  = { queued: 'Waiting to generate', generating: 'Generating with Arcads…', error: 'Generation failed' };
      return `
        <div class="cr-no-preview">
          <div class="cr-no-preview-icon">${icons[job.status] || '🎞️'}</div>
          <div class="cr-no-preview-text">${msgs[job.status] || 'No preview yet'}</div>
        </div>`;
    }
    if (resultUrls.length === 1) {
      const url = resultUrls[0];
      if (isVideo(url)) {
        return `<div class="cr-video-wrap"><video src="${escHtml(url)}" controls playsinline></video></div>`;
      }
      return `<div class="cr-video-wrap"><img src="${escHtml(url)}" alt="Creative" /></div>`;
    }
    // Multiple assets
    return `<div class="cr-multi-preview">${resultUrls.map(url =>
      isVideo(url)
        ? `<a href="${escHtml(url)}" target="_blank" rel="noopener">🎬 Video</a>`
        : `<a href="${escHtml(url)}" target="_blank" rel="noopener"><img src="${escHtml(url)}" alt="" /></a>`
    ).join('')}</div>`;
  }

  function actionButtons(job, resultUrls) {
    const btns = [];
    if (job.status === 'ready' || job.status === 'generating') {
      btns.push(`<button class="cr-action-btn approve" data-action="approve" data-id="${job.id}">✓ Approve</button>`);
      btns.push(`<button class="cr-action-btn reject"  data-action="reject"  data-id="${job.id}">✗ Reject</button>`);
    }
    if (job.status === 'approved') {
      btns.push(`<button class="cr-action-btn archive" data-action="archive" data-id="${job.id}">Archive</button>`);
    }
    if (job.status === 'rejected' || job.status === 'error') {
      btns.push(`<button class="cr-action-btn retry"  data-action="retry"  data-id="${job.id}">Retry</button>`);
    }
    if (resultUrls.length) {
      resultUrls.forEach((url, i) => {
        btns.push(`<a class="cr-action-btn download" href="${escHtml(url)}" download target="_blank" rel="noopener">⬇ ${resultUrls.length > 1 ? `Asset ${i+1}` : 'Download'}</a>`);
      });
    }
    if (!['generating'].includes(job.status)) {
      btns.push(`<button class="cr-action-btn delete" data-action="delete" data-id="${job.id}">Delete</button>`);
    }
    return btns.join('');
  }

  // ── Action handler ────────────────────────────────────────────────
  async function handleAction(action, id) {
    if (action === 'delete') {
      if (!confirm('Delete this job permanently?')) return;
    }
    try {
      let res, data;
      if (action === 'delete') {
        res  = await fetch(`/api/creative/jobs/${id}`, { method: 'DELETE' });
        data = await res.json();
        if (!res.ok) throw new Error(data.error);
        jobs = jobs.filter(j => j.id !== id);
        renderJobs();
        showStatus('Job deleted', 'success');
        return;
      }
      const statusMap = { approve: 'approved', reject: 'rejected', archive: 'archived', retry: 'queued' };
      const newStatus = statusMap[action];
      res  = await fetch(`/api/creative/jobs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const idx = jobs.findIndex(j => j.id === id);
      if (idx !== -1) jobs[idx] = data.job;
      renderJobs();
      showStatus(`Job ${newStatus}`, 'success');
    } catch (err) {
      showStatus(`Action failed: ${err.message}`, 'error');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function templateLabel(id) {
    const map = {
      new_arrival:        'New Arrival Drop',
      three_ways_to_style:'3 Ways to Style',
      low_stock_urgency:  'Low Stock Urgency',
      founder_ugc:        'Founder UGC',
      outfit_transform:   'Outfit Transformation',
      sale_event:         'Sale Event',
      product_showcase:   'Product Showcase',
    };
    return map[id] || id || 'Unknown';
  }

  function isVideo(url) {
    return /\.(mp4|mov|webm|avi)(\?|$)/i.test(url);
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showStatus(msg, type) {
    statusBar.innerHTML = msg;
    statusBar.className = `cr-status-bar ${type}`;
    setTimeout(() => { statusBar.className = 'cr-status-bar'; }, 4000);
  }

  // ── Init ──────────────────────────────────────────────────────────
  loadJobs();
})();
