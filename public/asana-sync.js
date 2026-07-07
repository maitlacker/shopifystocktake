'use strict';

// ── State ─────────────────────────────────────────────────────────────
let meData          = null;
let allTasks        = [];
let customFields    = [];
let selectedProject = null;
let expandedRows    = new Set();
let subtaskCache    = {};
let savedMapping    = {};

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
    await loadMapping();
    renderMapping();
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

// ── Field Mapping ─────────────────────────────────────────────────────

const PO_HEADER_FIELDS = [
  { key: 'po_number',     label: 'PO Number',          req: 'required',       desc: 'Unique identifier for this order' },
  { key: 'supplier_name', label: 'Supplier Name',       req: 'required',       desc: 'Manufacturer / supplier name' },
  { key: 'order_date',    label: 'Order Date',          req: 'default:today',  desc: 'Date the order was placed' },
  { key: 'delivery_date', label: 'Delivery Date',       req: 'optional',       desc: 'Expected arrival date' },
  { key: 'freight_mode',  label: 'Freight Mode',        req: 'default:sea',    desc: '"sea" or "air"' },
  { key: 'currency',      label: 'Currency',            req: 'default:AUD',    desc: 'Currency code — AUD, USD, CNY…' },
  { key: 'exchange_rate', label: 'Exchange Rate',       req: 'default:1.0',    desc: 'Multiplier to AUD (e.g. 0.63)' },
  { key: 'shipping_cost', label: 'Freight Cost',        req: 'default:0',      desc: 'Total freight cost in AUD' },
  { key: 'include_gst',   label: 'Prices incl. GST?',  req: 'default:false',  desc: 'true or false — are unit prices GST-inclusive?' },
  { key: 'notes',         label: 'Notes',               req: 'optional',       desc: 'PO notes / comments' },
];

const PO_LINE_FIELDS = [
  { key: 'product_name', label: 'Product Name',  req: 'required',         desc: 'Full product / style name' },
  { key: 'product_code', label: 'Product Code',  req: 'optional',         desc: 'SKU or internal product code' },
  { key: 'line_type',    label: 'Line Type',     req: 'default:restock',  desc: '"restock" (replenishment) or "new" (new style)' },
  { key: 'unit_price',   label: 'Unit Price',    req: 'default:0',        desc: 'Cost per unit in the PO currency' },
  { key: 'quantities',   label: 'Quantities',    req: 'required',         desc: 'Text parsed to size JSON — e.g. "S:10, M:20, L:15"' },
  { key: 'total_qty',    label: 'Total Qty',     req: 'default:computed', desc: 'Auto-summed from quantities if not mapped' },
];

async function loadMapping() {
  try {
    const res = await fetch('/api/asana/mapping');
    if (res.ok) savedMapping = await res.json();
  } catch {}
}

function buildSourceOptions(selectedVal) {
  const stdOptions = [
    { val: 'std_name',     label: 'Asana: Task name' },
    { val: 'std_notes',    label: 'Asana: Task notes' },
    { val: 'std_due_on',   label: 'Asana: Due date' },
    { val: 'std_start_on', label: 'Asana: Start date' },
    { val: 'std_section',  label: 'Asana: Section name' },
    { val: 'std_assignee', label: 'Asana: Assignee name' },
    { val: 'std_gid',      label: 'Asana: Task GID' },
  ];

  const cfOptions = customFields.map(cfs => {
    const cf = cfs.custom_field || cfs;
    const typeLabel = cf.type ? ` (${cf.type})` : '';
    return { val: `cf_${cf.gid}`, label: `Custom: ${cf.name}${typeLabel}`, gid: cf.gid };
  });

  const sel = v => v === selectedVal ? ' selected' : '';

  let html = `<option value=""${sel('')}>— not mapped / use default —</option>`;
  html += `<option value="fixed"${sel('fixed')}>Fixed value…</option>`;
  html += `<optgroup label="Standard Asana fields">`;
  html += stdOptions.map(o => `<option value="${o.val}"${sel(o.val)}>${escHtml(o.label)}</option>`).join('');
  html += `</optgroup>`;
  if (cfOptions.length) {
    html += `<optgroup label="Custom fields">`;
    html += cfOptions.map(o => `<option value="${o.val}"${sel(o.val)}>${escHtml(o.label)}</option>`).join('');
    html += `</optgroup>`;
  }
  return html;
}

function reqBadgeHtml(req) {
  if (req === 'required') return `<span class="map-req-star">&#9733; Required</span>`;
  if (req === 'optional')  return `<span class="map-req-opt">optional</span>`;
  const dflt = req.replace('default:', '');
  return `<span class="map-req-dflt">default: ${escHtml(dflt)}</span>`;
}

