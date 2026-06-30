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
  const scopes   = 'openid offline_access accounting.reports.profitandloss.read accounting.reports.balancesheet.read';
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

  const INCOME_KEYWORDS = ['income', 'revenue', 'trading income', 'sales'];
  const COGS_KEYWORDS   = [
    'cost of sales', 'direct costs', 'cogs', 'cost of goods',
    'cost of revenue', 'purchases', 'less cost',
  ];

  let xeroGrossProfit = null;
  let xeroNetProfit   = null;

  // Extract the best numeric value from a section (prefers SummaryRow, falls back to Row)
  function extractSectionValue(section) {
    const summaryRow = (section.Rows || []).find(r => r.RowType === 'SummaryRow');
    if (summaryRow?.Cells?.length >= 2) return parseFloat(summaryRow.Cells[1]?.Value || 0);
    const row = (section.Rows || []).find(r => r.RowType === 'Row');
    if (row?.Cells?.length >= 2) return parseFloat(row.Cells[1]?.Value || 0);
    return null;
  }

  for (const section of rows) {
    if (!section.Title) continue;
    const title = section.Title.toLowerCase().trim();

    // Capture Xero's own derived figures (authoritative — avoid recomputing them)
    if (title.includes('gross profit') || title.includes('gross loss')) {
      const val = extractSectionValue(section);
      if (val !== null) xeroGrossProfit = val;
      console.log(`[xero-parse] Gross Profit section "${section.Title}" → ${val}`);
      continue;
    }
    if (title.includes('net profit') || title.includes('net loss') || title.includes('net income')) {
      const val = extractSectionValue(section);
      if (val !== null) xeroNetProfit = val;
      console.log(`[xero-parse] Net Profit section "${section.Title}" → ${val}`);
      continue;
    }

    // Use SummaryRow total for all non-derived sections
    const summaryRow = (section.Rows || []).find(r => r.RowType === 'SummaryRow');
    if (!summaryRow?.Cells || summaryRow.Cells.length < 2) continue;
    const total = Math.abs(parseFloat(summaryRow.Cells[1]?.Value || 0));

    if (INCOME_KEYWORDS.some(k => title.includes(k))) {
      console.log(`[xero-parse] INCOME section "${section.Title}" → ${total}`);
      result.revenue += total;
    } else if (COGS_KEYWORDS.some(k => title.includes(k))) {
      console.log(`[xero-parse] COGS section "${section.Title}" → ${total}`);
      result.cogs += total;
    } else {
      console.log(`[xero-parse] EXPENSES section "${section.Title}" → ${total}`);
      result.expenses += total;
    }
  }

  // Prefer Xero's computed Gross Profit; if not available, compute from Revenue - COGS
  if (xeroGrossProfit !== null) {
    result.grossProfit = xeroGrossProfit;
    // If we didn't detect a COGS section by keyword, back-compute from Xero's figures
    if (result.cogs === 0 && result.revenue > 0) {
      result.cogs = result.revenue - xeroGrossProfit;
      console.log(`[xero-parse] COGS back-computed from Revenue - GrossProfit = ${result.cogs}`);
    }
  } else {
    result.grossProfit = result.revenue - result.cogs;
  }

  result.netProfit = xeroNetProfit !== null ? xeroNetProfit : result.grossProfit - result.expenses;

  console.log(`[xero-parse] Final: revenue=${result.revenue} cogs=${result.cogs} gp=${result.grossProfit} exp=${result.expenses} np=${result.netProfit}`);
  return result;
}

// ── Extract individual P&L line items (account-level detail) ───────
function parsePLLines(report) {
  const sections = report.Reports?.[0]?.Rows || [];
  const lines = [];

  for (const section of sections) {
    if (section.RowType !== 'Section' || !section.Title) continue;
    const sectionTitle = section.Title.trim();

    for (const row of (section.Rows || [])) {
      if (row.RowType !== 'Row') continue;
      const cells = row.Cells || [];
      if (cells.length < 2) continue;

      const accountName = (cells[0]?.Value || '').trim();
      const rawValue    = cells[1]?.Value;
      if (!accountName || rawValue === '' || rawValue == null) continue;

      const value = parseFloat(rawValue);
      if (isNaN(value)) continue;

      lines.push({ section: sectionTitle, account_name: accountName, value });
    }
  }

  return lines;
}

