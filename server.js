require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const session      = require('express-session');
const PgSession    = require('connect-pg-simple')(session);

const cron             = require('node-cron');
const { pool, initDb }               = require('./db');
const { configureAuth, requireAuth } = require('./auth');
const { startCron, runStockCheck, getStatus: getAlertStatus } = require('./alerts');
const googleAds        = require('./google-ads-sync');
const shopifyAnalytics = require('./shopify-analytics');
const labelMatcher     = require('./label-matcher');
const Anthropic        = require('@anthropic-ai/sdk');
const ideasCron        = require('./ideas-cron');
const metaAds          = require('./meta-ads-sync');
const xeroSync         = require('./xero-sync');
const weeklyPulse      = require('./weekly-pulse');
const opsSync          = require('./ops-sync');
const restockSync      = require('./restock-sync');
const stockValueSync   = require('./stock-value-sync');
const adsAssetSync     = require('./google-ads-asset-sync');
const arcadsSync       = require('./arcads-sync');
const leaveSync        = require('./leave-sync');
const mailer           = require('./email');

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const app = express();

// Trust Railway's reverse proxy so secure cookies work over HTTPS
app.set('trust proxy', 1);

// ── Sessions ───────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   isProduction,
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
    sameSite: 'lax',
  },
}));

// ── Auth ───────────────────────────────────────────────────────────
configureAuth(app);
app.use(requireAuth);

// ── Static + body parsing ──────────────────────────────────────────
// Serve login.html without auth (requireAuth already exempts /login)
app.use(express.static('public'));
app.use(express.json({ limit: '5mb' }));

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

let productsCache = [];
let lastFetched   = null;

// ── History helpers (PostgreSQL) ───────────────────────────────────
async function readHistory() {
  const { rows } = await pool.query(
    'SELECT product_id AS "productId", product_title AS "productTitle", initials, created_at AS "timestamp" FROM stocktake_history ORDER BY created_at DESC'
  );
  return rows;
}

async function appendHistory(entry) {
  await pool.query(
    'INSERT INTO stocktake_history (product_id, product_title, initials, created_at) VALUES ($1, $2, $3, $4)',
    [entry.productId, entry.productTitle, entry.initials, entry.timestamp]
  );
}

// ── Shopify ────────────────────────────────────────────────────────
function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function fetchAllProducts() {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=active&fields=id,title,variants,images`;

  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    products.push(...data.products);

    const linkHeader = res.headers.get('link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return products;
}

async function fetchInventoryCosts(inventoryItemIds) {
  const costs = {};
  const ids = [...inventoryItemIds];
  const totalBatches = Math.ceil(ids.length / 100);
  console.log(`[costs] fetching costs for ${ids.length} inventory items in ${totalBatches} batches`);

  for (let i = 0; i < ids.length; i += 100) {
    const batchNum = i / 100 + 1;
    const batch = ids.slice(i, i + 100).join(',');
    const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/inventory_items.json?ids=${batch}&limit=100&fields=id,cost`;

    let attempts = 0;
    while (attempts < 3) {
      try {
        const res = await fetch(url, { headers: shopifyHeaders() });
        if (res.status === 429) {
          const retryAfter = parseFloat(res.headers.get('retry-after') || '2');
          console.warn(`[costs] batch ${batchNum} rate limited, retrying after ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          attempts++;
          continue;
        }
        if (!res.ok) {
          const body = await res.text();
          console.warn(`[costs] batch ${batchNum} failed (${res.status}): ${body.slice(0, 200)}`);
          break;
        }
        const data = await res.json();
        const withCost = (data.inventory_items || []).filter((item) => item.cost != null);
        console.log(`[costs] batch ${batchNum}/${totalBatches}: ${withCost.length}/${data.inventory_items?.length ?? 0} items have cost`);
        for (const item of withCost) {
          costs[String(item.id)] = parseFloat(item.cost);
        }
        break;
      } catch (err) {
        console.warn(`[costs] batch ${batchNum} error:`, err.message);
        break;
      }
    }

    if (i + 100 < ids.length) await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[costs] done — ${Object.keys(costs).length} variants with cost`);
  return costs;
}

// ── Margin Tagger helpers ──────────────────────────────────────────
async function getMarginThresholds() {
  const { rows } = await pool.query(
    `SELECT key, value FROM app_settings WHERE key IN ('margin_low_max','margin_high_min')`
  );
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return {
    lowMax:  parseFloat(s.margin_low_max  ?? '25'),
    highMin: parseFloat(s.margin_high_min ?? '50'),
  };
}

function calcMarginTier(markup, lowMax, highMin) {
  if (markup == null) return 'UNKNOWN';
  if (markup >= highMin) return 'HIGH';
  if (markup >= lowMax)  return 'MEDIUM';
  return 'LOW';
}

async function recalcMarginTiers() {
  const { lowMax, highMin } = await getMarginThresholds();

  productsCache = await fetchAllProducts();
  lastFetched   = new Date();

  // Map inventoryItemId → { variant, product }
  const invMap = {};
  for (const p of productsCache) {
    for (const v of p.variants) {
      if (v.inventory_item_id) {
        invMap[String(v.inventory_item_id)] = { v, p };
      }
    }
  }

  const costs = await fetchInventoryCosts(Object.keys(invMap));

  let upserted = 0;
  for (const [invItemId, { v, p }] of Object.entries(invMap)) {
    const cost      = costs[invItemId] ?? null;
    const sellPrice = v.price ? parseFloat(v.price) : null;
    const markup    = (cost != null && sellPrice != null)
      ? Math.round((sellPrice - cost) * 100) / 100
      : null;
    const tier = calcMarginTier(markup, lowMax, highMin);

    await pool.query(`
      INSERT INTO margin_tags
        (product_id, variant_id, product_title, variant_title, sku,
         cost_price, sell_price, markup, margin_tier, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (variant_id) DO UPDATE SET
        product_title = EXCLUDED.product_title,
        variant_title = EXCLUDED.variant_title,
        sku           = EXCLUDED.sku,
        cost_price    = EXCLUDED.cost_price,
        sell_price    = EXCLUDED.sell_price,
        markup        = EXCLUDED.markup,
        margin_tier   = EXCLUDED.margin_tier,
        synced_at     = NOW()
    `, [p.id, v.id, p.title, v.title || null, v.sku || null,
        cost, sellPrice, markup, tier]);
    upserted++;
  }

  console.log(`[margin] recalc done — ${upserted} variants | LOW<$${lowMax} MEDIUM<$${highMin} HIGH>=$${highMin}`);
  return { upserted, lowMax, highMin };
}

// ── Discrepancy routes ─────────────────────────────────────────────
app.get('/api/discrepancies', async (req, res) => {
  const { status, q } = req.query;
  let where = [];
  const params = [];

  if (status === 'unreviewed') { params.push(false); where.push(`reviewed = $${params.length}`); }
  if (status === 'reviewed')   { params.push(true);  where.push(`reviewed = $${params.length}`); }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(product_title) LIKE $${params.length} OR LOWER(sku) LIKE $${params.length})`);
  }

  const sql = `
    SELECT id, product_id AS "productId", product_title AS "productTitle",
           variant_id AS "variantId", variant_title AS "variantTitle",
           sku, system_qty AS "systemQty", counted_qty AS "countedQty",
           difference, initials, created_at AS "createdAt",
           reviewed, reviewed_at AS "reviewedAt", reviewed_by AS "reviewedBy"
    FROM stocktake_discrepancies
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

app.get('/api/discrepancies/summary', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                        AS total,
      COUNT(*) FILTER (WHERE NOT reviewed)            AS unreviewed,
      COUNT(*) FILTER (WHERE reviewed)                AS reviewed,
      COUNT(*) FILTER (WHERE difference < 0)          AS short,
      COUNT(*) FILTER (WHERE difference > 0)          AS over,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last7days
    FROM stocktake_discrepancies
  `);
  res.json(rows[0]);
});

app.post('/api/discrepancies/:id/review', async (req, res) => {
  const { id } = req.params;
  const { reviewedBy } = req.body;
  const { rows } = await pool.query(
    `UPDATE stocktake_discrepancies
     SET reviewed = true, reviewed_at = NOW(), reviewed_by = $1
     WHERE id = $2 AND reviewed = false
     RETURNING id`,
    [reviewedBy || 'Unknown', id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Not found or already reviewed' });
  res.json({ ok: true });
});

app.post('/api/discrepancies/review-all', async (req, res) => {
  const { reviewedBy, ids } = req.body;
  if (!ids || !ids.length) return res.status(400).json({ error: 'ids required' });
  const { rowCount } = await pool.query(
    `UPDATE stocktake_discrepancies
     SET reviewed = true, reviewed_at = NOW(), reviewed_by = $1
     WHERE id = ANY($2::int[]) AND reviewed = false`,
    [reviewedBy || 'Unknown', ids]
  );
  res.json({ ok: true, updated: rowCount });
});

// ── Stock alert routes ─────────────────────────────────────────────
app.get('/api/alerts/status', (req, res) => {
  res.json(getAlertStatus());
});

app.post('/api/alerts/run', async (req, res) => {
  try {
    const result = await runStockCheck();
    res.json(result);
  } catch (err) {
    console.error('Manual alert run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alerts/recent', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, variant_id AS "variantId", product_title AS "productTitle",
             variant_title AS "variantTitle", sku, stock_at_alert AS "stockAtAlert",
             alerted_at AS "alertedAt", resolved, resolved_at AS "resolvedAt"
      FROM stock_alerts
      ORDER BY alerted_at DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Shopify Analytics routes ───────────────────────────────────────
app.get('/api/shopify-analytics/status', (req, res) => {
  res.json(shopifyAnalytics.getStatus());
});

app.post('/api/shopify-analytics/sync', async (req, res) => {
  const days = Math.min(parseInt(req.body.days) || 90, 365);
  try {
    const result = await shopifyAnalytics.runSync(days);
    res.json(result);
  } catch (err) {
    console.error('Shopify analytics sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shopify-analytics/daily', async (req, res) => {
  try {
    let whereClause, params;
    if (req.query.start && req.query.end) {
      whereClause = `date >= $1 AND date <= $2`;
      params = [req.query.start, req.query.end];
    } else {
      const days = Math.min(parseInt(req.query.days) || 30, 365);
      whereClause = `date >= CURRENT_DATE - ($1::int)`;
      params = [days];
    }
    const { rows } = await pool.query(
      `SELECT date, revenue, orders, items_sold AS "itemsSold", sessions
       FROM shopify_daily
       WHERE ${whereClause}
       ORDER BY date ASC`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Ads OAuth connect ───────────────────────────────────────
app.get('/auth/google-ads/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${process.env.APP_URL}/auth/google-ads/callback`,
    response_type: 'code',
    scope:         'https://www.googleapis.com/auth/adwords',
    access_type:   'offline',
    prompt:        'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google-ads/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/syncing.html?ads_error=${encodeURIComponent(error)}`);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  `${process.env.APP_URL}/auth/google-ads/callback`,
        grant_type:    'authorization_code',
      }).toString(),
    });
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      return res.redirect('/syncing.html?ads_error=no_refresh_token');
    }
    await googleAds.setSetting('google_ads_refresh_token', tokens.refresh_token);
    res.redirect('/syncing.html?ads_connected=1');
  } catch (err) {
    console.error('Google Ads OAuth error:', err.message);
    res.redirect(`/syncing.html?ads_error=${encodeURIComponent(err.message)}`);
  }
});

// ── Google Ads API routes ──────────────────────────────────────────
app.get('/api/google-ads/status', async (req, res) => {
  res.json(await googleAds.getStatus());
});

