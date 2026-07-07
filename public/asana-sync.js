'use strict';

// ── State ─────────────────────────────────────────────────────────────
let meData          = null;
let allTasks        = [];
let customFields    = [];
let selectedProject = null;
let expandedRows    = new Set();
let subtaskCache    = {};

// ── Helpers ───────────────────────────────────────────────────────────
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function isOverdue(dueOn) {
  if (!dueOn) return false;
  return new Date(dueOn) < new Date(new Date().toDateString());
}

function cfValue(cf) {
  if (cf.display_value) return cf.display_value;
  if (cf.text_value)    return cf.text_value;
  if (cf.number_value != null) return String(cf.number_value);
  if (cf.enum_value?.name)     return cf.enum_value.name;
  if (cf.date_value)           return fmtDate(cf.date_value.date || cf.date_value);
  return null;
}

// ── Init — verify Asana token ─────────────────────────────────────────
async function init() {
  const cardsEl = document.getElementById('as-cards');
  cardsEl.innerHTML = `<div class="as-card"><div class="as-card-val" style="font-size:1rem">Connecting…</div><div class="as-card-lbl">Asana API</div></div>`;

  try {
    const res = await fetch('/api/asana/me');
    const json = await res.json();

    if (!res.ok) {
      showConnectError(json.error || 'Unknown error');
      return;
    }

    meData = json;
    renderConnectionCards();
    populateWorkspaces();
    document.getElementById('as-toolbar').style.display = '';
    document.getElementById('as-refresh-btn').style.display = '';

    // Auto-select first workspace and load projects
    const firstWs = meData.workspaces?.[0];
    if (firstWs) {
      document.getElementById('as-workspace-sel').value = firstWs.gid;
      await loadProjects(firstWs.gid);
    }
  } catch (err) {
    showConnectError(err.message);
  }
}

function showConnectError(msg) {
  document.getElementById('as-cards').innerHTML = '';
  const notice = document.getElementById('as-connect-notice');
  notice.className = 'as-notice err';
  notice.style.display = '';

  const isNotSet = msg.includes('ASANA_ACCESS_TOKEN');
  notice.innerHTML = isNotSet
    ? `<div>
        <strong>ASANA_ACCESS_TOKEN not configured.</strong><br>
        Add it to your Railway environment variables:<br>
        1. Go to your Asana profile → <em>My Settings → Apps → Manage Developer Apps → Personal access tokens</em><br>
        2. Create a new token, copy it<br>
        3. Add <code>ASANA_ACCESS_TOKEN=&lt;your-token&gt;</code> to Railway environment variables and redeploy
       </div>`
    : `<div><strong>Asana connection failed:</strong> ${escHtml(msg)}<br>Check that ASANA_ACCESS_TOKEN is valid and not expired.</div>`;
}

function renderConnectionCards() {
  const ws = meData.workspaces || [];
  document.getElementById('as-cards').innerHTML = `
    <div class="as-card ok">
      <div class="as-card-val">Connected</div>
      <div class="as-card-lbl">Asana Status</div>
      <div class="as-card-sub">${escHtml(meData.email || '')}</div>
    </div>
    <div class="as-card">
      <div class="as-card-val">${escHtml(meData.name || '—')}</div>
      <div class="as-card-lbl">Account</div>
      <div class="as-card-sub">Personal Access Token</div>
    </div>
    <div class="as-card">
      <div class="as-card-val">${ws.length}</div>
      <div class="as-card-lbl">Workspace${ws.length !== 1 ? 's' : ''}</div>
      <div class="as-card-sub">${ws.map(w => escHtml(w.name)).join(', ') || '—'}</div>
    </div>
  `;
}

function populateWorkspaces() {
  const sel  = document.getElementById('as-workspace-sel');
  const ws   = meData.workspaces || [];
  sel.innerHTML = ws.map(w => `<option value="${w.gid}">${escHtml(w.name)}</option>`).join('');

  sel.addEventListener('change', async () => {
    document.getElementById('as-project-sel').innerHTML = '<option value="">— loading… —</option>';
    document.getElementById('as-load-tasks-btn').disabled = true;
    await loadProjects(sel.value);
  });
}

