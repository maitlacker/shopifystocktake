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

// ── Shopify Analytics card ─────────────────────────────────────────
const shopifyAnalyticsDot    = document.getElementById('shopify-analytics-dot');
const shopifyAnalyticsStatus = document.getElementById('shopify-analytics-status-text');
const shopifyAnalyticsLog    = document.getElementById('shopify-analytics-log');
const btnShopifyFull         = document.getElementById('btn-shopify-analytics-full');
const btnShopifyDaily        = document.getElementById('btn-shopify-analytics-daily');

function setShopifyAnalyticsStatus(state, text) {
  shopifyAnalyticsDot.className = `sync-status-dot sync-status-dot--${state}`;
  shopifyAnalyticsStatus.textContent = text;
}

function appendShopifyAnalyticsLog(msg, type = 'info') {
  shopifyAnalyticsLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  shopifyAnalyticsLog.appendChild(line);
  shopifyAnalyticsLog.scrollTop = shopifyAnalyticsLog.scrollHeight;
}

(async () => {
  try {
    const res    = await fetch('/api/shopify-analytics/status');
    const status = await res.json();
    if (status.isRunning) {
      setShopifyAnalyticsStatus('syncing', 'Sync in progress…');
    } else if (status.lastRun) {
      const r = status.lastRunResult;
      const sessNote = r.sessionsNote ? ` (sessions: ${r.sessionsNote})` : '';
      setShopifyAnalyticsStatus('ok',
        `Last synced ${formatRelative(status.lastRun)} — ${r.daysUpserted} days, ${r.ordersProcessed} orders${sessNote}`
      );
    } else {
      setShopifyAnalyticsStatus('idle', 'Not synced yet — click Full Sync to import history');
    }
  } catch {
    setShopifyAnalyticsStatus('error', 'Could not load status');
  }
})();

async function runShopifyAnalyticsSync(days) {
  btnShopifyFull.disabled  = true;
  btnShopifyDaily.disabled = true;
  setShopifyAnalyticsStatus('syncing', `Syncing last ${days} days…`);
  appendShopifyAnalyticsLog(`Starting Shopify analytics sync (${days} days)…`);

  try {
    const res  = await fetch('/api/shopify-analytics/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ days }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    if (data.skipped) {
      appendShopifyAnalyticsLog('Already running — try again shortly.', 'info');
    } else {
      const sessMsg = data.sessionsAvailable ? 'sessions included' : `sessions unavailable (${data.sessionsNote || 'check read_analytics scope'})`;
      appendShopifyAnalyticsLog(
        `Done — ${data.daysUpserted} days synced, ${data.ordersProcessed} orders. ${sessMsg}.`,
        'success'
      );
      setShopifyAnalyticsStatus('ok',
        `Synced ${data.daysUpserted} days, ${data.ordersProcessed} orders. ${data.sessionsAvailable ? 'Sessions included.' : 'Sessions unavailable.'}`
      );
    }
  } catch (err) {
    setShopifyAnalyticsStatus('error', 'Sync failed');
    appendShopifyAnalyticsLog(`Error: ${err.message}`, 'error');
  } finally {
    btnShopifyFull.disabled  = false;
    btnShopifyDaily.disabled = false;
  }
}

btnShopifyFull.addEventListener('click',  () => runShopifyAnalyticsSync(90));
btnShopifyDaily.addEventListener('click', () => runShopifyAnalyticsSync(7));

// ── Google Ads card ────────────────────────────────────────────────
const gadsDot        = document.getElementById('gads-dot');
const gadsStatusText = document.getElementById('gads-status-text');
const gadsLog        = document.getElementById('gads-log');
const btnGadsConnect = document.getElementById('btn-gads-connect');
const btnGadsFull    = document.getElementById('btn-gads-full');
const btnGadsDaily   = document.getElementById('btn-gads-daily');

function setGadsStatus(state, text) {
  gadsDot.className = `sync-status-dot sync-status-dot--${state}`;
  gadsStatusText.textContent = text;
}

function appendGadsLog(msg, type = 'info') {
  gadsLog.style.display = 'block';
  const line = document.createElement('div');
  line.className = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  gadsLog.appendChild(line);
  gadsLog.scrollTop = gadsLog.scrollHeight;
}

