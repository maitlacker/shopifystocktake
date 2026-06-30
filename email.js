'use strict';

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || '';

function enabled() {
  return Boolean(GMAIL_USER && GMAIL_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
}

async function sendMail({ to, subject, html, text }) {
  if (!enabled()) {
    console.warn('[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — skipping email');
    return;
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

module.exports = {
  enabled,
  sendLeaveRequestNotification,
  sendLeaveApprovedNotification,
  sendLeaveRejectedNotification,
};