app.post('/api/google-ads/sync', async (req, res) => {
  const days = Math.min(parseInt(req.body.days) || 7, 365);
  try {
    const result = await googleAds.runSync(days);
    res.json(result);
  } catch (err) {
    console.error('Google Ads sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google-ads/campaigns', async (req, res) => {
  try {
    const days   = Math.min(parseInt(req.query.days) || 30, 365);
    const { rows } = await pool.query(`
      SELECT
        campaign_id     AS "campaignId",
        campaign_name   AS "campaignName",
        campaign_status AS "campaignStatus",
        SUM(impressions)       AS impressions,
        SUM(clicks)            AS clicks,
        SUM(cost)              AS cost,
        SUM(conversions)       AS conversions,
        SUM(conversion_value)  AS "conversionValue",
        CASE WHEN SUM(cost) > 0
          THEN ROUND((SUM(conversion_value) / SUM(cost))::numeric, 2)
          ELSE 0
        END AS roas,
        CASE WHEN SUM(impressions) > 0
          THEN ROUND((SUM(clicks)::numeric / SUM(impressions) * 100), 2)
          ELSE 0
        END AS ctr,
        CASE WHEN SUM(clicks) > 0
          THEN ROUND((SUM(cost) / SUM(clicks))::numeric, 2)
          ELSE 0
        END AS cpc,
        MAX(date) AS "lastDate"
      FROM google_ads_daily
      WHERE date >= CURRENT_DATE - ($1::int)
      GROUP BY campaign_id, campaign_name, campaign_status
      ORDER BY SUM(cost) DESC
    `, [days]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google-ads/summary', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const { rows } = await pool.query(`
      SELECT
        SUM(impressions)      AS impressions,
        SUM(clicks)           AS clicks,
        SUM(cost)             AS cost,
        SUM(conversions)      AS conversions,
        SUM(conversion_value) AS "conversionValue",
        CASE WHEN SUM(cost) > 0
          THEN ROUND((SUM(conversion_value) / SUM(cost))::numeric, 2)
          ELSE 0
        END AS roas,
        COUNT(DISTINCT campaign_id) AS campaigns,
        MIN(date) AS "fromDate",
        MAX(date) AS "toDate"
      FROM google_ads_daily
      WHERE date >= CURRENT_DATE - ($1::int)
    `, [days]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google-ads/daily', async (req, res) => {
  try {
    let whereClause, params;
    if (req.query.start && req.query.end) {
      whereClause = `date >= $1 AND date <= $2`;
      params = [req.query.start, req.query.end];
    } else {
      const days = Math.min(parseInt(req.query.days) || 30, 365);
      whereClause = `date >= CURRENT_DATE - ($1::int)`;
      params = [days];
    }

    const { rows } = await pool.query(`
      SELECT
        date,
        SUM(impressions)      AS impressions,
        SUM(clicks)           AS clicks,
        SUM(cost)             AS cost,
        SUM(conversions)      AS conversions,
        SUM(conversion_value) AS "conversionValue",
        CASE WHEN SUM(cost) > 0
          THEN ROUND((SUM(conversion_value) / SUM(cost))::numeric, 2)
          ELSE 0
        END AS roas
      FROM google_ads_daily
      WHERE ${whereClause}
      GROUP BY date
      ORDER BY date ASC
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run PMAX coverage sync standalone — GET so it's easy to trigger from browser
app.get('/api/google-ads/pmax-sync', async (req, res) => {
  try {
    const result = await googleAds.syncPmaxCoverage();
    res.json(result);
  } catch (err) {
    console.error('[pmax] Manual sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/google-ads/pmax-sync', async (req, res) => {
  try {
    const result = await googleAds.syncPmaxCoverage();
    res.json(result);
  } catch (err) {
    console.error('[pmax] Manual sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — GAQL queries + DB state check
app.get('/api/google-ads/pmax-debug', async (req, res) => {
  try {
    const result = await googleAds.debugPmaxQuery();

    // Check what's actually in the DB
    const { rows: dbRows } = await pool.query(`
      SELECT
        COUNT(*)                  AS total_rows,
        COUNT(DISTINCT campaign_id) AS campaigns,
        MIN(snapshot_date)        AS earliest,
        MAX(snapshot_date)        AS latest
      FROM pmax_product_coverage
    `);
    result.database = dbRows[0];

    // Show last 10 DB rows
    const { rows: recent } = await pool.query(`
      SELECT snapshot_date, campaign_name, products_serving, shopify_active
      FROM pmax_product_coverage
      ORDER BY snapshot_date DESC, campaign_name ASC
      LIMIT 10
    `);
    result.databaseRecentRows = recent;

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/google-ads/pmax-coverage', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const { rows } = await pool.query(`
      SELECT
        snapshot_date    AS "snapshotDate",
        campaign_id      AS "campaignId",
        campaign_name    AS "campaignName",
        products_serving AS "productsServing",
        shopify_active   AS "shopifyActive",
        synced_at        AS "syncedAt"
      FROM pmax_product_coverage
      WHERE snapshot_date >= CURRENT_DATE - ($1::int)
      ORDER BY snapshot_date DESC, campaign_name ASC
    `, [days]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Label reference images ────────────────────────────────────────

// Summary list — all SKUs that have reference images, counts only (no image_data)
app.get('/api/label/references', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        sku,
        product_id      AS "productId",
        product_title   AS "productTitle",
        variant_title   AS "variantTitle",
        COUNT(*)::int   AS count,
        MAX(created_at) AS "lastAdded"
      FROM sku_reference_images
      GROUP BY sku, product_id, product_title, variant_title
      ORDER BY product_title ASC, sku ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Images for a specific SKU — includes image_data (for display + Phase 4 matching)
app.get('/api/label/references/images', async (req, res) => {
  const { sku } = req.query;
  if (!sku) return res.status(400).json({ error: 'sku query param required' });
  try {
    const { rows } = await pool.query(`
      SELECT id, sku, image_label AS "imageLabel", image_data AS "imageData",
             uploaded_by AS "uploadedBy", created_at AS "createdAt"
      FROM sku_reference_images
      WHERE sku = $1
      ORDER BY created_at ASC
    `, [sku]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a new reference image
app.post('/api/label/references', async (req, res) => {
  const { sku, productId, productTitle, variantTitle, imageData, imageLabel } = req.body;

  if (!sku || !sku.trim()) return res.status(400).json({ error: 'sku is required' });
  if (!imageData)          return res.status(400).json({ error: 'imageData is required' });
  if (!imageData.startsWith('data:image/'))
    return res.status(400).json({ error: 'imageData must be a valid image data URL' });
  if (imageData.length > 600_000)
    return res.status(400).json({ error: 'Image too large — please ensure it is compressed before uploading (max ~450KB)' });

  try {
    const { rows } = await pool.query(`
      INSERT INTO sku_reference_images
        (sku, product_id, product_title, variant_title, image_data, image_label, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      sku.trim(),
      productId   || null,
      productTitle || null,
      variantTitle || null,
      imageData,
      (imageLabel || '').trim() || null,
      req.user.email,
    ]);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a reference image
app.delete('/api/label/references/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM sku_reference_images WHERE id = $1', [id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI Label Matching (Phase 4) ────────────────────────────────────

// Match a label photo against known products
app.post('/api/label/match', async (req, res) => {
  const { imageData } = req.body;
  if (!imageData) return res.status(400).json({ error: 'imageData is required' });
  if (!imageData.startsWith('data:image/'))
    return res.status(400).json({ error: 'imageData must be a valid image data URL' });
  if (imageData.length > 600_000)
    return res.status(400).json({ error: 'Image too large — compress before sending (max ~450KB)' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on this server' });
  }

  try {
    const result = await labelMatcher.matchLabel(imageData);
    res.json(result);
  } catch (err) {
    console.error('[label-match] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scan Log (Phase 6) ────────────────────────────────────────────

// Save a scan result to the log
app.post('/api/scan/log', async (req, res) => {
  const {
    sku, productTitle, variantTitle, confidence,
    method, reasoning, confirmed, confirmedSku,
  } = req.body;

  try {
    const { rows } = await pool.query(
      `INSERT INTO scan_log
         (user_email, user_name, sku, product_title, variant_title,
          confidence, method, reasoning, confirmed, confirmed_sku)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        req.user.email,
        req.user.displayName || req.user.email,
        sku        || null,
        productTitle || null,
        variantTitle || null,
        confidence != null ? Number(confidence).toFixed(2) : null,
        method     || null,
        reasoning  || null,
        confirmed  ? true : false,
        confirmedSku || null,
      ]
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('[scan-log] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Scan history — last 200 scans
app.get('/api/scan/history', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const { rows } = await pool.query(
      `SELECT
         id,
         user_name      AS "userName",
         user_email     AS "userEmail",
         sku,
         product_title  AS "productTitle",
         variant_title  AS "variantTitle",
         confidence,
         method,
         reasoning,
         confirmed,
         confirmed_sku  AS "confirmedSku",
         scanned_at     AS "scannedAt"
       FROM scan_log
       WHERE scanned_at >= CURRENT_DATE - ($1::int)
       ORDER BY scanned_at DESC
       LIMIT 200`,
      [days]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Picking metrics ───────────────────────────────────────────────
const PICKING_REPORT_EMAIL = 'accounts@theselfstyler.com';

app.post('/api/picking/session', async (req, res) => {
  const {
    initials, orderStart, orderEnd, orderCount, itemCount,
    picksCompleted, avgPickSeconds, activeSeconds, excludedGaps,
    firstPickAt, lastPickAt,
  } = req.body;

  if (!picksCompleted || picksCompleted < 2) {
    return res.json({ ok: true, skipped: true });   // not enough data to be useful
  }

  try {
    await pool.query(
      `INSERT INTO picking_sessions
         (user_email, user_name, initials, order_start, order_end, order_count,
          item_count, picks_completed, avg_pick_seconds, active_seconds,
          excluded_gaps, first_pick_at, last_pick_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        req.user.email,
        req.user.displayName || req.user.email,
        (initials || '').toUpperCase().trim() || null,
        orderStart, orderEnd, orderCount || 0, itemCount || 0,
        picksCompleted,
        avgPickSeconds != null ? Number(avgPickSeconds).toFixed(2) : null,
        activeSeconds  != null ? Math.round(activeSeconds) : null,
        excludedGaps   || 0,
        firstPickAt    || null,
        lastPickAt     || null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[picking] Session save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/picking/report', async (req, res) => {
  if (req.user.email !== PICKING_REPORT_EMAIL) {
    return res.status(403).json({ error: 'Access restricted to accounts@theselfstyler.com' });
  }
  try {
    // Per-user summary
    const { rows: users } = await pool.query(`
      SELECT
        user_email                                      AS "userEmail",
        user_name                                       AS "userName",
        COALESCE(MAX(initials), '')                     AS initials,
        COUNT(*)::int                                   AS sessions,
        SUM(picks_completed)::int                       AS totalPicks,
        SUM(item_count)::int                            AS totalItems,
        ROUND(AVG(avg_pick_seconds)::numeric, 1)        AS "avgPickSeconds",
        ROUND(MIN(avg_pick_seconds)::numeric, 1)        AS "bestPickSeconds",
        MAX(created_at)                                 AS "lastSession"
      FROM picking_sessions
      GROUP BY user_email, user_name
      ORDER BY AVG(avg_pick_seconds) ASC NULLS LAST
    `);

    // All sessions
    const { rows: sessions } = await pool.query(`
      SELECT
        id,
        user_name        AS "userName",
        user_email       AS "userEmail",
        initials,
        order_start      AS "orderStart",
        order_end        AS "orderEnd",
        order_count      AS "orderCount",
        item_count       AS "itemCount",
        picks_completed  AS "picksCompleted",
        avg_pick_seconds AS "avgPickSeconds",
        active_seconds   AS "activeSeconds",
        excluded_gaps    AS "excludedGaps",
        first_pick_at    AS "firstPickAt",
        last_pick_at     AS "lastPickAt",
        created_at       AS "createdAt"
      FROM picking_sessions
      ORDER BY created_at DESC
      LIMIT 200
    `);

    res.json({ users, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Order Picking ─────────────────────────────────────────────────
app.get('/api/picking/orders', async (req, res) => {
  const start = parseInt(req.query.start);
  const end   = parseInt(req.query.end);

  if (!start || !end || isNaN(start) || isNaN(end) || start > end) {
    return res.status(400).json({ error: 'Valid start and end order numbers required' });
  }
  if (end - start > 500) {
    return res.status(400).json({ error: 'Range too large — max 500 orders at once' });
  }

  try {
    // Auto-populate products cache if empty (clears on every server restart)
    if (!productsCache.length) {
      productsCache = await fetchAllProducts();
      lastFetched   = new Date();
    }

    // Build variant→image and variant→stock maps from products cache
    const variantImageMap = {};
    const variantStockMap = {};
    for (const p of productsCache) {
      const productImg = p.images?.[0]?.src || null;
      for (const v of p.variants) {
        const variantImg = p.images?.find(img => img.id === v.image_id)?.src || productImg;
        variantImageMap[String(v.id)] = variantImg;
        variantStockMap[String(v.id)] = v.inventory_quantity ?? null;
      }
    }

    // Fetch orders from Shopify (newest first), stop once order_number < start
    const items = [];
    const orderNumbersSeen = new Set();
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=any&limit=250&fields=id,name,order_number,line_items,note`;
    let done = false;

    while (url && !done) {
      const r = await fetch(url, { headers: shopifyHeaders() });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Shopify API error ${r.status}: ${body.slice(0, 200)}`);
      }
      const data = await r.json();

      for (const order of data.orders) {
        if (order.order_number < start) { done = true; break; }
        if (order.order_number > end) continue;

        orderNumbersSeen.add(order.order_number);

        for (const item of (order.line_items || [])) {
          // x-redo is a shipping insurance add-on — not a physical item to pick
          if ((item.sku || '').toLowerCase() === 'x-redo') continue;
          items.push({
            orderNumber:  order.order_number,
            variantId:    item.variant_id,
            productId:    item.product_id,
            title:        item.title,
            variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
            sku:          item.sku || '',
            qty:          item.quantity,
            image:        variantImageMap[String(item.variant_id)] || null,
            stock:        variantStockMap[String(item.variant_id)] ?? null,
            note:         order.note || null,
          });
        }
      }

      if (!done) {
        const link = r.headers.get('link');
        url = null;
        if (link) {
          const m = link.match(/<([^>]+)>;\s*rel="next"/);
          if (m) url = m[1];
        }
      }
    }

    items.sort((a, b) => a.orderNumber - b.orderNumber);
    const orders = [...orderNumbersSeen].sort((a, b) => a - b);

    res.json({ orders, orderCount: orders.length, items });
  } catch (err) {
    console.error('[picking] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Restock Planner ───────────────────────────────────────────────

// GET /api/restock/settings
app.get('/api/restock/settings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM restock_settings WHERE id = 1');
    res.json(rows[0] || { sea_lead_days: 60, air_lead_days: 14, cover_weeks: 8, velocity_days: 42 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restock/settings
app.post('/api/restock/settings', async (req, res) => {
  const { sea_lead_days, air_lead_days, cover_weeks, velocity_days } = req.body;
  try {
    await pool.query(
      `INSERT INTO restock_settings (id, sea_lead_days, air_lead_days, cover_weeks, velocity_days, updated_at)
       VALUES (1,$1,$2,$3,$4,NOW())
       ON CONFLICT (id) DO UPDATE SET
         sea_lead_days = EXCLUDED.sea_lead_days,
         air_lead_days = EXCLUDED.air_lead_days,
         cover_weeks   = EXCLUDED.cover_weeks,
         velocity_days = EXCLUDED.velocity_days,
         updated_at    = NOW()`,
      [sea_lead_days || 60, air_lead_days || 14, cover_weeks || 8, velocity_days || 42]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/restock/analysis — returns cached analysis from app_settings
app.get('/api/restock/analysis', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = 'restock_analysis'`);
    if (!rows.length) return res.json({ products: [], generatedAt: null });
    res.json(JSON.parse(rows[0].value));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restock/analysis/refresh — kick off a new analysis run
app.post('/api/restock/analysis/refresh', async (req, res) => {
  restockSync.runAnalysis().catch(err => console.error('[restock] Refresh error:', err.message));
  res.json({ ok: true, message: 'Analysis started — check back in ~30 seconds' });
});

// GET /api/restock/orders
app.get('/api/restock/orders', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM restock_orders
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'received' THEN 1 ELSE 2 END,
                expected_delivery ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restock/orders
app.post('/api/restock/orders', async (req, res) => {
  const { productId, productTitle, freightMode, orderedAt, expectedDelivery,
          qtyByVariant, totalQty, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO restock_orders
         (product_id, product_title, freight_mode, ordered_at, expected_delivery,
          qty_by_variant, total_qty, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [productId, productTitle, freightMode, orderedAt, expectedDelivery,
       JSON.stringify(qtyByVariant || {}), totalQty || 0, notes || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/restock/orders/:id
app.patch('/api/restock/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, notes, expectedDelivery } = req.body;
  try {
    if (status === 'received') {
      // Clear alert log so this product can generate new alerts in the next cycle
      const { rows: r } = await pool.query('SELECT product_id FROM restock_orders WHERE id=$1', [id]);
      if (r.length) {
        await pool.query('DELETE FROM restock_alerts_log WHERE product_id=$1', [r[0].product_id]);
        console.log(`[restock] Alert log cleared for product ${r[0].product_id} (order received)`);
      }
    }
    const { rows } = await pool.query(
      `UPDATE restock_orders SET
         status            = COALESCE($1, status),
         notes             = COALESCE($2, notes),
         expected_delivery = COALESCE($3::date, expected_delivery),
         updated_at        = NOW()
       WHERE id = $4 RETURNING *`,
      [status || null, notes !== undefined ? notes : null, expectedDelivery || null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/restock/orders/:id
app.delete('/api/restock/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM restock_orders WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/restock/config
app.get('/api/restock/config', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM product_restock_config ORDER BY product_title ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/restock/config/:productId
app.post('/api/restock/config/:productId', async (req, res) => {
  const productId = parseInt(req.params.productId);
  const { productTitle, seaLeadDays, airLeadDays, coverWeeks, restockEnabled } = req.body;
  try {
    await pool.query(
      `INSERT INTO product_restock_config
         (product_id, product_title, sea_lead_days, air_lead_days, cover_weeks, restock_enabled, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (product_id) DO UPDATE SET
         product_title   = EXCLUDED.product_title,
         sea_lead_days   = EXCLUDED.sea_lead_days,
         air_lead_days   = EXCLUDED.air_lead_days,
         cover_weeks     = EXCLUDED.cover_weeks,
         restock_enabled = EXCLUDED.restock_enabled,
         updated_at      = NOW()`,
      [productId, productTitle || '', seaLeadDays || null, airLeadDays || null,
       coverWeeks || null, restockEnabled !== false]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Login page ─────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Exchange Rate ──────────────────────────────────────────────────
const exRateCache = {};
async function getExchangeRates(base) {
  const key = base.toUpperCase();
  const cached = exRateCache[key];
  if (cached && (Date.now() - cached.fetchedAt) < 3_600_000) return cached.rates;
  const r = await fetch(`https://open.er-api.com/v6/latest/${key}`);
  if (!r.ok) throw new Error(`Exchange rate API: ${r.status}`);
  const data = await r.json();
  exRateCache[key] = { rates: data.rates, fetchedAt: Date.now() };
  return data.rates;
}

app.get('/api/exchange-rate', async (req, res) => {
  const base = (req.query.base || 'AUD').toUpperCase();
  try {
    const rates = await getExchangeRates(base);
    res.json({ base, rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Suppliers ──────────────────────────────────────────────────────
app.get('/api/suppliers', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM suppliers ORDER BY company_name ASC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suppliers', async (req, res) => {
  const { companyName, location, currency, contactName, email, phone, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (company_name,location,currency,contact_name,email,phone,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [companyName, location||null, currency||'AUD', contactName||null, email||null, phone||null, notes||null]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/suppliers/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { companyName, location, currency, contactName, email, phone, notes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE suppliers SET company_name=$1,location=$2,currency=$3,contact_name=$4,
       email=$5,phone=$6,notes=$7,updated_at=NOW() WHERE id=$8 RETURNING *`,
      [companyName, location||null, currency||'AUD', contactName||null, email||null, phone||null, notes||null, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/suppliers/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM suppliers WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Production Orders ──────────────────────────────────────────────
app.get('/api/production-orders', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT po.*,
        COALESCE((SELECT SUM(l.total_qty) FROM production_order_lines l WHERE l.order_id=po.id),0) AS total_items,
        COALESCE((SELECT COUNT(*)         FROM production_order_lines l WHERE l.order_id=po.id),0) AS line_count,
        COALESCE(
          ROUND((SELECT SUM(l.total_qty * l.unit_price) FROM production_order_lines l WHERE l.order_id=po.id)
                * po.exchange_rate + po.shipping_cost, 2)
        , 0) AS subtotal_aud,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'code', l.product_code,
            'name', l.product_name,
            'qty',  l.total_qty,
            'quantities', l.quantities,
            'size_set',   l.size_set
          ) ORDER BY l.line_number)
          FROM production_order_lines l WHERE l.order_id=po.id)
        , '[]'::json) AS line_summaries
      FROM production_orders po
      ORDER BY po.delivery_date ASC NULLS LAST, po.order_date DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Production Budgets ─────────────────────────────────────────────
app.get('/api/production-budgets', async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    // Return all 12 months — fill missing months with 0
    const { rows } = await pool.query(
      'SELECT * FROM production_budgets WHERE year=$1 ORDER BY month ASC', [year]);
    const budgetMap = {};
    rows.forEach(r => { budgetMap[r.month] = r; });
    // Compute actuals from production orders (exclude cancelled)
    const { rows: actuals } = await pool.query(`
      SELECT
        EXTRACT(MONTH FROM delivery_date)::int AS month,
        ROUND(SUM(
          (COALESCE((SELECT SUM(l.total_qty * l.unit_price) FROM production_order_lines l WHERE l.order_id=po.id),0)
          * po.exchange_rate + po.shipping_cost)
          * CASE WHEN po.include_gst THEN 1.1 ELSE 1.0 END
        ), 2) AS actual_aud
      FROM production_orders po
      WHERE EXTRACT(YEAR FROM delivery_date) = $1
        AND status NOT IN ('cancelled')
      GROUP BY EXTRACT(MONTH FROM delivery_date)`, [year]);
    const actualMap = {};
    actuals.forEach(r => { actualMap[r.month] = parseFloat(r.actual_aud) || 0; });
    const result = Array.from({length:12},(_,i)=>i+1).map(m => ({
      year, month: m,
      budget_aud: budgetMap[m] ? parseFloat(budgetMap[m].budget_aud) : 0,
      notes:      budgetMap[m]?.notes || null,
      actual_aud: actualMap[m] || 0,
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/production-budgets/:year/:month', async (req, res) => {
  const year  = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  const { budgetAud, notes } = req.body;
  try {
    const { rows } = await pool.query(`
      INSERT INTO production_budgets (year, month, budget_aud, notes, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (year, month) DO UPDATE SET
        budget_aud = EXCLUDED.budget_aud,
        notes      = EXCLUDED.notes,
        updated_at = NOW()
      RETURNING *`, [year, month, budgetAud || 0, notes || null]);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stock Locations ───────────────────────────────────────────────────────
app.get('/api/locations/products', requireAuth, async (req, res) => {
  try {
    if (!productsCache.length) {
      productsCache = await fetchAllProducts();
      lastFetched = new Date();
    }
    res.json(productsCache.map(p => ({
      id: p.id,
      title: p.title,
      image: (p.images && p.images.length) ? p.images[0].src : null,
      variants: p.variants.map(v => ({ id: v.id, title: v.title, sku: v.sku || '' }))
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM stock_locations ORDER BY updated_at DESC');
    const result = {};
    for (const row of rows) {
      if (!result[row.product_id]) result[row.product_id] = { aisle: null, bay: null, excess_loc: '', variants: {} };
      if (row.variant_id === '') {
        result[row.product_id].aisle = row.aisle;
        result[row.product_id].bay = row.bay;
        result[row.product_id].excess_loc = row.excess_loc || '';
      } else {
        result[row.product_id].variants[row.variant_id] = { aisle: row.aisle, bay: row.bay };
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/locations', requireAuth, async (req, res) => {
  try {
    const { product_id, variant_id = '', aisle, bay, excess_loc } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    await pool.query(`
      INSERT INTO stock_locations (product_id, variant_id, aisle, bay, excess_loc, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (product_id, variant_id) DO UPDATE
        SET aisle = $3, bay = $4, excess_loc = $5, updated_at = NOW()
    `, [product_id, variant_id, aisle || null, bay || null, excess_loc || null]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/locations/variant', requireAuth, async (req, res) => {
  try {
    const { product_id, variant_id } = req.body;
    await pool.query('DELETE FROM stock_locations WHERE product_id=$1 AND variant_id=$2 AND variant_id<>\'\'',
      [product_id, variant_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Warehouse Layout ──────────────────────────────────────────────────────
app.get('/api/warehouse/layout', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT layout_json FROM warehouse_layout WHERE id = 1');
    res.json(rows.length ? rows[0].layout_json : {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/warehouse/layout', requireAuth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO warehouse_layout (id, layout_json, updated_at)
      VALUES (1, $1, NOW())
      ON CONFLICT (id) DO UPDATE SET layout_json = $1, updated_at = NOW()
    `, [JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/production-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows: [po] } = await pool.query('SELECT * FROM production_orders WHERE id=$1', [id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const { rows: lines } = await pool.query(
      'SELECT * FROM production_order_lines WHERE order_id=$1 ORDER BY line_number ASC', [id]);
    res.json({ ...po, lines });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function upsertLines(client, orderId, lines) {
  await client.query('DELETE FROM production_order_lines WHERE order_id=$1', [orderId]);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await client.query(
      `INSERT INTO production_order_lines
         (order_id,line_number,line_type,product_id,product_code,product_name,
          size_set,quantities,total_qty,unit_price,freight_override)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [orderId, i+1, l.lineType||'restock', l.productId||null, l.productCode||null,
       l.productName||'', l.sizeSet||'numeric', JSON.stringify(l.quantities||{}),
       l.totalQty||0, l.unitPrice||0, l.freightOverride||null]
    );
  }
}

app.post('/api/production-orders', async (req, res) => {
  const { poNumber, supplierId, supplierName, orderDate, deliveryDate, freightMode,
          currency, exchangeRate, shippingCost, includeGst, notes, lines=[] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows:[po] } = await client.query(
      `INSERT INTO production_orders
         (po_number,supplier_id,supplier_name,order_date,delivery_date,freight_mode,
          currency,exchange_rate,shipping_cost,include_gst,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [poNumber, supplierId||null, supplierName||'', orderDate, deliveryDate||null,
       freightMode||'sea', currency||'AUD', exchangeRate||1, shippingCost||0, includeGst||false, notes||null]
    );
    await upsertLines(client, po.id, lines);
    await client.query('COMMIT');
    res.json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.put('/api/production-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { poNumber, supplierId, supplierName, orderDate, deliveryDate, freightMode,
          currency, exchangeRate, shippingCost, includeGst, notes, status, lines } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows:[po] } = await client.query(
      `UPDATE production_orders SET
         po_number=$1,supplier_id=$2,supplier_name=$3,order_date=$4,delivery_date=$5,
         freight_mode=$6,currency=$7,exchange_rate=$8,shipping_cost=$9,include_gst=$10,
         notes=$11,status=COALESCE($12,status),updated_at=NOW()
       WHERE id=$13 RETURNING *`,
      [poNumber, supplierId||null, supplierName||'', orderDate, deliveryDate||null,
       freightMode||'sea', currency||'AUD', exchangeRate||1, shippingCost||0,
       includeGst||false, notes||null, status||null, id]
    );
    if (!po) { await client.query('ROLLBACK'); return res.status(404).json({ error:'Not found' }); }
    if (lines !== undefined) await upsertLines(client, id, lines);
    await client.query('COMMIT');
    res.json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.delete('/api/production-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    await pool.query('DELETE FROM production_order_lines WHERE order_id=$1', [id]);
    await pool.query('DELETE FROM production_orders WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Product routes ─────────────────────────────────────────────────
app.get('/api/products/refresh', async (req, res) => {
  try {
    productsCache = await fetchAllProducts();
    lastFetched = new Date();
    res.json({ count: productsCache.length, lastFetched });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/status', (req, res) => {
  res.json({ count: productsCache.length, lastFetched });
});

app.get('/api/debug/costs', async (req, res) => {
  const title = (req.query.title || '').toLowerCase();
  const product = productsCache.find((p) => p.title.toLowerCase().includes(title));
  if (!product) return res.json({ error: 'product not found in cache' });

  const iids = product.variants.map((v) => ({
    variant_id: v.id,
    variant_title: v.title,
    inventory_item_id: v.inventory_item_id,
    inventory_item_id_type: typeof v.inventory_item_id,
  }));

  const ids = product.variants.map((v) => v.inventory_item_id).filter(Boolean);
  const costMap = await fetchInventoryCosts(ids);

  res.json({ product: product.title, variants: iids, costMap });
});

app.get('/api/products/search', async (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();

  if (!query) return res.json([]);

  // Auto-populate cache after deploys (resets on every server restart)
  if (!productsCache.length) {
    try {
      productsCache = await fetchAllProducts();
      lastFetched   = new Date();
    } catch (err) {
      return res.status(500).json({ error: 'Could not load products: ' + err.message });
    }
  }

  const history = await readHistory();

  const results = productsCache.filter((product) => {
    if (product.title.toLowerCase().includes(query)) return true;
    return product.variants.some(
      (v) => v.sku && v.sku.toLowerCase().includes(query)
    );
  });

  const formatted = results.slice(0, 100).map((product) => {
    const skuMatch = product.variants.some(
      (v) => v.sku && v.sku.toLowerCase().includes(query)
    );
    const variants = skuMatch
      ? [...product.variants].sort((a, b) => {
          const aMatch = a.sku && a.sku.toLowerCase().includes(query) ? -1 : 1;
          const bMatch = b.sku && b.sku.toLowerCase().includes(query) ? -1 : 1;
          return aMatch - bMatch;
        })
      : product.variants;

    const image =
      product.images && product.images.length > 0
        ? product.images[0].src
        : null;

    const checks = history
      .filter((h) => String(h.productId) === String(product.id))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const lastCheck = checks.length > 0 ? checks[0] : null;

    return { id: product.id, title: product.title, image, variants, lastCheck };
  });

  res.json(formatted);
});

// ── Stocktake history routes ───────────────────────────────────────
app.post('/api/stocktake/submit', async (req, res) => {
  const { productId, productTitle, initials, variants = [] } = req.body;

  if (!productId || !productTitle || !initials) {
    return res.status(400).json({ error: 'productId, productTitle and initials are required' });
  }

  const normInitials = initials.toUpperCase().trim();
  const timestamp    = new Date().toISOString();

  const entry = { productId, productTitle, initials: normInitials, timestamp };
  await appendHistory(entry);

  // Save any discrepancies (counted ≠ system)
  const discrepancies = variants.filter((v) => v.countedQty !== v.systemQty);
  for (const v of discrepancies) {
    await pool.query(
      `INSERT INTO stocktake_discrepancies
        (product_id, product_title, variant_id, variant_title, sku,
         system_qty, counted_qty, difference, initials, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        productId, productTitle, v.variantId, v.variantTitle, v.sku || '',
        v.systemQty, v.countedQty, v.countedQty - v.systemQty,
        normInitials, timestamp,
      ]
    );
  }

  res.json({ ok: true, entry, discrepanciesSaved: discrepancies.length });
});

app.get('/api/stocktake/history', async (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  let history = await readHistory();

  if (query) {
    history = history.filter((h) =>
      h.productTitle.toLowerCase().includes(query)
    );
  }

  res.json(history);
});

app.get('/api/stocktake/last-checks', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (product_id)
      product_id AS "productId",
      product_title AS "productTitle",
      initials,
      created_at AS "timestamp"
    FROM stocktake_history
    ORDER BY product_id, created_at DESC
  `);
  res.json(rows);
});

// ── Draft + Archived products with stock ──────────────────────────
async function fetchProductsByStatus(status) {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=${status}&fields=id,title,variants,images`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Shopify API error ${r.status}: ${body}`);
    }
    const data = await r.json();
    data.products.forEach((p) => { p._status = status; });
    products.push(...data.products);

    const linkHeader = r.headers.get('link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return products;
}

app.get('/api/reports/draft-with-stock', async (req, res) => {
  try {
    const [draftProducts, archivedProducts] = await Promise.all([
      fetchProductsByStatus('draft'),
      fetchProductsByStatus('archived'),
    ]);

    const all = [...draftProducts, ...archivedProducts];

    const withStock = all
      .filter((p) => p.variants.some((v) => (v.inventory_quantity || 0) > 0))
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p._status,
        image: p.images && p.images.length > 0 ? p.images[0].src : null,
        totalStock: p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0),
        variants: p.variants
          .filter((v) => (v.inventory_quantity || 0) > 0)
          .map((v) => ({
            id: v.id,
            title: v.title,
            sku: v.sku,
            inventory_quantity: v.inventory_quantity,
          })),
      }))
      .sort((a, b) => b.totalStock - a.totalStock);

    res.json({ count: withStock.length, products: withStock });
  } catch (err) {
    console.error('Draft/archived report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sales Velocity ────────────────────────────────────────────────
async function fetchOrdersSince(sinceDate) {
  const orders = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${sinceDate.toISOString()}&limit=250&fields=id,cancelled_at,line_items`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Shopify Orders API error ${r.status}: ${body}`);
    }
    const data = await r.json();
    orders.push(...data.orders);

    const linkHeader = r.headers.get('link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return orders;
}

app.get('/api/velocity', async (req, res) => {
  try {
    const days              = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const lowStockDays      = parseFloat(req.query.low_stock_days) || 21;
    const criticalDays      = parseFloat(req.query.critical_days) || 7;
    const deadMinSold       = parseInt(req.query.dead_min_sold) || 10;
    const deadMinInventory  = parseInt(req.query.dead_inventory) || 5;
    const excludeCollection = (req.query.exclude_collection || '').trim();

    const since = new Date();
    since.setDate(since.getDate() - days);

    if (!productsCache || productsCache.length === 0) {
      productsCache = await fetchAllProducts();
      lastFetched = new Date();
    }

    // Build set of product IDs to exclude from dead-stock flagging
    const excludedProductIds = new Set();
    if (excludeCollection) {
      for (const endpoint of ['custom_collections', 'smart_collections']) {
        const cr = await fetch(
          `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/${endpoint}.json?title=${encodeURIComponent(excludeCollection)}&fields=id,title`,
          { headers: shopifyHeaders() }
        );
        if (!cr.ok) continue;
        const cd   = await cr.json();
        const list = cd[endpoint] || [];
        const col  = list.find((c) => c.title.toLowerCase() === excludeCollection.toLowerCase());
        if (col) {
          let pUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?collection_id=${col.id}&fields=id&limit=250`;
          while (pUrl) {
            const pr = await fetch(pUrl, { headers: shopifyHeaders() });
            if (!pr.ok) break;
            const pd = await pr.json();
            for (const p of (pd.products || [])) excludedProductIds.add(String(p.id));
            const lnk = pr.headers.get('link');
            pUrl = null;
            if (lnk) { const m = lnk.match(/<([^>]+)>;\s*rel="next"/); if (m) pUrl = m[1]; }
          }
          console.log(`[velocity] excluding ${excludedProductIds.size} products from "${excludeCollection}" collection`);
          break;
        }
      }
    }

    const orders = await fetchOrdersSince(since);

    const variantSales = {};
    for (const order of orders) {
      if (order.cancelled_at) continue;
      for (const item of (order.line_items || [])) {
        if (!item.variant_id) continue;
        const key = String(item.variant_id);
        variantSales[key] = (variantSales[key] || 0) + item.quantity;
      }
    }

    const allInventoryItemIds = productsCache.flatMap((p) =>
      p.variants.map((v) => v.inventory_item_id).filter(Boolean)
    );
    const costMap = await fetchInventoryCosts(allInventoryItemIds);

    const styles = productsCache.map((product) => {
      const variants = product.variants.map((v) => {
        const sold      = variantSales[String(v.id)] || 0;
        const inventory = Math.max(0, v.inventory_quantity || 0);
        const dailyVel  = sold / days;
        const daysStock = dailyVel > 0 ? inventory / dailyVel : null;

        const cost  = costMap[String(v.inventory_item_id)] ?? null;
        const price = v.price != null ? Math.round(parseFloat(v.price) * 100) / 100 : null;
        const margin     = (price !== null && cost !== null) ? Math.round((price - cost) * 100) / 100 : null;
        const margin_pct = (price !== null && cost !== null && price > 0)
          ? Math.round(((price - cost) / price) * 10000) / 100
          : null;

        return {
          id: v.id,
          title: v.title,
          sku: v.sku || '',
          inventory,
          sold,
          daily_velocity: Math.round(dailyVel * 100) / 100,
          days_of_stock: daysStock !== null ? Math.round(daysStock) : null,
          cost,
          price,
          margin,
          margin_pct,
        };
      });

      const totalInventory  = variants.reduce((s, v) => s + v.inventory, 0);
      const totalSold       = variants.reduce((s, v) => s + v.sold, 0);
      const styleDailyVel   = totalSold / days;
      const styleDaysStock  = styleDailyVel > 0 ? totalInventory / styleDailyVel : null;

      const variantsWithMargin = variants.filter((v) => v.margin !== null);
      const avg_margin_pct = variantsWithMargin.length > 0
        ? Math.round(variantsWithMargin.reduce((s, v) => s + v.margin_pct, 0) / variantsWithMargin.length * 100) / 100
        : null;
      const total_markup_on_hand = variantsWithMargin.length > 0
        ? Math.round(variantsWithMargin.reduce((s, v) => s + v.margin * v.inventory, 0) * 100) / 100
        : null;

      const soldOutVariants = variants.filter((v) => v.inventory === 0);
      const inStockVariants = variants.filter((v) => v.inventory > 0);
      const soldOutRatio    = variants.length > 0 ? soldOutVariants.length / variants.length : 0;

      let status      = 'green';
      let alertType   = 'ok';
      let priorityTier = 0;
      let sortKey     = -(styleDailyVel);

      if (totalInventory === 0 && totalSold === 0) {
        status = 'grey'; alertType = 'no_activity'; priorityTier = -1; sortKey = 0;
      } else if (styleDaysStock !== null && styleDaysStock <= criticalDays) {
        status = 'red';    alertType = 'critical_stock'; priorityTier = 4; sortKey = styleDaysStock;
      } else if (styleDaysStock !== null && styleDaysStock <= lowStockDays) {
        status = 'amber';  alertType = 'low_stock';      priorityTier = 3; sortKey = styleDaysStock;
      } else if (soldOutVariants.length > 0 && inStockVariants.length > 0 && totalInventory >= deadMinInventory) {
        status = 'yellow'; alertType = 'imbalanced';     priorityTier = 2; sortKey = -soldOutRatio;
      } else if (totalSold < deadMinSold && totalInventory >= deadMinInventory && !excludedProductIds.has(String(product.id))) {
        status = 'blue';   alertType = 'dead_stock';     priorityTier = 1; sortKey = -totalInventory;
      }

      return {
        id: product.id,
        title: product.title,
        tags: product.tags || '',
        product_type: product.product_type || '',
        image: product.images && product.images.length > 0 ? product.images[0].src : null,
        total_inventory: totalInventory,
        total_sold: totalSold,
        daily_velocity: Math.round(styleDailyVel * 100) / 100,
        days_of_stock: styleDaysStock !== null ? Math.round(styleDaysStock) : null,
        avg_margin_pct,
        total_markup_on_hand,
        variants,
        variant_sold_out_count: soldOutVariants.length,
        variant_in_stock_count: inStockVariants.length,
        variant_total_count: variants.length,
        status,
        alert_type: alertType,
        priority_tier: priorityTier,
        sort_key: sortKey,
      };
    });

    styles.sort((a, b) => {
      if (b.priority_tier !== a.priority_tier) return b.priority_tier - a.priority_tier;
      return a.sort_key - b.sort_key;
    });

    const summary = {
      critical_stock: styles.filter((s) => s.alert_type === 'critical_stock').length,
      low_stock:      styles.filter((s) => s.alert_type === 'low_stock').length,
      imbalanced:     styles.filter((s) => s.alert_type === 'imbalanced').length,
      dead_stock:     styles.filter((s) => s.alert_type === 'dead_stock').length,
      ok:             styles.filter((s) => s.alert_type === 'ok').length,
      no_activity:    styles.filter((s) => s.alert_type === 'no_activity').length,
    };

    res.json({
      period_days: days,
      generated_at: new Date().toISOString(),
      total_orders_analysed: orders.filter((o) => !o.cancelled_at).length,
      thresholds: { low_stock_days: lowStockDays, critical_days: criticalDays, dead_min_sold: deadMinSold, dead_min_inventory: deadMinInventory, exclude_collection: excludeCollection || null },
      summary,
      styles,
    });
  } catch (err) {
    console.error('Velocity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Velocity Insights (AI Analysis) ───────────────────────────────

// POST /api/velocity/insights
// Accepts the styles array from a velocity run, calls Claude to identify hot/cold keyword clusters.
app.post('/api/velocity/insights', requireAuth, async (req, res) => {
  if (!anthropicClient) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
  }
  const { days, styles } = req.body;
  if (!Array.isArray(styles) || styles.length === 0) {
    return res.status(400).json({ error: 'styles array is required — run the velocity report first.' });
  }
  const periodDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);

  try {
    // Hot: top sellers with actual velocity, sorted fastest first
    const hotStyles = styles
      .filter((s) => s.daily_velocity > 0 && s.alert_type !== 'no_activity')
      .sort((a, b) => b.daily_velocity - a.daily_velocity)
      .slice(0, 30);

    // Cold: dead stock + zero-velocity with inventory
    const coldStyles = styles
      .filter((s) =>
        s.alert_type === 'dead_stock' ||
        (s.daily_velocity === 0 && s.total_inventory > 5 && s.alert_type !== 'no_activity')
      )
      .sort((a, b) => b.total_inventory - a.total_inventory)
      .slice(0, 30);

    if (hotStyles.length < 3) {
      return res.status(400).json({ error: 'Not enough sales data — need at least 3 selling products. Run the velocity report with a longer period.' });
    }

    function fmtStyle(s) {
      const tags = s.tags ? s.tags.replace(/,\s*/g, ', ') : '';
      const type = s.product_type ? ` [${s.product_type}]` : '';
      const tagsStr = tags ? ` | tags: ${tags}` : '';
      return `• "${s.title}"${type}${tagsStr} | ${s.total_sold} sold, ${s.daily_velocity.toFixed(2)}/day, stock: ${s.total_inventory}`;
    }

    const hotList  = hotStyles.map(fmtStyle).join('\n');
    const coldList = coldStyles.length > 0
      ? coldStyles.map(fmtStyle).join('\n')
      : '(no clear slow movers identified in this period)';

    const prompt = `You are a retail analytics assistant for The Self Styler, an Australian women's fashion e-commerce retailer (clothing, dresses, tops, shoes, accessories).

Analyse these two groups of products from the last ${periodDays} days:

═══ TOP SELLERS (highest daily velocity) ═══
${hotList}

═══ SLOW MOVERS (dead stock / zero velocity with inventory) ═══
${coldList}

Identify the key themes, styles, keywords and product characteristics that explain each group's performance. Look for patterns in: silhouettes (wrap, oversized, bodycon), lengths (midi, mini, maxi), fabrics, prints/patterns, occasions (casual, workwear, occasion/formal), colours, and product categories.

Return ONLY raw JSON — absolutely no markdown fences or extra text before or after:
{
  "hot": {
    "summary": "2-3 sentences summarising what is selling well and the dominant trends driving it",
    "clusters": [
      {
        "label": "Short cluster name (e.g. 'Wrap Dresses', 'Floral Prints', 'Casual Knitwear')",
        "keywords": ["keyword1", "keyword2", "keyword3"],
        "insight": "1-2 sentences explaining why these products are resonating with customers",
        "examples": ["Exact Product Title 1", "Exact Product Title 2"],
        "product_count": 5
      }
    ]
  },
  "not_hot": {
    "summary": "2-3 sentences summarising what is not selling and the likely causes",
    "clusters": [...]
  }
}

Provide 4-7 clusters per section. Be specific — reference actual words and phrases from the titles and tags above.`;

    console.log(`[velocity/insights] Calling Claude: ${hotStyles.length} hot + ${coldStyles.length} cold, period=${periodDays}d`);

    const message = await anthropicClient.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0]?.text || '';
    // Strip markdown fences in case Claude adds them despite instructions
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[velocity/insights] JSON parse failed:', jsonText.slice(0, 400));
      return res.status(500).json({ error: 'AI returned malformed JSON — try again.' });
    }

    // Cache in DB
    await pool.query(`
      INSERT INTO velocity_insights (period_days, products_analysed, hot_json, not_hot_json, model_used)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      periodDays,
      hotStyles.length + coldStyles.length,
      JSON.stringify(parsed.hot    || {}),
      JSON.stringify(parsed.not_hot || {}),
      message.model || 'claude-haiku-4-5',
    ]);

    res.json({
      ok: true,
      period_days: periodDays,
      hot: parsed.hot,
      not_hot: parsed.not_hot,
      products_analysed: hotStyles.length + coldStyles.length,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[velocity/insights] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/velocity/insights/latest?days=N — return the most recent cached analysis for this period
app.get('/api/velocity/insights/latest', requireAuth, async (req, res) => {
  const periodDays = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  try {
    const { rows } = await pool.query(`
      SELECT
        period_days, products_analysed,
        hot_json      AS hot,
        not_hot_json  AS not_hot,
        model_used, generated_at
      FROM velocity_insights
      WHERE period_days = $1
      ORDER BY generated_at DESC
      LIMIT 1
    `, [periodDays]);
    res.json(rows.length > 0 ? rows[0] : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Velocity Idea Factory (AI Merchandising Advisor) ──────────────

// POST /api/velocity/idea-factory
// Sends full inventory context to Claude Sonnet and returns ~10-15 specific
// business ideas (clearance, pricing, bundles, Meta ads, email, etc.)
app.post('/api/velocity/idea-factory', requireAuth, async (req, res) => {
  if (!anthropicClient) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
  }
  const { days, styles } = req.body;
  if (!Array.isArray(styles) || styles.length === 0) {
    return res.status(400).json({ error: 'styles array is required — run the velocity report first.' });
  }
  const periodDays = Math.min(Math.max(parseInt(days) || 30, 1), 365);

  try {
    // ── Segment inventory by status ────────────────────────────────
    const deadStock   = styles.filter(s => s.alert_type === 'dead_stock')
      .sort((a, b) => b.total_inventory - a.total_inventory).slice(0, 15);

    const finalSizes  = styles.filter(s => s.alert_type === 'imbalanced')
      .sort((a, b) => b.variant_sold_out_count - a.variant_sold_out_count).slice(0, 12);

    const lowStock    = styles.filter(s => ['critical_stock', 'low_stock'].includes(s.alert_type))
      .sort((a, b) => (a.days_of_stock ?? 999) - (b.days_of_stock ?? 999)).slice(0, 10);

    const topSellers  = styles.filter(s => s.alert_type === 'ok' && s.daily_velocity > 0)
      .sort((a, b) => b.daily_velocity - a.daily_velocity).slice(0, 10);

    const productsAnalysed = deadStock.length + finalSizes.length + lowStock.length + topSellers.length;

    if (productsAnalysed < 3) {
      return res.status(400).json({ error: 'Not enough product data — run the velocity report first.' });
    }

    // ── Format product data for Claude ─────────────────────────────
    function fmtPrice(s) {
      const p = s.variants?.[0]?.price;
      return p != null ? `$${Number(p).toFixed(2)}` : '';
    }
    function fmtMargin(s) {
      return s.avg_margin_pct != null ? ` ${s.avg_margin_pct.toFixed(0)}% margin` : '';
    }
    function fmtVariants(s) {
      if (!s.variants || s.variants.length <= 1) return '';
      const parts = s.variants.map(v => {
        const label = v.title !== 'Default Title' ? v.title : null;
        return label ? `${label}: ${v.inventory === 0 ? 'SOLD OUT' : v.inventory + ' left'}` : null;
      }).filter(Boolean).slice(0, 8);
      return parts.length ? `\n    Sizes: ${parts.join(' | ')}` : '';
    }

    // For final-size products — make the remaining units unmissably obvious
    function fmtFinalSize(s) {
      const price     = fmtPrice(s);
      const margin    = fmtMargin(s);
      const hasVars   = s.variants && s.variants.length > 1;
      if (!hasVars) {
        return `  • "${s.title}" — ${price},${margin} ONLY ${s.total_inventory} unit(s) left, ${s.total_sold} sold in ${periodDays}d`;
      }
      const inStock   = s.variants.filter(v => v.inventory > 0 && v.title !== 'Default Title');
      const soldOut   = s.variants.filter(v => v.inventory === 0 && v.title !== 'Default Title');
      const totalLeft = inStock.reduce((sum, v) => sum + v.inventory, 0);
      const leftList  = inStock.map(v => `${v.title}: ${v.inventory}`).join(', ');
      const goneList  = soldOut.length ? ` | GONE: ${soldOut.map(v => v.title).join(', ')}` : '';
      return `  • "${s.title}" — ${price},${margin} ONLY ${totalLeft} unit(s) left → ${leftList}${goneList} (${s.total_sold} sold in ${periodDays}d)`;
    }

    function fmtBlock(arr, label) {
      if (!arr.length) return '';
      const lines = arr.map(s =>
        `  • "${s.title}" — ${fmtPrice(s)},${fmtMargin(s)}, stock: ${s.total_inventory}, sold: ${s.total_sold} in ${periodDays}d, velocity: ${s.daily_velocity.toFixed(2)}/day${fmtVariants(s)}`
      ).join('\n');
      return `${label}\n${lines}\n`;
    }

    function fmtFinalSizeBlock(arr) {
      if (!arr.length) return '';
      const lines = arr.map(s => fmtFinalSize(s)).join('\n');
      return `═══ FINAL SIZES (orphaned sizes — most variants sold out, last units stranded) ═══\n${lines}\n`;
    }

    const context = [
      fmtBlock(deadStock,     `═══ DEAD STOCK (sitting still — needs to move) ═══`),
      fmtFinalSizeBlock(finalSizes),
      fmtBlock(lowStock,      `═══ RUNNING LOW (selling fast — restock or capitalise now) ═══`),
      fmtBlock(topSellers,    `═══ TOP SELLERS (healthy performers — push harder) ═══`),
    ].filter(Boolean).join('\n');

    const prompt = `You are a senior retail strategist and digital marketing expert advising The Self Styler, an Australian women's fashion e-commerce retailer (dresses, tops, shoes, accessories, approx $50–$300 price range).

Here is the live inventory and sales performance snapshot from the last ${periodDays} days:

${context}

Generate 10–15 specific, high-impact action ideas to maximise revenue, clear stagnant stock, and grow the business. Think like an experienced retail merchandiser AND a performance marketing specialist.

Ideas must span multiple tactics — include a mix from: clearance/markdown pricing, final-size bundles, Meta/Instagram ad campaigns, email marketing, flash sales, site promotions, urgency messaging, restock decisions, product page tweaks.

Rules:
- Name ACTUAL products from the lists above — never give generic advice
- Be SPECIFIC and DIRECT — tell us exactly what to do, not vague advice
- FINAL SIZES: for every orphaned product, give a concrete action: "You have X [size] left in [Product] — drop to $Y and clear them." These are shelf-hogging dead weight; one idea per product if warranted
- Dead stock needs CREATIVE solutions (bundles, deep discounts, styled collections, gift-with-purchase)
- Top sellers deserve more ad budget, urgency copy ("selling fast"), and restock consideration
- Think about the cost of holding unsold stock — physical space and cash tied up
- If a product has only 1-3 units of a single size left, say so explicitly and recommend a specific price or action

Return ONLY raw JSON (absolutely no markdown fences):
{
  "headline": "Honest 1-2 sentence assessment of the overall inventory health and biggest opportunity right now",
  "ideas": [
    {
      "category": "Clearance|Final Sizes|Bundle Deal|Meta Ads|Email Campaign|Flash Sale|Pricing|Restock|Promotion|Site Merch",
      "icon": "single relevant emoji",
      "title": "Short punchy idea title (6 words max)",
      "action": "Exactly what to do — be specific and direct (2-3 sentences)",
      "products": ["Exact product name 1", "Exact product name 2"],
      "rationale": "Why this, why now — one sentence",
      "priority": "high|medium|low"
    }
  ]
}

Prioritise the ideas that will have the most immediate financial impact.`;

    console.log(`[idea-factory] Calling Claude Sonnet: ${productsAnalysed} products, period=${periodDays}d`);

    const message = await anthropicClient.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText  = message.content[0]?.text || '';
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[idea-factory] JSON parse failed:', jsonText.slice(0, 400));
      return res.status(500).json({ error: 'AI returned malformed JSON — try again.' });
    }

    const ideas    = parsed.ideas || [];
    const headline = parsed.headline || '';

    // Store in DB
    await pool.query(`
      INSERT INTO velocity_ideas (period_days, products_analysed, headline, ideas_json, model_used)
      VALUES ($1, $2, $3, $4, $5)
    `, [periodDays, productsAnalysed, headline, JSON.stringify(ideas), message.model || 'claude-sonnet-4-5']);

    res.json({ ok: true, period_days: periodDays, headline, ideas, products_analysed: productsAnalysed, generated_at: new Date().toISOString() });

  } catch (err) {
    console.error('[idea-factory] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/velocity/idea-factory/latest?days=N
app.get('/api/velocity/idea-factory/latest', requireAuth, async (req, res) => {
  const periodDays = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  try {
    const { rows } = await pool.query(`
      SELECT period_days, products_analysed, headline, ideas_json AS ideas, model_used, generated_at
      FROM velocity_ideas
      WHERE period_days = $1
      ORDER BY generated_at DESC
      LIMIT 1
    `, [periodDays]);
    res.json(rows.length > 0 ? rows[0] : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Google Ads Asset Sync ──────────────────────────────────────────

app.get('/api/ads-assets/status', (req, res) => {
  res.json(adsAssetSync.getStatus());
});

app.post('/api/ads-assets/sync', async (req, res) => {
  // Fire-and-forget — client polls /status to see progress
  adsAssetSync.runSync().catch((err) =>
    console.error('[ads-assets] Manual sync error:', err.message)
  );
  res.json({ started: true });
});

app.get('/api/ads-assets/list', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        shopify_image_id  AS "shopifyImageId",
        product_id        AS "productId",
        product_title     AS "productTitle",
        image_url         AS "imageUrl",
        asset_name        AS "assetName",
        resource_name     AS "resourceName",
        image_role        AS "imageRole",
        synced_at         AS "syncedAt"
      FROM google_ads_assets
      ORDER BY product_title ASC, image_role ASC, synced_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear all DB records so the next sync re-uploads the correct 20 images.
// Does NOT touch Google Ads — archive old assets there manually first.
app.post('/api/ads-assets/clear-db', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM google_ads_assets');
    res.json({ ok: true, cleared: rowCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Meta Ads OAuth & API ───────────────────────────────────────────

app.get('/auth/meta/connect', requireAuth, (req, res) => {
  const appId       = process.env.META_APP_ID;
  const redirectUri = `${process.env.APP_URL}/auth/meta/callback`;
  const scopes      = 'ads_read,ads_management,business_management';
  const url = `https://www.facebook.com/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code`;
  res.redirect(url);
});

app.get('/auth/meta/callback', requireAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/syncing.html?meta_error=${encodeURIComponent(error)}`);
  try {
    const redirectUri = `${process.env.APP_URL}/auth/meta/callback`;
    await metaAds.handleOAuthCallback(code, redirectUri);
    res.redirect('/syncing.html?meta_connected=1');
  } catch (err) {
    console.error('[meta] OAuth callback error:', err.message);
    res.redirect(`/syncing.html?meta_error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/meta/status', requireAuth, async (req, res) => {
  try {
    const [connection, lastSync] = await Promise.all([
      metaAds.getConnectionStatus(),
      metaAds.getLastSync(),
    ]);
    res.json({ ...connection, ...metaAds.getStatus(), lastSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/meta/sync', requireAuth, async (req, res) => {
  const days = Math.min(parseInt(req.body.days) || 30, 90);
  try {
    const result = await metaAds.syncDateRange(days);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta/campaigns', requireAuth, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const { rows } = await pool.query(`
      SELECT
        campaign_id,
        campaign_name,
        SUM(spend)          AS spend,
        SUM(impressions)    AS impressions,
        SUM(clicks)         AS clicks,
        SUM(purchases)      AS purchases,
        SUM(purchase_value) AS purchase_value,
        CASE WHEN SUM(spend) > 0
             THEN ROUND((SUM(purchase_value) / SUM(spend))::NUMERIC, 2)
             ELSE 0 END     AS roas,
        CASE WHEN SUM(clicks) > 0
             THEN ROUND((SUM(spend) / SUM(clicks))::NUMERIC, 2)
             ELSE 0 END     AS cpc
      FROM meta_ads_daily
      WHERE date >= CURRENT_DATE - ($1::int)
      GROUP BY campaign_id, campaign_name
      ORDER BY spend DESC
    `, [days]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Xero OAuth & API ───────────────────────────────────────────────

app.get('/auth/xero/connect', requireAuth, (req, res) => {
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    return res.status(500).send('XERO_CLIENT_ID or XERO_CLIENT_SECRET env vars are not set on the server.');
  }
  const redirectUri = `${process.env.APP_URL}/auth/xero/callback`;
  const url = xeroSync.getAuthUrl(redirectUri);
  console.log('[xero] Auth URL:', url);
  res.redirect(url);
});

app.get('/auth/xero/callback', requireAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/syncing.html?xero_error=${encodeURIComponent(error)}`);
  try {
    const redirectUri = `${process.env.APP_URL}/auth/xero/callback`;
    await xeroSync.handleOAuthCallback(code, redirectUri);
    res.redirect('/syncing.html?xero_connected=1');
  } catch (err) {
    console.error('[xero] OAuth callback error:', err.message);
    res.redirect(`/syncing.html?xero_error=${encodeURIComponent(err.message)}`);
  }
});

app.post('/api/xero/disconnect', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM app_settings WHERE key IN ('xero_tokens','xero_tenant_id','xero_tenant_name')`
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/xero/status', requireAuth, async (req, res) => {
  try {
    const [connection, lastSync] = await Promise.all([
      xeroSync.getConnectionStatus(),
      xeroSync.getLastSync(),
    ]);
    res.json({ ...connection, ...xeroSync.getStatus(), lastSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/xero/sync', requireAuth, async (req, res) => {
  const months = Math.min(parseInt(req.body.months) || 3, 12);
  try {
    const result = await xeroSync.syncProfitAndLoss(months);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/xero/financials', requireAuth, async (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 24);
  try {
    const { rows } = await pool.query(`
      SELECT period_start, period_end,
             revenue, cogs, gross_profit, expenses, net_profit,
             CASE WHEN revenue > 0 THEN ROUND((gross_profit / revenue * 100)::NUMERIC, 1) ELSE 0 END AS gross_margin_pct,
             CASE WHEN revenue > 0 THEN ROUND((net_profit   / revenue * 100)::NUMERIC, 1) ELSE 0 END AS net_margin_pct
      FROM xero_financials
      WHERE report_type = 'ProfitAndLoss'
        AND period_start >= CURRENT_DATE - ($1::int * 31)
      ORDER BY period_start DESC
    `, [months]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Idea Factory Cron Status & Manual Trigger ─────────────────────

// GET /api/ideas-cron/status
app.get('/api/ideas-cron/status', requireAuth, (req, res) => {
  res.json(ideasCron.getStatus());
});

// POST /api/ideas-cron/run  — manual trigger from syncing page
app.post('/api/ideas-cron/run', requireAuth, async (req, res) => {
  const result = await ideasCron.runIdeaCron();
  res.json(result);
});

// POST /api/ideas-cron/push-current — post all current DB ideas to Slack (one-off)
app.post('/api/ideas-cron/push-current', requireAuth, async (req, res) => {
  try {
    const result = await ideasCron.pushCurrentToSlack();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Coupon Export ──────────────────────────────────────────────────

// POST /api/coupons/sync
// Fetch 360REFUND# discount codes from Shopify, filter by expiry month + unused, store in DB
// Strategy: get price_rules expiring in the target month, then fetch their discount codes.
// The discount_codes/search.json endpoint does not exist in Shopify REST API.
app.post('/api/coupons/sync', async (req, res) => {
  const { expiryMonth } = req.body;
  if (!expiryMonth || !/^\d{4}-\d{2}$/.test(expiryMonth)) {
    return res.status(400).json({ error: 'expiryMonth must be YYYY-MM' });
  }

  try {
    const [year, month] = expiryMonth.split('-').map(Number);

    // Use a slightly wider window (+/- 2 days) to catch AEST/AEDT timezone edge cases.
    // Exact UTC month filtering is done in code below.
    const windowStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const windowEnd   = new Date(Date.UTC(year, month, 2, 23, 59, 59)).toISOString(); // 2 days into next month

    // 1. Paginate price_rules filtered by ends_at window
    const allPriceRules = [];
    let prUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/price_rules.json`
              + `?limit=250&ends_at_min=${encodeURIComponent(windowStart)}&ends_at_max=${encodeURIComponent(windowEnd)}`;

    while (prUrl) {
      const r = await fetch(prUrl, { headers: shopifyHeaders() });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Shopify price_rules error ${r.status}: ${body.slice(0, 200)}`);
      }
      const data = await r.json();
      allPriceRules.push(...(data.price_rules || []));

      const link = r.headers.get('link');
      prUrl = null;
      if (link) {
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        if (m) prUrl = m[1];
      }
    }

    console.log(`[coupons/sync] ${allPriceRules.length} price rules expiring in/around ${expiryMonth}`);

    // 2. For each price rule, fetch its discount codes and filter by 360REFUND# prefix + unused
    let totalFetched = 0;
    const filteredCodes = [];

    for (const pr of allPriceRules) {
      // Filter: ends_at must be in the selected UTC month.
      // Note: we do NOT filter on pr.status — Shopify auto-marks past-expiry rules as 'expired'
      // so restricting to 'active' would silently exclude every code for a past month.
      if (!pr.ends_at) continue;
      const expiryDate = new Date(pr.ends_at);
      if (expiryDate.getUTCFullYear() !== year || (expiryDate.getUTCMonth() + 1) !== month) continue;

      const discountValue = pr.value ? Math.abs(parseFloat(pr.value)) : null;

      let codeUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/price_rules/${pr.id}/discount_codes.json?limit=250`;
      while (codeUrl) {
        const r = await fetch(codeUrl, { headers: shopifyHeaders() });
        if (!r.ok) {
          console.warn(`[coupons/sync] codes for price_rule ${pr.id} failed (${r.status})`);
          break;
        }
        const data = await r.json();
        const codes = data.discount_codes || [];
        totalFetched += codes.length;

        for (const c of codes) {
          if (c.code && c.code.startsWith('360REFUND#') && c.usage_count === 0) {
            filteredCodes.push({
              code:           c.code,
              price_rule_id:  pr.id,
              usage_count:    c.usage_count,
              discount_type:  pr.value_type,
              discount_value: discountValue,
              ends_at:        pr.ends_at,
            });
          }
        }

        const link = r.headers.get('link');
        codeUrl = null;
        if (link) {
          const m = link.match(/<([^>]+)>;\s*rel="next"/);
          if (m) codeUrl = m[1];
        }
      }

      await new Promise((r) => setTimeout(r, 100)); // respect rate limits
    }

    console.log(`[coupons/sync] ${totalFetched} codes checked, ${filteredCodes.length} matching 360REFUND# + unused`);

    // 3. Upsert each filtered code — ON CONFLICT preserves existing order match data
    let inserted = 0;
    let updated  = 0;
    for (const c of filteredCodes) {
      const result = await pool.query(`
        INSERT INTO coupon_imports
          (code, price_rule_id, usage_count, discount_type, discount_value, expires_at, expiry_month)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (code, expiry_month)
        DO UPDATE SET
          usage_count    = EXCLUDED.usage_count,
          discount_type  = EXCLUDED.discount_type,
          discount_value = EXCLUDED.discount_value,
          expires_at     = EXCLUDED.expires_at,
          imported_at    = NOW()
        RETURNING (xmax = 0) AS was_inserted
      `, [c.code, c.price_rule_id, c.usage_count, c.discount_type, c.discount_value, c.ends_at, expiryMonth]);

      if (result.rows[0]?.was_inserted) inserted++;
      else updated++;
    }

    res.json({
      ok: true,
      priceRulesChecked: allPriceRules.length,
      totalFetched,
      monthFiltered: filteredCodes.length,
      inserted,
      updated,
    });
  } catch (err) {
    console.error('[coupons/sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coupons/list?month=YYYY-MM
app.get('/api/coupons/list', async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        code,
        usage_count    AS "usageCount",
        discount_type  AS "discountType",
        discount_value AS "discountValue",
        expires_at     AS "expiresAt",
        order_id       AS "orderId",
        order_name     AS "orderName",
        customer_name  AS "customerName",
        customer_email AS "customerEmail",
        imported_at    AS "importedAt"
      FROM coupon_imports
      WHERE expiry_month = $1
      ORDER BY code ASC
    `, [month]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coupons/match-orders
// For unmatched coupons: extract order ID from code, fetch customer from Shopify
app.post('/api/coupons/match-orders', async (req, res) => {
  const { expiryMonth } = req.body;
  if (!expiryMonth || !/^\d{4}-\d{2}$/.test(expiryMonth)) {
    return res.status(400).json({ error: 'expiryMonth must be YYYY-MM' });
  }
  try {
    const { rows: unmatched } = await pool.query(`
      SELECT id, code FROM coupon_imports
      WHERE expiry_month = $1 AND order_id IS NULL
    `, [expiryMonth]);

    let matched = 0, noOrderId = 0, notFound = 0, errors = 0;

    for (const row of unmatched) {
      // Code format: "360REFUND#XXXXXXYYY..."
      //   chars 0–9  = "360REFUND#"  (10 chars, skip)
      //   chars 10–15 = 6-digit order ID
      if (row.code.length < 16) { noOrderId++; continue; }
      const orderId = parseInt(row.code.substring(10, 16), 10);
      if (isNaN(orderId) || orderId <= 0) { noOrderId++; continue; }

      try {
        // Try direct order ID lookup first
        let order = null;
        const r = await fetch(
          `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders/${orderId}.json?fields=id,name,email,customer`,
          { headers: shopifyHeaders() }
        );

        if (r.status === 404) {
          // Fallback: search by order number (customer-facing #XXXX)
          const sr = await fetch(
            `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?name=%23${orderId}&status=any&fields=id,name,email,customer&limit=1`,
            { headers: shopifyHeaders() }
          );
          if (sr.ok) {
            const sd = await sr.json();
            order = sd.orders?.[0] || null;
          }
        } else if (r.ok) {
          const d = await r.json();
          order = d.order || null;
        }

        if (!order) { notFound++; continue; }

        const customerName = order.customer
          ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
          : null;

        await pool.query(`
          UPDATE coupon_imports
          SET order_id = $1, order_name = $2, customer_name = $3, customer_email = $4
          WHERE id = $5
        `, [order.id, order.name, customerName, order.email, row.id]);

        matched++;
      } catch (fetchErr) {
        console.warn(`[coupons/match] row ${row.id} error:`, fetchErr.message);
        errors++;
      }

      await new Promise((r) => setTimeout(r, 200));
    }

    res.json({ ok: true, processed: unmatched.length, matched, noOrderId, notFound, errors });
  } catch (err) {
    console.error('[coupons/match-orders] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coupons/export?month=YYYY-MM  — CSV file download
app.get('/api/coupons/export', async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        code,
        usage_count    AS "usageCount",
        discount_type  AS "discountType",
        discount_value AS "discountValue",
        expires_at     AS "expiresAt",
        order_name     AS "orderName",
        customer_name  AS "customerName",
        customer_email AS "customerEmail"
      FROM coupon_imports
      WHERE expiry_month = $1
      ORDER BY code ASC
    `, [month]);

    function csvCell(val) {
      if (val == null) return '';
      const s = String(val);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }

    const headers = ['Code', 'Uses', 'Expiry Date', 'Discount Type', 'Discount Value', 'Order', 'Customer Name', 'Email'];
    const lines = [
      headers.join(','),
      ...rows.map((r) => [
        csvCell(r.code),
        csvCell(r.usageCount),
        csvCell(r.expiresAt ? new Date(r.expiresAt).toISOString().split('T')[0] : ''),
        csvCell(r.discountType),
        csvCell(r.discountValue),
        csvCell(r.orderName),
        csvCell(r.customerName),
        csvCell(r.customerEmail),
      ].join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="coupons-${month}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gift Card Export ───────────────────────────────────────────────

// POST /api/gift-cards/sync
// Paginate all enabled Shopify gift cards, filter by expiry month + balance > 0, upsert to DB.
// Requires read_gift_cards scope on the Shopify token.
app.post('/api/gift-cards/sync', requireAuth, async (req, res) => {
  const { expiryMonth } = req.body;
  if (!expiryMonth || !/^\d{4}-\d{2}$/.test(expiryMonth)) {
    return res.status(400).json({ error: 'expiryMonth must be YYYY-MM' });
  }
  try {
    let totalFetched = 0;
    const filtered = [];

    let gcUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/gift_cards.json?status=enabled&limit=250`;
    while (gcUrl) {
      const r = await fetch(gcUrl, { headers: shopifyHeaders() });
      if (!r.ok) {
        const body = await r.text();
        if (r.status === 403) throw new Error('Shopify returned 403 — ensure the read_gift_cards scope is enabled on your access token.');
        throw new Error(`Shopify gift_cards error ${r.status}: ${body.slice(0, 200)}`);
      }
      const data = await r.json();
      const cards = data.gift_cards || [];
      totalFetched += cards.length;

      for (const gc of cards) {
        if (!gc.expires_on) continue;                              // skip cards with no expiry
        if (!gc.expires_on.startsWith(expiryMonth)) continue;     // wrong month
        if (parseFloat(gc.balance) <= 0) continue;                // fully used
        filtered.push(gc);
      }

      const link = r.headers.get('link');
      gcUrl = null;
      if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) gcUrl = m[1]; }
    }

    console.log(`[gift-cards/sync] ${totalFetched} scanned, ${filtered.length} with balance expiring ${expiryMonth}`);

    let inserted = 0, updated = 0;
    for (const gc of filtered) {
      const custName  = gc.customer
        ? `${gc.customer.first_name || ''} ${gc.customer.last_name || ''}`.trim() || null
        : null;
      const custEmail = gc.customer?.email || null;
      const custId    = gc.customer?.id    || null;

      const result = await pool.query(`
        INSERT INTO gift_card_imports
          (gift_card_id, last_characters, initial_value, balance, currency,
           expires_on, expiry_month, order_id, customer_id, customer_name, customer_email)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (gift_card_id) DO UPDATE SET
          last_characters = EXCLUDED.last_characters,
          balance         = EXCLUDED.balance,
          expires_on      = EXCLUDED.expires_on,
          expiry_month    = EXCLUDED.expiry_month,
          order_id        = COALESCE(EXCLUDED.order_id,      gift_card_imports.order_id),
          customer_id     = COALESCE(EXCLUDED.customer_id,   gift_card_imports.customer_id),
          customer_name   = COALESCE(EXCLUDED.customer_name, gift_card_imports.customer_name),
          customer_email  = COALESCE(EXCLUDED.customer_email,gift_card_imports.customer_email),
          imported_at     = NOW()
        RETURNING (xmax = 0) AS was_inserted
      `, [gc.id, gc.last_characters, gc.initial_value, gc.balance, gc.currency || 'AUD',
          gc.expires_on, expiryMonth, gc.order_id || null, custId, custName, custEmail]);

      if (result.rows[0]?.was_inserted) inserted++; else updated++;
    }

    const hint = filtered.length === 0
      ? ' ⚠️ No matching gift cards found — check the expiry month or that gift cards have an expiry date set.'
      : '';
    res.json({ ok: true, totalFetched, monthFiltered: filtered.length, inserted, updated, hint });
  } catch (err) {
    console.error('[gift-cards/sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gift-cards/list?month=YYYY-MM
app.get('/api/gift-cards/list', requireAuth, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT
        gift_card_id   AS "giftCardId",
        last_characters AS "lastCharacters",
        initial_value  AS "initialValue",
        balance,
        currency,
        expires_on     AS "expiresOn",
        order_id       AS "orderId",
        order_name     AS "orderName",
        customer_name  AS "customerName",
        customer_email AS "customerEmail",
        imported_at    AS "importedAt"
      FROM gift_card_imports
      WHERE expiry_month = $1
      ORDER BY balance DESC, last_characters ASC
    `, [month]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gift-cards/match-customers
// For cards without customer data: look up from order_id
app.post('/api/gift-cards/match-customers', requireAuth, async (req, res) => {
  const { expiryMonth } = req.body;
  if (!expiryMonth || !/^\d{4}-\d{2}$/.test(expiryMonth)) {
    return res.status(400).json({ error: 'expiryMonth must be YYYY-MM' });
  }
  try {
    const { rows: unmatched } = await pool.query(`
      SELECT id, order_id FROM gift_card_imports
      WHERE expiry_month = $1 AND customer_email IS NULL AND order_id IS NOT NULL
    `, [expiryMonth]);

    let matched = 0, notFound = 0, noOrderId = 0, errors = 0;

    for (const row of unmatched) {
      try {
        const r = await fetch(
          `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders/${row.order_id}.json?fields=id,name,email,customer`,
          { headers: shopifyHeaders() }
        );
        if (r.status === 404) { notFound++; continue; }
        if (!r.ok)            { errors++;   continue; }
        const data  = await r.json();
        const order = data.order;
        if (!order) { notFound++; continue; }

        const custEmail = order.customer?.email || order.email || null;
        const custName  = order.customer
          ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() || null
          : null;
        const custId    = order.customer?.id || null;

        if (custEmail) {
          await pool.query(`
            UPDATE gift_card_imports
            SET customer_id = $1, customer_name = $2, customer_email = $3, order_name = $4
            WHERE id = $5
          `, [custId, custName, custEmail, order.name || null, row.id]);
          matched++;
        } else {
          notFound++;
        }
      } catch (_) { errors++; }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Count how many still have no customer at all (no order_id either)
    const { rows: noOrder } = await pool.query(`
      SELECT COUNT(*) FROM gift_card_imports
      WHERE expiry_month = $1 AND customer_email IS NULL AND order_id IS NULL
    `, [expiryMonth]);
    noOrderId = parseInt(noOrder[0].count, 10);

    res.json({ ok: true, processed: unmatched.length, matched, notFound, noOrderId, errors });
  } catch (err) {
    console.error('[gift-cards/match-customers] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gift-cards/export?month=YYYY-MM  — CSV download
app.get('/api/gift-cards/export', requireAuth, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT last_characters, initial_value, balance, currency,
             expires_on, order_id, order_name, customer_name, customer_email
      FROM gift_card_imports
      WHERE expiry_month = $1
      ORDER BY balance DESC, last_characters ASC
    `, [month]);

    function csvCell(v) {
      if (v == null) return '';
      const s = String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }

    const headers = ['Last 4 Chars', 'Initial Value', 'Balance', 'Currency', 'Expiry Date', 'Order', 'Customer Name', 'Email'];
    const lines = [headers.join(','), ...rows.map((r) => [
      csvCell(r.last_characters ? `...${r.last_characters}` : ''),
      csvCell(r.initial_value != null ? `$${Number(r.initial_value).toFixed(2)}` : ''),
      csvCell(r.balance       != null ? `$${Number(r.balance).toFixed(2)}`       : ''),
      csvCell(r.currency || 'AUD'),
      csvCell(r.expires_on ? String(r.expires_on).slice(0, 10) : ''),
      csvCell(r.order_name || (r.order_id ? `#${r.order_id}` : '')),
      csvCell(r.customer_name  || ''),
      csvCell(r.customer_email || ''),
    ].join(','))];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="gift-cards-${month}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Margin Tagger ──────────────────────────────────────────────────

// GET /api/margin/debug?variantId=xxx  — trace why a variant has no cost
app.get('/api/margin/debug', requireAuth, async (req, res) => {
  const variantId = String(req.query.variantId || '').trim();
  if (!variantId) return res.status(400).json({ error: 'variantId query param required' });

  try {
    // 1. What do we have stored in the DB?
    const { rows: dbRows } = await pool.query(
      'SELECT * FROM margin_tags WHERE variant_id = $1', [variantId]
    );

    // 2. Find in products cache
    let cachedVariant = null;
    for (const p of productsCache) {
      const v = p.variants.find((v) => String(v.id) === variantId);
      if (v) { cachedVariant = { inventoryItemId: v.inventory_item_id, price: v.price, sku: v.sku, productTitle: p.title }; break; }
    }

    // 3. Fetch the variant directly from Shopify (ground truth)
    const vRes  = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/variants/${variantId}.json`, { headers: shopifyHeaders() });
    const vData = vRes.ok ? await vRes.json() : null;
    const shopifyVariant = vData?.variant || null;

    // 4. If we have an inventory_item_id, fetch its cost directly
    const invItemId = shopifyVariant?.inventory_item_id || cachedVariant?.inventoryItemId;
    let shopifyCost = null;
    if (invItemId) {
      const iRes  = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/inventory_items.json?ids=${invItemId}&fields=id,cost`, { headers: shopifyHeaders() });
      const iData = iRes.ok ? await iRes.json() : null;
      shopifyCost = iData?.inventory_items?.[0] ?? null;
    }

    res.json({
      variantId,
      db:             dbRows[0] ?? null,
      cache:          cachedVariant,
      cacheHasInvId:  cachedVariant ? (cachedVariant.inventoryItemId != null) : null,
      shopifyVariant: shopifyVariant ? { id: shopifyVariant.id, inventory_item_id: shopifyVariant.inventory_item_id, price: shopifyVariant.price, sku: shopifyVariant.sku } : null,
      inventoryItem:  shopifyCost,
      diagnosis: (() => {
        if (!cachedVariant)                    return 'Variant not in products cache — product may be draft/archived or cache is stale';
        if (!cachedVariant.inventoryItemId)    return 'inventory_item_id missing from cached variant — fields parameter may be stripping it';
        if (!shopifyCost)                      return 'Inventory item not returned by Shopify API — check read_inventory scope';
        if (shopifyCost.cost == null)          return 'Inventory item exists but cost is null in Shopify — cost not set on this item';
        return 'Data looks complete — try running Sync again to refresh the DB';
      })(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/margin/sync  — fresh Shopify fetch + full recalculate
app.post('/api/margin/sync', requireAuth, async (req, res) => {
  try {
    const stats = await recalcMarginTiers();
    res.json({ ok: true, ...stats });
  } catch (err) {
    console.error('[margin/sync] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/margin/list?tier=HIGH|MEDIUM|LOW|UNKNOWN
app.get('/api/margin/list', requireAuth, async (req, res) => {
  const { tier } = req.query;
  const params = [];
  let where = '';
  if (tier && ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(tier)) {
    where = 'WHERE margin_tier = $1';
    params.push(tier);
  }
  try {
    const { rows } = await pool.query(`
      SELECT product_id    AS "productId",
             variant_id    AS "variantId",
             product_title AS "productTitle",
             variant_title AS "variantTitle",
             sku,
             cost_price    AS "costPrice",
             sell_price    AS "sellPrice",
             markup,
             margin_tier   AS "marginTier",
             synced_at     AS "syncedAt"
      FROM margin_tags
      ${where}
      ORDER BY product_title ASC, markup DESC NULLS LAST
    `, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/margin/settings
app.get('/api/margin/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM app_settings
       WHERE key IN ('margin_low_max','margin_high_min','margin_feed_prefix','margin_feed_label','margin_feed_token')`
    );
    const s = {};
    for (const r of rows) s[r.key] = r.value;

    // Auto-generate a feed token on first load if one doesn't exist yet
    if (!s.margin_feed_token) {
      s.margin_feed_token = require('crypto').randomUUID();
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('margin_feed_token', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [s.margin_feed_token]
      );
    }

    res.json({
      lowMax:     parseFloat(s.margin_low_max     ?? '25'),
      highMin:    parseFloat(s.margin_high_min    ?? '50'),
      feedPrefix: s.margin_feed_prefix ?? 'shopify_AU',
      feedLabel:  s.margin_feed_label  ?? 'custom_label_3',
      feedToken:  s.margin_feed_token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/margin/settings  — save thresholds + re-tier existing rows in DB (no Shopify call)
app.post('/api/margin/settings', requireAuth, async (req, res) => {
  const { lowMax, highMin, feedPrefix, feedLabel } = req.body;
  if (lowMax == null || highMin == null) {
    return res.status(400).json({ error: 'lowMax and highMin are required' });
  }
  const lm = parseFloat(lowMax);
  const hm = parseFloat(highMin);
  if (isNaN(lm) || isNaN(hm) || lm >= hm) {
    return res.status(400).json({ error: 'lowMax must be a number less than highMin' });
  }
  try {
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at) VALUES
        ('margin_low_max',     $1, NOW()),
        ('margin_high_min',    $2, NOW()),
        ('margin_feed_prefix', $3, NOW()),
        ('margin_feed_label',  $4, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [String(lm), String(hm), feedPrefix || 'shopify_AU', feedLabel || 'custom_label_3']);

    // Re-tier all existing rows using the new thresholds (no Shopify fetch needed)
    await pool.query(`
      UPDATE margin_tags SET margin_tier = CASE
        WHEN markup IS NULL  THEN 'UNKNOWN'
        WHEN markup >= $1    THEN 'HIGH'
        WHEN markup >= $2    THEN 'MEDIUM'
        ELSE                      'LOW'
      END
    `, [hm, lm]);

    const { rows } = await pool.query('SELECT COUNT(*) FROM margin_tags');
    res.json({ ok: true, lowMax: lm, highMin: hm, variants: parseInt(rows[0].count, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/margin/feed.tsv  — Merchant Center supplemental feed (bypasses global auth; token-protected)
app.get('/api/margin/feed.tsv', async (req, res) => {
  try {
    const { rows: settings } = await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('margin_feed_prefix','margin_feed_label','margin_feed_token')`
    );
    const s = {};
    for (const r of settings) s[r.key] = r.value;

    // Require a valid token so the feed isn't wide-open
    if (s.margin_feed_token && req.query.token !== s.margin_feed_token) {
      return res.status(401).send('Unauthorised — include ?token=<your-feed-token> in the URL');
    }

    const prefix = s.margin_feed_prefix ?? 'shopify_AU';
    const label  = s.margin_feed_label  ?? 'custom_label_3';

    const { rows } = await pool.query(
      `SELECT product_id, variant_id, margin_tier FROM margin_tags ORDER BY product_id, variant_id`
    );

    const lines = [`id\t${label}`];
    for (const r of rows) {
      lines.push(`${prefix}_${r.product_id}_${r.variant_id}\t${r.margin_tier}`);
    }

    res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).send('Error generating feed: ' + err.message);
  }
});

// ── Xero — Balance Sheet ───────────────────────────────────────────

// POST /api/xero/sync-balance-sheet
app.post('/api/xero/sync-balance-sheet', async (req, res) => {
  try {
    const result = await xeroSync.syncBalanceSheet();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[xero/balance-sheet] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/xero/balance-sheet — latest snapshot for the BI dashboard
app.get('/api/xero/balance-sheet', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT report_date, section, subsection, account_name, value
      FROM xero_balance_sheet
      WHERE report_date = (SELECT MAX(report_date) FROM xero_balance_sheet)
      ORDER BY section, subsection NULLS LAST, value DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/xero/pl-lines?month=YYYY-MM — line items for a given month
app.get('/api/xero/pl-lines', async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }
  try {
    const { rows } = await pool.query(`
      SELECT section, account_name, value
      FROM xero_pl_lines
      WHERE to_char(period_start, 'YYYY-MM') = $1
      ORDER BY section, value DESC
    `, [month]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/xero/pl-debug — returns raw section structure from stored Xero P&L JSON
app.get('/api/xero/pl-debug', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT period_start, period_end, revenue, cogs, gross_profit, expenses, net_profit, raw_json
      FROM xero_financials
      WHERE report_type = 'ProfitAndLoss'
      ORDER BY period_start DESC
      LIMIT 1
    `);
    if (!rows.length) return res.json({ error: 'No Xero P&L data synced yet' });

    const row = rows[0];
    let rawRows = [];
    try {
      const parsed = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json;
      rawRows = parsed?.Reports?.[0]?.Rows || [];
    } catch { /* ignore parse error */ }

    const sections = rawRows.map(s => {
      if (!s.Title) return null;
      const summaryRow = (s.Rows || []).find(r => r.RowType === 'SummaryRow');
      const row0       = (s.Rows || []).find(r => r.RowType === 'Row');
      return {
        title:       s.Title,
        rowType:     s.RowType,
        summaryVal:  summaryRow?.Cells?.[1]?.Value ?? null,
        firstRowVal: row0?.Cells?.[1]?.Value ?? null,
        childCount:  (s.Rows || []).length,
      };
    }).filter(Boolean);

    res.json({
      period:      `${row.period_start} → ${row.period_end}`,
      stored:      { revenue: row.revenue, cogs: row.cogs, gross_profit: row.gross_profit, expenses: row.expenses, net_profit: row.net_profit },
      sections,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Weekly Business Pulse ──────────────────────────────────────────

// GET /api/weekly-pulse/status
app.get('/api/weekly-pulse/status', (req, res) => {
  res.json(weeklyPulse.getStatus());
});

// GET /api/weekly-pulse/reports — list of saved reports (restricted)
app.get('/api/weekly-pulse/reports', async (req, res) => {
  if (!BI_ALLOWED_EMAILS.includes(req.user?.email)) {
    return res.status(403).json({ error: 'Access restricted' });
  }
  try {
    const reports = await weeklyPulse.getReports();
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/weekly-pulse/run  — manual trigger (restricted)
app.post('/api/weekly-pulse/run', async (req, res) => {
  if (!BI_ALLOWED_EMAILS.includes(req.user?.email)) {
    return res.status(403).json({ error: 'Access restricted' });
  }
  try {
    const result = await weeklyPulse.runWeeklyPulse();
    res.json(result);
  } catch (err) {
    console.error('[weekly-pulse/run] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Home Dashboard ────────────────────────────────────────────────

// GET /api/home/kpis — lightweight KPI summary for the home page (all authenticated users)
app.get('/api/home/kpis', async (req, res) => {
  try {
    const [shopify, gads, meta, alerts] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(revenue), 0)::float AS revenue,
               COALESCE(SUM(orders),  0)::int   AS orders
        FROM shopify_daily
        WHERE date >= CURRENT_DATE - 7::int
      `),
      pool.query(`
        SELECT COALESCE(SUM(cost), 0)::float              AS spend,
               COALESCE(SUM(conversion_value), 0)::float  AS conv_value
        FROM google_ads_daily
        WHERE date >= CURRENT_DATE - 7::int
      `),
      pool.query(`
        SELECT COALESCE(SUM(spend), 0)::float             AS spend,
               COALESCE(SUM(purchase_value), 0)::float    AS conv_value
        FROM meta_ads_daily
        WHERE date >= CURRENT_DATE - 7::int
      `),
      pool.query(`SELECT COUNT(*)::int AS count FROM stock_alerts WHERE resolved = false`),
    ]);

    const revenue      = parseFloat(shopify.rows[0].revenue);
    const orders       = parseInt(shopify.rows[0].orders, 10);
    const googleSpend  = parseFloat(gads.rows[0].spend);
    const metaSpend    = parseFloat(meta.rows[0].spend);
    const totalAdSpend = googleSpend + metaSpend;
    const mer          = revenue > 0 && totalAdSpend > 0
      ? (revenue / totalAdSpend).toFixed(2)
      : null;
    const activeAlerts = parseInt(alerts.rows[0].count, 10);

    res.json({ revenue, orders, googleSpend, metaSpend, totalAdSpend, mer, activeAlerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Operations Status ─────────────────────────────────────────────

// GET /api/ops/status — today's pipeline counts (all authenticated users)
app.get('/api/ops/status', async (req, res) => {
  try {
    const settingsRow = await pool.query(
      "SELECT value FROM app_settings WHERE key = 'ops_status'"
    );
    const cached = settingsRow.rows[0] ? JSON.parse(settingsRow.rows[0].value) : {};
    const cutoff = cached.cutoffTime || new Date().toISOString().slice(0, 10) + 'T00:00:00Z';

    // Primary source: picking_sessions — sum order_count from fully-completed
    // sessions since the manifest cutoff. This has data even before the new
    // picked_orders table started filling up.
    const [sessionRows, pickedRows] = await Promise.all([
      // Proportional estimate from picking_sessions:
      // - Fully complete sessions (picks_completed >= item_count): all orders counted
      // - Partial sessions (stockouts, nav-away, last item missed): orders weighted
      //   by completion ratio so they still contribute rather than being dropped
      pool.query(`
        SELECT COALESCE(SUM(
          CASE
            WHEN picks_completed >= item_count
              THEN order_count
            WHEN item_count > 0 AND picks_completed > 0
              THEN ROUND(order_count::float * picks_completed::float / item_count)
            ELSE 0
          END
        ), 0)::int AS count
        FROM picking_sessions
        WHERE first_pick_at >= $1
          AND picks_completed > 0
      `, [cutoff]),
      // Fine-grained per-order tracking (accumulates going forward via picking page)
      pool.query(`
        SELECT COUNT(*)::int AS count
        FROM picked_orders
        WHERE picked_at >= $1
      `, [cutoff]),
    ]);

    // Use whichever is higher — sessions cover all of today's historical
    // activity; picked_orders adds per-order precision going forward.
    const ordersPicked = Math.max(
      sessionRows.rows[0].count,
      pickedRows.rows[0].count
    );

    res.json({
      ordersToShip: cached.ordersToShip ?? null,
      ordersPicked,
      ordersPacked: cached.ordersPacked ?? null,
      cutoffTime:   cutoff,
      lastSynced:   cached.lastSynced   ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ops/order-picked — called silently by picking.js when all
// items in an order are ticked off
app.post('/api/ops/order-picked', async (req, res) => {
  const { orderName, initials } = req.body || {};
  if (!orderName) return res.status(400).json({ error: 'orderName required' });

  try {
    await pool.query(`
      INSERT INTO picked_orders (order_name, picker_initials, picked_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (order_name) DO UPDATE
        SET picker_initials = EXCLUDED.picker_initials,
            picked_at       = NOW()
    `, [orderName, initials || null]);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Business Intelligence ──────────────────────────────────────────

// GET /api/bi/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns aggregated Shopify, Google Ads, Meta Ads, and Xero data for the period.
// Restricted to specific management emails.
const BI_ALLOWED_EMAILS = ['accounts@theselfstyler.com', 'bianca@theselfstyler.com'];

app.get('/api/bi/summary', async (req, res) => {
  if (!BI_ALLOWED_EMAILS.includes(req.user?.email)) {
    return res.status(403).json({ error: 'Access restricted' });
  }

  const { start, end } = req.query;
  if (!start || !end ||
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'start and end (YYYY-MM-DD) are required' });
  }

  try {
    // ── Shopify ──────────────────────────────────────────────────
    const { rows: sRows } = await pool.query(`
      SELECT
        COALESCE(SUM(revenue),    0) AS revenue,
        COALESCE(SUM(orders),     0) AS orders,
        COALESCE(SUM(items_sold), 0) AS items_sold,
        SUM(sessions)                AS sessions,
        COUNT(*)                     AS days_with_data
      FROM shopify_daily
      WHERE date >= $1 AND date <= $2
    `, [start, end]);

    // ── Google Ads ───────────────────────────────────────────────
    const { rows: gRows } = await pool.query(`
      SELECT
        COALESCE(SUM(cost),             0) AS spend,
        COALESCE(SUM(impressions),      0) AS impressions,
        COALESCE(SUM(clicks),           0) AS clicks,
        COALESCE(SUM(conversions),      0) AS conversions,
        COALESCE(SUM(conversion_value), 0) AS conversion_value
      FROM google_ads_daily
      WHERE date >= $1 AND date <= $2
    `, [start, end]);

    // ── Meta Ads ─────────────────────────────────────────────────
    const { rows: mRows } = await pool.query(`
      SELECT
        COALESCE(SUM(spend),          0) AS spend,
        COALESCE(SUM(impressions),    0) AS impressions,
        COALESCE(SUM(clicks),         0) AS clicks,
        COALESCE(SUM(purchases),      0) AS purchases,
        COALESCE(SUM(purchase_value), 0) AS purchase_value
      FROM meta_ads_daily
      WHERE date >= $1 AND date <= $2
    `, [start, end]);

    // ── Xero P&L — months overlapping the selected period ────────
    const { rows: xRows } = await pool.query(`
      SELECT
        to_char(period_start, 'YYYY-MM') AS month,
        revenue, cogs, gross_profit, expenses, net_profit
      FROM xero_financials
      WHERE report_type = 'ProfitAndLoss'
        AND period_end   >= $1
        AND period_start <= $2
      ORDER BY period_start DESC
    `, [start, end]);

    // ── EBITDA addbacks from P&L line items ───────────────────────
    const { rows: addbackRows } = await pool.query(`
      SELECT
        to_char(period_start, 'YYYY-MM') AS month,
        COALESCE(SUM(CASE WHEN
          LOWER(account_name) LIKE '%depreciation%' OR
          LOWER(account_name) LIKE '%amortis%'      OR
          LOWER(account_name) LIKE '%amortiz%'
          THEN ABS(value) ELSE 0 END), 0) AS da,
        COALESCE(SUM(CASE WHEN
          LOWER(account_name) LIKE '%interest%'
          THEN ABS(value) ELSE 0 END), 0) AS interest,
        COALESCE(SUM(CASE WHEN
          LOWER(account_name) LIKE '%income tax%'   OR
          LOWER(account_name) LIKE '%tax expense%'  OR
          (LOWER(account_name) LIKE '%tax%' AND LOWER(section) LIKE '%tax%')
          THEN ABS(value) ELSE 0 END), 0) AS tax_exp
      FROM xero_pl_lines
      WHERE period_end >= $1 AND period_start <= $2
      GROUP BY to_char(period_start, 'YYYY-MM')
    `, [start, end]);

    const addbackMap = {};
    for (const r of addbackRows) {
      addbackMap[r.month] = {
        da:       parseFloat(r.da),
        interest: parseFloat(r.interest),
        taxExp:   parseFloat(r.tax_exp),
      };
    }

    const s = sRows[0];
    const g = gRows[0];
    const m = mRows[0];

    const sRevenue  = parseFloat(s.revenue);
    const sOrders   = parseInt(s.orders,     10);
    const sItems    = parseInt(s.items_sold, 10);
    const sSessions = s.sessions != null ? parseInt(s.sessions, 10) : null;

    const gSpend    = parseFloat(g.spend);
    const gConvVal  = parseFloat(g.conversion_value);
    const mSpend    = parseFloat(m.spend);
    const mPurchVal = parseFloat(m.purchase_value);
    const totalSpend = gSpend + mSpend;

    res.json({
      period: { start, end },
      shopify: {
        revenue:        sRevenue,
        orders:         sOrders,
        itemsSold:      sItems,
        sessions:       sSessions,
        aov:            sOrders > 0 ? sRevenue / sOrders : 0,
        conversionRate: (sSessions != null && sSessions > 0)
                          ? (sOrders / sSessions) * 100 : null,
        daysWithData:   parseInt(s.days_with_data, 10),
      },
      googleAds: {
        spend:           gSpend,
        impressions:     parseInt(g.impressions, 10),
        clicks:          parseInt(g.clicks, 10),
        conversions:     parseFloat(g.conversions),
        conversionValue: gConvVal,
        roas:            gSpend > 0 ? gConvVal / gSpend : 0,
      },
      metaAds: {
        spend:         mSpend,
        impressions:   parseInt(m.impressions, 10),
        clicks:        parseInt(m.clicks, 10),
        purchases:     parseFloat(m.purchases),
        purchaseValue: mPurchVal,
        roas:          mSpend > 0 ? mPurchVal / mSpend : 0,
      },
      combined: {
        totalAdSpend:   totalSpend,
        mer:            totalSpend > 0 ? sRevenue / totalSpend : 0,
        adCostPerOrder: sOrders  > 0 ? totalSpend / sOrders  : 0,
      },
      xero: xRows.map((r) => {
        const ab = addbackMap[r.month] || { da: 0, interest: 0, taxExp: 0 };
        const netProfit = parseFloat(r.net_profit);
        return {
          month:       r.month,
          revenue:     parseFloat(r.revenue),
          cogs:        parseFloat(r.cogs),
          grossProfit: parseFloat(r.gross_profit),
          expenses:    parseFloat(r.expenses),
          netProfit,
          da:          ab.da,
          interest:    ab.interest,
          taxExp:      ab.taxExp,
          ebitda:      netProfit + ab.da + ab.interest + ab.taxExp,
        };
      }),
    });
  } catch (err) {
    console.error('[bi/summary] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Total Stock Value ──────────────────────────────────────────────

// GET /api/stock-value/history?days=90
app.get('/api/stock-value/history', requireAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 1095);
  try {
    const { rows } = await pool.query(`
      SELECT date, total_rrp, total_cost, variant_count, synced_at
      FROM stock_value_history
      WHERE date >= CURRENT_DATE - ($1::int)
      ORDER BY date ASC
    `, [days]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock-value/audit  — diagnostic: shows what's being counted without writing to DB
app.get('/api/stock-value/audit', requireAuth, async (req, res) => {
  try {
    const variants = [];
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json` +
              `?status=active&limit=250&fields=id,title,variants`;
    while (url) {
      const r = await fetch(url, { headers: shopifyHeaders() });
      if (!r.ok) throw new Error(`Products API ${r.status}`);
      const data = await r.json();
      for (const p of (data.products || [])) {
        if ((p.title || '').toLowerCase().includes('x-redo')) continue;
        for (const v of (p.variants || [])) {
          const qty = parseInt(v.inventory_quantity, 10) || 0;
          if (qty !== 0) {
            variants.push({
              product: p.title,
              sku:     v.sku || '—',
              mgmt:    v.inventory_management || 'none',
              tracked: v.inventory_management === 'shopify',
              price:   parseFloat(v.price) || 0,
              qty,
              rrpValue: (parseFloat(v.price) || 0) * qty,
            });
          }
        }
      }
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const tracked   = variants.filter(v => v.tracked);
    const untracked = variants.filter(v => !v.tracked);

    const totalRrpAll       = variants.reduce((s,v) => s + v.rrpValue, 0);
    const totalRrpTracked   = tracked.reduce((s,v) => s + v.rrpValue, 0);
    const totalRrpUntracked = untracked.reduce((s,v) => s + v.rrpValue, 0);

    // Top 20 by RRP value (untracked first so they're obvious)
    const top20 = [...variants]
      .sort((a,b) => b.rrpValue - a.rrpValue)
      .slice(0, 20)
      .map(v => ({
        product:   v.product,
        sku:       v.sku,
        mgmt:      v.mgmt,
        price:     v.price,
        qty:       v.qty,
        rrpValue:  Math.round(v.rrpValue),
      }));

    res.json({
      summary: {
        totalVariantsWithStock: variants.length,
        trackedCount:           tracked.length,
        untrackedCount:         untracked.length,
        totalRrpAll:            Math.round(totalRrpAll),
        totalRrpTrackedOnly:    Math.round(totalRrpTracked),
        totalRrpUntrackedOnly:  Math.round(totalRrpUntracked),
        inflationFromUntracked: `${((totalRrpUntracked / totalRrpAll) * 100).toFixed(1)}%`,
      },
      top20ByValue: top20,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock-value/sync  — manual trigger
app.post('/api/stock-value/sync', requireAuth, async (req, res) => {
  if (stockValueSync.getIsRunning()) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }
  try {
    const result = await stockValueSync.runSync(pool);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EDM Builder ───────────────────────────────────────────────────

// POST /api/edm/generate
// Accepts campaign brief, proxies to Anthropic, returns { html, subjectA, subjectB, previewText, sendTime, instructions }
app.post('/api/edm/generate', requireAuth, async (req, res) => {
  if (!anthropicClient) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
  }

  const {
    campaignName    = '',
    goal            = '',
    details         = '',
    ctaText         = 'Shop Now',
    ctaUrl          = '',
    products        = [],          // [{ url }] — resolved against Shopify API
    images          = [],          // [{ url, role, linkUrl }] — non-product images
    tone            = 'friendly',
    brandName       = 'The Self Styler',
    brandColour     = '#6366f1',
    logoUrl         = '',          // used to build header in scratch mode
    footerImageUrl  = '',          // optional footer banner
    footerImageLink = '',          // optional click-through link for footer image
    imageFirst      = true,        // hero image before body text
    existingHtml    = '',          // if set: populate-template mode
  } = req.body;

  if (!goal && !details) {
    return res.status(400).json({ error: 'At least a campaign goal or details are required.' });
  }

  // ── Resolve product URLs against Shopify Admin API ────────────────
  function extractProductHandle(url) {
    const m = String(url || '').match(/\/products\/([^/?#\s]+)/);
    return m ? m[1] : null;
  }

  const productResults = [];   // returned to client for status badges
  const resolvedProducts = []; // handed to Claude

  for (const p of products) {
    if (!p.url) continue;
    const handle = extractProductHandle(p.url);
    if (!handle) {
      productResults.push({ url: p.url, ok: false, error: 'No /products/ handle found in URL' });
      continue;
    }
    try {
      const r = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json` +
        `?handle=${encodeURIComponent(handle)}&fields=title,body_html,images,variants,handle&limit=1`,
        { headers: shopifyHeaders() }
      );
      if (!r.ok) throw new Error(`Shopify API ${r.status}`);
      const data  = await r.json();
      const prod  = data.products?.[0];
      if (!prod) throw new Error('Product not found');

      const title       = prod.title;
      const imageUrl    = prod.images?.[0]?.src || null;
      const price       = prod.variants?.[0]?.price ? `AUD $${prod.variants[0].price}` : null;
      const description = prod.body_html
        ? prod.body_html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
        : null;

      resolvedProducts.push({ url: p.url, title, imageUrl, price, description });
      productResults.push({ url: p.url, ok: true, title });
    } catch (e) {
      resolvedProducts.push({ url: p.url, title: null, imageUrl: null, price: null, description: null, error: e.message });
      productResults.push({ url: p.url, ok: false, error: e.message });
    }
  }

  console.log(`[edm/generate] Resolved ${resolvedProducts.length} products (${productResults.filter(r=>r.ok).length} ok)`);

  // Build products section for prompt
  const productsSection = resolvedProducts.length
    ? resolvedProducts.map((p, i) => {
        if (p.error && !p.title) {
          return `  Product ${i + 1}: URL = ${p.url}\n    ⚠ Could not fetch product (${p.error}) — use a placeholder`;
        }
        return [
          `  Product ${i + 1}:`,
          `    Title: ${p.title}`,
          p.price       ? `    Price: ${p.price}` : null,
          `    Product page URL: ${p.url}`,
          `      → Wrap this product's image AND title in <a href="${p.url}" target="_blank" style="text-decoration:none;color:inherit">`,
          p.imageUrl    ? `    Image URL: ${p.imageUrl}\n      → Use this EXACT URL as the <img src> — do not alter it` : `    Image: none available — use a styled placeholder div`,
          p.description ? `    Description snippet: ${p.description}` : null,
        ].filter(Boolean).join('\n');
      }).join('\n\n')
    : null;

  // Build images section for prompt (shared by both modes)
  const imagesSection = images.length
    ? images.map((img, i) => {
        let line = `  Image ${i + 1}: Role = "${img.role || 'product'}", URL = ${img.url || '(none)'}`;
        if (img.linkUrl) {
          line += `\n    → Wrap this <img> in <a href="${img.linkUrl}" target="_blank" style="display:block;text-decoration:none"> so the whole image is clickable`;
        }
        return line;
      }).join('\n')
    : '  (no images provided — keep/replace any existing image placeholders as appropriate)';

  // Logo header instruction (shared)
  const logoInstruction = logoUrl
    ? `- Header: centre the brand logo at the very top of the email using:
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:20px 0 16px">
      <img src="${logoUrl}" alt="${brandName}" style="max-width:180px;height:auto;display:block" />
    </td></tr></table>
    Place this header row before the hero/banner section.`
    : `- Header: create a simple text-based header with the brand name "${brandName}" in large bold font, centred, as a fallback since no logo URL was provided.`;

  // Footer image instruction (shared)
  const footerImageInstruction = footerImageUrl
    ? (() => {
        const imgTag = `<img src="${footerImageUrl}" alt="${brandName}" style="display:block;max-width:100%;height:auto" />`;
        const wrapped = footerImageLink
          ? `<a href="${footerImageLink}" target="_blank" style="display:block;text-decoration:none">${imgTag}</a>`
          : imgTag;
        return `- Footer image: place the following HTML directly above the unsubscribe/copyright line in the footer:
    ${wrapped}`;
      })()
    : '';

  // Brief block reused in both prompts
  const briefBlock = `## Campaign Brief
- Campaign Name: ${campaignName || '(untitled)'}
- Goal: ${goal}
- Tone: ${tone}
- Details / Context:
${details || '(none provided)'}

## Call-to-Action
- CTA Button Text: ${ctaText}
- CTA URL: ${ctaUrl || 'https://theselfstyler.com.au'}
${productsSection ? `
## Products to Feature
${productsSection}

For EACH product above: use the exact provided Image URL as <img src>, wrap both the image and the product title in <a href="[Product page URL]" target="_blank"> for click-through, display the price, and draw on the description for copy inspiration.
` : ''}
## Additional Images
${imagesSection}`;

  let prompt;

  if (existingHtml) {
    // ── Populate-template mode ──────────────────────────────────────
    prompt = `You are an expert email marketing copywriter. You have been given an existing HTML email template for the brand "${brandName}". Your job is to populate it with fresh campaign content based on the brief below.

${briefBlock}

## Your Task
Update the template HTML to reflect this specific campaign. Follow these rules precisely:

CHANGE these things:
1. Hero/banner image src — replace with the Image 1 URL if provided; if the image has a link, wrap in the supplied <a> tag
2. Headline and hero text — rewrite for this campaign's goal and tone
3. Body copy paragraphs — replace with campaign-specific copy (tone: ${tone})
4. CTA button text — use "${ctaText}"
5. CTA button href — use "${ctaUrl || 'https://theselfstyler.com.au'}"
6. Any secondary product images — replace ONLY with image URLs explicitly listed in the Images section above. Never guess or construct Shopify CDN URLs. If no URL is provided for a product, leave the existing image src unchanged or replace with a styled placeholder div
7. Klaviyo personalisation tag in greeting: {{ first_name|default:'there' }}
${logoUrl ? `8. Header logo image src — update to: ${logoUrl}` : ''}
${footerImageUrl ? `9. Footer image — ${footerImageInstruction}` : ''}
${imageFirst ? '10. Layout: if the hero image is not already the first content block after the header, move it above the headline and body copy.' : ''}

DO NOT CHANGE these things:
- Overall table/div structure and layout
- Inline CSS styles, colours, fonts, spacing
- Footer content, unsubscribe link ({{ unsubscribe_url }}), social icons
- Any existing Klaviyo block tags ({% ... %}) or conditional logic
- Image dimensions and alignment attributes

## Output Format
Respond ONLY with a JSON object (no markdown fences, no explanation) with exactly these keys:
{
  "html": "<the complete updated HTML as a single string — escape internal double-quotes with \\">",
  "subjectA": "Subject line variant A (max 50 chars)",
  "subjectB": "Subject line variant B — different angle, also max 50 chars",
  "previewText": "Preview/preheader text shown in inbox before opening (max 90 chars)",
  "sendTime": "Recommended send day and time with reasoning (1–2 sentences)",
  "instructions": "Brief Klaviyo setup notes for this campaign (2–4 dot points as a single string separated by \\n)"
}

## Existing Template HTML
${existingHtml}`;

  } else {
    // ── Generate-from-scratch mode ──────────────────────────────────
    prompt = `You are an expert email marketing designer and copywriter for a fashion e-commerce brand. Create a complete, production-ready HTML email campaign for Klaviyo.

## Brand Details
- Brand Name: ${brandName}
- Brand Colour (primary): ${brandColour}

${briefBlock}

## Requirements for the HTML Email

### Design
- Responsive HTML (mobile-first, max-width 600px, centered)
- Clean fashion-forward layout: header (logo), hero banner, body copy, CTA button, footer
- ${logoInstruction}
- Layout order: ${imageFirst ? 'IMPORTANT — the hero/main image must appear FIRST in the content area, before any headline or body copy text. Structure: logo header → hero image → headline → body copy → CTA button.' : 'Structure: logo header → headline → hero image → body copy → CTA button.'}
- Use the brand colour ${brandColour} for the CTA button and key accents
- Font: system fonts stack — -apple-system, Arial, sans-serif
- Background: #ffffff for content, #f8f8f8 for outer body
- CTA button: bold, rounded (border-radius 4px), high contrast white text on brand colour
- Body images: ONLY use image URLs that are explicitly listed in the Images section above. Do NOT construct, guess, or invent any image URLs — Shopify CDN URLs contain randomised hash segments that cannot be predicted. For any product that does not have an explicit URL provided, render a styled placeholder div (background:#f1f5f9, min-height:300px, display:flex, align-items:center, justify-content:center, with a grey italic label like "[ Product Image ]")
- ${footerImageInstruction || `Footer: no footer image provided — use a clean text-only footer`}
- Footer text: "© ${new Date().getFullYear()} ${brandName} · Unsubscribe" with Klaviyo unsubscribe tag {{ unsubscribe_url }}
- Add Klaviyo merge tags where natural: {{ first_name|default:'there' }} in greeting

### HTML Rules
- Inline all CSS (no <style> blocks — Klaviyo strips them)
- Use table-based layout for Outlook compatibility
- No JavaScript
- All <img> tags must have alt attributes
- Include <!--[if mso]> hacks for Outlook button rendering

### Copy
- Write all headline, body copy, and CTA text yourself based on the campaign brief
- Keep subject-line-worthy headline visible in the hero
- Copy tone must match: ${tone}

## Output Format
Respond ONLY with a JSON object (no markdown fences, no explanation) with exactly these keys:
{
  "html": "<the complete HTML email as a single string — escape internal double-quotes with \\">",
  "subjectA": "Subject line variant A (max 50 chars)",
  "subjectB": "Subject line variant B — different angle, also max 50 chars",
  "previewText": "Preview/preheader text shown in inbox before opening (max 90 chars)",
  "sendTime": "Recommended send day and time with reasoning (1–2 sentences)",
  "instructions": "Brief Klaviyo setup notes: segment suggestion, any personalisation tags used, A/B test recommendation (2–4 dot points as a single string separated by \\n)"
}`;
  }

  try {
    console.log(`[edm/generate] Generating EDM for "${campaignName || goal.slice(0,40)}"`);

    const message = await anthropicClient.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 8000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0]?.text || '';

    // Strip markdown fences if Claude wraps the JSON
    const jsonText = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[edm/generate] JSON parse failed. Raw (first 600):', jsonText.slice(0, 600));
      return res.status(500).json({ error: 'AI returned malformed JSON. Please try again.' });
    }

    // Validate required keys exist
    const required = ['html', 'subjectA', 'subjectB', 'previewText', 'sendTime', 'instructions'];
    const missing  = required.filter(k => !parsed[k]);
    if (missing.length) {
      console.error('[edm/generate] Missing keys:', missing);
      return res.status(500).json({ error: `AI response missing fields: ${missing.join(', ')}` });
    }

    console.log(`[edm/generate] Done — HTML length ${parsed.html.length} chars`);
    res.json({ ...parsed, productResults });

  } catch (err) {
    console.error('[edm/generate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sales Reconciliation ──────────────────────────────────────────

// GET /api/reconcile/analyse?month=YYYY-MM
// Fetches all Shopify orders for the month and compares with Xero P&L data.
// Returns GST breakdown, domestic vs international split, and zero-tax domestic orders.
app.get('/api/reconcile/analyse', requireAuth, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }

  try {
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();

    // AEST (UTC+10) month boundaries — close enough for monthly reconciliation
    const createdAtMin = `${month}-01T00:00:00+10:00`;
    const createdAtMax = `${month}-${String(lastDay).padStart(2, '0')}T23:59:59+10:00`;

    // ── 1. Paginate all Shopify orders for the month ──────────────
    const allOrders = [];
    let ordUrl =
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=any` +
      `&created_at_min=${encodeURIComponent(createdAtMin)}` +
      `&created_at_max=${encodeURIComponent(createdAtMax)}` +
      `&limit=250` +
      `&fields=id,name,created_at,financial_status,cancelled_at,` +
      `total_price,subtotal_price,total_tax,taxes_included,` +
      `total_shipping_price_set,shipping_address,billing_address,` +
      `tax_lines,customer`;

    while (ordUrl) {
      const r = await fetch(ordUrl, { headers: shopifyHeaders() });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Shopify orders API ${r.status}: ${body.slice(0, 200)}`);
      }
      const data = await r.json();
      allOrders.push(...(data.orders || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      ordUrl = next ? next[1] : null;
    }

    // ── 2. Filter to revenue orders (paid / partially_refunded, not cancelled) ──
    const revenueOrders = allOrders.filter(o =>
      (o.financial_status === 'paid' || o.financial_status === 'partially_refunded') &&
      !o.cancelled_at
    );

    // Status breakdown for info
    const byStatus = {};
    for (const o of allOrders) {
      const k = o.cancelled_at ? 'cancelled' : (o.financial_status || 'unknown');
      byStatus[k] = (byStatus[k] || 0) + 1;
    }

    // ── 3. Analyse ────────────────────────────────────────────────
    function getCC(order) {
      const addr = order.shipping_address || order.billing_address;
      return addr && addr.country_code ? addr.country_code.toUpperCase() : 'AU';
    }
    function r2(n) { return Math.round((n || 0) * 100) / 100; }

    let grossRevenue = 0, totalTaxCollected = 0, totalShipping = 0;
    let domesticRevenue = 0, internationalRevenue = 0;
    let domesticCount = 0, internationalCount = 0;
    const zeroTaxDomestic = [];
    const internationalOrders = [];

    for (const o of revenueOrders) {
      const price  = parseFloat(o.total_price) || 0;
      const tax    = parseFloat(o.total_tax)   || 0;
      const ship   = parseFloat(
        o.total_shipping_price_set &&
        o.total_shipping_price_set.shop_money &&
        o.total_shipping_price_set.shop_money.amount
      ) || 0;
      const cc       = getCC(o);
      const domestic = cc === 'AU';

      grossRevenue      += price;
      totalTaxCollected += tax;
      totalShipping     += ship;

      if (domestic) {
        domesticRevenue += price;
        domesticCount++;
        // Zero-tax domestic orders are the key diagnostic
        if (tax < 0.01) {
          const addr = o.shipping_address || o.billing_address || {};
          const cust = o.customer || {};
          zeroTaxDomestic.push({
            name:         o.name,
            createdAt:    o.created_at,
            totalPrice:   r2(price),
            customer:    `${cust.first_name || ''} ${cust.last_name || ''}`.trim() || '—',
            taxesIncluded: !!o.taxes_included,
            taxLines:     (o.tax_lines || []).length,
          });
        }
      } else {
        internationalRevenue += price;
        internationalCount++;
        const addr2 = o.shipping_address || o.billing_address || {};
        const cust2 = o.customer || {};
        internationalOrders.push({
          name:       o.name,
          createdAt:  o.created_at,
          totalPrice: r2(price),
          customer:  `${cust2.first_name || ''} ${cust2.last_name || ''}`.trim() || '—',
          country:    addr2.country || addr2.country_code || '—',
          countryCode: cc,
        });
      }
    }

    const netRevenue        = grossRevenue - totalTaxCollected;
    const expectedGST       = domesticRevenue / 11;     // 10% GST inclusive
    const gstVariance       = totalTaxCollected - expectedGST;
    const zeroTaxRevenue    = zeroTaxDomestic.reduce((s, o) => s + o.totalPrice, 0);
    const impliedMissingGST = zeroTaxRevenue / 11;

    // ── 4. Xero data for comparison ───────────────────────────────
    let xeroRevenue = null, xeroAvailable = false;
    let xeroIncomeLines = [];

    try {
      const { rows: xfRows } = await pool.query(`
        SELECT revenue
        FROM xero_financials
        WHERE report_type = 'ProfitAndLoss'
          AND to_char(period_start, 'YYYY-MM') = $1
        LIMIT 1
      `, [month]);
      if (xfRows.length) {
        xeroRevenue   = parseFloat(xfRows[0].revenue);
        xeroAvailable = true;
      }
    } catch (e) {
      console.warn('[reconcile] xero_financials query error:', e.message);
    }

    try {
      const { rows: xlRows } = await pool.query(`
        SELECT account_name, value, section
        FROM xero_pl_lines
        WHERE to_char(period_start, 'YYYY-MM') = $1
          AND LOWER(section) LIKE '%income%'
        ORDER BY value DESC
      `, [month]);
      xeroIncomeLines = xlRows.map(r => ({
        account: r.account_name,
        value:   parseFloat(r.value),
        section: r.section,
      }));
    } catch (e) { /* ignore — xero_pl_lines may be empty */ }

    // ── 5. Build response ─────────────────────────────────────────
    res.json({
      month,
      ordersTotal:   allOrders.length,
      revenueOrders: revenueOrders.length,
      byStatus,
      shopify: {
        grossRevenue:           r2(grossRevenue),
        totalTaxCollected:      r2(totalTaxCollected),
        totalShipping:          r2(totalShipping),
        netRevenue:             r2(netRevenue),
        domesticOrders:         domesticCount,
        internationalOrders:    internationalCount,
        domesticRevenue:        r2(domesticRevenue),
        internationalRevenue:   r2(internationalRevenue),
        expectedGST:            r2(expectedGST),
        gstVariance:            r2(gstVariance),
        zeroTaxDomesticCount:   zeroTaxDomestic.length,
        zeroTaxDomesticRevenue: r2(zeroTaxRevenue),
        impliedMissingGST:      r2(impliedMissingGST),
        zeroTaxOrders:          zeroTaxDomestic.sort((a, b) => b.totalPrice - a.totalPrice),
        internationalOrdersList: internationalOrders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
      },
      xero: {
        revenue:     xeroRevenue !== null ? r2(xeroRevenue) : null,
        available:   xeroAvailable,
        incomeLines: xeroIncomeLines,
      },
      comparison: (xeroAvailable && xeroRevenue !== null) ? {
        shopifyNetRevenue: r2(netRevenue),
        xeroRevenue:       r2(xeroRevenue),
        difference:        r2(netRevenue - xeroRevenue),
      } : null,
    });

  } catch (err) {
    console.error('[reconcile] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reconcile/taxability-scan
// Fetches all active products and identifies any variants with taxable:false.
// These are the root cause of zero-tax domestic orders.
app.get('/api/reconcile/taxability-scan', requireAuth, async (req, res) => {
  try {
    const allProducts = [];
    let scanUrl =
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json` +
      `?status=active&limit=250&fields=id,title,product_type,variants`;

    while (scanUrl) {
      const r = await fetch(scanUrl, { headers: shopifyHeaders() });
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Shopify products API ${r.status}: ${body.slice(0, 200)}`);
      }
      const data = await r.json();
      allProducts.push(...(data.products || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      scanUrl = next ? next[1] : null;
    }

    let totalVariants = 0;
    let nonTaxableVariantCount = 0;
    const nonTaxableProducts = [];

    for (const p of allProducts) {
      const variants = p.variants || [];
      totalVariants += variants.length;

      const badVariants = variants.filter(v => v.taxable === false);
      nonTaxableVariantCount += badVariants.length;

      if (badVariants.length > 0) {
        nonTaxableProducts.push({
          id:           String(p.id),
          title:        p.title,
          productType:  p.product_type || '',
          totalVariants: variants.length,
          affectedCount: badVariants.length,
          allAffected:   badVariants.length === variants.length,
          variants:      badVariants.map(v => ({
            id:     String(v.id),
            sku:    v.sku || '—',
            price:  v.price,
            option1: v.option1 || null,
            option2: v.option2 || null,
            option3: v.option3 || null,
          })),
        });
      }
    }

    // Sort: most affected variants first, then alphabetically
    nonTaxableProducts.sort((a, b) => b.affectedCount - a.affectedCount || a.title.localeCompare(b.title));

    res.json({
      scannedProducts:        allProducts.length,
      scannedVariants:        totalVariants,
      nonTaxableProductCount: nonTaxableProducts.length,
      nonTaxableVariantCount,
      products: nonTaxableProducts,
    });

  } catch (err) {
    console.error('[reconcile/taxability-scan] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GST Gap Report ────────────────────────────────────────────────
// Scans a date range month-by-month for domestic AU orders containing
// non-taxable line items (taxable:false), excluding gift cards.
// Uses a background-job pattern with polling so the client isn't blocked.

let gstGapState = {
  isRunning:       false,
  currentMonth:    null,
  processedMonths: 0,
  totalMonths:     0,
  result:          null,
  error:           null,
  startedAt:       null,
};

// POST /api/gst-gap/run  { from, to, keywords, excludeGiftCards }
app.post('/api/gst-gap/run', requireAuth, async (req, res) => {
  if (gstGapState.isRunning) {
    return res.status(409).json({ error: 'A job is already running — please wait.' });
  }
  const { from, to, keywords = '', excludeGiftCards = true } = req.body;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !to   || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  }

  gstGapState = {
    isRunning: true, currentMonth: null,
    processedMonths: 0, totalMonths: 0,
    result: null, error: null,
    startedAt: new Date().toISOString(),
  };

  res.json({ started: true });

  runGstGapAnalysis(from, to, String(keywords), !!excludeGiftCards)
    .then(result => {
      gstGapState.isRunning    = false;
      gstGapState.result       = result;
      gstGapState.currentMonth = null;
    })
    .catch(err => {
      console.error('[gst-gap] Error:', err.message);
      gstGapState.isRunning = false;
      gstGapState.error     = err.message;
    });
});

// GET /api/gst-gap/status
app.get('/api/gst-gap/status', requireAuth, (req, res) => res.json(gstGapState));

async function runGstGapAnalysis(from, to, keywordsStr, excludeGiftCards) {
  const keywords = keywordsStr
    .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

  // Build list of YYYY-MM months spanning from → to
  const months = [];
  let [cy, cm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (cy < ty || (cy === ty && cm <= tm)) {
    months.push(`${cy}-${String(cm).padStart(2, '0')}`);
    if (++cm > 12) { cm = 1; cy++; }
  }
  gstGapState.totalMonths = months.length;

  let totalRevenue = 0, totalMissingGST = 0, totalUnits = 0, totalOrders = 0;
  const byProduct = {};
  const byMonth   = [];

  function r2(n) { return Math.round((n || 0) * 100) / 100; }
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  for (const month of months) {
    gstGapState.currentMonth = month;

    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    const minDate = `${month}-01T00:00:00+10:00`;
    const maxDate = `${month}-${String(lastDay).padStart(2,'0')}T23:59:59+10:00`;

    // Fetch all orders for this month (status=any, filter in code)
    const allOrders = [];
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json`
      + `?status=any`
      + `&created_at_min=${encodeURIComponent(minDate)}`
      + `&created_at_max=${encodeURIComponent(maxDate)}`
      + `&limit=250`;

    while (url) {
      const r = await fetch(url, { headers: shopifyHeaders() });
      if (r.status === 429) {
        await sleep(parseInt(r.headers.get('retry-after') || '2', 10) * 1000);
        continue;
      }
      if (r.status === 503 || r.status === 502) { await sleep(3000); continue; }
      if (!r.ok) throw new Error(`Shopify orders ${r.status} (${month})`);
      const data = await r.json();
      allOrders.push(...(data.orders || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    // Revenue orders only: paid or partially_refunded, not cancelled
    const revenueOrders = allOrders.filter(o =>
      (o.financial_status === 'paid' || o.financial_status === 'partially_refunded') &&
      !o.cancelled_at
    );

    const monthData = { month, orders: 0, units: 0, revenue: 0, missingGST: 0 };

    for (const o of revenueOrders) {
      // Domestic AU only
      const addr = o.shipping_address || o.billing_address;
      if (addr && (addr.country_code || '').toUpperCase() !== 'AU') continue;

      let orderAffected = false;

      for (const li of (o.line_items || [])) {
        if (li.taxable !== false) continue;   // only non-taxable items

        // Exclude gift cards
        if (excludeGiftCards) {
          if (li.gift_card === true) continue;
          const titleLow = (li.title || '').toLowerCase();
          if (titleLow.includes('gift card') || titleLow.includes('gift voucher') ||
              titleLow.includes('gift certificate')) continue;
        }

        // Keyword filter — if keywords provided, at least one must match the title
        if (keywords.length > 0) {
          const titleLow = (li.title || '').toLowerCase();
          if (!keywords.some(k => titleLow.includes(k))) continue;
        }

        const qty        = li.quantity || 1;
        const lineTotal  = parseFloat(li.price) * qty;
        const missingGST = lineTotal / 11;

        totalRevenue    += lineTotal;
        totalMissingGST += missingGST;
        totalUnits      += qty;
        monthData.revenue    += lineTotal;
        monthData.missingGST += missingGST;
        monthData.units      += qty;
        orderAffected         = true;

        const pid = String(li.product_id || li.title);
        if (!byProduct[pid]) {
          byProduct[pid] = { title: li.title, revenue: 0, missingGST: 0, units: 0, variants: {} };
        }
        byProduct[pid].revenue    += lineTotal;
        byProduct[pid].missingGST += missingGST;
        byProduct[pid].units      += qty;

        const vk = li.variant_title || 'Default';
        if (!byProduct[pid].variants[vk]) {
          byProduct[pid].variants[vk] = { sku: li.sku || '—', units: 0, revenue: 0, missingGST: 0 };
        }
        byProduct[pid].variants[vk].units      += qty;
        byProduct[pid].variants[vk].revenue    += lineTotal;
        byProduct[pid].variants[vk].missingGST += missingGST;
      }

      if (orderAffected) { totalOrders++; monthData.orders++; }
    }

    byMonth.push({
      month:      monthData.month,
      orders:     monthData.orders,
      units:      monthData.units,
      revenue:    r2(monthData.revenue),
      missingGST: r2(monthData.missingGST),
    });
    gstGapState.processedMonths++;
  }

  const products = Object.values(byProduct)
    .sort((a, b) => b.missingGST - a.missingGST)
    .map(p => ({
      title:      p.title,
      units:      p.units,
      revenue:    r2(p.revenue),
      missingGST: r2(p.missingGST),
      variants:   Object.entries(p.variants)
        .sort((a, b) => b[1].missingGST - a[1].missingGST)
        .map(([name, v]) => ({
          name, sku: v.sku, units: v.units,
          revenue: r2(v.revenue), missingGST: r2(v.missingGST),
        })),
    }));

  return {
    from, to, keywords: keywordsStr, excludeGiftCards,
    totalOrders, totalUnits,
    totalRevenue:    r2(totalRevenue),
    totalMissingGST: r2(totalMissingGST),
    products,
    byMonth,
  };
}

// ── Leave Management ──────────────────────────────────────────────

const LEAVE_ADMIN = 'accounts@theselfstyler.com';

function requireLeaveAdmin(req, res, next) {
  if (!req.user || req.user.email !== LEAVE_ADMIN) {
    return res.status(403).json({ error: 'Leave admin access only' });
  }
  next();
}

// GET /api/leave/employees — list all Xero employees
app.get('/api/leave/employees', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leave_employees ORDER BY last_name, first_name`
    );
    res.json({ employees: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/employees/sync — pull employees from Xero (admin only)
app.post('/api/leave/employees/sync', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    const count = await leaveSync.syncEmployees(pool);
    res.json({ synced: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leave/employees/:id/casual — toggle casual flag (admin only)
app.patch('/api/leave/employees/:id/casual', requireAuth, requireLeaveAdmin, async (req, res) => {
  const { is_casual } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE leave_employees SET is_casual=$1 WHERE id=$2 RETURNING *`,
      [Boolean(is_casual), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ employee: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leave/employees/:id/link — set wms_email on an employee (admin only)
app.patch('/api/leave/employees/:id/link', requireAuth, requireLeaveAdmin, async (req, res) => {
  const { wms_email } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE leave_employees SET wms_email=$1 WHERE id=$2 RETURNING *`,
      [wms_email || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Employee not found' });
    res.json({ employee: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leave/me — get the current user's linked employee
app.get('/api/leave/me', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const { rows } = await pool.query(
      `SELECT * FROM leave_employees WHERE wms_email=$1 AND is_active=TRUE LIMIT 1`,
      [email]
    );
    res.json({ employee: rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leave/requests — admin sees all; staff sees their own
app.get('/api/leave/requests', requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    const isAdmin = req.user.email === LEAVE_ADMIN;
    const params  = [];
    const where   = [];
    if (!isAdmin) { params.push(req.user.email); where.push(`lr.wms_email=$${params.length}`); }
    if (status)   { params.push(status);          where.push(`lr.status=$${params.length}`); }

    // When admin views pending requests, include who else already has approved leave on the same dates
    const conflictsCol = (isAdmin && (!status || status === 'pending')) ? `,
      (SELECT COALESCE(json_agg(json_build_object(
         'name',       TRIM(COALESCE(le2.first_name,'') || ' ' || COALESCE(le2.last_name,'')),
         'start_date', lr2.start_date::text,
         'end_date',   lr2.end_date::text
       ) ORDER BY le2.last_name, le2.first_name), '[]'::json)
       FROM leave_requests lr2
       JOIN leave_employees le2 ON le2.id = lr2.employee_id
       WHERE lr2.status = 'approved'
         AND lr2.start_date <= lr.end_date
         AND lr2.end_date  >= lr.start_date
         AND lr2.id != lr.id
      ) AS conflicts` : '';

    const { rows } = await pool.query(
      `SELECT lr.*, le.first_name, le.last_name, le.xero_employee_id${conflictsCol}
       FROM leave_requests lr
       LEFT JOIN leave_employees le ON le.id = lr.employee_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY lr.created_at DESC`,
      params
    );
    res.json({ requests: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/requests — submit a leave request
app.post('/api/leave/requests', requireAuth, async (req, res) => {
  const { start_date, end_date, notes } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  if (new Date(end_date) < new Date(start_date)) return res.status(400).json({ error: 'end_date must be on or after start_date' });

  try {
    const email = req.user.email;
    // Check blackout periods
    const { rows: blackouts } = await pool.query(
      `SELECT name, start_date, end_date FROM leave_blackouts
       WHERE start_date <= $2 AND end_date >= $1`,
      [start_date, end_date]
    );
    if (blackouts.length) {
      const names = blackouts.map(b => b.name).join(', ');
      return res.status(400).json({
        error: `Your requested dates overlap a blackout period: ${names}. Annual leave cannot be taken during this time.`,
        blackout: true,
      });
    }

    // Find linked employee (include is_casual)
    const { rows: empRows } = await pool.query(
      `SELECT id, first_name, last_name, is_casual FROM leave_employees WHERE wms_email=$1 AND is_active=TRUE LIMIT 1`,
      [email]
    );
    if (!empRows.length) {
      return res.status(400).json({ error: 'Your account is not yet linked to a Xero employee. Contact accounts@theselfstyler.com.' });
    }
    const emp        = empRows[0];
    const employeeId = emp.id;
    const isCasual   = emp.is_casual;

    // Count working days (Mon–Fri, excluding QLD public holidays)
    const { rows: phRows } = await pool.query(
      `SELECT date::text AS date FROM leave_public_holidays WHERE date >= $1 AND date <= $2`,
      [start_date, end_date]
    );
    const publicHolidaySet = new Set(phRows.map(r => r.date));
    const days = (() => {
      let count = 0;
      const end = new Date(end_date);
      const cur = new Date(start_date);
      while (cur <= end) {
        const d = cur.getDay();
        const dateStr = cur.toISOString().slice(0, 10);
        if (d !== 0 && d !== 6 && !publicHolidaySet.has(dateStr)) count++;
        cur.setDate(cur.getDate() + 1);
      }
      return count;
    })();

    // Casual staff: auto-approve immediately, never write to Xero
    const insertStatus    = isCasual ? 'approved' : 'pending';
    const insertApprovedBy = isCasual ? 'casual-auto' : null;

    const { rows: [request] } = await pool.query(
      `INSERT INTO leave_requests
         (employee_id, wms_email, start_date, end_date, days_count, notes, status, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ${isCasual ? 'NOW()' : 'NULL'}) RETURNING *`,
      [employeeId, email, start_date, end_date, days, notes || null, insertStatus, insertApprovedBy]
    );

    const staffName = `${emp.first_name} ${emp.last_name}`.trim() || email;

    if (isCasual) {
      // FYI email to admin — no approval action needed
      mailer.sendCasualUnavailabilityNotification({
        adminEmail: LEAVE_ADMIN,
        staffName,
        staffEmail: email,
        startDate:  start_date,
        endDate:    end_date,
        daysCount:  days,
        notes:      notes || null,
      }).catch(err => console.error('[email] Casual notification failed:', err.message));
    } else {
      mailer.sendLeaveRequestNotification({
        adminEmail: LEAVE_ADMIN,
        staffName,
        staffEmail: email,
        startDate:  start_date,
        endDate:    end_date,
        daysCount:  days,
        notes:      notes || null,
      }).catch(err => console.error('[email] Leave request notification failed:', err.message));
    }

    res.json({ request, isCasual });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leave/requests/:id — approve or reject (admin only)
app.patch('/api/leave/requests/:id', requireAuth, requireLeaveAdmin, async (req, res) => {
  const { status, reject_reason } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved or rejected' });
  }
  try {
    await pool.query(
      `UPDATE leave_requests
       SET status=$1, approved_by=$2, approved_at=NOW(), reject_reason=$3, updated_at=NOW()
       WHERE id=$4`,
      [status, req.user.email, reject_reason || null, req.params.id]
    );
    const { rows } = await pool.query(
      `SELECT lr.*, le.first_name, le.last_name
       FROM leave_requests lr
       LEFT JOIN leave_employees le ON le.id = lr.employee_id
       WHERE lr.id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    const request = rows[0];

    // Email notification to staff member
    mailer[status === 'approved' ? 'sendLeaveApprovedNotification' : 'sendLeaveRejectedNotification']({
      staffEmail:   request.wms_email,
      staffName:    `${request.first_name || ''} ${request.last_name || ''}`.trim() || request.wms_email,
      startDate:    request.start_date,
      endDate:      request.end_date,
      daysCount:    request.days_count,
      rejectReason: request.reject_reason,
    }).catch(err => console.error('[email] Leave status notification failed:', err.message));

    // Auto-create in Xero when approved
    if (status === 'approved' && request.employee_id) {
      leaveSync.createLeaveInXero(pool, request.id).catch(err => {
        console.error(`[leave] Xero write-back failed for request ${request.id}:`, err.message);
        pool.query(
          `UPDATE leave_requests SET xero_status='error', xero_error=$1, updated_at=NOW() WHERE id=$2`,
          [err.message, request.id]
        ).catch(() => {});
      });
    }
    res.json({ request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/requests/:id/xero-retry — manually retry Xero write-back (admin only)
app.post('/api/leave/requests/:id/xero-retry', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    const leaveId = await leaveSync.createLeaveInXero(pool, Number(req.params.id));
    res.json({ ok: true, xero_leave_id: leaveId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leave/slack-preview — preview this week's Slack message (admin only)
app.get('/api/leave/slack-preview', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    const message = await leaveSync.buildSlackMessage(pool);
    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/import-xero — import all leave applications from Xero (admin only)
app.post('/api/leave/import-xero', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    const result = await leaveSync.importLeaveFromXero(pool);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leave/blackouts — list all blackout periods (all staff, so the form can validate)
app.get('/api/leave/blackouts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM leave_blackouts ORDER BY start_date`
    );
    res.json({ blackouts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/blackouts — create a blackout period (admin only)
app.post('/api/leave/blackouts', requireAuth, requireLeaveAdmin, async (req, res) => {
  const { name, start_date, end_date } = req.body;
  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date and end_date are required' });
  }
  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' });
  }
  try {
    const { rows: [blackout] } = await pool.query(
      `INSERT INTO leave_blackouts (name, start_date, end_date) VALUES ($1,$2,$3) RETURNING *`,
      [name.trim(), start_date, end_date]
    );
    res.json({ blackout });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leave/blackouts/:id (admin only)
app.delete('/api/leave/blackouts/:id', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM leave_blackouts WHERE id=$1`, [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leave/public-holidays — list QLD public holidays (all staff)
app.get('/api/leave/public-holidays', requireAuth, async (req, res) => {
  try {
    const { year, from, to } = req.query;
    let query, params;
    if (year) {
      query  = `SELECT * FROM leave_public_holidays WHERE year=$1 ORDER BY date`;
      params = [Number(year)];
    } else if (from && to) {
      query  = `SELECT * FROM leave_public_holidays WHERE date >= $1 AND date <= $2 ORDER BY date`;
      params = [from, to];
    } else {
      query  = `SELECT * FROM leave_public_holidays WHERE year >= EXTRACT(YEAR FROM NOW()) ORDER BY date`;
      params = [];
    }
    const { rows } = await pool.query(query, params);
    res.json({ holidays: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/public-holidays/sync — sync QLD holidays from Nager.Date (admin only)
app.post('/api/leave/public-holidays/sync', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    const years = req.body.year
      ? [Number(req.body.year)]
      : [currentYear, currentYear + 1];
    const results = [];
    for (const y of years) {
      results.push(await leaveSync.syncPublicHolidays(pool, y));
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leave/calendar — monthly calendar data for all staff
app.get('/api/leave/calendar', requireAuth, async (req, res) => {
  const year  = Number(req.query.year)  || new Date().getFullYear();
  const month = Number(req.query.month) || (new Date().getMonth() + 1);

  const firstDay = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay  = new Date(year, month, 0).toISOString().slice(0, 10);

  try {
    const [leaveRes, holidayRes, blackoutRes] = await Promise.all([
      pool.query(
        `SELECT lr.id, lr.start_date::text, lr.end_date::text,
                le.first_name, le.last_name, lr.wms_email, le.is_casual
         FROM leave_requests lr
         LEFT JOIN leave_employees le ON le.id = lr.employee_id
         WHERE lr.status = 'approved'
           AND lr.start_date <= $2 AND lr.end_date >= $1
         ORDER BY le.last_name, le.first_name`,
        [firstDay, lastDay]
      ),
      pool.query(
        `SELECT date::text AS date, name
         FROM leave_public_holidays WHERE date >= $1 AND date <= $2 ORDER BY date`,
        [firstDay, lastDay]
      ),
      pool.query(
        `SELECT id, name, start_date::text, end_date::text
         FROM leave_blackouts WHERE start_date <= $2 AND end_date >= $1 ORDER BY start_date`,
        [firstDay, lastDay]
      ),
    ]);
    res.json({
      year, month,
      leave:    leaveRes.rows,
      holidays: holidayRes.rows,
      blackouts: blackoutRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leave/slack-send — manually trigger the Slack digest (admin only)
app.post('/api/leave/slack-send', requireAuth, requireLeaveAdmin, async (req, res) => {
  try {
    await leaveSync.postWeeklySlackDigest(pool);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Creative Pipeline ─────────────────────────────────────────────

const CREATIVE_TEMPLATES = [
  { id: 'new_arrival',        label: 'New Arrival Drop' },
  { id: 'three_ways_to_style', label: '3 Ways to Style' },
  { id: 'low_stock_urgency',  label: 'Low Stock Urgency' },
  { id: 'founder_ugc',        label: 'Founder UGC' },
  { id: 'outfit_transform',   label: 'Outfit Transformation' },
  { id: 'sale_event',         label: 'Sale Event' },
  { id: 'product_showcase',   label: 'Product Showcase' },
];

// Fetch a product from Shopify GraphQL by GID
async function fetchShopifyProduct(gid) {
  const query = `{
    product(id: "${gid}") {
      id title vendor productType description tags
      priceRangeV2 { minVariantPrice { amount } }
      compareAtPriceRange { maxVariantCompareAtPrice { amount } }
      images(first: 6) { nodes { url altText } }
      collections(first: 10) { nodes { title } }
      totalInventory status
    }
  }`;
  const res = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/2024-01/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }
  );
  const json = await res.json();
  return json.data && json.data.product ? json.data.product : null;
}

// Search Shopify products by title query
async function searchShopifyProducts(q, first = 30) {
  const query = `{
    products(first: ${first}, query: "title:*${q}*") {
      nodes {
        id title vendor productType tags status totalInventory
        priceRangeV2 { minVariantPrice { amount } }
        images(first: 1) { nodes { url } }
      }
    }
  }`;
  const res = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/2024-01/graphql.json`,
    {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }
  );
  const json = await res.json();
  return (json.data && json.data.products && json.data.products.nodes) || [];
}

// GET /api/creative/products — list synced products (with optional search)
app.get('/api/creative/products', requireAuth, async (req, res) => {
  const { q = '', limit = 50, offset = 0 } = req.query;
  try {
    const filter = q ? `AND (title ILIKE $3 OR tags ILIKE $3)` : '';
    const params = q
      ? [Number(limit), Number(offset), `%${q}%`]
      : [Number(limit), Number(offset)];
    const { rows } = await pool.query(
      `SELECT * FROM creative_products ${filter ? 'WHERE ' + filter.slice(4) : ''}
       ORDER BY synced_at DESC LIMIT $1 OFFSET $2`,
      params
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/creative/products/search — live Shopify search
app.post('/api/creative/products/search', requireAuth, async (req, res) => {
  const { q = '' } = req.body;
  try {
    const products = await searchShopifyProducts(q.trim() || '*');
    res.json({ products: products.map(p => ({
      shopify_product_id: p.id,
      title:              p.title,
      vendor:             p.vendor,
      product_type:       p.productType,
      tags:               p.tags ? p.tags.join(', ') : '',
      price:              p.priceRangeV2.minVariantPrice.amount,
      inventory_count:    p.totalInventory,
      is_available:       p.status === 'ACTIVE',
      images:             (p.images.nodes || []).map(i => i.url),
    })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/creative/products/sync — save selected products to DB
app.post('/api/creative/products/sync', requireAuth, async (req, res) => {
  const { productIds } = req.body;  // array of Shopify GIDs
  if (!Array.isArray(productIds) || !productIds.length) {
    return res.status(400).json({ error: 'productIds array required' });
  }
  if (productIds.length > 20) {
    return res.status(400).json({ error: 'Max 20 products per sync' });
  }
  try {
    const synced = [];
    for (const gid of productIds) {
      const p = await fetchShopifyProduct(gid);
      if (!p) continue;
      const images      = (p.images.nodes || []).map(n => n.url);
      const collections = (p.collections.nodes || []).map(n => n.title);
      const price       = parseFloat(p.priceRangeV2.minVariantPrice.amount) || 0;
      const cap         = parseFloat((p.compareAtPriceRange.maxVariantCompareAtPrice || {}).amount) || null;
      await pool.query(
        `INSERT INTO creative_products
           (shopify_product_id, title, vendor, product_type, tags, description,
            price, compare_at_price, images, collections, inventory_count, is_available, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (shopify_product_id) DO UPDATE SET
           title=$2, vendor=$3, product_type=$4, tags=$5, description=$6,
           price=$7, compare_at_price=$8, images=$9, collections=$10,
           inventory_count=$11, is_available=$12, synced_at=NOW()`,
        [
          p.id, p.title, p.vendor, p.productType,
          (p.tags || []).join(', '), p.description || '',
          price, cap,
          JSON.stringify(images), JSON.stringify(collections),
          p.totalInventory || 0, p.status === 'ACTIVE',
        ]
      );
      synced.push(p.id);
    }
    res.json({ synced: synced.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/creative/templates — list available templates
app.get('/api/creative/templates', requireAuth, (_req, res) => {
  res.json({ templates: CREATIVE_TEMPLATES });
});

// POST /api/creative/jobs — create a new generation job
app.post('/api/creative/jobs', requireAuth, async (req, res) => {
  const { productIds, templateType, jobType = 'single', brief: extraBrief = {} } = req.body;
  if (!Array.isArray(productIds) || !productIds.length) {
    return res.status(400).json({ error: 'productIds required' });
  }
  if (jobType === 'single' && productIds.length > 1) {
    return res.status(400).json({ error: 'Single jobs take exactly one product; use jobType=collage for multiple' });
  }
  try {
    // Fetch product rows from DB
    const { rows: products } = await pool.query(
      `SELECT * FROM creative_products WHERE shopify_product_id = ANY($1)`,
      [productIds]
    );
    if (!products.length) {
      return res.status(404).json({ error: 'No matching synced products found — sync them first' });
    }

    // Build brief
    const brief = {
      jobType,
      templateType,
      product:  products[0],
      products: products,
      ...extraBrief,
    };

    // Submit to Arcads if enabled
    let arcadsJobId = null;
    let status = 'queued';
    if (arcadsSync.arcadsEnabled()) {
      try {
        const resp = jobType === 'collage'
          ? await arcadsSync.submitCollageJob(brief)
          : await arcadsSync.submitJob(brief);
        arcadsJobId = resp.id || resp.job_id || resp.video_id || null;
        if (arcadsJobId) status = 'generating';
      } catch (arcadsErr) {
        console.error('[arcads] Submit error:', arcadsErr.message);
        // Fall through — job stays in 'queued' for manual retry
      }
    }

    const { rows: [job] } = await pool.query(
      `INSERT INTO creative_jobs
         (job_type, shopify_product_ids, template_type, arcads_job_id, status, brief, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        jobType,
        productIds,
        templateType,
        arcadsJobId,
        status,
        JSON.stringify(brief),
        req.user ? req.user.email : null,
      ]
    );
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/creative/jobs — list jobs
app.get('/api/creative/jobs', requireAuth, async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  try {
    const params = [Number(limit), Number(offset)];
    const where  = status ? `WHERE status=$3` : '';
    if (status) params.push(status);
    const { rows } = await pool.query(
      `SELECT * FROM creative_jobs ${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      params
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/creative/jobs/:id
app.get('/api/creative/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM creative_jobs WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/creative/jobs/:id — update status (approve/reject/archive)
app.patch('/api/creative/jobs/:id', requireAuth, async (req, res) => {
  const { status, error_message } = req.body;
  const ALLOWED = ['approved', 'rejected', 'archived', 'queued'];
  if (status && !ALLOWED.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED.join(', ')}` });
  }
  try {
    const sets = ['updated_at=NOW()'];
    const params = [];
    if (status)        { params.push(status);        sets.push(`status=$${params.length}`); }
    if (error_message !== undefined) { params.push(error_message); sets.push(`error_message=$${params.length}`); }
    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE creative_jobs SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ job: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/creative/jobs/:id
app.delete('/api/creative/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM creative_jobs WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    startCron();
    googleAds.startCron();
    shopifyAnalytics.startCron();
    ideasCron.startCron(pool, anthropicClient);
    metaAds.startCron(pool);
    xeroSync.startCron(pool);
    weeklyPulse.startCron(pool, anthropicClient);
    opsSync.startCron(pool);
    restockSync.startCron(pool);
    stockValueSync.startCron(pool);
    adsAssetSync.startCron();
    arcadsSync.startCron(pool);
    leaveSync.startCron(pool);

    // Auto-sync QLD public holidays for current + next year
    const _holidayYear = new Date().getFullYear();
    Promise.all([
      leaveSync.syncPublicHolidays(pool, _holidayYear),
      leaveSync.syncPublicHolidays(pool, _holidayYear + 1),
    ]).catch(err => console.error('[leave] Holiday auto-sync failed:', err.message));

    // On Jan 1st, pull in the newly-started year's holidays
    cron.schedule('0 1 1 1 *', async () => {
      const yr = new Date().getFullYear();
      try { await leaveSync.syncPublicHolidays(pool, yr + 1); }
      catch (err) { console.error('[leave] New-year holiday sync failed:', err.message); }
    });

    // Recalculate margin tiers nightly at 02:00
    cron.schedule('0 2 * * *', async () => {
      console.log('[margin] Nightly recalc starting…');
      try {
        const { upserted } = await recalcMarginTiers();
        console.log(`[margin] Nightly recalc done — ${upserted} variants updated`);
      } catch (err) {
        console.error('[margin] Nightly recalc error:', err.message);
      }
    });
    app.listen(PORT, () => {
      console.log(`Warehouse Studio running at http://localhost:${PORT}`);
      if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN) {
        console.warn('WARNING: SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN not set');
      }
    });
  })
  .catch((err) => {
    console.error('Database init failed:', err.message);
    process.exit(1);
  });