async function loadProjects(workspaceGid) {
  const projectSel = document.getElementById('as-project-sel');
  projectSel.innerHTML = '<option value="">— loading projects… —</option>';

  try {
    const res  = await fetch(`/api/asana/projects?workspace=${encodeURIComponent(workspaceGid)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);

    const projects = Array.isArray(json) ? json : [];
    projectSel.innerHTML = '<option value="">— select a project —</option>' +
      projects.map(p => `<option value="${p.gid}">${escHtml(p.name)}</option>`).join('');

    // Auto-select "Orders" project if present
    const autoMatch = projects.find(p =>
      p.name.toLowerCase().includes('orders') && p.name.toLowerCase().includes('production'));
    if (autoMatch) {
      projectSel.value = autoMatch.gid;
      document.getElementById('as-load-tasks-btn').disabled = false;
    }
  } catch (err) {
    projectSel.innerHTML = '<option value="">— error loading projects —</option>';
    console.error('loadProjects error:', err.message);
  }

  // Enable button when a project is selected
  projectSel.addEventListener('change', () => {
    document.getElementById('as-load-tasks-btn').disabled = !projectSel.value;
  });
}

// ── Load tasks ────────────────────────────────────────────────────────
async function loadTasks() {
  const projectGid = document.getElementById('as-project-sel').value;
  if (!projectGid) return;

  const projectName = document.getElementById('as-project-sel').selectedOptions[0]?.text || '';
  selectedProject = { gid: projectGid, name: projectName };

  // Show loading
  document.getElementById('as-tasks-section').style.display  = '';
  document.getElementById('as-tasks-loading').style.display  = '';
  document.getElementById('as-schema-section').style.display = 'none';
  document.getElementById('as-search-wrap').style.display    = 'none';
  document.getElementById('as-tbody').innerHTML = '';
  expandedRows.clear();
  subtaskCache = {};

  try {
    const res  = await fetch(`/api/asana/tasks?project=${encodeURIComponent(projectGid)}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);

    allTasks     = json.tasks || [];
    customFields = json.customFieldSettings || [];

    document.getElementById('as-tasks-loading').style.display = 'none';
    document.getElementById('as-task-sub').textContent = `from "${projectName}"`;
    document.getElementById('as-search-wrap').style.display = '';

    renderSchema();
    renderTasks();
  } catch (err) {
    document.getElementById('as-tasks-loading').style.display = 'none';
    document.getElementById('as-tbody').innerHTML =
      `<tr><td colspan="8" style="color:#dc2626;padding:20px">Error loading tasks: ${escHtml(err.message)}</td></tr>`;
  }
}

// ── Schema panel ──────────────────────────────────────────────────────
function renderSchema() {
  const section = document.getElementById('as-schema-section');
  const grid    = document.getElementById('as-schema-grid');

  if (!customFields.length) { section.style.display = 'none'; return; }

  grid.innerHTML = customFields.map(cfs => {
    const cf   = cfs.custom_field || cfs;
    const opts = cf.enum_options?.map(o => escHtml(o.name)).join(', ') || '';
    return `
      <div class="as-schema-item">
        <div class="as-schema-name">${escHtml(cf.name)}
          <span class="as-schema-type">${escHtml(cf.type || '')}</span>
        </div>
        ${opts ? `<div class="as-schema-opts">Options: ${opts}</div>` : ''}
      </div>`;
  }).join('');

  section.style.display = '';
}

// ── Task table ────────────────────────────────────────────────────────
function renderTasks() {
  const hideDone = document.getElementById('as-hide-done').checked;
  const search   = (document.getElementById('as-search').value || '').toLowerCase();

  const filtered = allTasks.filter(t => {
    if (hideDone && t.completed) return false;
    if (search) {
      const haystack = [
        t.name,
        t.assignee?.name,
        t.memberships?.[0]?.section?.name,
        ...(t.custom_fields || []).map(cf => cfValue(cf) || ''),
      ].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  document.getElementById('as-task-count').textContent = `${filtered.length} / ${allTasks.length}`;

  const tbody = document.getElementById('as-tbody');
  tbody.innerHTML = filtered.map(task => renderTaskRow(task)).join('');

  // Re-render any expanded rows
  filtered.forEach(task => {
    if (expandedRows.has(task.gid)) {
      const row = tbody.querySelector(`[data-expand="${task.gid}"]`);
      if (row) renderExpandRow(task, row);
    }
  });

  // Attach expand handlers
  tbody.querySelectorAll('.as-expand-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid  = btn.dataset.gid;
      const task = allTasks.find(t => t.gid === gid);
      if (!task) return;

      const expandRow = tbody.querySelector(`[data-expand="${gid}"]`);
      if (!expandRow) return;

      if (expandedRows.has(gid)) {
        expandedRows.delete(gid);
        expandRow.style.display = 'none';
        btn.textContent = '▶ Details';
      } else {
        expandedRows.add(gid);
        await renderExpandRow(task, expandRow);
        expandRow.style.display = '';
        btn.textContent = '▼ Hide';
      }
    });
  });
}

