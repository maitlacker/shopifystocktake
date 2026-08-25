'use strict';

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || '';

function enabled() {
  return Boolean(GMAIL_USER && GMAIL_PASS);
}

// One pooled transporter for the process — a fresh SMTP login per message
// trips Gmail's rate limiting on bulk sends
let _transporter = null;
function createTransport() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });
  }
  return _transporter;
}

async function sendMail({ to, subject, html, text }) {
  if (!enabled()) {
    console.warn('[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email');
    return false;
  }
  const transporter = createTransport();
  await transporter.sendMail({
    from: `"The Self Styler WMS" <${GMAIL_USER}>`,
    to,
    subject,
    html,
    text,
  });
  console.log(`[email] Sent "${subject}" → ${to}`);
  return true;
}

// ── Leave email templates ──────────────────────────────────────────

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function baseStyle() {
  return `font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 15px; color: #1e293b; line-height: 1.6;`;
}

async function sendLeaveRequestNotification({ adminEmail, staffName, staffEmail, startDate, endDate, daysCount, notes }) {
  const start   = fmtDate(startDate);
  const end     = fmtDate(endDate);
  const dates   = start === end ? start : `${start} – ${end}`;
  const subject = `New Leave Request — ${staffName} (${dates})`;

  const html = `
    <div style="${baseStyle()} max-width:540px;">
      <div style="background:#6366f1; padding:20px 24px; border-radius:10px 10px 0 0;">
        <h1 style="color:#fff; margin:0; font-size:1.1rem;">New Annual Leave Request</h1>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-top:none; border-radius:0 0 10px 10px; padding:24px;">
        <table style="width:100%; border-collapse:collapse;">
          <tr><td style="padding:7px 0; color:#64748b; width:110px;">Staff member</td><td style="padding:7px 0; font-weight:600;">${staffName}</td></tr>
          <tr><td style="padding:7px 0; color:#64748b;">Email</td><td style="padding:7px 0;">${staffEmail}</td></tr>
          <tr><td style="padding:7px 0; color:#64748b;">Dates</td><td style="padding:7px 0; font-weight:600;">${dates}</td></tr>
          <tr><td style="padding:7px 0; color:#64748b;">Duration</td><td style="padding:7px 0;">${daysCount} calendar day${daysCount !== 1 ? 's' : ''}</td></tr>
          ${notes ? `<tr><td style="padding:7px 0; color:#64748b; vertical-align:top;">Notes</td><td style="padding:7px 0;">${notes}</td></tr>` : ''}
        </table>
        <div style="margin-top:20px;">
          <a href="${process.env.APP_URL}/leave-admin.html"
             style="background:#6366f1; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:600; display:inline-block;">
            Review in Leave Admin →
          </a>
        </div>
      </div>
    </div>`;

  const text = `New leave request from ${staffName} (${staffEmail})\nDates: ${dates}\nDuration: ${daysCount} day(s)\n${notes ? `Notes: ${notes}\n` : ''}Review: ${process.env.APP_URL}/leave-admin.html`;

  await sendMail({ to: adminEmail, subject, html, text });
}

async function sendLeaveApprovedNotification({ staffEmail, staffName, startDate, endDate, daysCount }) {
  const start   = fmtDate(startDate);
  const end     = fmtDate(endDate);
  const dates   = start === end ? start : `${start} – ${end}`;
  const subject = `Your Leave Request Has Been Approved`;

  const html = `
    <div style="${baseStyle()} max-width:540px;">
      <div style="background:#16a34a; padding:20px 24px; border-radius:10px 10px 0 0;">
        <h1 style="color:#fff; margin:0; font-size:1.1rem;">Leave Request Approved ✓</h1>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-top:none; border-radius:0 0 10px 10px; padding:24px;">
        <p style="margin:0 0 16px;">Hi ${staffName},</p>
        <p style="margin:0 0 16px;">Your annual leave request has been approved and lodged in Xero.</p>
        <table style="width:100%; border-collapse:collapse;">
          <tr><td style="padding:7px 0; color:#64748b; width:110px;">Dates</td><td style="padding:7px 0; font-weight:600;">${dates}</td></tr>
          <tr><td style="padding:7px 0; color:#64748b;">Duration</td><td style="padding:7px 0;">${daysCount} calendar day${daysCount !== 1 ? 's' : ''}</td></tr>
        </table>
        <p style="margin:20px 0 0; color:#64748b; font-size:0.88rem;">
          If you have any questions please contact accounts@theselfstyler.com.
        </p>
      </div>
    </div>`;

  const text = `Hi ${staffName},\n\nYour annual leave request has been approved and lodged in Xero.\n\nDates: ${dates}\nDuration: ${daysCount} day(s)\n\nQuestions? Email accounts@theselfstyler.com`;

  await sendMail({ to: staffEmail, subject, html, text });
}

