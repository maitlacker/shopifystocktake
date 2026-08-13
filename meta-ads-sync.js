// meta-ads-sync.js — Meta (Facebook/Instagram) Ads data sync
'use strict';

const fetch = require('node-fetch');
const cron  = require('node-cron');

let _pool     = null;
let isRunning = false;
let lastRun   = null;
let lastResult = null;

const META_API_VERSION = process.env.META_API_VERSION || 'v21.0';
const BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ── Token helpers ──────────────────────────────────────────────────
async function getAccessToken() {
  // Check DB first, fall back to env var
  if (_pool) {
    const { rows } = await _pool.query(
      `SELECT value FROM app_settings WHERE key = 'meta_access_token'`
    );
    if (rows.length && rows[0].value) return rows[0].value;
  }
  return process.env.META_ACCESS_TOKEN || null;
}

async function saveAccessToken(token) {
  if (!_pool) return;
  await _pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('meta_access_token', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [token]
  );
}

// Exchange a short-lived token for a long-lived one (60 days)
async function exchangeForLongLivedToken(shortToken) {
  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const url = `${BASE_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(shortToken)}`;
  const res  = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || `Token exchange failed: ${res.status}`);
  return data.access_token;
}

// ── OAuth callback handler — call this from server.js ─────────────
async function handleOAuthCallback(code, redirectUri) {
  const appId     = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  // Exchange code for short-lived token
  const tokenUrl = `${BASE_URL}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`;
  const tokenRes  = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok || tokenData.error) throw new Error(tokenData.error?.message || 'Token exchange failed');

  // Immediately exchange for long-lived token
  const longToken = await exchangeForLongLivedToken(tokenData.access_token);
  await saveAccessToken(longToken);
  return longToken;
}

// ── Sync campaigns for a date range ───────────────────────────────
async function syncDateRange(daysBack = 30) {
  const token     = await getAccessToken();
  if (!token) throw new Error('Meta access token not configured — connect Meta Ads first');

  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID env var not set');

  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = new Date().toISOString().slice(0, 10);

  console.log(`[meta-ads] Syncing ${daysBack} days (${sinceStr} → ${untilStr})`);

  const fields = 'campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,reach,actions,action_values,purchase_roas';
  const url = `${BASE_URL}/act_${adAccountId}/insights?fields=${fields}&time_range={"since":"${sinceStr}","until":"${untilStr}"}&time_increment=1&level=adset&limit=500&access_token=${token}`;

  let allRows = [];
  let nextUrl = url;

  while (nextUrl) {
    const res  = await fetch(nextUrl);
    const data = await res.json();

    if (!res.ok || data.error) {
      // Token may have expired — clear it so user re-connects
      if (data.error?.code === 190) {
        await saveAccessToken('');
        throw new Error('Meta token expired — please reconnect Meta Ads on the Syncing page');
      }
      throw new Error(data.error?.message || `Meta API error ${res.status}`);
    }

    allRows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
  }

  console.log(`[meta-ads] Fetched ${allRows.length} daily rows`);

  // Upsert into DB
  let inserted = 0, updated = 0;
  for (const row of allRows) {
    // Extract purchase actions
    const purchaseAction = (row.actions || []).find(a => a.action_type === 'purchase');
    const purchaseValueAction = (row.action_values || []).find(a => a.action_type === 'purchase');
    const purchases     = parseFloat(purchaseAction?.value || 0);
    const purchaseValue = parseFloat(purchaseValueAction?.value || 0);

    const { rows: upsertRows } = await _pool.query(
      `INSERT INTO meta_ads_daily
         (campaign_id, campaign_name, adset_id, adset_name, date,
          spend, impressions, clicks, reach, purchases, purchase_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (campaign_id, date) DO UPDATE SET
         campaign_name  = EXCLUDED.campaign_name,
         adset_id       = EXCLUDED.adset_id,
         adset_name     = EXCLUDED.adset_name,
         spend          = EXCLUDED.spend,
         impressions    = EXCLUDED.impressions,
         clicks         = EXCLUDED.clicks,
         reach          = EXCLUDED.reach,
         purchases      = EXCLUDED.purchases,
         purchase_value = EXCLUDED.purchase_value,
         synced_at      = NOW()
       RETURNING (xmax = 0) AS was_inserted`,
      [
        row.campaign_id, row.campaign_name,
        row.adset_id || null, row.adset_name || null,
        row.date_start,
        parseFloat(row.spend || 0),
        parseInt(row.impressions || 0),
        parseInt(row.clicks || 0),
        parseInt(row.reach || 0),
        purchases, purchaseValue,
      ]
    );
    if (upsertRows[0]?.was_inserted) inserted++; else updated++;
  }

  console.log(`[meta-ads] Done — ${inserted} inserted, ${updated} updated`);
  return { rows: allRows.length, inserted, updated, daysBack };
}

