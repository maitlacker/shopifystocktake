const fetch     = require('node-fetch');
const cron      = require('node-cron');
const { pool }  = require('./db');

const ADS_VERSION    = process.env.GOOGLE_ADS_API_VERSION || 'v23';
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

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`Google Ads API returned non-JSON (status ${res.status}). First 200 chars: ${rawText.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`Google Ads API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
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

async function syncPmaxCoverage() {
  const today    = toDateStr(new Date());
  const weekAgo  = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = toDateStr(weekAgo);

  // Query shopping_performance_view — no channel type filter in WHERE (not supported),
  // select advertising_channel_type and filter PMAX in code instead
  const gaql = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      segments.product_item_id
    FROM shopping_performance_view
    WHERE metrics.impressions > 0
      AND segments.date BETWEEN '${weekAgoStr}' AND '${today}'
  `;

  console.log(`[pmax] Querying shopping_performance_view for ${weekAgoStr} → ${today}`);
  const results = await queryAds(gaql);
  console.log(`[pmax] Raw API rows returned: ${results.length}`);

  if (results.length > 0) {
    console.log('[pmax] Sample row:', JSON.stringify(results[0]));
  }

  // Count distinct product_item_id per PMAX campaign
  const campaignMap = {};
  let skippedNoProduct = 0;
  for (const row of results) {
    if (row.campaign?.advertisingChannelType !== 'PERFORMANCE_MAX') continue;
    const id            = String(row.campaign?.id || '');
    const name          = row.campaign?.name || '';
    const productItemId = row.segments?.productItemId || '';
    if (!id || !productItemId) { skippedNoProduct++; continue; }
    if (!campaignMap[id]) campaignMap[id] = { name, products: new Set() };
    campaignMap[id].products.add(productItemId);
  }

  console.log(`[pmax] PMAX campaigns with products: ${Object.keys(campaignMap).length}, rows skipped (no productItemId): ${skippedNoProduct}`);

  // Fallback: asset_group_listing_group_filter shows products ELIGIBLE in each PMAX asset group
  if (Object.keys(campaignMap).length === 0) {
    console.log('[pmax] No product data from shopping_performance_view — trying asset_group_listing_group_filter');
    const gaql2 = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        asset_group_listing_group_filter.type,
        asset_group_listing_group_filter.case_value.product_item_id.value
      FROM asset_group_listing_group_filter
      WHERE asset_group_listing_group_filter.type = 'UNIT_INCLUDED'
    `;
    const results2 = await queryAds(gaql2);
    console.log(`[pmax] asset_group_listing_group_filter rows: ${results2.length}`);
    if (results2.length > 0) {
      console.log('[pmax] Sample row (fallback):', JSON.stringify(results2[0]));
    }
    for (const row of results2) {
      if (row.campaign?.advertisingChannelType !== 'PERFORMANCE_MAX') continue;
      const id            = String(row.campaign?.id || '');
      const name          = row.campaign?.name || '';
      const productItemId = row.assetGroupListingGroupFilter?.caseValue?.productItemId?.value || '';
      if (!id || !productItemId) continue;
      if (!campaignMap[id]) campaignMap[id] = { name, products: new Set() };
      campaignMap[id].products.add(productItemId);
    }
    console.log(`[pmax] After fallback — PMAX campaigns with products: ${Object.keys(campaignMap).length}`);
  }

  // Fetch Shopify active product count
  let shopifyActive = null;
  try {
    const shopifyRes = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01/products/count.json?status=active`,
      { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN } }
    );
    if (shopifyRes.ok) {
      const data = await shopifyRes.json();
      shopifyActive = data.count ?? null;
    }
  } catch (err) {
    console.warn('[pmax] Could not fetch Shopify product count:', err.message);
  }

  // Upsert today's snapshot per campaign
  let upserted = 0;
  for (const [campaignId, { name, products }] of Object.entries(campaignMap)) {
    await pool.query(
      `INSERT INTO pmax_product_coverage
         (snapshot_date, campaign_id, campaign_name, products_serving, shopify_active)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (snapshot_date, campaign_id) DO UPDATE SET
         campaign_name    = EXCLUDED.campaign_name,
         products_serving = EXCLUDED.products_serving,
         shopify_active   = EXCLUDED.shopify_active,
         synced_at        = NOW()`,
      [today, campaignId, name, products.size, shopifyActive]
    );
    upserted++;
  }

  console.log(`[pmax] ${upserted} campaigns snapshotted, shopify_active=${shopifyActive}`);
  return { campaigns: upserted, shopifyActive, rawRows: results.length, skippedNoProduct };
}

// Runs the debug GAQL queries and returns raw results for inspection (no DB writes)
async function debugPmaxQuery() {
  const today    = toDateStr(new Date());
  const weekAgo  = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = toDateStr(weekAgo);

  const out = { dateRange: { from: weekAgoStr, to: today } };

  // Query 1: shopping_performance_view — all campaigns with impressions, filter PMAX in code
  try {
    const results1 = await queryAds(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        segments.product_item_id
      FROM shopping_performance_view
      WHERE metrics.impressions > 0
        AND segments.date BETWEEN '${weekAgoStr}' AND '${today}'
    `);
    const pmaxRows = results1.filter(r => r.campaign?.advertisingChannelType === 'PERFORMANCE_MAX');
    out.shoppingPerformanceView = {
      rowCount: results1.length,
      pmaxRowCount: pmaxRows.length,
      channelTypes: [...new Set(results1.map(r => r.campaign?.advertisingChannelType))],
      sample: results1.slice(0, 3),
      withProductId: results1.filter(r => r.segments?.productItemId).length,
    };
  } catch (err) {
    out.shoppingPerformanceView = { error: err.message };
  }

  // Query 2: asset_group_listing_group_filter — correct field path for product item ID
  try {
    const results2 = await queryAds(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        asset_group_listing_group_filter.type,
        asset_group_listing_group_filter.case_value.product_item_id.value
      FROM asset_group_listing_group_filter
      WHERE asset_group_listing_group_filter.type = 'UNIT_INCLUDED'
    `);
    const pmaxRows2 = results2.filter(r => r.campaign?.advertisingChannelType === 'PERFORMANCE_MAX');
    out.assetGroupListingGroupFilter = {
      rowCount: results2.length,
      pmaxRowCount: pmaxRows2.length,
      sample: results2.slice(0, 3),
      withProductId: results2.filter(r => r.assetGroupListingGroupFilter?.caseValue?.productItemId?.value).length,
    };
  } catch (err) {
    out.assetGroupListingGroupFilter = { error: err.message };
  }

  return out;
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

    const pmaxResult = await syncPmaxCoverage().catch((err) => {
      console.warn('[google-ads] PMAX coverage sync failed:', err.message);
      return null;
    });

    lastRunResult = { ...result, days, pmaxCoverage: pmaxResult };
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

module.exports = { runSync, syncPmaxCoverage, debugPmaxQuery, getStatus, startCron, getSetting, setSetting, getRefreshToken };
