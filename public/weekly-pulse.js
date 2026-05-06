'use strict';

const btnGenerate  = document.getElementById('btnGenerate');
const reportSelect = document.getElementById('reportSelect');
const wpStatus     = document.getElementById('wpStatus');
const wpLoading    = document.getElementById('wpLoading');
const wpEmpty      = document.getElementById('wpEmpty');
const wpPanel      = document.getElementById('wpPanel');
const wpMeta       = document.getElementById('wpMeta');
const wpContent    = document.getElementById('wpContent');

let allReports = [];

// ── Load report list on boot ──────────────────────────────────────
async function loadReports() {
  try {
    const r = await fetch('/api/weekly-pulse/reports');
    if (!r.ok) throw new Error(await r.text());
    allReports = await r.json();

    if (allReports.length === 0) {
      wpEmpty.style.display = 'block';
      return;
    }

    // Populate history dropdown
    reportSelect.innerHTML = '<option value="">— Past reports —</option>' +
      allReports.map((rep) =>
        `<option value="${rep.id}">${fmtReportLabel(rep)}</option>`
      ).join('');
    reportSelect.style.display = '';

    // Show the most recent by default
    showReport(allReports[0]);
  } catch (err) {
    setStatus('Could not load reports: ' + err.message, true);
  }
}

// ── Show a report ─────────────────────────────────────────────────
function showReport(rep) {
  wpEmpty.style.display = 'none';
  wpPanel.style.display = 'block';

  const start = fmtDate(rep.period_start);
  const end   = fmtDate(rep.period_end);
  const gen   = new Date(rep.generated_at).toLocaleString('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  wpMeta.innerHTML =
    `Period: <strong>${start} → ${end}</strong> &nbsp;·&nbsp; Generated: ${gen} &nbsp;·&nbsp; ${rep.model_used || 'Claude'}`;

  wpContent.innerHTML = renderPulse(rep.content);
}

// ── Generate new report ───────────────────────────────────────────
btnGenerate.addEventListener('click', async () => {
  btnGenerate.disabled      = true;
  wpLoading.style.display   = 'block';
  wpPanel.style.display     = 'none';
  wpEmpty.style.display     = 'none';
  setStatus('');

  try {
    const r = await fetch('/api/weekly-pulse/run', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Unknown error');
    if (data.skipped) {
      setStatus('Already running — please wait a moment and try again.');
      wpLoading.style.display = 'none';
      return;
    }
    // Reload the list to pick up the new report
    await loadReports();
    setStatus('');
  } catch (err) {
    setStatus('Error: ' + err.message, true);
    if (allReports.length === 0) wpEmpty.style.display = 'block';
    else showReport(allReports[0]);
  } finally {
    wpLoading.style.display = 'none';
    btnGenerate.disabled    = false;
  }
});

// ── History dropdown ──────────────────────────────────────────────
reportSelect.addEventListener('change', () => {
  const id  = parseInt(reportSelect.value, 10);
  const rep = allReports.find((r) => r.id === id);
  if (rep) showReport(rep);
});

// ── Render Claude's text output to HTML ───────────────────────────
function renderPulse(text) {
  const lines = text.split('\n');
  let html = '';
  let inActions = false; // true once we hit the TOP 3 ACTIONS section

  for (let i = 0; i < lines.length; i++) {
    const raw     = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) continue;

    // Section headers: *📈 SECTION TITLE*  (bold single asterisks, whole line)
    const hdrMatch = trimmed.match(/^\*(.+)\*$/);
    if (hdrMatch) {
      const title = hdrMatch[1];
      inActions   = title.includes('ACTION');
      html += `<h3>${escHtml(title)}</h3>`;
      continue;
    }

    // Numbered action items: 1. text
    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numMatch && inActions) {
      html += `<div class="wp-action">
        <span class="wp-action-num">${numMatch[1]}.</span>
        <span class="wp-action-text">${inlineFormat(escHtml(numMatch[2]))}</span>
      </div>`;
      continue;
    }

    // Bullet points: • or -
    if (/^[•\-]\s+/.test(trimmed)) {
      const body = trimmed.replace(/^[•\-]\s+/, '');
      html += `<ul><li>${inlineFormat(escHtml(body))}</li></ul>`;
      continue;
    }

    // Regular paragraph
    html += `<p>${inlineFormat(escHtml(trimmed))}</p>`;
  }

  // Merge consecutive <ul> tags
  html = html.replace(/<\/ul>\s*<ul>/g, '');

  return html;
}

// Bold: **text** or *text* (inline, not whole-line)
function inlineFormat(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g,  '<strong>$1</strong>');
}

// ── Helpers ───────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtReportLabel(rep) {
  const gen = new Date(rep.generated_at).toLocaleDateString('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
  const period = `${fmtDate(rep.period_start)} – ${fmtDate(rep.period_end)}`;
  return `${gen} · ${period}`;
}

function setStatus(msg, isError) {
  wpStatus.textContent = msg;
  wpStatus.className   = isError ? 'is-error' : '';
}

// ── Boot ──────────────────────────────────────────────────────────
loadReports();
