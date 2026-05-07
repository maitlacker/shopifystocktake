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

// ── Ops pipeline ──────────────────────────────────────────────────
function renderOpsStatus(d) {
  const ship   = d.ordersToShip ?? '—';
  const picked = d.ordersPicked ?? '—';
  const packed = d.ordersPacked ?? '—';

  document.getElementById('opsShip').textContent   = ship;
  document.getElementById('opsPicked').textContent = picked;
  document.getElementById('opsPacked').textContent = packed;

  // Progress bar: picked / ordersToShip
  const pct = (d.ordersToShip > 0 && d.ordersPicked != null)
    ? Math.min(100, Math.round((d.ordersPicked / d.ordersToShip) * 100))
    : 0;
  document.getElementById('opsBar').style.width = pct + '%';

  const progressEl = document.getElementById('opsProgressText');
  if (d.ordersToShip != null && d.ordersPicked != null) {
    progressEl.textContent = `${pct}% of ship queue picked · ${d.ordersPacked ?? 0} packed`;
  } else {
    progressEl.textContent = 'No data yet — sync runs every 5 minutes';
  }

  const syncEl = document.getElementById('opsSyncTime');
  if (d.lastSynced) {
    const ago = Math.round((Date.now() - new Date(d.lastSynced)) / 60000);
    syncEl.textContent = ago < 2 ? 'Just synced' : `Synced ${ago}m ago`;
  }
}

async function loadOpsStatus() {
  try {
    const r = await fetch('/api/ops/status');
    if (!r.ok) return;
    renderOpsStatus(await r.json());
  } catch (_) {}
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
loadOpsStatus();

// Auto-refresh ops pipeline every 5 minutes
setInterval(loadOpsStatus, 5 * 60 * 1000);
