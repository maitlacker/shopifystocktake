let allRows   = [];
let currentStatus = 'all';
let searchQuery   = '';
let currentUser   = '';

// Fetch logged-in user initials for "reviewed by"
fetch('/api/me').then(r => r.json()).then(u => {
  currentUser = u.displayName || u.email || '';
}).catch(() => {});

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString();
}

function formatRelative(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function diffBadge(d) {
  if (d === 0)  return `<span class="diff-badge diff-ok">✓ 0</span>`;
  if (d > 0)    return `<span class="diff-badge diff-over">+${d}</span>`;
  return              `<span class="diff-badge diff-under">${d}</span>`;
}

// ── Summary ────────────────────────────────────────────────────────
async function loadSummary() {
  try {
    const res  = await fetch('/api/discrepancies/summary');
    const data = await res.json();
    document.getElementById('stat-unreviewed').textContent = data.unreviewed ?? 0;
    document.getElementById('stat-total').textContent      = data.total ?? 0;
    document.getElementById('stat-short').textContent      = data.short ?? 0;
    document.getElementById('stat-over').textContent       = data.over ?? 0;
    document.getElementById('stat-7days').textContent      = data.last7days ?? 0;

    // Highlight unreviewed card if there are items needing attention
    const card = document.querySelector('.disc-stat-card--red');
    if (card) card.classList.toggle('disc-stat-card--alert', Number(data.unreviewed) > 0);
  } catch (err) {
    console.error('Summary load error', err);
  }
}

// ── Table ──────────────────────────────────────────────────────────
async function loadDiscrepancies() {
  const params = new URLSearchParams();
  if (currentStatus !== 'all') params.set('status', currentStatus);
  if (searchQuery)             params.set('q', searchQuery);

  try {
    const res  = await fetch(`/api/discrepancies?${params}`);
    allRows    = await res.json();
    renderTable(allRows);
  } catch (err) {
    document.getElementById('disc-tbody').innerHTML =
      `<tr><td colspan="10" style="color:#b91c1c;padding:16px">Error loading data: ${err.message}</td></tr>`;
  }
}

function renderTable(rows) {
  const tbody    = document.getElementById('disc-tbody');
  const empty    = document.getElementById('disc-empty');
  const btnAll   = document.getElementById('btn-review-all');
  const table    = document.getElementById('disc-table');

  if (rows.length === 0) {
    tbody.innerHTML = '';
    table.style.display = 'none';
    empty.style.display = 'block';
    btnAll.style.display = 'none';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  const hasUnreviewed = rows.some(r => !r.reviewed);
  btnAll.style.display = hasUnreviewed ? '' : 'none';

  tbody.innerHTML = rows.map((r) => {
    const variantLabel = r.variantTitle && r.variantTitle !== 'Default Title'
      ? r.variantTitle : '—';

    const statusCell = r.reviewed
      ? `<span class="disc-badge disc-badge--reviewed" title="Reviewed ${formatDate(r.reviewedAt)} by ${r.reviewedBy}">&#10003; Reviewed</span>`
      : `<span class="disc-badge disc-badge--pending">Needs Review</span>`;

    const actionCell = r.reviewed
      ? `<span class="disc-reviewed-meta">by ${r.reviewedBy || '—'}<br><small>${formatRelative(r.reviewedAt)}</small></span>`
      : `<button class="btn btn-sm btn-secondary btn-review" data-id="${r.id}">Mark Reviewed</button>`;

    return `
      <tr class="${r.reviewed ? 'disc-row--reviewed' : ''}" data-id="${r.id}">
        <td class="disc-product-title">${r.productTitle}</td>
        <td>${variantLabel}</td>
        <td><code>${r.sku || '—'}</code></td>
        <td style="text-align:center">${r.systemQty}</td>
        <td style="text-align:center">${r.countedQty}</td>
        <td style="text-align:center">${diffBadge(r.difference)}</td>
        <td>${r.initials}</td>
        <td title="${formatDate(r.createdAt)}">${formatRelative(r.createdAt)}</td>
        <td>${statusCell}</td>
        <td>${actionCell}</td>
      </tr>`;
  }).join('');

  // Attach review button listeners
  tbody.querySelectorAll('.btn-review').forEach((btn) => {
    btn.addEventListener('click', () => reviewOne(Number(btn.dataset.id)));
  });
}

// ── Review actions ─────────────────────────────────────────────────
async function reviewOne(id) {
  const btn = document.querySelector(`.btn-review[data-id="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const res = await fetch(`/api/discrepancies/${id}/review`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ reviewedBy: currentUser }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    await Promise.all([loadSummary(), loadDiscrepancies()]);
  } catch (err) {
    alert(`Failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = 'Mark Reviewed'; }
  }
}

document.getElementById('btn-review-all').addEventListener('click', async () => {
  const unreviewedIds = allRows.filter(r => !r.reviewed).map(r => r.id);
  if (!unreviewedIds.length) return;
  if (!confirm(`Mark ${unreviewedIds.length} discrepanc${unreviewedIds.length === 1 ? 'y' : 'ies'} as reviewed?`)) return;

  const btn = document.getElementById('btn-review-all');
  btn.disabled = true;
  try {
    await fetch('/api/discrepancies/review-all', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ reviewedBy: currentUser, ids: unreviewedIds }),
    });
    await Promise.all([loadSummary(), loadDiscrepancies()]);
  } catch (err) {
    alert(`Failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ── Filters ────────────────────────────────────────────────────────
document.querySelectorAll('.disc-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.disc-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentStatus = tab.dataset.status;
    loadDiscrepancies();
  });
});

let searchTimeout;
document.getElementById('disc-search').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = e.target.value.trim();
    loadDiscrepancies();
  }, 300);
});

// ── Init ───────────────────────────────────────────────────────────
loadSummary();
loadDiscrepancies();
