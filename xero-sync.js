// xero-sync.js — Xero financial data sync
'use strict';

const fetch = require('node-fetch');
const cron  = require('node-cron');

let _pool     = null;
let isRunning = false;
let lastRun   = null;
let lastResult = null;

const XERO_API   = 'https://api.xero.com/api.xro/2.0';
const XERO_TOKEN = 'https://identity.xero.com/connect/token';
const XERO_AUTH  = 'https://login.xero.com/identity/connect/authorize';

// ── Token management ───────────────────────────────────────────────
async function getTokens() {
  if (!_pool) return null;
  const { rows } = await _pool.query(
    `SELECT value FROM app_settings WHERE key = 'xero_tokens'`
  );
  if (!rows.length || !rows[0].value) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

async function saveTokens(tokens) {
  if (!_pool) return;
  await _pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('xero_tokens', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(tokens)]
  );
}

async function saveTenantId(tenantId, tenantName) {
  if (!_pool) return;
  await _pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('xero_tenant_id', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [tenantId]
  );
  await _pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('xero_tenant_name', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [tenantName]
  );
}

async function getTenantId() {
  if (!_pool) return null;
  const { rows } = await _pool.query(
    `SELECT value FROM app_settings WHERE key = 'xero_tenant_id'`
  );
  return rows[0]?.value || null;
}

// Refresh access token using refresh token
async function refreshAccessToken(tokens) {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(XERO_TOKEN, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || `Token refresh failed: ${res.status}`);

  const newTokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at:    Date.now() + (data.expires_in * 1000),
  };
  await saveTokens(newTokens);
  return newTokens;
}

// Get a valid access token, refreshing if needed
async function getValidAccessToken() {
  let tokens = await getTokens();
  if (!tokens) throw new Error('Xero not connected — use Connect Xero on the Syncing page');

  // Refresh if expires within 5 minutes
  if (Date.now() > tokens.expires_at - 300000) {
    console.log('[xero] Refreshing access token…');
    tokens = await refreshAccessToken(tokens);
  }
  return tokens.access_token;
}

// ── OAuth flow ─────────────────────────────────────────────────────
function getAuthUrl(redirectUri, state) {
  const clientId = process.env.XERO_CLIENT_ID;
  const scopes   = 'openid profile email accounting.reports.read offline_access';
  // Build manually — URLSearchParams encodes spaces as + but Xero requires %20
  return `${XERO_AUTH}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes.split(' ').map(encodeURIComponent).join('%20')}` +
    `&state=${encodeURIComponent(state || 'xero_connect')}`;
}

async function handleOAuthCallback(code, redirectUri) {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(XERO_TOKEN, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || `OAuth callback failed: ${res.status}`);

  const tokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    Date.now() + (data.expires_in * 1000),
  };
  await saveTokens(tokens);

  // Fetch and store the organisation tenant ID
  const connRes  = await fetch('https://api.xero.com/connections', {
    headers: { 'Authorization': `Bearer ${data.access_token}`, 'Content-Type': 'application/json' },
  });
  const tenants = await connRes.json();
  if (tenants.length > 0) {
    await saveTenantId(tenants[0].tenantId, tenants[0].tenantName);
    console.log(`[xero] Connected to: ${tenants[0].tenantName}`);
  }

  return tokens;
}