function fieldRowHtml(f, sectionKey) {
  const saved    = (savedMapping[sectionKey] || {})[f.key] || {};
  let sourceVal  = '';
  if (saved.source === 'fixed')    sourceVal = 'fixed';
  else if (saved.source === 'standard') sourceVal = `std_${saved.std_field}`;
  else if (saved.source === 'custom')   sourceVal = `cf_${saved.cf_gid}`;

  const fixedVal     = saved.fixed_value || '';
  const fixedDisplay = saved.source === 'fixed' ? '' : 'display:none';

  return `
    <tr>
      <td>
        <div class="map-field-name">${escHtml(f.key)}</div>
        <div class="map-field-desc">${escHtml(f.desc)}</div>
      </td>
      <td style="white-space:nowrap">${reqBadgeHtml(f.req)}</td>
      <td>
        <div class="map-source-wrap">
          <select class="map-source-sel" data-field="${escHtml(f.key)}" data-section="${escHtml(sectionKey)}">
            ${buildSourceOptions(sourceVal)}
          </select>
          <input type="text" class="map-fixed-val" placeholder="value…" value="${escHtml(fixedVal)}"
            data-field="${escHtml(f.key)}" data-section="${escHtml(sectionKey)}"
            style="${fixedDisplay}">
        </div>
      </td>
    </tr>`;
}

function renderMapping() {
  const section = document.getElementById('as-mapping-section');
  const body    = document.getElementById('as-mapping-body');
  const structure = savedMapping.structure || 'task_per_po';

  const lineNote = structure === 'task_per_po'
    ? '<span style="font-size:0.68rem;font-weight:400;color:#94a3b8;margin-left:6px">mapped from subtasks</span>'
    : '<span style="font-size:0.68rem;font-weight:400;color:#94a3b8;margin-left:6px">mapped from task</span>';

  body.innerHTML = `
    <div class="map-structure">
      <span class="map-struct-lbl">Structure</span>
      <label>
        <input type="radio" name="map-structure" value="task_per_po" ${structure === 'task_per_po' ? 'checked' : ''}>
        One Asana task = one production order &nbsp;<small style="color:#94a3b8">(line items come from subtasks)</small>
      </label>
      <label>
        <input type="radio" name="map-structure" value="task_per_line" ${structure === 'task_per_line' ? 'checked' : ''}>
        One Asana task = one line item &nbsp;<small style="color:#94a3b8">(PO header comes from task custom fields)</small>
      </label>
    </div>

    <div class="map-sub-hdr">Order header fields</div>
    <div class="as-table-wrap">
      <table class="map-table">
        <thead><tr><th>WMS field</th><th>Required?</th><th>Asana source</th></tr></thead>
        <tbody>${PO_HEADER_FIELDS.map(f => fieldRowHtml(f, 'po_fields')).join('')}</tbody>
      </table>
    </div>

    <div class="map-sub-hdr">Line item fields ${lineNote}</div>
    <div class="as-table-wrap">
      <table class="map-table">
        <thead><tr><th>WMS field</th><th>Required?</th><th>Asana source</th></tr></thead>
        <tbody>${PO_LINE_FIELDS.map(f => fieldRowHtml(f, 'line_fields')).join('')}</tbody>
      </table>
    </div>

    <div id="as-map-preview-wrap"></div>

    <div class="map-actions">
      <span id="as-map-saved-msg" class="map-saved-ok" style="display:none">&#10003; Mapping saved</span>
      <button class="as-btn as-btn-secondary" id="as-map-preview-btn">Preview from first task</button>
      <button class="as-btn as-btn-primary" id="as-map-save-btn">Save mapping</button>
    </div>
  `;

  section.style.display = '';

  // Toggle fixed input visibility on source change
  body.querySelectorAll('.map-source-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const wrap = sel.closest('.map-source-wrap');
      const input = wrap.querySelector('.map-fixed-val');
      if (input) input.style.display = sel.value === 'fixed' ? '' : 'none';
    });
  });

  // Structure change → re-render with current selections persisted
  body.querySelectorAll('input[name="map-structure"]').forEach(radio => {
    radio.addEventListener('change', () => {
      savedMapping = collectMapping();
      renderMapping();
    });
  });

  document.getElementById('as-map-save-btn').addEventListener('click', saveMapping);
  document.getElementById('as-map-preview-btn').addEventListener('click', previewMapping);
}

