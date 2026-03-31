function formatDate(d) {
  if (!d) return 'Never';
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

// ── Inventory sync card ────────────────────────────────────────────
const btnInventorySync  = document.getElementById('btn-inventory-sync');
const inventoryDot      = document.getElementById('inventory-dot');
const inventoryStatus   = document.getElementById('inventory-status-text');
const inventoryLog      = document.getElementById('inventory-log');

function setInventoryStatus(state, text) {
  inventoryDot.className = `sync-status-dot sync-status-dot--${state}`;
  inventoryStatus.textContent = text;
}

function appendInventoryLog(msg, type = 'info') {
  inventoryLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  inventoryLog.appendChild(line);
  inventoryLog.scrollTop = inventoryLog.scrollHeight;
}

(async () => {
  try {
    const res  = await fetch('/api/products/status');
    const data = await res.json();
    if (data.count > 0) {
      setInventoryStatus('ok', `${data.count} products loaded — last synced ${formatDate(data.lastFetched)}`);
    } else {
      setInventoryStatus('idle', 'Not synced yet — click Sync Inventory to load');
    }
  } catch {
    setInventoryStatus('error', 'Could not reach server');
  }
})();

btnInventorySync.addEventListener('click', async () => {
  btnInventorySync.disabled = true;
  setInventoryStatus('syncing', 'Syncing…');
  appendInventoryLog('Starting Shopify inventory sync…');

  try {
    const res  = await fetch('/api/products/refresh');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    setInventoryStatus('ok', `${data.count} products loaded — synced ${formatDate(data.lastFetched)}`);
    appendInventoryLog(`Done — ${data.count} active products loaded.`, 'success');
  } catch (err) {
    setInventoryStatus('error', 'Sync failed');
    appendInventoryLog(`Error: ${err.message}`, 'error');
  } finally {
    btnInventorySync.disabled = false;
  }
});

// ── Stock alert card ───────────────────────────────────────────────
const btnAlertsRun   = document.getElementById('btn-alerts-run');
const alertsDot      = document.getElementById('alerts-dot');
const alertsStatus   = document.getElementById('alerts-status-text');
const alertsLog      = document.getElementById('alerts-log');
const alertsRecent   = document.getElementById('alerts-recent');
const alertsTbody    = document.getElementById('alerts-tbody');

function setAlertsStatus(state, text) {
  alertsDot.className = `sync-status-dot sync-status-dot--${state}`;
  alertsStatus.textContent = text;
}

function appendAlertsLog(msg, type = 'info') {
  alertsLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  alertsLog.appendChild(line);
  alertsLog.scrollTop = alertsLog.scrollHeight;
}

function renderAlerts(alerts) {
  if (alerts.length === 0) {
    alertsRecent.style.display = 'none';
    return;
  }
  alertsRecent.style.display = 'block';

  alertsTbody.innerHTML = alerts.map((a) => {
    const variantLabel = a.variantTitle && a.variantTitle !== 'Default Title'
      ? a.variantTitle : '—';
    const statusBadge = a.resolved
      ? `<span class="alert-badge alert-badge--resolved">Resolved</span>`
      : `<span class="alert-badge alert-badge--active">Active</span>`;

    return `
      <tr>
        <td>${a.productTitle}</td>
        <td>${variantLabel}</td>
        <td><code>${a.sku || '—'}</code></td>
        <td style="text-align:center"><strong>${a.stockAtAlert}</strong></td>
        <td title="${formatDate(a.alertedAt)}">${formatRelative(a.alertedAt)}</td>
        <td>${statusBadge}</td>
      </tr>`;
  }).join('');
}

async function loadAlertStatus() {
  try {
    const [statusRes, recentRes] = await Promise.all([
      fetch('/api/alerts/status'),
      fetch('/api/alerts/recent'),
    ]);
    const status = await statusRes.json();
    const recent = await recentRes.json();

    if (status.isRunning) {
      setAlertsStatus('syncing', 'Checking stock levels…');
    } else if (status.lastRun) {
      const r = status.lastRunResult;
      setAlertsStatus('ok',
        `Last checked ${formatRelative(status.lastRun)} — ${r.alertsSent} alert${r.alertsSent !== 1 ? 's' : ''} sent, ${r.variantsChecked} variants scanned. Next check: ${status.schedule}`
      );
    } else {
      setAlertsStatus('idle', `Scheduled every 30 min (${status.schedule}). Not run yet this session.`);
    }

    renderAlerts(recent);
  } catch {
    setAlertsStatus('error', 'Could not load status');
  }
}

loadAlertStatus();

btnAlertsRun.addEventListener('click', async () => {
  btnAlertsRun.disabled = true;
  setAlertsStatus('syncing', 'Running stock check…');
  appendAlertsLog('Starting stock level check…');

  try {
    const res  = await fetch('/api/alerts/run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    if (data.skipped) {
      appendAlertsLog('Already running — try again in a moment.', 'info');
    } else {
      appendAlertsLog(
        `Done — ${data.variantsChecked} variants checked. Alerts sent: ${data.alertsSent}, skipped: ${data.alertsSkipped}, resolved: ${data.alertsResolved}.`,
        'success'
      );
    }

    await loadAlertStatus();
  } catch (err) {
    setAlertsStatus('error', 'Run failed');
    appendAlertsLog(`Error: ${err.message}`, 'error');
  } finally {
    btnAlertsRun.disabled = false;
  }
});
