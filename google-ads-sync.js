const fetch     = require('node-fetch');
const cron      = require('node-cron');
const { pool }  = require('./db');

const ADS_VERSION    = process.env.GOOGLE_ADS_API_VERSION || 'v17';
const DAILY_CRON     = '0 2 * * *'; // 2am every day

let isRunning      = false;
let lastRun        = null;
let lastRunResult  = null;

// ── Settings helpers ───────────────────────────────────────────────
async function getSetting(key) {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_settings WHERE key = $1', [key]
    );
    return rows[0]?.value || null;
  } catch { return null; }
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

// ── Credentials ────────────────────────────────────────────────────
async function getRefreshToken() {
  return (await getSetting('google_ads_refresh_token'))
    || process.env.GOOGLE_ADS_REFRESH_TOKEN
    || null;
}

function getCustomerId() {
  return (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
}

async function isConfigured() {
  const token = await getRefreshToken();
  return !!(token && process.env.GOOGLE_ADS_DEVELOPER_TOKEN && getCustomerId());
}

// ── OAuth token refresh ────────────────────────────────────────────
async function getAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('Google Ads not connected — no refresh token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }).toString(),
  });

  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  return data.access_token;
}

// ── GAQL query ─────────────────────────────────────────────────────
async function queryAds(gaql) {
  const customerId  = getCustomerId();
  const accessToken = await getAccessToken();
  const devToken    = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const loginId     = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  const headers = {
    'Authorization':    `Bearer ${accessToken}`,
    'developer-token':  devToken,
    'Content-Type':     'application/json',
  };
  if (loginId) headers['login-customer-id'] = loginId.replace(/-/g, '');

  const allResults = [];
  let pageToken = null;

  do {
    const body = { query: gaql };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(
      `https://googleads.googleapis.com/${ADS_VERSION}/customers/${customerId}/googleAds:search`,
      { method: 'POST', headers, body: JSON.stringify(body) }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Google Ads API error: ${data.error?.message || JSON.stringify(data)}`);
    }

    if (data.results) allResults.push(...data.results);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allResults;
}

// ── Sync ───────────────────────────────────────────────────────────
function toDateStr(date) {
  return date.toISOString().split('T')[0];
}

async function syncDateRange(startDate, endDate) {
  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status != 'REMOVED'
    ORDER BY segments.date DESC, campaign.name ASC
  `;

  const results = await queryAds(gaql);
  let upserted = 0;

  for (const row of results) {
    const costMicros = Number(row.metrics?.costMicros || 0);
    await pool.query(
      `INSERT INTO google_ads_daily
         (campaign_id, campaign_name, campaign_status, date,
          impressions, clicks, cost, conversions, conversion_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (campaign_id, date) DO UPDATE SET
         campaign_name    = EXCLUDED.campaign_name,
         campaign_status  = EXCLUDED.campaign_status,
         impressions      = EXCLUDED.impressions,
         clicks           = EXCLUDED.clicks,
         cost             = EXCLUDED.cost,
         conversions      = EXCLUDED.conversions,
         conversion_value = EXCLUDED.conversion_value,
         synced_at        = NOW()`,
      [
        String(row.campaign?.id || ''),
        row.campaign?.name || '',
        row.campaign?.status || '',
        row.segments?.date,
        Number(row.metrics?.impressions || 0),
        Number(row.metrics?.clicks || 0),
        (costMicros / 1_000_000).toFixed(2),
        Number(row.metrics?.conversions || 0),
        Number(row.metrics?.conversionsValue || 0),
      ]
    );
    upserted++;
  }

  return { rows: results.length, upserted };
}

async function runSync(days = 7) {
  if (isRunning) return { skipped: true, reason: 'already running' };
  if (!await isConfigured()) throw new Error('Google Ads not configured');

  isRunning = true;
  const started = new Date();

  try {
    console.log(`[google-ads] Syncing last ${days} days…`);
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);

    const result = await syncDateRange(toDateStr(start), toDateStr(end));
    lastRunResult = { ...result, days };
    lastRun       = started;
    console.log(`[google-ads] Done — ${result.upserted} rows upserted`);
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

// ── Status ─────────────────────────────────────────────────────────
async function getStatus() {
  return {
    configured:    await isConfigured(),
    isRunning,
    lastRun,
    lastRunResult,
    dailyCron:     DAILY_CRON,
  };
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron() {
  cron.schedule(DAILY_CRON, async () => {
    if (!await isConfigured()) return;
    runSync(2).catch((err) => console.error('[google-ads] Cron error:', err.message));
  });
  console.log(`[google-ads] Daily sync cron scheduled: ${DAILY_CRON}`);
}

module.exports = { runSync, getStatus, startCron, getSetting, setSetting, getRefreshToken };
