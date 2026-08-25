'use strict';

// ── Staff Documents — sign-off tracking engine ─────────────────────
// Computes who owes a sign-off on which document version, sends individual
// email prompts with links back to the WMS, and re-issues documents when a
// new version is uploaded or a recurring cadence lapses.

const cron   = require('node-cron');
const mailer = require('./email');

let pool;

const APP_URL     = (process.env.APP_URL || '').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.DOCS_ADMIN_EMAIL || 'accounts@theselfstyler.com';
const REMIND_EVERY_DAYS = 3;   // don't nag the same person about the same doc more often

// ── Due computation ─────────────────────────────────────────────────
// For every active document × audience employee: pending when there is no
// acknowledgment for the CURRENT version, or (recurring docs) the latest
// acknowledgment is older than recur_days.
async function computeDueList() {
  const { rows } = await pool.query(`
    SELECT d.id AS document_id, d.title, d.recur_days, d.allow_decline,
           d.current_version_id, v.version_number, v.created_at AS version_created_at,
           e.id AS employee_id, e.first_name, e.last_name, e.wms_email,
           a.id AS ack_id, a.response AS ack_response, a.created_at AS ack_at
    FROM staff_documents d
    JOIN staff_document_versions v ON v.id = d.current_version_id
    JOIN leave_employees e
      ON e.is_active = TRUE AND e.wms_email IS NOT NULL
     AND (d.audience = 'all' OR EXISTS (
           SELECT 1 FROM staff_document_recipients r
           WHERE r.document_id = d.id AND r.employee_id = e.id))
    LEFT JOIN LATERAL (
      SELECT id, response, created_at FROM staff_document_acks a2
      WHERE a2.document_id = d.id AND a2.version_id = d.current_version_id
        AND LOWER(a2.wms_email) = LOWER(e.wms_email)
      ORDER BY a2.created_at DESC LIMIT 1
    ) a ON TRUE
    WHERE d.status = 'active'
  `);

  const now = Date.now();
  return rows.map(r => {
    let status = 'pending';
    let dueAt  = r.version_created_at;
    if (r.ack_id) {
      status = r.ack_response;   // acknowledged | declined
      if (r.recur_days && r.ack_response === 'acknowledged') {
        const nextDue = new Date(r.ack_at).getTime() + r.recur_days * 86400000;
        dueAt = new Date(nextDue);
        if (now >= nextDue) status = 'renewal_due';
      }
    }
    return { ...r, status, due_at: dueAt };
  });
}

function isOutstanding(row) {
  return row.status === 'pending' || row.status === 'renewal_due';
}

// ── Emails ──────────────────────────────────────────────────────────
async function recentlyEmailed(documentId, email, type, days) {
  const { rows } = await pool.query(
    `SELECT 1 FROM staff_document_email_log
     WHERE document_id=$1 AND LOWER(wms_email)=LOWER($2) AND email_type=$3
       AND sent_at > NOW() - ($4::int || ' days')::interval
     LIMIT 1`,
    [documentId, email, type, days]
  );
  return rows.length > 0;
}

async function logEmail(documentId, email, type) {
  await pool.query(
    `INSERT INTO staff_document_email_log (document_id, wms_email, email_type) VALUES ($1,$2,$3)`,
    [documentId, email, type]
  );
}

async function sendDuePrompt(row, emailType) {
  const firstName = row.first_name || 'there';
  const isRenewal = row.status === 'renewal_due';
  const heading = isRenewal
    ? `Time to re-confirm: ${row.title}`
    : `Action required: ${row.title}`;
  const body = isRenewal
    ? `<p>Hi ${firstName},</p><p>It's time for your regular re-confirmation of <strong>${row.title}</strong> (version ${row.version_number}). Please read it again and sign off in the WMS — it only takes a minute.</p>`
    : `<p>Hi ${firstName},</p><p><strong>${row.title}</strong> (version ${row.version_number}) needs your review and sign-off. Please read the document and record your response in the WMS.</p>`;
  const ok = await mailer.sendMail({
    to: row.wms_email,
    subject: heading,
    html: mailer.template({
      heading,
      bodyHtml: body,
      buttonText: 'Review & Sign Off',
      buttonUrl: `${APP_URL}/my-documents.html`,
    }),
  });
  if (ok) await logEmail(row.document_id, row.wms_email, emailType);
  return ok;
}