function collectMapping() {
  const structure = document.querySelector('input[name="map-structure"]:checked')?.value || 'task_per_po';
  const result = { structure, po_fields: {}, line_fields: {} };

  document.querySelectorAll('.map-source-sel').forEach(sel => {
    const field   = sel.dataset.field;
    const section = sel.dataset.section;
    const val     = sel.value;
    if (!val || !field || !section) return;

    const wrap     = sel.closest('.map-source-wrap');
    const fixedInp = wrap ? wrap.querySelector('.map-fixed-val') : null;

    if (val === 'fixed') {
      result[section][field] = { source: 'fixed', fixed_value: fixedInp?.value || '' };
    } else if (val.startsWith('std_')) {
      result[section][field] = { source: 'standard', std_field: val.slice(4) };
    } else if (val.startsWith('cf_')) {
      const cfGid = val.slice(3);
      const cfDef = customFields.find(cfs => (cfs.custom_field || cfs).gid === cfGid);
      const cfName = cfDef ? (cfDef.custom_field || cfDef).name : cfGid;
      result[section][field] = { source: 'custom', cf_gid: cfGid, cf_name: cfName };
    }
  });

  return result;
}

async function saveMapping() {
  const config = collectMapping();
  const btn    = document.getElementById('as-map-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch('/api/asana/mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Save failed');
    savedMapping = config;

    const msg = document.getElementById('as-map-saved-msg');
    msg.style.display = '';
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
  } catch (err) {
    alert('Save failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save mapping';
  }
}

function resolveFieldValue(fieldDef, task) {
  if (!fieldDef) return null;
  const { source, std_field, cf_gid, fixed_value } = fieldDef;
  if (source === 'fixed') return fixed_value;
  if (source === 'standard') {
    if (std_field === 'name')     return task.name;
    if (std_field === 'notes')    return task.notes ? (task.notes.slice(0, 80) + (task.notes.length > 80 ? '…' : '')) : null;
    if (std_field === 'due_on')   return task.due_on;
    if (std_field === 'start_on') return task.start_on;
    if (std_field === 'section')  return task.memberships?.[0]?.section?.name;
    if (std_field === 'assignee') return task.assignee?.name;
    if (std_field === 'gid')      return task.gid;
  }
  if (source === 'custom') {
    const cf = (task.custom_fields || []).find(c => c.gid === cf_gid);
    return cf ? cfValue(cf) : null;
  }
  return null;
}

function previewMapping() {
  const config  = collectMapping();
  const wrap    = document.getElementById('as-map-preview-wrap');

  const task = allTasks.find(t => !t.completed) || allTasks[0];
  if (!task) {
    wrap.innerHTML = '<p style="color:#94a3b8;font-size:0.8rem;margin-top:12px">No tasks loaded — load tasks first to preview.</p>';
    return;
  }

  // Line items come from first subtask when task_per_po
  const isPerPo  = config.structure === 'task_per_po';
  const lineTask = isPerPo ? (subtaskCache[task.gid]?.[0] || null) : task;
  const lineNote = isPerPo
    ? (lineTask ? `from subtask: "${escHtml(lineTask.name)}"` : 'no subtasks loaded — expand task first to load subtasks')
    : `from task: "${escHtml(task.name)}"`;

  function previewRows(fields, sectionKey, srcTask) {
    if (!srcTask) return `<div class="map-pv-grid" style="color:#94a3b8;font-size:0.78rem;padding:6px 0">Subtask not loaded — click ▶ Details on a task to cache its subtasks.</div>`;
    const fieldMap = config[sectionKey] || {};
    return `<div class="map-pv-grid">` +
      fields.map(f => {
        const val = resolveFieldValue(fieldMap[f.key], srcTask);
        return `<div class="map-pv-key">${escHtml(f.key)}</div>
                <div class="map-pv-val ${val ? '' : 'empty'}">${val ? escHtml(String(val)) : 'not mapped'}</div>`;
      }).join('') +
    `</div>`;
  }

  wrap.innerHTML = `
    <div class="map-preview-box" style="margin-top:16px">
      <h4>Preview — order header &nbsp;<span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:0.75rem;color:#64748b">from task: "${escHtml(task.name)}"</span></h4>
      ${previewRows(PO_HEADER_FIELDS, 'po_fields', task)}
      <div style="font-size:0.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px">
        Line item &nbsp;<span style="font-weight:400;text-transform:none;letter-spacing:0;color:#94a3b8">${lineNote}</span>
      </div>
      ${previewRows(PO_LINE_FIELDS, 'line_fields', lineTask)}
    </div>`;
}

// ── Event wiring ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('as-load-tasks-btn').addEventListener('click', loadTasks);
  document.getElementById('as-refresh-btn').addEventListener('click', loadTasks);

  document.getElementById('as-search').addEventListener('input', renderTasks);
  document.getElementById('as-hide-done').addEventListener('change', renderTasks);

  init();
});
