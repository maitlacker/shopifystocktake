// leave-sync.js — Xero AU Payroll leave management + Monday Slack digest
'use strict';

const fetch    = require('node-fetch');
const cron     = require('node-cron');
const xeroSync = require('./xero-sync');

const PAYROLL_API        = 'https://api.xero.com/payroll.xro/1.0';
const SLACK_WEBHOOK_URL  = process.env.SLACK_WEBHOOK_URL || '';
const ANNUAL_LEAVE_CRON  = process.env.LEAVE_SLACK_CRON || '0 22 * * 0'; // 8am Mon AEST

// Cache the Annual Leave type ID to avoid fetching every time
let _annualLeaveTypeId = null;

// ── Payroll API helpers ────────────────────────────────────────────
async function payrollGet(path) {
  const token    = await xeroSync.getValidAccessToken();
  const tenantId = await xeroSync.getTenantId();
  if (!tenantId) throw new Error('Xero not connected');

  const res = await fetch(`${PAYROLL_API}${path}`, {
    headers: {
      Authorization:    `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      Accept:           'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xero Payroll GET ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function payrollPost(path, body) {
  const token    = await xeroSync.getValidAccessToken();
  const tenantId = await xeroSync.getTenantId();
  if (!tenantId) throw new Error('Xero not connected');

  const res = await fetch(`${PAYROLL_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization:    `Bearer ${token}`,
      'Xero-Tenant-Id': tenantId,
      'Content-Type':   'application/json',
      Accept:           'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Xero Payroll POST ${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Convert a YYYY-MM-DD string to the Xero /Date(ms)/ format (midnight UTC)
function toXeroDate(dateStr) {
  const ms = new Date(dateStr + 'T00:00:00Z').getTime();
  return `/Date(${ms}+0000)/`;
}

// ── Leave types ────────────────────────────────────────────────────
async function getAnnualLeaveTypeId() {
  if (_annualLeaveTypeId) return _annualLeaveTypeId;
  // AU Payroll: leave types are nested inside PayItems, not a top-level endpoint
  const data  = await payrollGet('/PayItems');
  const types = (data.PayItems && data.PayItems.LeaveTypes) || [];
  const annual = types.find(t =>
    (t.Name || '').toLowerCase().includes('annual') ||
    (t.Name || '').toLowerCase().includes('holiday')
  );
  if (!annual) throw new Error(`No "Annual Leave" type found in Xero PayItems — found: ${types.map(t => t.Name).join(', ')}`);
  _annualLeaveTypeId = annual.LeaveTypeID;
  console.log(`[leave] Annual Leave type ID: ${_annualLeaveTypeId} ("${annual.Name}")`);
  return _annualLeaveTypeId;
}

// ── Sync employees from Xero ───────────────────────────────────────
async function syncEmployees(pool) {
  const data = await payrollGet('/Employees');
  const employees = data.Employees || [];
  let synced = 0;

  for (const emp of employees) {
    const isActive = emp.Status === 'ACTIVE';
    await pool.query(
      `INSERT INTO leave_employees
         (xero_employee_id, first_name, last_name, xero_email, is_active, synced_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (xero_employee_id) DO UPDATE SET
         first_name=$2, last_name=$3, xero_email=$4, is_active=$5, synced_at=NOW()`,
      [
        emp.EmployeeID,
        emp.FirstName  || '',
        emp.LastName   || '',
        emp.Email      || null,
        isActive,
      ]
    );
    synced++;
  }
  console.log(`[leave] Synced ${synced} employees from Xero`);
  return synced;
}

// ── Create leave application in Xero ──────────────────────────────
async function createLeaveInXero(pool, requestId) {
  const { rows } = await pool.query(
    `SELECT lr.*, le.xero_employee_id
     FROM leave_requests lr
     JOIN leave_employees le ON le.id = lr.employee_id
     WHERE lr.id = $1`,
    [requestId]
  );
  if (!rows.length) throw new Error(`Leave request ${requestId} not found`);
  const req = rows[0];

  if (!req.xero_employee_id) throw new Error('Employee not linked to a Xero account');

  const leaveTypeId = await getAnnualLeaveTypeId();

  const payload = [{
    EmployeeID:  req.xero_employee_id,
    LeaveTypeID: leaveTypeId,
    StartDate:   toXeroDate(req.start_date.toISOString().slice(0, 10)),
    EndDate:     toXeroDate(req.end_date.toISOString().slice(0, 10)),
    Description: req.notes || 'Annual Leave',
  }];

  const result = await payrollPost('/LeaveApplications', payload);
  const created = (result.LeaveApplications || [])[0];
  if (!created || !created.LeaveApplicationID) {
    throw new Error('Xero did not return a LeaveApplicationID');
  }

  await pool.query(
    `UPDATE leave_requests SET xero_leave_id=$1, xero_status='created', xero_error=NULL, updated_at=NOW() WHERE id=$2`,
    [created.LeaveApplicationID, requestId]
  );
  console.log(`[leave] Created Xero leave application ${created.LeaveApplicationID} for request ${requestId}`);
  return created.LeaveApplicationID;
}

// ── Import leave applications from Xero ───────────────────────────
function fromXeroDate(xeroDate) {
  if (!xeroDate) return null;
  const match = String(xeroDate).match(/\/Date\((-?\d+)/);
  return match ? new Date(parseInt(match[1])) : null;
}

function toDateStr(d) {
  return d ? d.toISOString().slice(0, 10) : null;
}

async function importLeaveFromXero(pool) {
  // Fetch all leave applications from Xero (no date filter — get everything)
  const data  = await payrollGet('/LeaveApplications');
  const apps  = data.LeaveApplications || [];
  console.log(`[leave] Xero returned ${apps.length} leave application(s)`);

  let imported = 0, skipped = 0, unmatched = 0;

  for (const app of apps) {
    const xeroLeaveId = app.LeaveApplicationID;
    const startDate   = toDateStr(fromXeroDate(app.StartDate));
    const endDate     = toDateStr(fromXeroDate(app.EndDate));

    if (!xeroLeaveId || !startDate || !endDate) { skipped++; continue; }

    // Skip if already imported
    const { rows: existing } = await pool.query(
      `SELECT id FROM leave_requests WHERE xero_leave_id=$1`, [xeroLeaveId]
    );
    if (existing.length) { skipped++; continue; }

    // Match to our employee record
    const { rows: empRows } = await pool.query(
      `SELECT id, wms_email FROM leave_employees WHERE xero_employee_id=$1`, [app.EmployeeID]
    );
    if (!empRows.length) { unmatched++; continue; }
    const emp = empRows[0];

    // Use wms_email if linked, otherwise fall back to xero_employee_id as placeholder
    const wmsEmail = emp.wms_email || `xero:${app.EmployeeID}`;

    const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;

    await pool.query(
      `INSERT INTO leave_requests
         (employee_id, wms_email, start_date, end_date, days_count, notes,
          status, approved_by, approved_at, xero_leave_id, xero_status)
       VALUES ($1,$2,$3,$4,$5,$6,'approved','xero-import',NOW(),$7,'created')`,
      [
        emp.id,
        wmsEmail,
        startDate,
        endDate,
        days,
        app.Description || null,
        xeroLeaveId,
      ]
    );
    imported++;
  }

  console.log(`[leave] Import complete — imported: ${imported}, skipped: ${skipped}, unmatched employees: ${unmatched}`);
  return { imported, skipped, unmatched };
}

// ── Upcoming leave lookup ──────────────────────────────────────────
async function getUpcomingLeave(pool, fromDate, toDate) {
  const { rows } = await pool.query(
    `SELECT lr.*, le.first_name, le.last_name
     FROM leave_requests lr
     JOIN leave_employees le ON le.id = lr.employee_id
     WHERE lr.status = 'approved'
       AND lr.end_date >= $1
       AND lr.start_date <= $2
     ORDER BY lr.start_date`,
    [fromDate, toDate]
  );
  return rows;
}

// ── Monday Slack digest ────────────────────────────────────────────
function formatDate(d) {
  return new Date(d).toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Australia/Sydney',
  });
}

function countDays(start, end) {
  const ms = new Date(end) - new Date(start);
  return Math.round(ms / 86400000) + 1;
}

async function buildSlackMessage(pool) {
  const today = new Date();
  // Next Monday from today (or today if it is Monday)
  const day = today.getDay();
  const daysToMon = day === 1 ? 0 : (8 - day) % 7;
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() + daysToMon);
  const toDate = new Date(fromDate);
  toDate.setDate(fromDate.getDate() + 13); // 2 weeks

  const fmt = d => d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const leaves = await getUpcomingLeave(pool,
    fromDate.toISOString().slice(0, 10),
    toDate.toISOString().slice(0, 10)
  );

  const header = `📅 *Annual Leave — ${fmt(fromDate)} to ${fmt(toDate)}*`;

  if (!leaves.length) {
    return `${header}\n\n_No annual leave scheduled in the next 2 weeks_ ✅`;
  }

  const lines = leaves.map(l => {
    const start   = formatDate(l.start_date);
    const end     = formatDate(l.end_date);
    const days    = l.days_count || countDays(l.start_date, l.end_date);
    const name    = `${l.first_name} ${l.last_name}`.trim();
    const dateStr = start === end ? start : `${start} – ${end}`;
    return `• *${name}* — ${dateStr} _(${days} day${days !== 1 ? 's' : ''})_`;
  });

  const count = leaves.length;
  const footer = `_${count} team member${count !== 1 ? 's' : ''} on leave this fortnight_`;

  return `${header}\n\n${lines.join('\n')}\n\n${footer}`;
}

async function postWeeklySlackDigest(pool) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('[leave] SLACK_WEBHOOK_URL not set — skipping weekly digest');
    return;
  }
  const text = await buildSlackMessage(pool);
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
  console.log('[leave] Weekly Slack digest posted');
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(pool) {
  // Monday 8am AEST (22:00 Sunday UTC) by default
  cron.schedule(ANNUAL_LEAVE_CRON, async () => {
    try {
      await postWeeklySlackDigest(pool);
    } catch (err) {
      console.error('[leave] Slack digest error:', err.message);
    }
  });
  console.log(`[leave] Weekly Slack digest cron: ${ANNUAL_LEAVE_CRON}`);
}

module.exports = {
  startCron,
  syncEmployees,
  importLeaveFromXero,
  createLeaveInXero,
  getUpcomingLeave,
  buildSlackMessage,
  postWeeklySlackDigest,
};