// ── Ad browsing + ad-level insights (influencer campaign linking) ──

// List individual ads with creative thumbnails, optionally filtered by name
async function browseAds(q) {
  const token = await getAccessToken();
  if (!token) throw new Error('Meta not connected — connect Meta Ads on the Syncing page');
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID env var not set');

  const fields = 'id,name,status,effective_status,adset{id,name},campaign{id,name},creative{id,thumbnail_url}';
  let url = `${BASE_URL}/act_${adAccountId}/ads?fields=${encodeURIComponent(fields)}&limit=100&access_token=${token}`;
  if (q) {
    const filtering = JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: q }]);
    url += `&filtering=${encodeURIComponent(filtering)}`;
  }

  const ads = [];
  let nextUrl = url;
  let pages = 0;
  while (nextUrl && pages < 5) { // cap at 500 ads per browse
    const res  = await fetch(nextUrl);
    const data = await res.json();
    if (!res.ok || data.error) {
      if (data.error?.code === 190) { await saveAccessToken(''); throw new Error('Meta token expired — reconnect on the Syncing page'); }
      throw new Error(data.error?.message || `Meta API error ${res.status}`);
    }
    ads.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
    pages++;
  }

  return ads.map(a => ({
    ad_id: a.id,
    ad_name: a.name,
    status: a.effective_status || a.status,
    adset_id: a.adset?.id || null,
    adset_name: a.adset?.name || null,
    campaign_meta_id: a.campaign?.id || null,
    campaign_meta_name: a.campaign?.name || null,
    creative_id: a.creative?.id || null,
    creative_thumb_url: a.creative?.thumbnail_url || null,
  }));
}