async function sendLeaveRejectedNotification({ staffEmail, staffName, startDate, endDate, rejectReason }) {
  const start   = fmtDate(startDate);
  const end     = fmtDate(endDate);
  const dates   = start === end ? start : `${start} – ${end}`;
  const subject = `Your Leave Request Has Been Declined`;

  const html = `
    <div style="${baseStyle()} max-width:540px;">
      <div style="background:#dc2626; padding:20px 24px; border-radius:10px 10px 0 0;">
        <h1 style="color:#fff; margin:0; font-size:1.1rem;">Leave Request Declined</h1>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-top:none; border-radius:0 0 10px 10px; padding:24px;">
        <p style="margin:0 0 16px;">Hi ${staffName},</p>
        <p style="margin:0 0 16px;">Unfortunately your annual leave request for <strong>${dates}</strong> has been declined.</p>
        ${rejectReason ? `<p style="margin:0 0 16px; background:#fef2f2; border-left:3px solid #fca5a5; padding:10px 14px; border-radius:0 6px 6px 0;">Reason: ${rejectReason}</p>` : ''}
        <p style="margin:0; color:#64748b; font-size:0.88rem;">
          Please contact accounts@theselfstyler.com if you'd like to discuss further.
        </p>
      </div>
    </div>`;

  const text = `Hi ${staffName},\n\nYour leave request for ${dates} has been declined.\n${rejectReason ? `Reason: ${rejectReason}\n` : ''}\nContact accounts@theselfstyler.com to discuss.`;

  await sendMail({ to: staffEmail, subject, html, text });
}

async function sendCasualUnavailabilityNotification({ adminEmail, staffName, staffEmail, startDate, endDate, daysCount, notes }) {
  const start   = fmtDate(startDate);
  const end     = fmtDate(endDate);
  const dates   = start === end ? start : `${start} – ${end}`;
  const subject = `Casual Unavailability — ${staffName} (${dates})`;

  const html = `
    <div style="${baseStyle()} max-width:540px;">
      <div style="background:#7c3aed; padding:20px 24px; border-radius:10px 10px 0 0;">
        <h1 style="color:#fff; margin:0; font-size:1.1rem;">Casual Unavailability Notice</h1>
      </div>
      <div style="background:#fff; border:1px solid #e2e8f0; border-top:none; border-radius:0 0 10px 10px; padding:24px;">
        <p style="margin:0 0 16px; color:#64748b; font-size:0.88rem;">No action required — this has been automatically recorded.</p>
        <table style="width:100%; border-collapse:collapse;">
          <tr><td style="padding:7px 0; color:#64748b; width:110px;">Staff member</td><td style="padding:7px 0; font-weight:600;">${staffName} <span style="font-size:0.75rem; background:#ede9fe; color:#6d28d9; padding:1px 6px; border-radius:4px; font-weight:700;">CASUAL</span></td></tr>
          <tr><td style="padding:7px 0; color:#64748b;">Dates</td><td style="padding:7px 0; font-weight:600;">${dates}</td></tr>
          <tr><td style="padding:7px 0; color:#64748b;">Duration</td><td style="padding:7px 0;">${daysCount} working day${daysCount !== 1 ? 's' : ''}</td></tr>
          ${notes ? `<tr><td style="padding:7px 0; color:#64748b; vertical-align:top;">Notes</td><td style="padding:7px 0;">${notes}</td></tr>` : ''}
        </table>
        <div style="margin-top:20px;">
          <a href="${process.env.APP_URL}/leave-calendar.html"
             style="background:#7c3aed; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:600; display:inline-block;">
            View Calendar →
          </a>
        </div>
      </div>
    </div>`;

  const text = `Casual unavailability from ${staffName} (${staffEmail})\nDates: ${dates}\nDuration: ${daysCount} day(s)\n${notes ? `Notes: ${notes}\n` : ''}No action required — automatically recorded.`;

  await sendMail({ to: adminEmail, subject, html, text });
}

// Standard WMS email shell with a call-to-action button (staff documents etc.)
function template({ heading, bodyHtml, buttonText, buttonUrl }) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
    <div style="font-size:13px;font-weight:700;color:#64748b;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:16px">The Self Styler — WMS</div>
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
      <h2 style="margin:0 0 12px;font-size:19px;color:#1e293b">${heading}</h2>
      <div style="font-size:15px;color:#334155;line-height:1.6">${bodyHtml}</div>
      ${buttonUrl ? `
      <div style="margin-top:24px">
        <a href="${buttonUrl}" style="background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:9px;display:inline-block">${buttonText || 'Open in WMS'}</a>
      </div>` : ''}
    </div>
    <div style="font-size:12px;color:#94a3b8;margin-top:14px">Sent automatically by The Self Styler WMS.</div>
  </div>`;
}

module.exports = {
  enabled,
  sendMail,
  template,
  sendLeaveRequestNotification,
  sendLeaveApprovedNotification,
  sendLeaveRejectedNotification,
  sendCasualUnavailabilityNotification,
};