// Preview email — sent only to the admin, never logged against staff
async function sendTestPrompt(doc, toEmail) {
  const heading = `Action required: ${doc.title}`;
  return mailer.sendMail({
    to: toEmail,
    subject: `[TEST] ${heading}`,
    html: mailer.template({
      heading,
      bodyHtml: `<p>Hi there,</p><p><strong>${doc.title}</strong> (version ${doc.version_number}) needs your review and sign-off. Please read the document and record your response in the WMS.</p>
        <p style="color:#b91c1c"><em>This is a test preview sent only to you — no staff have been emailed.</em></p>`,
      buttonText: 'Review & Sign Off',
      buttonUrl: `${APP_URL}/my-documents.html`,
    }),
  });
}

async function sendDeclineAlert({ document, ack }) {
  return mailer.sendMail({
    to: ADMIN_EMAIL,
    subject: `Declined: ${document.title} — ${ack.employee_name || ack.wms_email}`,
    html: mailer.template({
      heading: `Document declined`,
      bodyHtml: `<p><strong>${ack.employee_name || ack.wms_email}</strong> (${ack.wms_email}) has <strong>declined</strong>
        “${document.title}” (version ${ack.version_number}) on ${new Date(ack.created_at).toLocaleString('en-AU')}.</p>
        <p>The decline is stored in the register. They can change their response at any time from their My Documents page.</p>`,
      buttonText: 'Open Register',
      buttonUrl: `${APP_URL}/staff-docs-admin.html`,
    }),
  });
}

// Send prompts to a list of due rows — one failure never blocks the rest,
// and every failure is reported back rather than lost in logs
async function sendPrompts(rows) {
  let sent = 0;
  const failures = [];
  for (const row of rows) {
    try {
      if (await sendDuePrompt(row, 'due_reminder')) sent++;
      await new Promise(w => setTimeout(w, 400)); // gentle pace for Gmail
    } catch (err) {
      console.error(`[staff-docs] Email to ${row.wms_email} failed:`, err.message);
      failures.push({ email: row.wms_email, error: err.message });
    }
  }
  return { sent, failures };
}

// Prompt everyone outstanding on one document immediately (new doc / new version / manual resend)
async function promptOutstanding(documentId, { force } = {}) {
  const due = (await computeDueList()).filter(r => r.document_id === documentId && isOutstanding(r));
  const targets = [];
  for (const row of due) {
    if (!force && await recentlyEmailed(row.document_id, row.wms_email, 'due_reminder', 1)) continue;
    targets.push(row);
  }
  const { sent, failures } = await sendPrompts(targets);
  return { outstanding: due.length, emailed: sent, failures };
}

// Daily sweep: prompt anyone outstanding who hasn't been emailed recently
async function runDailySweep() {
  const due = (await computeDueList()).filter(isOutstanding);
  const targets = [];
  for (const row of due) {
    if (await recentlyEmailed(row.document_id, row.wms_email, 'due_reminder', REMIND_EVERY_DAYS)) continue;
    targets.push(row);
  }
  const { sent, failures } = await sendPrompts(targets);
  console.log(`[staff-docs] Daily sweep — ${due.length} outstanding, ${sent} sent, ${failures.length} failed`);
  return { outstanding: due.length, emailed: sent, failures };
}

function startCron(dbPool) {
  pool = dbPool;
  // 9am AEST daily (23:00 UTC)
  cron.schedule('0 23 * * *', () => runDailySweep().catch(err =>
    console.error('[staff-docs] Sweep error:', err.message)));
  console.log('[staff-docs] Daily sign-off sweep cron: 9am AEST');
}

module.exports = { startCron, computeDueList, isOutstanding, promptOutstanding, runDailySweep, sendDeclineAlert, sendTestPrompt };