// Daily ad-level insights for specific ads → influencer_ad_insights_daily
async function syncInfluencerAdInsights(adIds, daysBack = 7) {
  if (!_pool || !adIds || !adIds.length) return { rows: 0 };
  const token = await getAccessToken();
  if (!token) throw new Error('Meta not connected');
  const adAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID env var not set');

  const since = new Date();
  since.setDate(since.getDate() - daysBack);
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = new Date().toISOString().slice(0, 10);

  const fields = 'ad_id,ad_name,spend,impressions,clicks,reach,frequency,actions,action_values,' +
    'video_play_actions,video_thruplay_watched_actions,video_p100_watched_actions,ctr,cpc,cpm,attribution_setting';
  const num = (arr) => parseFloat((arr || []).find(x => x.action_type === 'video_view')?.value || 0) || null;

  let total = 0;
  // Meta filtering IN caps out — batch 40 ads per call
  for (let i = 0; i < adIds.length; i += 40) {
    const batch = adIds.slice(i, i + 40);
    const filtering = JSON.stringify([{ field: 'ad.id', operator: 'IN', value: batch }]);
    let url = `${BASE_URL}/act_${adAccountId}/insights?level=ad&fields=${encodeURIComponent(fields)}` +
      `&filtering=${encodeURIComponent(filtering)}` +
      `&time_range={"since":"${sinceStr}","until":"${untilStr}"}&time_increment=1&limit=500&access_token=${token}`;

    while (url) {
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) {
        if (data.error?.code === 190) { await saveAccessToken(''); throw new Error('Meta token expired — reconnect on the Syncing page'); }
        throw new Error(data.error?.message || `Meta API error ${res.status}`);
      }
      for (const row of (data.data || [])) {
        const purchases     = parseFloat((row.actions || []).find(a => a.action_type === 'purchase')?.value || 0);
        const purchaseValue = parseFloat((row.action_values || []).find(a => a.action_type === 'purchase')?.value || 0);
        await _pool.query(
          `INSERT INTO influencer_ad_insights_daily
             (ad_id, date, spend, impressions, clicks, reach, frequency,
              purchases, purchase_value, video_3s_views, thruplays, video_p100,
              ctr, cpc, cpm, attribution_setting, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
           ON CONFLICT (ad_id, date) DO UPDATE SET
             spend=EXCLUDED.spend, impressions=EXCLUDED.impressions, clicks=EXCLUDED.clicks,
             reach=EXCLUDED.reach, frequency=EXCLUDED.frequency, purchases=EXCLUDED.purchases,
             purchase_value=EXCLUDED.purchase_value, video_3s_views=EXCLUDED.video_3s_views,
             thruplays=EXCLUDED.thruplays, video_p100=EXCLUDED.video_p100,
             ctr=EXCLUDED.ctr, cpc=EXCLUDED.cpc, cpm=EXCLUDED.cpm,
             attribution_setting=EXCLUDED.attribution_setting, synced_at=NOW()`,
          [row.ad_id, row.date_start,
           parseFloat(row.spend || 0), parseInt(row.impressions || 0), parseInt(row.clicks || 0),
           parseInt(row.reach || 0), parseFloat(row.frequency || 0) || null,
           purchases, purchaseValue,
           num(row.video_play_actions),
           num(row.video_thruplay_watched_actions),
           num(row.video_p100_watched_actions),
           parseFloat(row.ctr || 0) || null, parseFloat(row.cpc || 0) || null, parseFloat(row.cpm || 0) || null,
           row.attribution_setting || null]
        );
        total++;
      }
      url = data.paging?.next || null;
    }
  }
  console.log(`[meta-ads] Influencer ad insights: ${total} daily rows for ${adIds.length} ads`);
  return { rows: total };
}

// ── Status helpers ─────────────────────────────────────────────────
async function getConnectionStatus() {
  const token = await getAccessToken();
  if (!token) return { connected: false };

  // Quick check: verify token is still valid
  try {
    const res  = await fetch(`${BASE_URL}/me?fields=id,name&access_token=${token}`);
    const data = await res.json();
    if (data.error?.code === 190) return { connected: false, expired: true };
    return { connected: true, name: data.name || 'Connected' };
  } catch {
    return { connected: false };
  }
}

async function getLastSync() {
  if (!_pool) return null;
  const { rows } = await _pool.query(
    `SELECT MAX(synced_at) AS last_sync, COUNT(*) AS total_rows FROM meta_ads_daily`
  );
  return rows[0];
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(pool) {
  _pool = pool;
  const schedule = process.env.META_SYNC_CRON || '30 2 * * *'; // 2:30am daily
  cron.schedule(schedule, async () => {
    console.log('[meta-ads] Cron fired — syncing last 7 days');
    isRunning = true;
    try {
      lastResult = await syncDateRange(7);
    } catch (err) {
      console.error('[meta-ads] Cron error:', err.message);
      lastResult = { error: err.message };
    } finally {
      isRunning = false;
      lastRun   = new Date();
    }
    // Refresh insights for ads linked to influencer campaigns
    try {
      const { rows } = await _pool.query('SELECT DISTINCT ad_id FROM influencer_campaign_ads');
      if (rows.length) await syncInfluencerAdInsights(rows.map(r => r.ad_id), 7);
    } catch (err) {
      console.error('[meta-ads] Influencer ad sync error:', err.message);
    }
  });
  console.log(`[meta-ads] Cron scheduled: ${schedule}`);
}

function getStatus() {
  return { isRunning, lastRun: lastRun?.toISOString() || null, lastResult };
}

module.exports = { startCron, syncDateRange, getConnectionStatus, getLastSync, handleOAuthCallback, getStatus, browseAds, syncInfluencerAdInsights };