function renderTaskRow(task) {
  const section   = task.memberships?.[0]?.section?.name || '—';
  const due       = task.due_on;
  const overdue   = !task.completed && isOverdue(due);
  const dueCls    = task.completed ? 'done' : overdue ? 'over' : 'open';
  const statusCls = task.completed ? 'done' : overdue ? 'over' : 'open';
  const statusLbl = task.completed ? '✓ Done' : overdue ? '⚠ Overdue' : 'Open';

  // Top 3 non-empty custom fields for preview
  const cfPreview = (task.custom_fields || [])
    .filter(cf => cfValue(cf))
    .slice(0, 3)
    .map(cf => `<span style="display:inline-block;margin:1px 2px"><em style="color:#94a3b8;font-size:0.65rem">${escHtml(cf.name)}:</em> ${escHtml(cfValue(cf))}</span>`)
    .join(' &nbsp;');

  const isExpanded = expandedRows.has(task.gid);

  return `
    <tr data-gid="${task.gid}">
      <td><button class="as-expand-btn" data-gid="${task.gid}">${isExpanded ? '▼ Hide' : '▶ Details'}</button></td>
      <td>
        <div class="as-task-name" style="${task.completed ? 'text-decoration:line-through;color:#94a3b8' : ''}">${escHtml(task.name)}</div>
        ${task.tags?.length ? `<div class="as-task-sub">${task.tags.map(t => `<span class="as-chip">${escHtml(t.name)}</span>`).join('')}</div>` : ''}
      </td>
      <td style="color:#64748b;font-size:0.78rem">${escHtml(section)}</td>
      <td><span class="as-chip ${statusCls}">${statusLbl}</span></td>
      <td style="font-size:0.78rem;white-space:nowrap" class="${overdue ? 'fc-neg' : ''}">${fmtDate(due)}</td>
      <td style="font-size:0.78rem">${escHtml(task.assignee?.name || '—')}</td>
      <td style="font-size:0.78rem;color:#64748b">${task.num_subtasks > 0 ? `${task.num_subtasks} subtask${task.num_subtasks !== 1 ? 's' : ''}` : '—'}</td>
      <td style="font-size:0.75rem;color:#475569">${cfPreview || '<span style="color:#cbd5e1">—</span>'}</td>
    </tr>
    <tr data-expand="${task.gid}" class="as-expand-row" style="display:${isExpanded ? '' : 'none'}">
      <td colspan="8"><div class="as-expand-inner" id="expand-inner-${task.gid}">
        <div class="as-spinner" style="width:20px;height:20px;margin:8px auto"></div>
      </div></td>
    </tr>`;
}

async function renderExpandRow(task, expandRow) {
  const inner = expandRow.querySelector(`#expand-inner-${task.gid}`);
  if (!inner) return;

  // Fetch subtasks if needed and task has them
  if (task.num_subtasks > 0 && !subtaskCache[task.gid]) {
    try {
      const res  = await fetch(`/api/asana/subtasks?task=${encodeURIComponent(task.gid)}`);
      const json = await res.json();
      subtaskCache[task.gid] = res.ok ? (Array.isArray(json) ? json : []) : [];
    } catch {
      subtaskCache[task.gid] = [];
    }
  }

  const subtasks = subtaskCache[task.gid] || [];
  const cfs      = task.custom_fields || [];

  // All custom fields
  const cfHtml = cfs.length
    ? `<div class="as-cf-grid">
        ${cfs.map(cf => {
          const val = cfValue(cf);
          return `<div class="as-cf-item">
            <div class="as-cf-name">${escHtml(cf.name)}</div>
            <div class="as-cf-val ${val ? '' : 'empty'}">${val ? escHtml(val) : 'not set'}</div>
          </div>`;
        }).join('')}
       </div>`
    : '<p style="color:#94a3b8;font-size:0.8rem">No custom fields</p>';

  // Subtasks
  const subtaskHtml = subtasks.length
    ? `<div class="as-subtask-list">
        <div class="as-subtask-hdr">Subtasks (${subtasks.length})</div>
        ${subtasks.map(st => {
          const stCfs = (st.custom_fields || []).filter(cf => cfValue(cf));
          return `<div class="as-subtask-row">
            <span class="as-subtask-name ${st.completed ? 'done' : ''}">${escHtml(st.name)}</span>
            ${st.due_on ? `<span style="font-size:0.72rem;color:#64748b;white-space:nowrap">${fmtDate(st.due_on)}</span>` : ''}
            ${stCfs.map(cf => `<span style="font-size:0.72rem"><em style="color:#94a3b8">${escHtml(cf.name)}:</em> ${escHtml(cfValue(cf))}</span>`).join('')}
          </div>`;
        }).join('')}
       </div>`
    : '';

  // Notes
  const notesHtml = task.notes
    ? `<div class="as-notes-lbl">Notes / Description</div>
       <div class="as-notes-body">${escHtml(task.notes)}</div>`
    : '';

  // Meta row
  const metaHtml = `<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:0.74rem;color:#94a3b8;margin-bottom:10px">
    <span>GID: <strong style="color:#475569">${escHtml(task.gid)}</strong></span>
    <span>Created: <strong style="color:#475569">${fmtDate(task.created_at)}</strong></span>
    <span>Modified: <strong style="color:#475569">${fmtDate(task.modified_at)}</strong></span>
    ${task.completed_at ? `<span>Completed: <strong style="color:#16a34a">${fmtDate(task.completed_at)}</strong></span>` : ''}
  </div>`;

  inner.innerHTML = `
    ${metaHtml}
    <div style="font-size:0.78rem;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Custom Fields</div>
    ${cfHtml}
    ${subtaskHtml}
    ${notesHtml}
  `;
}

// ── Event wiring ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('as-load-tasks-btn').addEventListener('click', loadTasks);
  document.getElementById('as-refresh-btn').addEventListener('click', loadTasks);

  document.getElementById('as-search').addEventListener('input', renderTasks);
  document.getElementById('as-hide-done').addEventListener('change', renderTasks);

  init();
});