async function loadGadsStatus() {
  try {
    const res    = await fetch('/api/google-ads/status');
    const status = await res.json();

    if (!status.configured) {
      setGadsStatus('idle', 'Not connected — click Connect Google Ads to authorise');
      btnGadsConnect.style.display = '';
      btnGadsFull.style.display    = 'none';
      btnGadsDaily.style.display   = 'none';
    } else if (status.isRunning) {
      setGadsStatus('syncing', 'Sync in progress…');
    } else if (status.lastRun) {
      const r = status.lastRunResult;
      setGadsStatus('ok', `Last synced ${formatRelative(status.lastRun)} — ${r.upserted} rows. Daily cron: ${status.dailyCron}`);
      btnGadsConnect.style.display = 'none';
      btnGadsFull.style.display    = '';
      btnGadsDaily.style.display   = '';
    } else {
      setGadsStatus('idle', 'Connected — no sync run yet. Run a full sync to import history.');
      btnGadsConnect.style.display = 'none';
      btnGadsFull.style.display    = '';
      btnGadsDaily.style.display   = '';
    }

    // Show error from URL param if redirected back from OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get('ads_connected')) {
      setGadsStatus('ok', 'Google Ads connected! Run a full sync to import your data.');
      appendGadsLog('Successfully connected to Google Ads.', 'success');
      btnGadsConnect.style.display = 'none';
      btnGadsFull.style.display    = '';
      btnGadsDaily.style.display   = '';
      window.history.replaceState({}, '', '/syncing.html');
    }
    if (params.get('ads_error')) {
      const msg = params.get('ads_error');
      setGadsStatus('error', `Connection failed: ${msg}`);
      appendGadsLog(`OAuth error: ${msg}`, 'error');
      window.history.replaceState({}, '', '/syncing.html');
    }
  } catch {
    setGadsStatus('error', 'Could not load status');
  }
}

async function runGadsSync(days) {
  btnGadsFull.disabled  = true;
  btnGadsDaily.disabled = true;
  setGadsStatus('syncing', `Syncing last ${days} days…`);
  appendGadsLog(`Starting Google Ads sync (${days} days)…`);

  try {
    const res  = await fetch('/api/google-ads/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ days }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    if (data.skipped) {
      appendGadsLog('Already running — try again shortly.', 'info');
    } else {
      appendGadsLog(`Done — ${data.upserted} rows synced across ${days} days.`, 'success');
    }
    await loadGadsStatus();
  } catch (err) {
    setGadsStatus('error', 'Sync failed');
    appendGadsLog(`Error: ${err.message}`, 'error');
  } finally {
    btnGadsFull.disabled  = false;
    btnGadsDaily.disabled = false;
  }
}

btnGadsFull.addEventListener('click',  () => runGadsSync(90));
btnGadsDaily.addEventListener('click', () => runGadsSync(7));

loadGadsStatus();

// ── Meta Ads card ──────────────────────────────────────────────────
const metaDot       = document.getElementById('meta-dot');
const metaStatusTxt = document.getElementById('meta-status-text');
const metaLog       = document.getElementById('meta-log');
const btnMetaConnect = document.getElementById('btn-meta-connect');
const btnMetaFull    = document.getElementById('btn-meta-full');
const btnMetaDaily   = document.getElementById('btn-meta-daily');

// Show success/error from OAuth redirect
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('meta_connected')) {
  history.replaceState({}, '', '/syncing.html');
}
if (urlParams.get('xero_connected')) {
  history.replaceState({}, '', '/syncing.html');
}

function setMetaStatus(state, text) {
  metaDot.className = `sync-status-dot sync-status-dot--${state}`;
  metaStatusTxt.textContent = text;
}

function appendMetaLog(msg, type = 'info') {
  metaLog.style.display = 'block';
  const line = document.createElement('div');
  line.className   = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  metaLog.appendChild(line);
  metaLog.scrollTop = metaLog.scrollHeight;
}

