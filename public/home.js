'use strict';

const BI_ALLOWED = ['accounts@theselfstyler.com', 'bianca@theselfstyler.com'];

// ── Greeting & date ────────────────────────────────────────────────
function setGreeting(name) {
  const hour = new Date().getHours();
  const prefix = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first  = name ? ', ' + name.split(' ')[0] : '';
  document.getElementById('homeGreeting').textContent = prefix + first;
}

function setDate() {
  const d = new Date();
  document.getElementById('homeDate').textContent = d.toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ── KPI rendering ──────────────────────────────────────────────────
function fmtCurrency(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 10000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + Math.round(n).toLocaleString('en-AU');
}

function renderKpis(d) {
  const alertColor = d.activeAlerts > 0 ? '#dc2626' : '#16a34a';
  const kpis = [
    {
      label: '7-Day Revenue',
      value: fmtCurrency(d.revenue),
      sub:   d.orders + ' orders',
      color: '#4f46e5',
    },
    {
      label: '7-Day Orders',
      value: d.orders != null ? d.orders.toLocaleString() : '—',
      sub:   'Shopify',
      color: '#0891b2',
    },
    {
      label: 'Google Spend',
      value: fmtCurrency(d.googleSpend),
      sub:   '7 days',
      color: '#ea580c',
    },
    {
      label: 'Meta Spend',
      value: fmtCurrency(d.metaSpend),
      sub:   '7 days',
      color: '#1d4ed8',
    },
    {
      label: 'MER',
      value: d.mer ? parseFloat(d.mer).toFixed(1) + 'x' : '—',
      sub:   'Revenue ÷ Ad Spend',
      color: '#16a34a',
    },
    {
      label: 'Stock Alerts',
      value: d.activeAlerts != null ? d.activeAlerts : '—',
      sub:   d.activeAlerts === 1 ? 'active alert' : 'active alerts',
      color: alertColor,
    },
  ];

  document.getElementById('kpiStrip').innerHTML = kpis.map((k) => `
    <div class="home-kpi" style="--kpi-color:${k.color}">
      <div class="home-kpi-label">${k.label}</div>
      <div class="home-kpi-value">${k.value}</div>
      <div class="home-kpi-sub">${k.sub}</div>
    </div>
  `).join('');
}

async function loadKpis() {
  try {
    const r = await fetch('/api/home/kpis');
    if (!r.ok) return;
    const d = await r.json();
    renderKpis(d);
  } catch (_) {
    // Non-critical — leave skeleton placeholders
  }
}

// ── Reveal restricted tiles ────────────────────────────────────────
function revealRestricted(email) {
  document.querySelectorAll('[data-restrict]').forEach((el) => {
    const allowed = el.dataset.restrict.split(',');
    if (allowed.includes(email)) el.style.display = '';
  });
}

// ── Boot ───────────────────────────────────────────────────────────
setDate();

fetch('/api/me')
  .then((r) => (r.ok ? r.json() : null))
  .then((user) => {
    if (!user) return;
    setGreeting(user.displayName || user.email);
    if (BI_ALLOWED.includes(user.email)) revealRestricted(user.email);
  })
  .catch(() => {});

loadKpis();