// ── Extract Balance Sheet line items ───────────────────────────────
function parseBSLines(report) {
  const topRows = report.Reports?.[0]?.Rows || [];
  const lines   = [];

  for (const section of topRows) {
    if (section.RowType !== 'Section' || !section.Title) continue;
    const sectionTitle = section.Title.trim();

    for (const row of (section.Rows || [])) {
      // Xero balance sheet has nested sections (e.g. "Current Assets" inside "Assets")
      if (row.RowType === 'Section') {
        const subsectionTitle = (row.Title || '').trim() || null;
        for (const subrow of (row.Rows || [])) {
          if (subrow.RowType !== 'Row') continue;
          const cells = subrow.Cells || [];
          if (cells.length < 2) continue;
          const accountName = (cells[0]?.Value || '').trim();
          const rawValue    = cells[1]?.Value;
          if (!accountName || rawValue === '' || rawValue == null) continue;
          const value = parseFloat(rawValue);
          if (isNaN(value)) continue;
          lines.push({ section: sectionTitle, subsection: subsectionTitle, account_name: accountName, value });
        }
        continue;
      }

      if (row.RowType !== 'Row') continue;
      const cells = row.Cells || [];
      if (cells.length < 2) continue;
      const accountName = (cells[0]?.Value || '').trim();
      const rawValue    = cells[1]?.Value;
      if (!accountName || rawValue === '' || rawValue == null) continue;
      const value = parseFloat(rawValue);
      if (isNaN(value)) continue;
      lines.push({ section: sectionTitle, subsection: null, account_name: accountName, value });
    }
  }

  return lines;
}

// ── Sync P&L for a given month range (summaries + line items) ─────
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

    // Save top-level summary
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

    // Save individual account line items
    const lines = parsePLLines(data);
    for (const line of lines) {
      await _pool.query(
        `INSERT INTO xero_pl_lines (period_start, period_end, section, account_name, value)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (period_start, section, account_name) DO UPDATE SET
           value     = EXCLUDED.value,
           synced_at = NOW()`,
        [start, end, line.section, line.account_name, line.value]
      );
    }
    console.log(`[xero] Saved ${lines.length} P&L line items for ${start}`);

    synced.push({ month: start.slice(0, 7), ...parsed, lineItems: lines.length });
  }

  console.log(`[xero] Synced ${synced.length} months of P&L`);
  return { months: synced.length, data: synced };
}

// ── Sync Balance Sheet (point-in-time snapshot) ────────────────────
async function syncBalanceSheet() {
  const tenantId = await getTenantId();
  if (!tenantId) throw new Error('Xero not connected');

  const today = new Date().toISOString().slice(0, 10);
  console.log(`[xero] Fetching Balance Sheet as at ${today}`);

  const data  = await xeroGet('/Reports/BalanceSheet', { date: today });
  const lines = parseBSLines(data);

  for (const line of lines) {
    await _pool.query(
      `INSERT INTO xero_balance_sheet (report_date, section, subsection, account_name, value)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (report_date, section, account_name) DO UPDATE SET
         subsection = EXCLUDED.subsection,
         value      = EXCLUDED.value,
         synced_at  = NOW()`,
      [today, line.section, line.subsection, line.account_name, line.value]
    );
  }

  console.log(`[xero] Balance Sheet synced — ${lines.length} line items as at ${today}`);
  return { date: today, lines: lines.length };
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
  startCron, syncProfitAndLoss, syncBalanceSheet,
  getConnectionStatus, getLastSync,
  getAuthUrl, handleOAuthCallback, getStatus,
};