async function loadMetaStatus() {
  try {
    const res  = await fetch('/api/meta/status');
    const data = await res.json();
    if (data.connected) {
      const last = data.lastSync?.last_sync ? `· Last sync ${formatRelative(data.lastSync.last_sync)}` : '· Not yet synced';
      setMetaStatus('ok', `Connected as ${data.name || 'Meta Ads'} ${last}`);
      btnMetaConnect.style.display = 'none';
      btnMetaFull.style.display    = '';
      btnMetaDaily.style.display   = '';
    } else {
      setMetaStatus('idle', data.expired ? 'Token expired — reconnect Meta Ads' : 'Not connected');
      btnMetaConnect.style.display = '';
      btnMetaFull.style.display    = 'none';
      btnMetaDaily.style.display   = 'none';
    }
  } catch {
    setMetaStatus('error', 'Could not load status');
  }
}

async function runMetaSync(days) {
  btnMetaFull.disabled  = true;
  btnMetaDaily.disabled = true;
  setMetaStatus('syncing', `Syncing last ${days} days…`);
  appendMetaLog(`Syncing Meta Ads — last ${days} days…`);
  try {
    const res  = await fetch('/api/meta/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    appendMetaLog(`Done — ${data.rows} rows fetched, ${data.inserted} inserted, ${data.updated} updated`, 'success');
    await loadMetaStatus();
  } catch (err) {
    setMetaStatus('error', 'Sync failed');
    appendMetaLog(`Error: ${err.message}`, 'error');
  } finally {
    btnMetaFull.disabled  = false;
    btnMetaDaily.disabled = false;
  }
}

btnMetaFull.addEventListener('click',  () => runMetaSync(30));
btnMetaDaily.addEventListener('click', () => runMetaSync(7));

loadMetaStatus();

// ── Xero card ──────────────────────────────────────────────────────
const xeroDot        = document.getElementById('xero-dot');
const xeroStatusTxt  = document.getElementById('xero-status-text');
const xeroLog        = document.getElementById('xero-log');
const btnXeroConnect    = document.getElementById('btn-xero-connect');
const btnXeroFull       = document.getElementById('btn-xero-full');
const btnXeroTtm        = document.getElementById('btn-xero-ttm');
const btnXeroDaily      = document.getElementById('btn-xero-daily');
const btnXeroBs         = document.getElementById('btn-xero-bs');
const btnXeroDisconnect = document.getElementById('btn-xero-disconnect');

function setXeroStatus(state, text) {
  xeroDot.className = `sync-status-dot sync-status-dot--${state}`;
  xeroStatusTxt.textContent = text;
}

function appendXeroLog(msg, type = 'info') {
  xeroLog.style.display = 'block';
  const line = document.createElement('div');
  line.className   = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  xeroLog.appendChild(line);
  xeroLog.scrollTop = xeroLog.scrollHeight;
}

async function loadXeroStatus() {
  try {
    const res  = await fetch('/api/xero/status');
    const data = await res.json();
    if (data.connected) {
      const last = data.lastSync?.last_sync ? `· Last sync ${formatRelative(data.lastSync.last_sync)}` : '· Not yet synced';
      setXeroStatus('ok', `Connected to ${data.tenantName} ${last}`);
      btnXeroConnect.style.display    = 'none';
      btnXeroFull.style.display       = '';
      btnXeroTtm.style.display        = '';
      btnXeroDaily.style.display      = '';
      btnXeroBs.style.display         = '';
      btnXeroDisconnect.style.display = '';
    } else {
      setXeroStatus('idle', 'Not connected');
      btnXeroConnect.style.display    = '';
      btnXeroFull.style.display       = 'none';
      btnXeroTtm.style.display        = 'none';
      btnXeroDaily.style.display      = 'none';
      btnXeroBs.style.display         = 'none';
      btnXeroDisconnect.style.display = 'none';
    }
  } catch {
    setXeroStatus('error', 'Could not load status');
  }
}

async function runXeroSync(months) {
  btnXeroFull.disabled  = true;
  btnXeroTtm.disabled   = true;
  btnXeroDaily.disabled = true;
  btnXeroBs.disabled    = true;
  setXeroStatus('syncing', `Syncing ${months} month${months !== 1 ? 's' : ''} of P&L…`);
  appendXeroLog(`Syncing Xero P&L — ${months} month${months !== 1 ? 's' : ''}…`);
  try {
    const res  = await fetch('/api/xero/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ months }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    appendXeroLog(`Done — ${data.months} months synced`, 'success');
    if (data.data?.length) {
      const latest = data.data[0];
      appendXeroLog(
        `Latest: Revenue $${Number(latest.revenue).toLocaleString('en-AU')} · Gross profit $${Number(latest.grossProfit).toLocaleString('en-AU')} · Net profit $${Number(latest.netProfit).toLocaleString('en-AU')}`,
        'info'
      );
    }
    await loadXeroStatus();
  } catch (err) {
    setXeroStatus('error', 'Sync failed');
    appendXeroLog(`Error: ${err.message}`, 'error');
  } finally {
    btnXeroFull.disabled  = false;
    btnXeroTtm.disabled   = false;
    btnXeroDaily.disabled = false;
    btnXeroBs.disabled    = false;
  }
}

btnXeroBs.addEventListener('click', async () => {
  btnXeroFull.disabled  = true;
  btnXeroDaily.disabled = true;
  btnXeroBs.disabled    = true;
  setXeroStatus('syncing', 'Syncing Balance Sheet…');
  appendXeroLog('Fetching Balance Sheet from Xero…');
  try {
    const res  = await fetch('/api/xero/sync-balance-sheet', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sync failed');
    appendXeroLog(`Done — ${data.lines} line items as at ${data.date}`, 'success');
    await loadXeroStatus();
  } catch (err) {
    setXeroStatus('error', 'Balance Sheet sync failed');
    appendXeroLog(`Error: ${err.message}`, 'error');
  } finally {
    btnXeroFull.disabled  = false;
    btnXeroDaily.disabled = false;
    btnXeroBs.disabled    = false;
  }
});

btnXeroFull.addEventListener('click',  () => runXeroSync(3));
btnXeroTtm.addEventListener('click',   () => runXeroSync(12));
btnXeroDaily.addEventListener('click', () => runXeroSync(1));

btnXeroDisconnect.addEventListener('click', async () => {
  if (!confirm('Disconnect Xero? You will need to reconnect and re-authorise to use Xero features.')) return;
  try {
    const res = await fetch('/api/xero/disconnect', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    appendXeroLog('Xero disconnected.', 'info');
    loadXeroStatus();
  } catch (err) {
    appendXeroLog(`Disconnect failed: ${err.message}`, 'error');
  }
});

loadXeroStatus();

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

// ── Idea Factory cron card ─────────────────────────────────────────
const btnIdeasPush = document.getElementById('btn-ideas-push');
const btnIdeasRun  = document.getElementById('btn-ideas-run');
const ideasDot     = document.getElementById('ideas-dot');
const ideasStatus  = document.getElementById('ideas-status-text');
const ideasLog     = document.getElementById('ideas-log');

function setIdeasStatus(state, text) {
  ideasDot.className   = `sync-status-dot sync-status-dot--${state}`;
  ideasStatus.textContent = text;
}

function appendIdeasLog(msg, type = 'info') {
  ideasLog.style.display = 'block';
  const line = document.createElement('div');
  line.className  = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  ideasLog.appendChild(line);
  ideasLog.scrollTop = ideasLog.scrollHeight;
}

async function loadIdeasStatus() {
  try {
    const res  = await fetch('/api/ideas-cron/status');
    const data = await res.json();

    if (data.isRunning) {
      setIdeasStatus('syncing', 'Generating ideas… this takes ~30 seconds');
    } else if (data.lastRunAt) {
      const slackNote = data.slackConfigured ? '' : ' (Slack not configured)';
      setIdeasStatus(
        data.lastRunStatus && data.lastRunStatus.startsWith('error') ? 'error' : 'ok',
        `Last run ${formatRelative(data.lastRunAt)} — ${data.lastRunStatus}${slackNote}`
      );
    } else {
      const slackNote = data.slackConfigured ? '' : ' · ⚠ SLACK_IDEAS_WEBHOOK_URL not set';
      setIdeasStatus('idle', `Scheduled daily at 7am AEST (${data.schedule})${slackNote}. Not run yet this session.`);
    }
  } catch {
    setIdeasStatus('error', 'Could not load status');
  }
}

loadIdeasStatus();

btnIdeasPush.addEventListener('click', async () => {
  btnIdeasPush.disabled = true;
  btnIdeasRun.disabled  = true;
  appendIdeasLog('Posting all current ideas to Slack…');

  try {
    const res  = await fetch('/api/ideas-cron/push-current', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || data.error || 'Unknown error');
    appendIdeasLog(`Done — ${data.count} ideas posted to Slack ✓`, 'success');
    appendIdeasLog('From now on the daily cron will only post NEW ideas vs this snapshot.', 'info');
  } catch (err) {
    appendIdeasLog(`Error: ${err.message}`, 'error');
  } finally {
    btnIdeasPush.disabled = false;
    btnIdeasRun.disabled  = false;
  }
});

btnIdeasRun.addEventListener('click', async () => {
  btnIdeasRun.disabled = true;
  setIdeasStatus('syncing', 'Running — fetching inventory and calling Claude…');
  appendIdeasLog('Starting idea generation (this takes ~30–60 seconds)…');

  try {
    const res  = await fetch('/api/ideas-cron/run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    if (data.skipped) {
      appendIdeasLog(data.message || 'Skipped — already running or not configured.', 'info');
    } else if (data.error) {
      appendIdeasLog(`Error: ${data.message}`, 'error');
    } else {
      const slackMsg = data.slackSent ? ' · posted to Slack ✓' : '';
      appendIdeasLog(
        `Done — ${data.total} ideas generated, ${data.newIdeas} new${slackMsg}`,
        'success'
      );
    }

    await loadIdeasStatus();
  } catch (err) {
    setIdeasStatus('error', 'Run failed');
    appendIdeasLog(`Error: ${err.message}`, 'error');
  } finally {
    btnIdeasRun.disabled = false;
  }
});

// ── Weekly Business Pulse card ─────────────────────────────────────
const pulseDot      = document.getElementById('pulse-dot');
const pulseStatusTxt= document.getElementById('pulse-status-text');
const pulseLog      = document.getElementById('pulse-log');
const btnPulseRun   = document.getElementById('btn-pulse-run');

function setPulseStatus(state, text) {
  pulseDot.className    = `sync-status-dot sync-status-dot--${state}`;
  pulseStatusTxt.textContent = text;
}

function appendPulseLog(msg, type = 'info') {
  pulseLog.style.display = 'block';
  const line = document.createElement('div');
  line.className   = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  pulseLog.appendChild(line);
  pulseLog.scrollTop = pulseLog.scrollHeight;
}

async function loadPulseStatus() {
  try {
    const res  = await fetch('/api/weekly-pulse/status');
    const data = await res.json();
    if (data.isRunning) {
      setPulseStatus('syncing', 'Generating pulse report…');
    } else if (data.lastRun) {
      const slackNote = data.slackConfigured ? '' : ' · ⚠ Slack webhook not set';
      const statusTxt = data.lastResult?.error
        ? `Last run ${formatRelative(data.lastRun)} — error: ${data.lastResult.error}`
        : `Last run ${formatRelative(data.lastRun)} ✓${slackNote}`;
      setPulseStatus(data.lastResult?.error ? 'error' : 'ok', statusTxt);
    } else {
      const slackNote = data.slackConfigured ? '' : ' · ⚠ SLACK_IDEAS_WEBHOOK_URL not set';
      setPulseStatus('idle', `Scheduled Mon 8am AEST (${data.schedule}). Not run yet.${slackNote}`);
    }
  } catch {
    setPulseStatus('error', 'Could not load status');
  }
}

btnPulseRun.addEventListener('click', async () => {
  btnPulseRun.disabled = true;
  setPulseStatus('syncing', 'Running — gathering data and calling Claude (takes ~30s)…');
  appendPulseLog('Starting weekly pulse generation…');

  try {
    const res  = await fetch('/api/weekly-pulse/run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    if (data.skipped) {
      appendPulseLog('Already running — try again in a moment.', 'info');
    } else {
      appendPulseLog(`Done — ${data.chars} chars posted to Slack ✓`, 'success');
    }
    await loadPulseStatus();
  } catch (err) {
    setPulseStatus('error', 'Failed');
    appendPulseLog(`Error: ${err.message}`, 'error');
  } finally {
    btnPulseRun.disabled = false;
  }
});

loadPulseStatus();