// ── Xero API request helper ────────────────────────────────────────
async function xeroGet(path, params = {}) {
  const token    = await getValidAccessToken();
  const tenantId = await getTenantId();
  if (!tenantId) throw new Error('Xero tenant not found — please reconnect');

  const url = new URL(`${XERO_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Xero-tenant-id': tenantId,
      'Accept':         'application/json',
    },
  });

  if (res.status === 401) {
    await saveTokens(null);
    throw new Error('Xero token invalid — please reconnect');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Xero API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Parse P&L report from Xero's nested row structure ─────────────
function parseProfitAndLoss(report) {
  const rows = report.Reports?.[0]?.Rows || [];
  const result = { revenue: 0, cogs: 0, grossProfit: 0, expenses: 0, netProfit: 0 };

  function sumSection(sectionTitle) {
    for (const section of rows) {
      if (!section.Title) continue;
      const title = section.Title.toLowerCase();
      if (!title.includes(sectionTitle.toLowerCase())) continue;
      // Find the summary row (last row in section)
      const sectionRows = section.Rows || [];
      const summaryRow  = sectionRows.find(r => r.RowType === 'SummaryRow');
      if (summaryRow?.Cells?.length >= 2) {
        return Math.abs(parseFloat(summaryRow.Cells[1]?.Value || 0));
      }
    }
    return 0;
  }

  result.revenue     = sumSection('income') || sumSection('revenue') || sumSection('trading income');
  result.cogs        = sumSection('cost of sales') || sumSection('direct costs') || sumSection('cogs');
  result.grossProfit = result.revenue - result.cogs;
  result.expenses    = sumSection('operating') || sumSection('overhead') || sumSection('expenses');
  result.netProfit   = result.grossProfit - result.expenses;

  return result;
}

// ── Sync P&L for a given month range ──────────────────────────────
async function syncProfitAndLoss(monthsBack = 3) {
  const tenantId = await getTenantId();
  if (!tenantId) throw new Error('Xero not connected');

  const synced = [];
  const now    = new Date();

  for (let i = 0; i < monthsBack; i++) {
    const d     = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0)
      .toISOString().slice(0, 10);

    console.log(`[xero] Fetching P&L for ${start} → ${end}`);

    const data   = await xeroGet('/Reports/ProfitAndLoss', { fromDate: start, toDate: end });
    const parsed = parseProfitAndLoss(data);

    await _pool.query(
      `INSERT INTO xero_financials
         (period_start, period_end, report_type, revenue, cogs, gross_profit, expenses, net_profit, raw_json)
       VALUES ($1,$2,'ProfitAndLoss',$3,$4,$5,$6,$7,$8)
       ON CONFLICT (period_start, period_end, report_type) DO UPDATE SET
         revenue      = EXCLUDED.revenue,
         cogs         = EXCLUDED.cogs,
         gross_profit = EXCLUDED.gross_profit,
         expenses     = EXCLUDED.expenses,
         net_profit   = EXCLUDED.net_profit,
         raw_json     = EXCLUDED.raw_json,
         synced_at    = NOW()`,
      [start, end, parsed.revenue, parsed.cogs, parsed.grossProfit,
       parsed.expenses, parsed.netProfit, JSON.stringify(data)]
    );

    synced.push({ month: start.slice(0, 7), ...parsed });
  }

  console.log(`[xero] Synced ${synced.length} months of P&L`);
  return { months: synced.length, data: synced };
}

// ── Status helpers ─────────────────────────────────────────────────
async function getConnectionStatus() {
  try {
    const tokens   = await getTokens();
    if (!tokens) return { connected: false };
    const tenantId = await getTenantId();
    if (!tenantId) return { connected: false };

    // Get tenant name from settings
    const { rows } = await _pool.query(
      `SELECT value FROM app_settings WHERE key = 'xero_tenant_name'`
    );
    return { connected: true, tenantName: rows[0]?.value || 'Connected' };
  } catch {
    return { connected: false };
  }
}

async function getLastSync() {
  if (!_pool) return null;
  const { rows } = await _pool.query(
    `SELECT MAX(synced_at) AS last_sync, COUNT(*) AS total_months FROM xero_financials`
  );
  return rows[0];
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(pool) {
  _pool = pool;
  const schedule = process.env.XERO_SYNC_CRON || '0 3 * * *'; // 3am daily
  cron.schedule(schedule, async () => {
    console.log('[xero] Cron fired — syncing last 2 months P&L');
    isRunning = true;
    try {
      lastResult = await syncProfitAndLoss(2);
    } catch (err) {
      console.error('[xero] Cron error:', err.message);
      lastResult = { error: err.message };
    } finally {
      isRunning = false;
      lastRun   = new Date();
    }
  });
  console.log(`[xero] Cron scheduled: ${schedule}`);
}

function getStatus() {
  return { isRunning, lastRun: lastRun?.toISOString() || null, lastResult };
}

module.exports = {
  startCron, syncProfitAndLoss, getConnectionStatus, getLastSync,
  getAuthUrl, handleOAuthCallback, getStatus,
};
