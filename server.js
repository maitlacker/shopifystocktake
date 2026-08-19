require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const PDFDocument  = require('pdfkit');
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
const sellthroughAlerts = require('./sellthrough-alerts');

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
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=active&fields=id,title,variants,images,published_at`;

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
    // Always refresh products cache when loading a pick run — ensures stock numbers are live
    productsCache = await fetchAllProducts();
    lastFetched   = new Date();

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
    const removedItems = [];
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
          // Skip items that are already fulfilled (shipped) — silently, no banner
          if (item.fulfillment_status === 'fulfilled') continue;

          // fulfillable_quantity = qty still needed after refunds/edits (for unfulfilled items)
          const fulfillableQty = item.fulfillable_quantity ?? item.quantity;
          if (fulfillableQty <= 0 && item.quantity > 0) {
            // Unfulfilled item with zero fulfillable qty = refunded/removed before picking
            removedItems.push({
              orderNumber:  order.order_number,
              title:        item.title,
              variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
              sku:          item.sku || '',
            });
            continue;
          }
          items.push({
            orderNumber:  order.order_number,
            variantId:    item.variant_id,
            productId:    item.product_id,
            title:        item.title,
            variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
            sku:          item.sku || '',
            qty:          fulfillableQty,
            originalQty:  item.quantity,
            modified:     fulfillableQty < item.quantity,
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

    res.json({ orders, orderCount: orders.length, items, removedItems });
  } catch (err) {
    console.error('[picking] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/picking/job — get or create a picking job for an order range (shared across devices)
app.post('/api/picking/job', async (req, res) => {
  const { orderStart, orderEnd, initials } = req.body;
  if (!orderStart || !orderEnd) return res.status(400).json({ error: 'orderStart and orderEnd required' });

  try {
    // Find a job for this range within the last 16 hours (covers any single shift)
    const { rows: existing } = await pool.query(
      `SELECT id FROM picking_jobs
       WHERE order_start = $1 AND order_end = $2
         AND created_at > NOW() - INTERVAL '16 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [orderStart, orderEnd]
    );

    let jobId;
    if (existing.length) {
      jobId = existing[0].id;
    } else {
      const { rows: created } = await pool.query(
        `INSERT INTO picking_jobs (order_start, order_end, created_by) VALUES ($1, $2, $3) RETURNING id`,
        [orderStart, orderEnd, initials || null]
      );
      jobId = created[0].id;
    }

    const { rows: states } = await pool.query(
      `SELECT order_number, variant_id::text AS variant_id, picked, picked_by
       FROM picking_item_states WHERE job_id = $1`,
      [jobId]
    );

    res.json({ jobId, states });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/picking/item-state — upsert a single item's pick state
app.post('/api/picking/item-state', async (req, res) => {
  const { jobId, orderNumber, variantId, picked, pickedBy } = req.body;
  if (!jobId || !orderNumber || variantId == null) return res.status(400).json({ error: 'jobId, orderNumber, variantId required' });

  try {
    await pool.query(
      `INSERT INTO picking_item_states (job_id, order_number, variant_id, picked, picked_by, picked_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_id, order_number, variant_id)
       DO UPDATE SET picked = EXCLUDED.picked, picked_by = EXCLUDED.picked_by, picked_at = EXCLUDED.picked_at`,
      [jobId, orderNumber, variantId, picked, pickedBy || null, picked ? new Date() : null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Smart Pick ────────────────────────────────────────────────────

// POST /api/smart-pick/plan
// Accepts { orderStart, orderEnd } — finds up to 8 unfulfilled orders in range,
// joins items with stock_locations, returns serpentine-routed pick plan.
app.post('/api/smart-pick/plan', requireAuth, async (req, res) => {
  const MAX_ORDERS = 8;
  const { orderStart, orderEnd } = req.body;
  const start = parseInt(orderStart);
  const end   = parseInt(orderEnd);

  if (!start || !end || isNaN(start) || isNaN(end) || start > end) {
    return res.status(400).json({ error: 'Valid orderStart and orderEnd required' });
  }

  try {
    // Ensure products cache
    if (!productsCache.length) {
      productsCache = await fetchAllProducts();
      lastFetched   = new Date();
    }

    // Build variant → product and variant → image maps
    const variantProductMap = {};
    const variantImageMap   = {};
    for (const p of productsCache) {
      const productImg = p.images?.[0]?.src || null;
      for (const v of p.variants) {
        const vid = String(v.id);
        variantProductMap[vid] = String(p.id);
        variantImageMap[vid]   = p.images?.find(img => img.id === v.image_id)?.src || productImg;
      }
    }

    // Load all location rows from DB
    const { rows: locRows } = await pool.query(
      'SELECT product_id, variant_id, aisle, bay FROM stock_locations'
    );
    const productLocMap = {};
    const variantLocMap = {};
    for (const row of locRows) {
      if (!row.variant_id) {
        productLocMap[row.product_id] = { aisle: row.aisle, bay: row.bay };
      } else {
        variantLocMap[row.variant_id] = { aisle: row.aisle, bay: row.bay };
      }
    }

    // Fetch orders from Shopify (newest → oldest); collect unfulfilled in range, up to MAX_ORDERS
    const collectedOrders = [];
    let url  = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
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
        if (order.order_number > end)   continue;

        const pickableItems = (order.line_items || []).filter(item =>
          item.fulfillment_status !== 'fulfilled' &&
          (item.fulfillable_quantity ?? item.quantity) > 0 &&
          (item.sku || '').toLowerCase() !== 'x-redo'
        );
        if (pickableItems.length > 0) collectedOrders.push(order);
        if (collectedOrders.length >= MAX_ORDERS) { done = true; break; }
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

    // Sort ascending (oldest order first = bag 1) and assign bag numbers
    collectedOrders.sort((a, b) => a.order_number - b.order_number);
    const bags = collectedOrders.map((order, idx) => ({
      bagNum:      idx + 1,
      orderNumber: order.order_number,
      orderName:   order.name,
      note:        order.note || null,
    }));

    if (!bags.length) {
      return res.json({ bags: [], stops: [], unlocatedItems: [], stats: { orderCount: 0, totalItems: 0, locatedItems: 0, unlocatedItems: 0, stopCount: 0, aisleCount: 0 } });
    }

    // Build per-order item lists
    const bagMap = {};
    for (const bag of bags) bagMap[bag.orderNumber] = bag;

    const locatedItems   = [];
    const unlocatedItems = [];

    for (const order of collectedOrders) {
      const bag = bagMap[order.order_number];
      for (const item of (order.line_items || [])) {
        if ((item.sku || '').toLowerCase() === 'x-redo') continue;
        if (item.fulfillment_status === 'fulfilled')     continue;
        const qty = item.fulfillable_quantity ?? item.quantity;
        if (qty <= 0) continue;

        const vid  = String(item.variant_id);
        const pid  = variantProductMap[vid] || String(item.product_id);
        const loc  = variantLocMap[vid] || productLocMap[pid];
        const base = {
          bagNum:       bag.bagNum,
          orderNumber:  order.order_number,
          orderName:    order.name,
          variantId:    vid,
          productId:    pid,
          title:        item.title,
          variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
          sku:          item.sku || '',
          qty,
          image:        variantImageMap[vid] || null,
        };

        if (loc?.aisle != null) {
          locatedItems.push({ ...base, aisle: loc.aisle, bay: loc.bay });
        } else {
          unlocatedItems.push(base);
        }
      }
    }

    // Serpentine sort: aisle asc; odd aisles bay asc, even aisles bay desc
    locatedItems.sort((a, b) => {
      if (a.aisle !== b.aisle) return a.aisle - b.aisle;
      const bayA = a.aisle % 2 === 0 ? -(a.bay ?? 0) : (a.bay ?? 0);
      const bayB = b.aisle % 2 === 0 ? -(b.bay ?? 0) : (b.bay ?? 0);
      return bayA - bayB;
    });

    // Group into stops (consecutive items at the same aisle + bay)
    const stops = [];
    for (const item of locatedItems) {
      const last = stops[stops.length - 1];
      if (last && last.aisle === item.aisle && last.bay === item.bay) {
        last.items.push(item);
      } else {
        stops.push({ stopNum: stops.length + 1, aisle: item.aisle, bay: item.bay, items: [item] });
      }
    }

    // Sort unlocated by order number
    unlocatedItems.sort((a, b) => a.orderNumber - b.orderNumber);

    res.json({
      bags,
      stops,
      unlocatedItems,
      stats: {
        orderCount:    bags.length,
        totalItems:    locatedItems.length + unlocatedItems.length,
        locatedItems:  locatedItems.length,
        unlocatedItems: unlocatedItems.length,
        stopCount:     stops.length,
        aisleCount:    new Set(locatedItems.map(i => i.aisle)).size,
      },
    });
  } catch (err) {
    console.error('[smart-pick] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Packing Portal ────────────────────────────────────────────────

// GET /api/packing/orders — orders grouped by order number with customer name, for packing portal
app.get('/api/packing/orders', async (req, res) => {
  const start = parseInt(req.query.start);
  const end   = parseInt(req.query.end);

  if (!start || !end || isNaN(start) || isNaN(end) || start > end) {
    return res.status(400).json({ error: 'Valid start and end order numbers required' });
  }
  if (end - start > 500) {
    return res.status(400).json({ error: 'Range too large — max 500 orders at once' });
  }

  try {
    if (!productsCache.length) {
      productsCache = await fetchAllProducts();
      lastFetched   = new Date();
    }

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

    const orders = [];
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=any&limit=250&fields=id,name,order_number,line_items,note,note_attributes,customer,shipping_address`;
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

        // Prefer shipping address name (who it's going to), fall back to customer name
        const sa = order.shipping_address;
        const cu = order.customer;
        const customerName = sa
          ? [sa.first_name, sa.last_name].filter(Boolean).join(' ')
          : (cu ? [cu.first_name, cu.last_name].filter(Boolean).join(' ') : null);

        const items        = [];
        const removedItems = [];

        for (const item of (order.line_items || [])) {
          if ((item.sku || '').toLowerCase() === 'x-redo') continue;
          if (item.fulfillment_status === 'fulfilled') continue;

          const fulfillableQty = item.fulfillable_quantity ?? item.quantity;
          if (fulfillableQty <= 0 && item.quantity > 0) {
            removedItems.push({
              title:        item.title,
              variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
              sku:          item.sku || '',
            });
            continue;
          }

          items.push({
            variantId:    item.variant_id,
            productId:    item.product_id,
            title:        item.title,
            variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
            sku:          item.sku || '',
            qty:          fulfillableQty,
            originalQty:  item.quantity,
            modified:     fulfillableQty < item.quantity,
            image:        variantImageMap[String(item.variant_id)] || null,
            stock:        variantStockMap[String(item.variant_id)] ?? null,
          });
        }

        if (items.length > 0 || removedItems.length > 0) {
          const totalItems = items.reduce((s, i) => s + i.qty, 0);
          orders.push({
            orderNumber:    order.order_number,
            orderName:      order.name,
            customerName:   customerName || null,
            note:           order.note || null,
            noteAttributes: (order.note_attributes || []).filter(a => a.value),
            totalItems,
            items,
            removedItems,
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

    orders.sort((a, b) => a.orderNumber - b.orderNumber);
    res.json({ orders, orderCount: orders.length });
  } catch (err) {
    console.error('[packing] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/packing/audit — record a completed pack event
app.post('/api/packing/audit', async (req, res) => {
  const { orderNumber, orderName, initials, customerName, totalItems,
          rangeStart, rangeEnd, startedAt, packedAt, packTaps, navEvents } = req.body;

  if (!orderNumber || !orderName) {
    return res.status(400).json({ error: 'orderNumber and orderName required' });
  }

  try {
    await pool.query(`
      INSERT INTO packing_audit
        (order_number, order_name, initials, customer_name, total_items,
         range_start, range_end, started_at, packed_at, pack_taps, nav_events)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      orderNumber,
      orderName,
      initials    || null,
      customerName || null,
      totalItems  || 0,
      rangeStart  || null,
      rangeEnd    || null,
      startedAt   ? new Date(startedAt) : new Date(),
      packedAt    ? new Date(packedAt)  : new Date(),
      packTaps    || 0,
      navEvents   || 0,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[packing/audit] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/packing/report — audit report data
app.get('/api/packing/report', async (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 7));

  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        order_number,
        order_name,
        initials,
        customer_name,
        total_items,
        range_start,
        range_end,
        started_at,
        packed_at,
        GREATEST(0, EXTRACT(EPOCH FROM (packed_at - started_at))::int) AS time_seconds,
        pack_taps,
        nav_events
      FROM packing_audit
      WHERE packed_at >= NOW() - ($1 || ' days')::interval
      ORDER BY packed_at DESC
    `, [days]);
    res.json(rows);
  } catch (err) {
    console.error('[packing/report] Error:', err.message);
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

// GET /api/restock/analysis/status — is a run in progress / did the last one fail
app.get('/api/restock/analysis/status', (req, res) => {
  res.json(restockSync.getStatus());
});

// GET /api/restock/po-incoming-debug — how PO lines resolved in the last analysis,
// plus every non-received PO line so draft/unlinked issues are visible
app.get('/api/restock/po-incoming-debug', requireAuth, async (req, res) => {
  try {
    const [{ rows: cacheRows }, { rows: lineRows }] = await Promise.all([
      pool.query(`SELECT value FROM app_settings WHERE key='restock_analysis'`),
      pool.query(`
        SELECT po.po_number, po.status AS po_status, po.delivery_date, po.freight_mode,
               pol.product_id, pol.product_name, pol.product_code, pol.total_qty
        FROM production_order_lines pol
        JOIN production_orders po ON po.id = pol.order_id
        WHERE po.status NOT IN ('received','cancelled') AND po.archived_at IS NULL
        ORDER BY po.po_number, pol.id`),
    ]);
    const analysis = cacheRows.length ? JSON.parse(cacheRows[0].value) : null;
    res.json({
      analysis_generated_at: analysis?.generatedAt || null,
      resolution_last_run: analysis?.poIncoming || 'analysis has not run since this feature deployed — hit Run Analysis',
      all_open_po_lines: lineRows.map(l => ({
        ...l,
        counted_as_incoming: l.po_status === 'confirmed',
        linked_to_shopify: !!l.product_id,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// Normalize "fa, df,SIS" → "FA,DF,SIS"
function normalizeSkuPrefixes(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  return parts.length ? [...new Set(parts)].join(',') : null;
}

app.post('/api/suppliers', async (req, res) => {
  const { companyName, location, currency, contactName, email, phone, notes, leadTimeSea, leadTimeAir, skuPrefixes } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO suppliers (company_name,location,currency,contact_name,email,phone,notes,lead_time_sea,lead_time_air,sku_prefixes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [companyName, location||null, currency||'AUD', contactName||null, email||null, phone||null, notes||null,
       leadTimeSea ? parseInt(leadTimeSea) : null, leadTimeAir ? parseInt(leadTimeAir) : null,
       normalizeSkuPrefixes(skuPrefixes)]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/suppliers/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { companyName, location, currency, contactName, email, phone, notes, leadTimeSea, leadTimeAir, skuPrefixes } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE suppliers SET company_name=$1,location=$2,currency=$3,contact_name=$4,
       email=$5,phone=$6,notes=$7,lead_time_sea=$8,lead_time_air=$9,sku_prefixes=$10,updated_at=NOW() WHERE id=$11 RETURNING *`,
      [companyName, location||null, currency||'AUD', contactName||null, email||null, phone||null, notes||null,
       leadTimeSea ? parseInt(leadTimeSea) : null, leadTimeAir ? parseInt(leadTimeAir) : null,
       normalizeSkuPrefixes(skuPrefixes), id]
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
      WHERE ${req.query.view === 'archived' ? 'po.archived_at IS NOT NULL' : 'po.archived_at IS NULL'}
      ORDER BY po.delivery_date ASC NULLS LAST, po.order_date DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk archive / unarchive
app.post('/api/production-orders/archive', requireAuth, async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE production_orders SET archived_at=NOW(), archived_by=$1, updated_at=NOW()
       WHERE id = ANY($2::int[]) AND archived_at IS NULL`,
      [req.user.email, ids]
    );
    res.json({ ok: true, archived: rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk mark received — confirmed orders only (draft/cancelled are skipped)
app.post('/api/production-orders/mark-received', requireAuth, async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE production_orders SET status='received', updated_at=NOW()
       WHERE id = ANY($1::int[]) AND status = 'confirmed'`,
      [ids]
    );
    // Refresh the planner so the POs drop out of incoming
    if (rowCount) {
      restockSync.runAnalysis().catch(err =>
        console.error('[po] Post-receive restock refresh failed:', err.message));
    }
    res.json({ ok: true, marked_received: rowCount, skipped: ids.length - rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/production-orders/unarchive', requireAuth, async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE production_orders SET archived_at=NULL, archived_by=NULL, updated_at=NOW()
       WHERE id = ANY($1::int[])`,
      [ids]
    );
    res.json({ ok: true, unarchived: rowCount });
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

// Next sequential PO number: starts at 20001, always above any numeric PO already used
async function nextPoNumber(client) {
  const { rows } = await client.query(
    `SELECT GREATEST(
       COALESCE((SELECT MAX(po_number::bigint) FROM production_orders WHERE po_number ~ '^\\d+$'), 0),
       20000
     ) + 1 AS next`
  );
  return String(rows[0].next);
}

// Returns the conflicting PO row if the number is taken, else null
async function findPoNumberConflict(client, poNumber, excludeId) {
  if (!poNumber) return null;
  const params = [poNumber];
  let sql = `SELECT id, po_number, supplier_name, status FROM production_orders
             WHERE UPPER(TRIM(po_number)) = UPPER(TRIM($1))`;
  if (excludeId) { sql += ' AND id <> $2'; params.push(excludeId); }
  const { rows } = await pool.query(sql + ' LIMIT 1', params);
  return rows[0] || null;
}

// NOTE: must register before /api/production-orders/:id
app.get('/api/production-orders/next-number', async (req, res) => {
  try {
    res.json({ next: await nextPoNumber(pool) });
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
          currency, exchangeRate, shippingCost, includeGst, notes, lines=[],
          poType, launchType, collectionName } = req.body;
  const client = await pool.connect();
  try {
    // Blank number → auto-generate; provided number (override) must be unused
    let finalPoNumber = (poNumber || '').trim();
    if (finalPoNumber) {
      const conflict = await findPoNumberConflict(pool, finalPoNumber, null);
      if (conflict) {
        // finally-block releases the client
        return res.status(409).json({
          error: `PO number "${finalPoNumber}" is already used by PO #${conflict.id} (${conflict.supplier_name || 'no supplier'}, ${conflict.status})`,
        });
      }
    }
    await client.query('BEGIN');
    if (!finalPoNumber) finalPoNumber = await nextPoNumber(client);
    const { rows:[po] } = await client.query(
      `INSERT INTO production_orders
         (po_number,supplier_id,supplier_name,order_date,delivery_date,freight_mode,
          currency,exchange_rate,shipping_cost,include_gst,notes,po_type,launch_type,collection_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [finalPoNumber, supplierId||null, supplierName||'', orderDate, deliveryDate||null,
       freightMode||'sea', currency||'AUD', exchangeRate||1, shippingCost||0, includeGst||false, notes||null,
       poType||'restock', launchType||'', collectionName||null]
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
          currency, exchangeRate, shippingCost, includeGst, notes, status, lines,
          poType, launchType, collectionName } = req.body;
  const client = await pool.connect();
  try {
    // Overridden PO numbers must not collide with any other PO
    const conflict = await findPoNumberConflict(pool, (poNumber || '').trim(), id);
    if (conflict) {
      // finally-block releases the client
      return res.status(409).json({
        error: `PO number "${(poNumber || '').trim()}" is already used by PO #${conflict.id} (${conflict.supplier_name || 'no supplier'}, ${conflict.status})`,
      });
    }
    await client.query('BEGIN');
    const { rows:[po] } = await client.query(
      `UPDATE production_orders SET
         po_number=$1,supplier_id=$2,supplier_name=$3,order_date=$4,delivery_date=$5,
         freight_mode=$6,currency=$7,exchange_rate=$8,shipping_cost=$9,include_gst=$10,
         notes=$11,status=COALESCE($12,status),po_type=$13,launch_type=$14,
         collection_name=$15,updated_at=NOW()
       WHERE id=$16 RETURNING *`,
      [poNumber, supplierId||null, supplierName||'', orderDate, deliveryDate||null,
       freightMode||'sea', currency||'AUD', exchangeRate||1, shippingCost||0,
       includeGst||false, notes||null, status||null,
       poType||'restock', launchType||'', collectionName||null, id]
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

// GET /api/production-orders/:id/pdf — download PO as PDF
app.get('/api/production-orders/:id/pdf', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const { rows: [po] } = await pool.query('SELECT * FROM production_orders WHERE id=$1', [id]);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const { rows: lines } = await pool.query(
      'SELECT * FROM production_order_lines WHERE order_id=$1 ORDER BY line_number ASC', [id]);

    const safe = (po.po_number || String(id)).replace(/[^a-zA-Z0-9\-_]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="PO-${safe}.pdf"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4', autoFirstPage: true });
    doc.pipe(res);
    buildPOPdf(doc, po, lines);
    doc.end();
  } catch (err) {
    console.error('PDF error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

function buildPOPdf(doc, po, lines) {
  const W    = doc.page.width;   // 595
  const M    = 48;
  const FULL = W - 2 * M;       // 499

  // ── Palette: black & greys only ──────────────────────────────────
  const BLACK  = '#111827';  // near-black — header bg, table header
  const INK    = '#1f2937';  // dark grey — body text
  const BODY   = '#374151';  // secondary body
  const MUTED  = '#6b7280';  // labels / captions
  const SUBTLE = '#9ca3af';  // faint labels
  const RULE   = '#e5e7eb';  // hairline dividers
  const ALT    = '#f9fafb';  // alternate row tint
  const WHITE  = '#ffffff';

  // ── Helpers ───────────────────────────────────────────────────────
  function pdfDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function fmtNum(n, dp = 2) { return (parseFloat(n) || 0).toFixed(dp); }
  function fmtAud(n) {
    return '$' + (parseFloat(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── Draw the WMS warehouse icon (greyscale) ───────────────────────
  function drawIcon(ix, iy, sz) {
    const s = sz / 32;
    // dark background square
    doc.roundedRect(ix, iy, sz, sz, 5 * s).fill(INK);
    // roof chevron
    doc.moveTo(ix + 4*s, iy + 15*s)
       .lineTo(ix + 16*s, iy + 7*s)
       .lineTo(ix + 28*s, iy + 15*s)
       .closePath().fill(SUBTLE);
    // building body
    doc.rect(ix + 6*s, iy + 15*s, 20*s, 12*s).fill(SUBTLE);
    // door cutout
    doc.rect(ix + 12*s, iy + 19*s, 8*s, 8*s).fill(INK);
  }

  // ── Header band (full bleed dark) ────────────────────────────────
  const BAND_H = 64;
  doc.rect(0, 0, W, BAND_H).fill(BLACK);

  // Icon
  const ICON_SZ = 34;
  drawIcon(M, 15, ICON_SZ);

  // Logo text
  const LOGO_X = M + ICON_SZ + 10;
  doc.font('Helvetica').fontSize(8).fillColor(WHITE)
     .text('THE SELF STYLER', LOGO_X, 22, { characterSpacing: 2.2, lineBreak: false });
  doc.font('Helvetica').fontSize(6).fillColor(SUBTLE)
     .text('WMS', LOGO_X, 34, { characterSpacing: 3, lineBreak: false });

  // PURCHASE ORDER + PO number (right side of band)
  doc.font('Helvetica-Bold').fontSize(13).fillColor(WHITE)
     .text('PURCHASE ORDER', M, 19, { width: FULL, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9.5).fillColor(SUBTLE)
     .text(po.po_number || `#${po.id}`, M, 36, { width: FULL, align: 'right', lineBreak: false });

  // Status pill (small, right)
  const statusLabel = (po.status || 'draft').toUpperCase();
  doc.font('Helvetica-Bold').fontSize(7).fillColor(SUBTLE)
     .text(statusLabel, M, 50, { width: FULL, align: 'right', lineBreak: false });

  // Thin hairline under band
  doc.moveTo(0, BAND_H).lineTo(W, BAND_H).lineWidth(0.5).strokeColor('#374151').stroke();

  let y = BAND_H + 22;

  // ── Info block (supplier + order details) ─────────────────────────
  const COL2_X = M + Math.round(FULL * 0.5);
  const COL2_W = W - M - COL2_X;

  // SUPPLIER label
  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
     .text('SUPPLIER', M, y, { characterSpacing: 1, lineBreak: false });
  y += 12;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(INK)
     .text(po.supplier_name || '—', M, y, { width: COL2_X - M - 12, lineBreak: false });

  // ORDER DETAILS (right column) — position relative to top of info block
  const detailTopY = y - 12;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
     .text('ORDER DETAILS', COL2_X, detailTopY, { characterSpacing: 1, lineBreak: false });

  const detailRows = [
    ['Order Date', pdfDate(po.order_date)],
    ['Due Date',   pdfDate(po.delivery_date)],
    ['Freight',    (po.freight_mode || 'sea').toUpperCase()],
    ['Currency',   po.currency || 'AUD'],
    ['Type',       (po.po_type || 'restock').toUpperCase()],
  ];
  if (po.currency && po.currency !== 'AUD') {
    detailRows.push(['Ex. Rate', `1 ${po.currency} = ${fmtNum(po.exchange_rate, 4)} AUD`]);
  }
  if (po.launch_type) {
    detailRows.push(['Launch Type', po.launch_type === 'new_collection' ? 'New Collection' : 'New Item']);
  }
  if (po.launch_type === 'new_collection' && po.collection_name) {
    detailRows.push(['Collection', po.collection_name]);
  }

  const LBL_COL = 84;
  let dy = detailTopY + 12;
  detailRows.forEach(([lbl, val]) => {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
       .text(lbl, COL2_X, dy, { width: LBL_COL, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BODY)
       .text(val, COL2_X + LBL_COL, dy, { width: COL2_W - LBL_COL, lineBreak: false });
    dy += 13;
  });

  y = Math.max(y + 20, dy) + 16;

  // Divider above table
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor(RULE).stroke();
  y += 14;

  // ── Line items table ──────────────────────────────────────────────
  // Col widths: # | Product Name | Code | Quantities | Qty | Unit | Total  (sum = 499)
  const COLS = [22, 138, 56, 110, 30, 69, 74];
  const curr = po.currency || 'AUD';
  const exRatePdf = parseFloat(po.exchange_rate) || 1;
  const HDRS = ['#', 'Product Name', 'Code', 'Quantities', 'Qty', 'Unit (AUD)', 'Total (AUD)'];
  const ALGN = ['center', 'left', 'left', 'left', 'right', 'right', 'right'];
  const PAD  = 5;
  const HDR_H = 22;
  const ROW_H = 21;

  // Table header — dark background
  doc.rect(M, y, FULL, HDR_H).fill(BLACK);
  let cx = M;
  COLS.forEach((cw, i) => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(WHITE)
       .text(HDRS[i], cx + PAD, y + 7, { width: cw - PAD * 2, align: ALGN[i], lineBreak: false });
    cx += cw;
  });
  y += HDR_H;

  let subtotalForeign = 0;

  const SZ_LINE_H = 12;  // height per size line

  lines.forEach((line, idx) => {
    const qtyObj = typeof line.quantities === 'object' && line.quantities !== null
      ? line.quantities
      : (typeof line.quantities === 'string' ? JSON.parse(line.quantities || '{}') : {});

    const sizeLines = Object.entries(qtyObj)
      .filter(([, v]) => parseInt(v) > 0)
      .map(([k, v]) => `Size ${k} = ${v}`);

    const totalQty     = line.total_qty || Object.values(qtyObj).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const unitPrice    = parseFloat(line.unit_price) || 0;
    const unitPriceAud = unitPrice * exRatePdf;
    const lineTotal    = totalQty * unitPriceAud;
    subtotalForeign += lineTotal;

    // Row height expands to fit all size lines (min ROW_H)
    const rowH = Math.max(ROW_H, sizeLines.length * SZ_LINE_H + 10);

    // Alternate row background
    if (idx % 2 === 1) doc.rect(M, y, FULL, rowH).fill(ALT);

    // Non-quantity cells: vertically centred in rowH
    const otherCells = [
      String(line.line_number || idx + 1),
      line.product_name || '',
      line.product_code || '',
      null,                        // placeholder — drawn separately below
      String(totalQty || 0),
      fmtNum(unitPriceAud),
      fmtNum(lineTotal),
    ];

    const cellTop = y + Math.floor((rowH - 8.5) / 2);
    cx = M;
    otherCells.forEach((text, i) => {
      if (text !== null) {
        const isTotal = i === otherCells.length - 1;
        doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
           .fillColor(isTotal ? INK : BODY)
           .text(text, cx + PAD, cellTop, { width: COLS[i] - PAD * 2, align: ALGN[i], lineBreak: false });
      }
      cx += COLS[i];
    });

    // Quantities column: one "Size X = Y" per line, top-padded
    const QTY_COL_X = M + COLS[0] + COLS[1] + COLS[2];  // col index 3
    const qtyTop = y + 5;
    if (sizeLines.length > 0) {
      sizeLines.forEach((sl, si) => {
        doc.font('Helvetica').fontSize(8).fillColor(BODY)
           .text(sl, QTY_COL_X + PAD, qtyTop + si * SZ_LINE_H,
                 { width: COLS[3] - PAD * 2, align: 'left', lineBreak: false });
      });
    } else {
      doc.font('Helvetica').fontSize(8.5).fillColor(BODY)
         .text('—', QTY_COL_X + PAD, cellTop, { width: COLS[3] - PAD * 2, align: 'left', lineBreak: false });
    }

    y += rowH;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.25).strokeColor(RULE).stroke();

    if (y > doc.page.height - 200) { doc.addPage(); y = M; }
  });

  // Thick bottom border on table
  doc.moveTo(M, y).lineTo(W - M, y).lineWidth(1).strokeColor(INK).stroke();

  // ── Totals block ──────────────────────────────────────────────────
  y += 22;
  const TOT_X  = M + Math.round(FULL * 0.58);
  const TOT_W  = W - M - TOT_X;
  const TLBL_W = Math.round(TOT_W * 0.52);
  const TVAL_X = TOT_X + TLBL_W;
  const TVAL_W = TOT_W - TLBL_W;

  function totLine(lbl, val, bold = false) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .fillColor(MUTED).text(lbl, TOT_X, y, { width: TLBL_W, lineBreak: false });
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
       .fillColor(bold ? INK : BODY)
       .text(val, TVAL_X, y, { width: TVAL_W, align: 'right', lineBreak: false });
    y += 15;
  }

  const freight    = parseFloat(po.shipping_cost) || 0;
  const subtotalAud = subtotalForeign;  // already accumulated in AUD (qty × unit × exRate)
  const beforeGst   = subtotalAud + freight;
  const gst         = po.include_gst ? beforeGst * 0.1 : 0;
  const grandTotal  = beforeGst + gst;

  totLine('Subtotal AUD', fmtAud(subtotalAud));
  totLine('Freight', fmtAud(freight));
  if (po.include_gst) totLine('GST (10%)', fmtAud(gst));

  // Grand total row
  doc.rect(TOT_X - 8, y - 2, TOT_W + 8, 26).fill(BLACK);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(SUBTLE)
     .text('GRAND TOTAL AUD', TOT_X, y + 5, { width: TLBL_W, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(12).fillColor(WHITE)
     .text(fmtAud(grandTotal), TVAL_X, y + 3, { width: TVAL_W, align: 'right', lineBreak: false });
  y += 36;

  // ── Notes ─────────────────────────────────────────────────────────
  if (po.notes && po.notes.trim()) {
    y += 6;
    doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.5).strokeColor(RULE).stroke();
    y += 14;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED)
       .text('NOTES', M, y, { characterSpacing: 1, lineBreak: false });
    y += 13;
    doc.font('Helvetica').fontSize(9).fillColor(BODY).text(po.notes.trim(), M, y, { width: FULL });
    y = doc.y + 8;
  }

  // ── Footer ────────────────────────────────────────────────────────
  const footerY = doc.page.height - 30;
  doc.moveTo(M, footerY - 10).lineTo(W - M, footerY - 10).lineWidth(0.3).strokeColor(RULE).stroke();
  doc.font('Helvetica').fontSize(7).fillColor(SUBTLE)
     .text(
       `The Self Styler WMS  ·  Generated ${new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`,
       M, footerY, { width: FULL, align: 'center', lineBreak: false }
     );
}

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

// ── Stocktake search (live — no cache required) ────────────────────
app.get('/api/stocktake/search-live', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try {
    const h = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
    const f = 'id,title,images,variants,status';

    // Title search via GraphQL — REST products.json has no text-search param
    const safeQ = q.replace(/["\\():*]/g, ' ').replace(/\s+/g, ' ').trim();
    const searchProducts = async (searchQuery) => {
      const gql = `{
        products(first: 12, query: "${searchQuery}", sortKey: TITLE) {
          edges { node {
            legacyResourceId title
            featuredImage { url }
            variants(first: 100) { edges { node {
              legacyResourceId title sku inventoryQuantity
            } } }
          } }
        }
      }`;
      const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: gql }),
      });
      const json = await r.json();
      if (json.errors) throw new Error(`Shopify GraphQL: ${json.errors[0]?.message}`);
      return (json.data?.products?.edges || []).map(({ node }) => ({
        id: Number(node.legacyResourceId),
        title: node.title,
        status: 'active',
        images: node.featuredImage ? [{ src: node.featuredImage.url }] : [],
        variants: (node.variants?.edges || []).map(({ node: v }) => ({
          id: Number(v.legacyResourceId),
          title: v.title,
          sku: v.sku,
          inventory_quantity: v.inventoryQuantity,
        })),
      }));
    };

    // Parallel: title contains-search + exact SKU variant lookup
    let [titleProds, skuData] = await Promise.all([
      searchProducts(`status:active AND title:*${safeQ}*`),
      fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/variants.json?sku=${encodeURIComponent(q)}&limit=5&fields=id,sku,product_id,title,inventory_quantity`, { headers: h }).then(r => r.json()),
    ]);
    // Fallback: free-text search (word-prefix matching, like the Shopify admin search box)
    if (!titleProds.length && safeQ) {
      titleProds = await searchProducts(`status:active AND ${safeQ}`);
    }
    const skuVars = skuData.variants || [];

    // Fetch products for any SKU hits not already in title results
    const titleIds = new Set(titleProds.map(p => p.id));
    const extraIds = [...new Set(skuVars.map(v => v.product_id).filter(id => id && !titleIds.has(id)))];
    let extraProds = [];
    if (extraIds.length) {
      const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?ids=${extraIds.join(',')}&fields=${f}`, { headers: h });
      const { products = [] } = await r.json();
      extraProds = products.filter(p => p.status === 'active');
    }

    const all = [...titleProds.filter(p => p.status === 'active'), ...extraProds].slice(0, 15);
    const ids = all.map(p => p.id);
    const { rows: lastChecks } = ids.length
      ? await pool.query(
          `SELECT DISTINCT ON (product_id) product_id AS "productId", initials, created_at AS "timestamp"
           FROM stocktake_history WHERE product_id = ANY($1::bigint[])
           ORDER BY product_id, created_at DESC`, [ids])
      : { rows: [] };
    const lcMap = {};
    lastChecks.forEach(r => { lcMap[String(r.productId)] = r; });

    res.json(all.map(p => ({
      id: p.id, title: p.title,
      image: p.images && p.images[0] ? p.images[0].src : null,
      variants: (p.variants || []).map(v => ({ id: v.id, title: v.title, sku: v.sku || '', inventory_quantity: v.inventory_quantity || 0 })),
      lastCheck: lcMap[String(p.id)] || null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Product shelf-count (standalone) ───────────────────────────────
app.get('/api/products/:id/shelf-count', requireAuth, async (req, res) => {
  const shopifyId = Number(req.params.id);
  if (!shopifyId) return res.status(400).json({ error: 'Product ID required' });
  try {
    const prodRes = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json?fields=id,title,variants`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    if (!prodRes.ok) return res.status(502).json({ error: `Shopify ${prodRes.status}` });
    const { product } = await prodRes.json();
    const variantIds = new Set((product.variants || []).map(v => v.id));

    const committedMap = {}, orderQtyMap = {};
    let ordersUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=open&fulfillment_status=unfulfilled,partial&limit=250&fields=id,order_number,line_items`;
    while (ordersUrl) {
      const r = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
      if (!r.ok) break;
      const { orders } = await r.json();
      for (const o of (orders || [])) {
        for (const item of (o.line_items || [])) {
          if (!variantIds.has(item.variant_id)) continue;
          const qty = item.fulfillable_quantity ?? item.quantity;
          if (qty <= 0) continue;
          committedMap[item.variant_id] = (committedMap[item.variant_id] || 0) + qty;
          if (!orderQtyMap[o.order_number]) orderQtyMap[o.order_number] = {};
          orderQtyMap[o.order_number][item.variant_id] = (orderQtyMap[o.order_number][item.variant_id] || 0) + qty;
        }
      }
      const link = r.headers.get('link');
      ordersUrl = null;
      if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) ordersUrl = m[1]; }
    }

    const wmsPickedMap = {};
    const unfulfilledNums = Object.keys(orderQtyMap).map(Number);
    if (unfulfilledNums.length && variantIds.size) {
      const { rows } = await pool.query(
        `SELECT DISTINCT order_number, variant_id FROM picking_item_states
         WHERE picked=true AND order_number=ANY($1::int[]) AND variant_id=ANY($2::bigint[])`,
        [unfulfilledNums, [...variantIds]]
      );
      for (const row of rows) {
        const varId = Number(row.variant_id);
        const qty   = (orderQtyMap[Number(row.order_number)] || {})[varId] || 0;
        wmsPickedMap[varId] = (wmsPickedMap[varId] || 0) + qty;
      }
    }

    const variants = (product.variants || []).map(v => {
      const available  = v.inventory_quantity || 0;
      const committed  = committedMap[v.id] || 0;
      const wms_picked = wmsPickedMap[v.id] || 0;
      return { id: v.id, title: v.title, sku: v.sku, available, committed, wms_picked, on_hand: available + committed, true_shelf: available + committed - wms_picked };
    });
    res.json({ variants, product_title: product.title });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${sinceDate.toISOString()}&limit=250&fields=id,cancelled_at,created_at,line_items`;

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
    const newProductGrace   = parseInt(req.query.new_product_grace) || 30;
    const excludeCollection = (req.query.exclude_collection || '').trim();

    const since = new Date();
    since.setDate(since.getDate() - days);

    const newProductCutoff = new Date();
    newProductCutoff.setDate(newProductCutoff.getDate() - newProductGrace);

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

    const now = Date.now();
    const styles = productsCache.map((product) => {
      // Only count sales from when the product became active
      const publishedAt    = product.published_at ? new Date(product.published_at) : null;
      const effectiveStart = publishedAt && publishedAt > since ? publishedAt : since;
      const effectiveDays  = Math.max(1, (now - effectiveStart.getTime()) / (1000 * 60 * 60 * 24));

      const variants = product.variants.map((v) => {
        const sold      = variantSales[String(v.id)] || 0;
        const inventory = Math.max(0, v.inventory_quantity || 0);
        const dailyVel  = sold / effectiveDays;
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
      const styleDailyVel   = totalSold / effectiveDays;
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
      } else if (totalSold < deadMinSold && totalInventory >= deadMinInventory && !excludedProductIds.has(String(product.id)) && !(publishedAt && publishedAt > newProductCutoff)) {
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

// ── Velocity Chart (per-product daily sales from launch) ──────────

app.get('/api/velocity-chart', requireAuth, async (req, res) => {
  try {
  const rawIds    = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const productIds = rawIds.map(Number).filter(n => n > 0);
  const maxDays   = Math.min(parseInt(req.query.max_days || '730'), 730);

  if (!productIds.length || productIds.length > 4)
    return res.status(400).json({ error: 'Provide 1–4 product IDs' });

  if (!productsCache.length) { productsCache = await fetchAllProducts(); lastFetched = new Date(); }

  const products = productIds.map(id => productsCache.find(p => p.id === id)).filter(Boolean);
  if (!products.length)
    return res.status(404).json({ error: 'No products found — try refreshing the product cache.' });

  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const capDate  = new Date(today.getTime() - maxDays * 86400000);

  const meta = products.map(p => ({
    id:          p.id,
    title:       p.title,
    publishedAt: p.published_at ? new Date(p.published_at) : null,
    variantIds:  new Set((p.variants || []).map(v => v.id)),
  })).filter(m => m.publishedAt);

  if (!meta.length)
    return res.status(400).json({ error: 'None of the selected products have a published date.' });

  const minPub    = meta.reduce((d, m) => m.publishedAt < d ? m.publishedAt : d, meta[0].publishedAt);
  const fetchFrom = minPub > capDate ? minPub : capDate;
  const sinceISO  = fetchFrom.toISOString().slice(0, 10);

    const allOrders = [];
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?` +
      `status=any&limit=250&created_at_min=${sinceISO}T00:00:00&fields=created_at,line_items`;

    while (url) {
      const r = await fetch(url, { headers: shopifyHeaders() });
      if (r.status === 429) {
        await new Promise(ok => setTimeout(ok, (parseFloat(r.headers.get('retry-after') || '2')) * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`Shopify orders ${r.status}`);
      const data = await r.json();
      allOrders.push(...(data.orders || []));
      const next = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const results = meta.map(m => {
      const dayMap = {};
      for (const order of allOrders) {
        const ds = order.created_at.slice(0, 10);
        for (const item of (order.line_items || [])) {
          if (m.variantIds.has(item.variant_id)) dayMap[ds] = (dayMap[ds] || 0) + item.quantity;
        }
      }

      const startDate = m.publishedAt > fetchFrom ? m.publishedAt : fetchFrom;
      const days = [];
      const cur = new Date(startDate);
      cur.setUTCHours(0, 0, 0, 0);
      while (cur.toISOString().slice(0, 10) <= todayStr) {
        const d = cur.toISOString().slice(0, 10);
        days.push({ date: d, sold: dayMap[d] || 0 });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }

      const totalSold = days.reduce((s, d) => s + d.sold, 0);
      const peak      = days.reduce((b, d, i) =>
        d.sold > b.sold ? { date: d.date, sold: d.sold, dayNum: i + 1 } : b,
        { date: null, sold: 0, dayNum: 0 });
      const r7  = days.slice(-7).reduce((s, d) => s + d.sold, 0) / 7;
      const p7  = days.length >= 14 ? days.slice(-14, -7).reduce((s, d) => s + d.sold, 0) / 7 : r7;
      const trend = r7 > p7 * 1.1 ? 'up' : r7 < p7 * 0.9 ? 'down' : 'flat';

      return {
        id: m.id, title: m.title,
        published_at: m.publishedAt.toISOString().slice(0, 10),
        days, total_sold: totalSold, total_days: days.length,
        peak, recent7_avg: +r7.toFixed(1), prior7_avg: +p7.toFixed(1), trend,
      };
    });

    res.json({ products: results, orders_fetched: allOrders.length });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)) || 'Unknown server error';
    console.error('[velocity-chart] error:', msg, err.stack || err);
    res.status(500).json({ error: msg });
  }
});

// ── Sell-Through Report ────────────────────────────────────────────

app.get('/api/sell-through', requireAuth, async (req, res) => {
  try {
    const sinceParam   = req.query.since;
    const seasonStart  = sinceParam ? new Date(sinceParam) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const seasonEnd    = req.query.season_end ? new Date(req.query.season_end) : null;
    const minStarting  = parseInt(req.query.min_stock) || 10;

    if (!productsCache || productsCache.length === 0) {
      productsCache = await fetchAllProducts();
      lastFetched = new Date();
    }

    const orders = await fetchOrdersSince(seasonStart);

    const twoWeeksAgo      = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const variantSales     = {};
    const recentVariantSales = {};
    for (const order of orders) {
      if (order.cancelled_at) continue;
      const isRecent = new Date(order.created_at) >= twoWeeksAgo;
      for (const item of (order.line_items || [])) {
        if (!item.variant_id) continue;
        const k = String(item.variant_id);
        variantSales[k]       = (variantSales[k] || 0) + item.quantity;
        if (isRecent) recentVariantSales[k] = (recentVariantSales[k] || 0) + item.quantity;
      }
    }

    const TIER_ORDER = { critical: 4, action: 3, monitor: 2, healthy: 1 };

    const products = productsCache
      .map(product => {
        const r = sellthroughAlerts.calcSellThrough(product, variantSales, recentVariantSales, seasonStart, seasonEnd);
        if (r.startingStock < minStarting)                       return null;
        if (r.currentStock === 0 && r.unitsSold === 0)          return null;
        return {
          id:           product.id,
          title:        product.title,
          product_type: product.product_type || '',
          tags:         product.tags || '',
          image:        product.images && product.images[0] ? product.images[0].src : null,
          ...r,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const td = TIER_ORDER[b.tier] - TIER_ORDER[a.tier];
        if (td !== 0) return td;
        if (a.tier === 'healthy') return b.sell_through_pct - a.sell_through_pct;
        return a.sell_through_pct - b.sell_through_pct;
      });

    const summary = { critical: 0, action: 0, monitor: 0, healthy: 0 };
    products.forEach(p => summary[p.tier]++);

    res.json({
      season_start:   seasonStart.toISOString().split('T')[0],
      season_end:     seasonEnd ? seasonEnd.toISOString().split('T')[0] : null,
      generated_at:   new Date().toISOString(),
      total_analysed: products.length,
      summary,
      products,
    });
  } catch (err) {
    console.error('[sell-through]', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
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

// ── Forecast & Budget ─────────────────────────────────────────────

// GET /api/forecast/data
// Aggregates monthly Shopify revenue, Meta spend, and Xero P&L + computes auto growth rate
app.get('/api/forecast/data', requireAuth, async (req, res) => {
  try {
    const [shopifyRes, metaRes, xeroRes, settingsRes, budgetsRes, stockRes] = await Promise.all([
      pool.query(`
        SELECT
          EXTRACT(YEAR  FROM date)::INT AS year,
          EXTRACT(MONTH FROM date)::INT AS month,
          ROUND(SUM(revenue)::NUMERIC, 2)  AS revenue,
          SUM(orders)::INT                  AS orders,
          COUNT(date)::INT                  AS days_with_data,
          EXTRACT(DAY FROM (DATE_TRUNC('month', MIN(date))
            + INTERVAL '1 month' - INTERVAL '1 day'))::INT AS days_in_month
        FROM shopify_daily
        GROUP BY 1, 2
        ORDER BY 1, 2
      `),
      pool.query(`
        SELECT
          EXTRACT(YEAR  FROM date)::INT AS year,
          EXTRACT(MONTH FROM date)::INT AS month,
          ROUND(SUM(spend)::NUMERIC, 2)          AS spend,
          ROUND(SUM(purchase_value)::NUMERIC, 2) AS purchase_value,
          CASE WHEN SUM(spend) > 0
               THEN ROUND((SUM(purchase_value)/SUM(spend))::NUMERIC, 2)
               ELSE 0 END                         AS roas
        FROM meta_ads_daily
        GROUP BY 1, 2
        ORDER BY 1, 2
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT
          EXTRACT(YEAR  FROM period_start::DATE)::INT AS year,
          EXTRACT(MONTH FROM period_start::DATE)::INT AS month,
          ROUND(revenue::NUMERIC, 2)      AS revenue,
          ROUND(cogs::NUMERIC, 2)         AS cogs,
          ROUND(gross_profit::NUMERIC, 2) AS gross_profit,
          ROUND(expenses::NUMERIC, 2)     AS expenses,
          ROUND(net_profit::NUMERIC, 2)   AS net_profit
        FROM xero_financials
        WHERE report_type = 'ProfitAndLoss'
        ORDER BY period_start
      `).catch(() => ({ rows: [] })),
      pool.query(`SELECT key, value FROM forecast_settings`).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT year, month,
               meta_planned::FLOAT,
               google_planned::FLOAT,
               opex_planned::FLOAT,
               purchasing_planned::FLOAT,
               notes
        FROM forecast_monthly_budgets
        ORDER BY year, month
      `).catch(() => ({ rows: [] })),
      pool.query(`
        SELECT total_rrp::FLOAT, total_cost::FLOAT, date AS snapshot_date
        FROM stock_value_history
        ORDER BY date DESC LIMIT 1
      `).catch(() => ({ rows: [] })),
    ]);

    const settings = {};
    settingsRes.rows.forEach(r => {
      try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
    });

    // Compute CAGR from complete calendar years in shopify_daily
    const yearTotals = {};
    shopifyRes.rows.forEach(r => {
      if (r.days_with_data >= 20) {
        yearTotals[r.year] = (yearTotals[r.year] || 0) + parseFloat(r.revenue);
      }
    });
    const sortedYears = Object.keys(yearTotals).map(Number).sort();
    let autoGrowthRate = 0.15;
    if (sortedYears.length >= 2) {
      const first = sortedYears[0];
      const last  = sortedYears[sortedYears.length - 1];
      const n     = last - first;
      if (n > 0 && yearTotals[first] > 0) {
        autoGrowthRate = Math.pow(yearTotals[last] / yearTotals[first], 1 / n) - 1;
      }
    }

    res.json({
      shopifyMonthly: shopifyRes.rows,
      metaMonthly:    metaRes.rows,
      xeroMonthly:    xeroRes.rows,
      budgets:        budgetsRes.rows,
      settings,
      yearTotals,
      autoGrowthRate: parseFloat(autoGrowthRate.toFixed(4)),
      stockLatest:    stockRes.rows[0] || null,
    });
  } catch (err) {
    console.error('[forecast] data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forecast/settings
app.get('/api/forecast/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, value FROM forecast_settings ORDER BY key`);
    const settings = {};
    rows.forEach(r => {
      try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
    });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forecast/settings
app.post('/api/forecast/settings', requireAuth, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await pool.query(
        `INSERT INTO forecast_settings (key, value, updated_at) VALUES ($1,$2,NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, JSON.stringify(value)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forecast/monthly-budget
app.post('/api/forecast/monthly-budget', requireAuth, async (req, res) => {
  const { year, month, meta_planned, google_planned, opex_planned, purchasing_planned, notes } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  try {
    await pool.query(
      `INSERT INTO forecast_monthly_budgets
         (year, month, meta_planned, google_planned, opex_planned, purchasing_planned, notes, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (year, month) DO UPDATE SET
         meta_planned        = EXCLUDED.meta_planned,
         google_planned      = EXCLUDED.google_planned,
         opex_planned        = EXCLUDED.opex_planned,
         purchasing_planned  = EXCLUDED.purchasing_planned,
         notes               = EXCLUDED.notes,
         updated_at          = NOW()`,
      [year, month, meta_planned ?? null, google_planned ?? null, opex_planned ?? null, purchasing_planned ?? null, notes ?? null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/forecast/backfill
// Triggers historical Shopify revenue sync in the background (returns immediately)
app.post('/api/forecast/backfill', requireAuth, async (req, res) => {
  const yearsBack = Math.min(parseInt(req.body.years || 5), 7);
  const endDate   = new Date().toISOString().slice(0, 10);
  const startYear = new Date().getFullYear() - yearsBack;
  const startDate = `${startYear}-01-01`;
  // Fire and forget — wrapped so a failure cannot crash the process
  try {
    shopifyAnalytics.syncDateRange(startDate, endDate).catch(err => {
      console.error('[forecast] backfill error:', err.message);
    });
  } catch (err) {
    console.error('[forecast] backfill launch error:', err.message);
  }
  res.json({
    message: `Syncing ${yearsBack} years of history (${startDate} → ${endDate}) in the background. This takes a few minutes — refresh the page when done.`,
    startDate,
    endDate,
  });
});

// ── Asana Integration ─────────────────────────────────────────────

const asana = require('./asana');

// GET /api/asana/me — verify token + return user/workspaces
app.get('/api/asana/me', requireAuth, async (req, res) => {
  if (!process.env.ASANA_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'ASANA_ACCESS_TOKEN env var not set' });
  }
  try {
    const me = await asana.getMe();
    res.json(me);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/asana/projects?workspace=<gid>
app.get('/api/asana/projects', requireAuth, async (req, res) => {
  if (!process.env.ASANA_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'ASANA_ACCESS_TOKEN env var not set' });
  }
  const { workspace } = req.query;
  if (!workspace) return res.status(400).json({ error: 'workspace query param required' });
  try {
    const projects = await asana.getProjects(workspace);
    res.json(projects);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/asana/tasks?project=<gid>
app.get('/api/asana/tasks', requireAuth, async (req, res) => {
  if (!process.env.ASANA_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'ASANA_ACCESS_TOKEN env var not set' });
  }
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'project query param required' });
  try {
    const data = await asana.getProjectTasks(project);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/asana/subtasks?task=<gid>
app.get('/api/asana/subtasks', requireAuth, async (req, res) => {
  if (!process.env.ASANA_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'ASANA_ACCESS_TOKEN env var not set' });
  }
  const { task } = req.query;
  if (!task) return res.status(400).json({ error: 'task query param required' });
  try {
    const subtasks = await asana.getSubtasks(task);
    res.json(subtasks);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/asana/mapping — load saved field mapping config
app.get('/api/asana/mapping', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT config FROM asana_po_mapping WHERE id = 1');
    res.json(r.rows.length ? r.rows[0].config : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/asana/mapping — save field mapping config
app.post('/api/asana/mapping', requireAuth, async (req, res) => {
  try {
    await pool.query(`
      INSERT INTO asana_po_mapping (id, config)
      VALUES (1, $1)
      ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = NOW()
    `, [JSON.stringify(req.body)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stock Sleuth ──────────────────────────────────────────────────────

async function sleutherFindVariantBySku(sku) {
  const safe = sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const query = `{
    productVariants(first: 10, query: "sku:${safe}") {
      edges { node {
        id legacyResourceId sku title inventoryQuantity
        inventoryItem { id legacyResourceId }
        product { id legacyResourceId title images(first: 1) { nodes { url } } }
      }}
    }
  }`;
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Shopify variant API ${r.status}: ${t.slice(0,200)}`); }
  let json;
  try { json = await r.json(); } catch (e) { throw new Error(`Shopify variant response not JSON: ${e.message}`); }
  if (json.errors) throw new Error(`Shopify GraphQL: ${json.errors[0]?.message || JSON.stringify(json.errors)}`);
  const edges = (json.data?.productVariants?.edges) || [];
  const exact = edges.find(e => e.node.sku.toLowerCase() === sku.toLowerCase());
  return exact ? exact.node : (edges[0]?.node || null);
}

async function sleutherGetInventory(inventoryItemGid) {
  const query = `{
    inventoryItem(id: "${inventoryItemGid}") {
      id legacyResourceId sku tracked
      inventoryLevels(first: 20) {
        edges { node {
          location { id name }
          quantities(names: ["available","committed","on_hand","reserved","damaged","safety_stock","quality_control","incoming"]) {
            name quantity
          }
        }}
      }
    }
  }`;
  const r = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Shopify inventory API ${r.status}: ${t.slice(0,200)}`); }
  let json;
  try { json = await r.json(); } catch (e) { throw new Error(`Shopify inventory response not JSON: ${e.message}`); }
  if (json.errors) throw new Error(`Shopify GraphQL: ${json.errors[0]?.message || JSON.stringify(json.errors)}`);
  const item = json.data?.inventoryItem;
  if (!item) return null;
  const locations = (item.inventoryLevels?.edges || []).map(e => {
    const q = {};
    for (const { name, quantity } of (e.node.quantities || [])) q[name] = quantity;
    return { name: e.node.location.name, quantities: q };
  });
  const totals = { available: 0, committed: 0, on_hand: 0, reserved: 0, damaged: 0, safety_stock: 0, quality_control: 0, incoming: 0 };
  for (const loc of locations) {
    for (const [k, v] of Object.entries(loc.quantities)) {
      if (k in totals) totals[k] += (v || 0);
    }
  }
  return { tracked: item.tracked, locations, totals };
}

async function sleutherFetchInventoryEvents(productLegacyId, sinceDate) {
  const events = [];
  const sinceParam = sinceDate ? `&created_at_min=${sinceDate.toISOString()}` : '';
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/events.json?filter=Product&subject_id=${productLegacyId}&limit=250${sinceParam}`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) break;
    const data = await r.json().catch(() => ({}));
    events.push(...(data.events || []));
    const link = r.headers.get('link');
    url = null;
    if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  // Keep only inventory-related events
  return events
    .filter(ev => {
      const verb = (ev.verb || '').toLowerCase();
      const msg  = (ev.message || ev.body || '').toLowerCase();
      return verb === 'adjusted'
        || verb.includes('inventory')
        || msg.includes('inventory')
        || msg.includes('adjusted')
        || msg.includes('units')
        || msg.includes('stock');
    })
    .map(ev => ({
      id:      ev.id,
      date:    ev.created_at,
      author:  ev.author || '(app / unknown)',
      verb:    ev.verb   || '',
      message: ev.message || (ev.body || '').replace(/<[^>]*>/g, '') || '',
    }));
}

async function sleutherFetchOrders(sinceDate) {
  const orders = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${sinceDate.toISOString()}&limit=250&fields=id,name,email,created_at,financial_status,fulfillment_status,cancelled_at,cancel_reason,line_items,refunds`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) { const t = await r.text(); throw new Error(`Shopify Orders ${r.status}: ${t}`); }
    const data = await r.json();
    orders.push(...data.orders);
    const link = r.headers.get('link');
    url = null;
    if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return orders;
}

app.get('/api/stock-sleuth', requireAuth, async (req, res) => {
  try {
    const sku = (req.query.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku param is required' });

    const windowDays = Math.min(parseInt(req.query.days) || 730, 730);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const variantNode = await sleutherFindVariantBySku(sku);
    if (!variantNode) return res.status(404).json({ error: `No variant found for SKU "${sku}"` });

    const variantId = String(variantNode.legacyResourceId);
    const inventoryItemGid = variantNode.inventoryItem.id;

    const productLegacyId = String(variantNode.product.legacyResourceId);

    const [inventory, allOrders, inventoryEvents] = await Promise.all([
      sleutherGetInventory(inventoryItemGid),
      sleutherFetchOrders(since),
      sleutherFetchInventoryEvents(productLegacyId, since),
    ]);

    const matchedOrders = allOrders.filter(o =>
      (o.line_items || []).some(li => String(li.variant_id) === variantId)
    );

    const events = [];

    for (const order of matchedOrders) {
      const lis = (order.line_items || []).filter(li => String(li.variant_id) === variantId);
      const totalQty = lis.reduce((s, li) => s + (li.quantity || 0), 0);
      if (!totalQty) continue;

      if (order.cancelled_at) {
        events.push({
          type: 'cancellation',
          date: order.cancelled_at,
          order_id: order.id,
          order_name: order.name,
          email: order.email || '',
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          cancel_reason: order.cancel_reason || '',
          qty: totalQty,
          qty_delta: +totalQty,
        });
      } else {
        events.push({
          type: 'sale',
          date: order.created_at,
          order_id: order.id,
          order_name: order.name,
          email: order.email || '',
          financial_status: order.financial_status,
          fulfillment_status: order.fulfillment_status,
          qty: totalQty,
          qty_delta: -totalQty,
        });
      }

      for (const refund of (order.refunds || [])) {
        const rlis = (refund.refund_line_items || []).filter(rli => {
          const li = (order.line_items || []).find(l => l.id === rli.line_item_id);
          return li && String(li.variant_id) === variantId;
        });
        if (!rlis.length) continue;
        const refundQty   = rlis.reduce((s, rli) => s + (rli.quantity || 0), 0);
        const restockType = rlis[0].restock_type || 'unknown';
        const restocked   = restockType !== 'no_restock';
        events.push({
          type: 'refund',
          date: refund.created_at || order.created_at,
          order_id: order.id,
          order_name: order.name,
          qty: refundQty,
          qty_delta: restocked ? +refundQty : 0,
          restock_type: restockType,
          restocked,
        });
      }
    }

    events.sort((a, b) => new Date(a.date) - new Date(b.date));

    const onHand     = inventory ? (inventory.totals.on_hand || 0) : 0;
    const totalSold  = events.filter(e => e.type === 'sale').reduce((s, e) => s + e.qty, 0);
    const totalRest  = events.filter(e => e.type === 'refund' && e.restocked).reduce((s, e) => s + e.qty, 0);
    const inferredStart = onHand + totalSold - totalRest;

    let running = inferredStart;
    for (const ev of events) {
      ev.running_before = running;
      running += ev.qty_delta;
    }
    const inferredFinal = running;

    const anomalies = [];

    if (onHand < 0) {
      anomalies.push({
        severity: 'error',
        type: 'negative_stock',
        message: `Current on-hand stock is ${onHand}. This is only expected after a checkout race condition and should resolve once both orders are fulfilled.`,
        date: null, orders: [],
      });
    }

    const sales = events.filter(e => e.type === 'sale').sort((a, b) => new Date(a.date) - new Date(b.date));
    for (let i = 0; i < sales.length - 1; i++) {
      const gap = (new Date(sales[i + 1].date) - new Date(sales[i].date)) / 1000;
      if (gap <= 60) {
        anomalies.push({
          severity: 'info',
          type: 'race_condition',
          message: `Orders ${sales[i].order_name} and ${sales[i + 1].order_name} were placed ${Math.round(gap)}s apart — likely a checkout race condition where two customers bought the last unit simultaneously.`,
          date: sales[i].date,
          orders: [sales[i].order_name, sales[i + 1].order_name],
        });
      }
    }

    for (const ev of events.filter(e => e.type === 'refund' && !e.restocked)) {
      anomalies.push({
        severity: 'warning',
        type: 'refund_no_restock',
        message: `${ev.qty} unit(s) on ${ev.order_name} were refunded with restock_type="${ev.restock_type}" — no inventory adjustment made. If the item was physically returned, the stock should be +1'd manually.`,
        date: ev.date,
        orders: [ev.order_name],
      });
    }

    for (const ev of events.filter(e => e.type === 'cancellation' && ['paid', 'partially_refunded', 'partially_paid'].includes(e.financial_status))) {
      const hasRestockRefund = events.some(e2 => e2.type === 'refund' && e2.order_id === ev.order_id && e2.restocked);
      if (!hasRestockRefund) {
        anomalies.push({
          severity: 'warning',
          type: 'paid_cancellation',
          message: `Order ${ev.order_name} was cancelled after payment (${ev.financial_status}) with no corresponding restock refund found — stock may not have been returned.`,
          date: ev.date,
          orders: [ev.order_name],
        });
      }
    }

    const drift = inferredFinal - onHand;
    if (Math.abs(drift) > 0) {
      const sev = Math.abs(drift) >= 3 ? 'warning' : 'info';
      anomalies.push({
        severity: sev,
        type: 'stock_drift',
        message: `Order history implies ${inferredFinal} units now; Shopify shows ${onHand} on hand — ${drift > 0 ? '+' : ''}${drift} unexplained. This gap is likely REDO restocks or manual stocktake adjustments not captured in orders.`,
        date: null, orders: [],
      });
    }

    const minRunning = events.length ? events.reduce((m, e) => Math.min(m, e.running_before || 0), inferredStart) : inferredStart;
    if (minRunning < -1) {
      anomalies.push({
        severity: 'error',
        type: 'multi_negative',
        message: `Order timeline shows stock reaching ${minRunning} — below the -1 expected from a single race condition. Orders may have been processed when stock was already at zero or negative.`,
        date: null, orders: [],
      });
    }

    res.json({
      sku,
      variant: {
        id: variantId,
        sku: variantNode.sku,
        title: variantNode.title,
        product_id: String(variantNode.product.legacyResourceId),
        product_title: variantNode.product.title,
        product_image: variantNode.product.images.nodes[0]?.url || null,
      },
      inventory: inventory || { tracked: false, locations: [], totals: {} },
      events,
      anomalies,
      inventoryEvents,
      stats: {
        orders_in_window: matchedOrders.length,
        total_sold: totalSold,
        total_refund_restocked: totalRest,
        inferred_start: inferredStart,
        window_days: windowDays,
        window_since: since.toISOString(),
      },
    });
  } catch (err) {
    console.error('[stock-sleuth] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stock Receipt Forms (SRF) ─────────────────────────────────────

app.get('/api/srf/config', requireAuth, async (req, res) => {
  try {
    const [ftRes, sgRes, supRes] = await Promise.all([
      pool.query('SELECT * FROM srf_form_types ORDER BY sort_order, name'),
      pool.query('SELECT * FROM srf_size_groups ORDER BY sort_order, name'),
      pool.query('SELECT id, company_name FROM suppliers ORDER BY company_name ASC'),
    ]);
    res.json({ formTypes: ftRes.rows, sizeGroups: sgRes.rows, suppliers: supRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/srf/po-search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, po_number, supplier_name, status, order_date
       FROM production_orders
       WHERE po_number ILIKE $1
       ORDER BY order_date DESC LIMIT 10`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/srf/style-search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json([]);
    const cache = productsCache.length ? productsCache : await fetchAllProducts();
    const results = [];
    const seen = new Set();
    for (const p of cache) {
      if (seen.has(p.id)) continue;
      const titleMatch = p.title.toLowerCase().includes(q);
      const skuMatch   = (p.variants || []).find(v => v.sku && v.sku.toLowerCase().includes(q));
      if (titleMatch || skuMatch) {
        seen.add(p.id);
        results.push({
          id:    p.id,
          title: p.title,
          image: (p.images || [])[0]?.src || null,
          sku:   skuMatch ? skuMatch.sku : null,
        });
        if (results.length >= 12) break;
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock-receipts', requireAuth, async (req, res) => {
  try {
    const { status, form_type_id, q } = req.query;
    const limit  = Math.min(Number(req.query.limit)  || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const showArchived = req.query.archived === '1';
    const conditions   = [];
    const filterParams = [];

    if (status) {
      filterParams.push(status);
      conditions.push(`status = $${filterParams.length}`);
    }
    if (form_type_id) {
      filterParams.push(Number(form_type_id));
      conditions.push(`form_type_id = $${filterParams.length}`);
    }
    if (q) {
      const like = `%${q}%`;
      filterParams.push(like, like, like, like);
      const n = filterParams.length;
      conditions.push(`(style_name ILIKE $${n-3} OR supplier ILIKE $${n-2} OR po_number ILIKE $${n-1} OR invoice_number ILIKE $${n})`);
    }

    conditions.push('deleted_at IS NULL');
    conditions.push(showArchived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
    const where   = `WHERE ${conditions.join(' AND ')}`;
    const pLimit  = filterParams.length + 1;
    const pOffset = filterParams.length + 2;

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, form_type_name, size_group_name, receipt_type, style_name, supplier,
                invoice_number, po_number, receipt_date, processed_by, status,
                completed_at, archived_at, created_at, created_by, updated_at
         FROM stock_receipts ${where}
         ORDER BY created_at DESC LIMIT $${pLimit} OFFSET $${pOffset}`,
        [...filterParams, limit, offset]
      ),
      pool.query(`SELECT COUNT(*) FROM stock_receipts ${where}`, filterParams),
    ]);

    res.json({ receipts: dataRes.rows, total: Number(countRes.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-receipts', requireAuth, async (req, res) => {
  try {
    const { form_type_id, size_group_id, receipt_type = 'restock', processed_by } = req.body;
    const user = req.user?.email || 'unknown';

    const [ftRes, sgRes] = await Promise.all([
      form_type_id  ? pool.query('SELECT name FROM srf_form_types WHERE id=$1', [form_type_id])  : Promise.resolve({ rows: [] }),
      size_group_id ? pool.query('SELECT name, sizes FROM srf_size_groups WHERE id=$1', [size_group_id]) : Promise.resolve({ rows: [] }),
    ]);
    const form_type_name  = ftRes.rows[0]?.name  || null;
    const size_group_name = sgRes.rows[0]?.name  || null;
    const rawSizes        = sgRes.rows[0]?.sizes || [];
    const sizesArr        = Array.isArray(rawSizes) ? rawSizes : JSON.parse(rawSizes);

    const { rows } = await pool.query(
      `INSERT INTO stock_receipts (form_type_id, form_type_name, size_group_id, size_group_name,
         receipt_type, processed_by, receipt_date, status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,'draft',$7,$7) RETURNING id`,
      [form_type_id || null, form_type_name, size_group_id || null, size_group_name,
       receipt_type, processed_by || null, user]
    );
    const id = rows[0].id;

    for (let i = 0; i < sizesArr.length; i++) {
      await pool.query(
        `INSERT INTO stock_receipt_sizes (receipt_id, size_label, sort_order) VALUES ($1,$2,$3)`,
        [id, String(sizesArr[i]), i]
      );
    }
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, changed_by) VALUES ($1,'created',$2)`,
      [id, user]
    );

    res.json({ id });
  } catch (err) {
    console.error('[srf] create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-off backfill: mark POs received where a completed receipt already references them.
// Visit without params for a dry run; add ?apply=1 to write the changes.
// NOTE: must register before /api/stock-receipts/:id or ":id" swallows the path.
app.get('/api/stock-receipts/backfill-po-received', requireAuth, async (req, res) => {
  const apply = req.query.apply === '1';
  try {
    const matchSql = `
      SELECT po.id, po.po_number, po.supplier_name, po.status,
        (SELECT json_agg(json_build_object('receipt_id', sr.id, 'style', sr.style_name, 'completed_at', sr.completed_at))
         FROM stock_receipts sr
         WHERE sr.status='complete' AND sr.deleted_at IS NULL
           AND (sr.po_id = po.id OR (sr.po_number IS NOT NULL AND TRIM(sr.po_number) <> ''
                AND UPPER(TRIM(sr.po_number)) = UPPER(TRIM(po.po_number))))
        ) AS matching_receipts
      FROM production_orders po
      WHERE po.status NOT IN ('received','cancelled')
        AND EXISTS (
          SELECT 1 FROM stock_receipts sr
          WHERE sr.status='complete' AND sr.deleted_at IS NULL
            AND (sr.po_id = po.id OR (sr.po_number IS NOT NULL AND TRIM(sr.po_number) <> ''
                 AND UPPER(TRIM(sr.po_number)) = UPPER(TRIM(po.po_number))))
        )
      ORDER BY po.po_number`;
    const { rows: matches } = await pool.query(matchSql);

    if (!apply) {
      return res.json({
        mode: 'dry_run',
        would_mark_received: matches.length,
        pos: matches,
        hint: matches.length ? 'Re-run with ?apply=1 to mark these POs as received' : 'Nothing to change',
      });
    }

    const ids = matches.map(m => m.id);
    if (ids.length) {
      await pool.query(
        `UPDATE production_orders SET status='received', updated_at=NOW() WHERE id = ANY($1::int[])`,
        [ids]
      );
    }
    console.log(`[srf] Backfill: ${ids.length} POs marked received by ${req.user?.email}`);
    res.json({ mode: 'applied', marked_received: ids.length, pos: matches });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stock-receipts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [receiptRes, sizesRes, photosRes, auditRes] = await Promise.all([
      pool.query('SELECT * FROM stock_receipts WHERE id=$1', [id]),
      pool.query('SELECT * FROM stock_receipt_sizes WHERE receipt_id=$1 ORDER BY sort_order', [id]),
      pool.query(
        `SELECT id, receipt_id, filename, uploaded_at, uploaded_by,
                LEFT(data, 100) AS data_preview, LENGTH(data) AS data_length
         FROM stock_receipt_photos WHERE receipt_id=$1 ORDER BY id`, [id]
      ),
      pool.query('SELECT * FROM stock_receipt_audit WHERE receipt_id=$1 ORDER BY changed_at DESC LIMIT 100', [id]),
    ]);
    if (!receiptRes.rows.length || receiptRes.rows[0].deleted_at) return res.status(404).json({ error: 'Not found' });
    res.json({
      receipt: receiptRes.rows[0],
      sizes:   sizesRes.rows,
      photos:  photosRes.rows,
      audit:   auditRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock-receipts/:id/photos/:pid/data', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT data, filename FROM stock_receipt_photos WHERE id=$1 AND receipt_id=$2',
      [req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ data: rows[0].data, filename: rows[0].filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/stock-receipts/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = req.user?.email || 'unknown';

    const existingRes = await pool.query('SELECT * FROM stock_receipts WHERE id=$1', [id]);
    if (!existingRes.rows.length) return res.status(404).json({ error: 'Not found' });
    if (existingRes.rows[0].status === 'complete') return res.status(400).json({ error: 'Completed forms cannot be edited' });

    const prev = existingRes.rows[0];
    const body = req.body;

    const UPDATABLE = [
      'receipt_type','style_name','supplier','invoice_number','po_number','po_id',
      'product_code','shopify_product_id','shopify_product_title','receipt_date',
      'processed_by','stock_matches_invoice','on_rack_for_photoshoot',
      'cost_price','discount_percent','freight_price','final_price',
      'fabric','stretch_allowance','product_features','notes',
    ];

    const setClauses   = [];
    const setParams    = [];
    const auditEntries = [];

    for (const field of UPDATABLE) {
      if (!(field in body)) continue;
      const newVal = body[field];
      const oldVal = prev[field];
      const toStr  = v => v == null ? null : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      const newStr = toStr(newVal);
      const oldStr = toStr(oldVal);
      if (newStr !== oldStr) {
        const dbVal = (field === 'product_features') ? JSON.stringify(newVal) : newVal;
        setClauses.push(`${field} = $${setParams.push(dbVal)}`);
        auditEntries.push({ field_name: field, old_value: oldStr, new_value: newStr });
      }
    }

    // Transition draft → in_progress on first save
    if (prev.status === 'draft') {
      setClauses.push(`status = 'in_progress'`);
    }

    setClauses.push(`updated_at = NOW()`);
    setClauses.push(`updated_by = $${setParams.push(user)}`);
    setParams.push(id);

    await pool.query(
      `UPDATE stock_receipts SET ${setClauses.join(', ')} WHERE id=$${setParams.length}`,
      setParams
    );

    // Replace size rows
    if (Array.isArray(body.sizes)) {
      await pool.query('DELETE FROM stock_receipt_sizes WHERE receipt_id=$1', [id]);
      for (let i = 0; i < body.sizes.length; i++) {
        const s = body.sizes[i];
        await pool.query(
          `INSERT INTO stock_receipt_sizes (receipt_id, size_label, sort_order, qty, measurements, weight_grams)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, s.size_label, i, s.qty ?? null, JSON.stringify(s.measurements || {}), s.weight_grams ?? null]
        );
      }
      auditEntries.push({ field_name: 'sizes', old_value: null, new_value: `${body.sizes.length} rows` });
    }

    for (const entry of auditEntries) {
      await pool.query(
        `INSERT INTO stock_receipt_audit (receipt_id, action, field_name, old_value, new_value, changed_by)
         VALUES ($1,'updated',$2,$3,$4,$5)`,
        [id, entry.field_name, entry.old_value, entry.new_value, user]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[srf] update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-receipts/:id/complete', requireAuth, async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const user = req.user?.email || 'unknown';

    const existingRes = await pool.query('SELECT * FROM stock_receipts WHERE id=$1', [id]);
    if (!existingRes.rows.length) return res.status(404).json({ error: 'Not found' });
    if (existingRes.rows[0].status === 'complete') return res.status(400).json({ error: 'Already complete' });

    await pool.query(
      `UPDATE stock_receipts SET status='complete', completed_at=NOW(), completed_by=$1,
         updated_at=NOW(), updated_by=$1 WHERE id=$2`,
      [user, id]
    );
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, changed_by) VALUES ($1,'completed',$2)`,
      [id, user]
    );

    // Cross-reference production orders — mark matching PO(s) as received
    let receivedPOs = [];
    try {
      const r = existingRes.rows[0];
      let poResult = { rows: [] };
      if (r.po_id) {
        poResult = await pool.query(
          `UPDATE production_orders SET status='received', updated_at=NOW()
           WHERE id=$1 AND status NOT IN ('received','cancelled')
           RETURNING id, po_number`,
          [r.po_id]
        );
      } else if (r.po_number) {
        poResult = await pool.query(
          `UPDATE production_orders SET status='received', updated_at=NOW()
           WHERE UPPER(TRIM(po_number))=UPPER(TRIM($1)) AND status NOT IN ('received','cancelled')
           RETURNING id, po_number`,
          [r.po_number]
        );
      }
      receivedPOs = poResult.rows;
      for (const po of receivedPOs) {
        await pool.query(
          `INSERT INTO stock_receipt_audit (receipt_id, action, field_name, new_value, changed_by)
           VALUES ($1,'updated','production_order',$2,$3)`,
          [id, `PO ${po.po_number || po.id} marked received`, user]
        );
        console.log(`[srf] Receipt #${id} complete → PO ${po.po_number || po.id} marked received`);
      }
      // Refresh the restock analysis so the PO drops out of incoming and
      // live Shopify stock is re-read — fire and forget
      if (receivedPOs.length) {
        restockSync.runAnalysis().catch(err =>
          console.error('[srf] Post-receipt restock refresh failed:', err.message));
      }
    } catch (poErr) {
      console.error('[srf] PO cross-reference failed:', poErr.message);
    }

    // Slack notification — fire and forget, no crash if env var missing
    const slackWebhook = process.env.SLACK_SRF_WEBHOOK_URL;
    if (slackWebhook) {
      const r = existingRes.rows[0];
      fetch(slackWebhook, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `✅ Stock Receipt #${id} completed`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *Stock Receipt #${id} — Complete*\n*${r.form_type_name || 'Receipt'}* | *${r.style_name || 'No style name'}*\nCompleted by: ${user}`,
              },
            },
            {
              type: 'section',
              fields: [
                { type: 'mrkdwn', text: `*Supplier:*\n${r.supplier || '—'}` },
                { type: 'mrkdwn', text: `*Invoice:*\n${r.invoice_number || '—'}` },
                { type: 'mrkdwn', text: `*PO Number:*\n${r.po_number || '—'}` },
                { type: 'mrkdwn', text: `*Date:*\n${r.receipt_date ? String(r.receipt_date).slice(0,10) : '—'}` },
              ],
            },
            ...(receivedPOs.length ? [{
              type: 'section',
              text: { type: 'mrkdwn', text: `📦 *PO ${receivedPOs.map(po => po.po_number || po.id).join(', ')} marked as Received*` },
            }] : []),
            {
              type: 'actions',
              elements: [{
                type: 'button',
                text: { type: 'plain_text', text: '→ Open Receipt in WMS' },
                url: `${process.env.APP_URL}/stock-receipt.html?id=${id}`,
                style: 'primary',
              }],
            },
          ],
        }),
      }).catch(err => console.error('[srf] Slack notification failed:', err.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[srf] complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-receipts/:id/photos', requireAuth, async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const user = req.user?.email || 'unknown';
    const { filename, data } = req.body;
    if (!data) return res.status(400).json({ error: 'No photo data' });

    const existingRes = await pool.query('SELECT status FROM stock_receipts WHERE id=$1', [id]);
    if (!existingRes.rows.length) return res.status(404).json({ error: 'Not found' });
    if (existingRes.rows[0].status === 'complete') return res.status(400).json({ error: 'Completed forms cannot be edited' });

    const countRes = await pool.query('SELECT COUNT(*) FROM stock_receipt_photos WHERE receipt_id=$1', [id]);
    if (Number(countRes.rows[0].count) >= 3) return res.status(400).json({ error: 'Maximum 3 photos per receipt' });

    const { rows } = await pool.query(
      `INSERT INTO stock_receipt_photos (receipt_id, filename, data, uploaded_by)
       VALUES ($1,$2,$3,$4) RETURNING id, filename, uploaded_at`,
      [id, filename || null, data, user]
    );
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, field_name, new_value, changed_by)
       VALUES ($1,'photo_added','photo',$2,$3)`,
      [id, filename || 'photo', user]
    );
    res.json({ photo: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stock-receipts/:id/photos/:pid', requireAuth, async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const pid  = Number(req.params.pid);
    const user = req.user?.email || 'unknown';

    const existingRes = await pool.query('SELECT status FROM stock_receipts WHERE id=$1', [id]);
    if (!existingRes.rows.length) return res.status(404).json({ error: 'Not found' });
    if (existingRes.rows[0].status === 'complete') return res.status(400).json({ error: 'Completed forms cannot be edited' });

    await pool.query('DELETE FROM stock_receipt_photos WHERE id=$1 AND receipt_id=$2', [pid, id]);
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, field_name, changed_by)
       VALUES ($1,'photo_removed','photo',$2)`,
      [id, user]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stock-receipts/:id', requireAuth, async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const user = req.user?.email || 'unknown';

    const { rows } = await pool.query('SELECT status, deleted_at FROM stock_receipts WHERE id=$1', [id]);
    if (!rows.length || rows[0].deleted_at) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status === 'complete') return res.status(400).json({ error: 'Completed forms cannot be deleted' });

    await pool.query(
      'UPDATE stock_receipts SET deleted_at=NOW(), deleted_by=$1, updated_at=NOW(), updated_by=$1 WHERE id=$2',
      [user, id]
    );
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, changed_by) VALUES ($1,'deleted',$2)`,
      [id, user]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-receipts/:id/archive', requireAuth, async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const user = req.user?.email || 'unknown';
    const { rows } = await pool.query('SELECT deleted_at, archived_at FROM stock_receipts WHERE id=$1', [id]);
    if (!rows.length || rows[0].deleted_at) return res.status(404).json({ error: 'Not found' });
    if (rows[0].archived_at) return res.status(400).json({ error: 'Already archived' });
    await pool.query(
      'UPDATE stock_receipts SET archived_at=NOW(), archived_by=$1, updated_at=NOW(), updated_by=$1 WHERE id=$2',
      [user, id]
    );
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, changed_by) VALUES ($1,'archived',$2)`,
      [id, user]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stock-receipts/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const id   = Number(req.params.id);
    const user = req.user?.email || 'unknown';
    const { rows } = await pool.query('SELECT deleted_at, archived_at FROM stock_receipts WHERE id=$1', [id]);
    if (!rows.length || rows[0].deleted_at) return res.status(404).json({ error: 'Not found' });
    if (!rows[0].archived_at) return res.status(400).json({ error: 'Not archived' });
    await pool.query(
      'UPDATE stock_receipts SET archived_at=NULL, archived_by=NULL, updated_at=NOW(), updated_by=$1 WHERE id=$2',
      [user, id]
    );
    await pool.query(
      `INSERT INTO stock_receipt_audit (receipt_id, action, changed_by) VALUES ($1,'unarchived',$2)`,
      [id, user]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock-receipts/:id/shelf-count', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const overrideProductId = req.query.product_id ? Number(req.query.product_id) : null;

    let shopifyId = overrideProductId;
    if (!shopifyId) {
      const { rows } = await pool.query(
        'SELECT shopify_product_id FROM stock_receipts WHERE id=$1 AND deleted_at IS NULL', [id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      shopifyId = rows[0].shopify_product_id;
    }
    if (!shopifyId) return res.json({ variants: [], totals: null, note: 'No Shopify product linked' });

    // 1. Fetch product variants from Shopify
    const prodRes = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products/${shopifyId}.json?fields=id,title,variants`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    if (!prodRes.ok) return res.status(502).json({ error: `Shopify API error ${prodRes.status}` });
    const { product } = await prodRes.json();

    const variantIds = new Set((product.variants || []).map(v => v.id));

    // 2. Paginate unfulfilled open orders, collecting committed qty per variant
    const committedMap = {}; // variantId → committed qty
    const orderQtyMap  = {}; // orderNumber → { variantId → qty }
    let ordersUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=open&fulfillment_status=unfulfilled,partial&limit=250&fields=id,order_number,line_items`;

    while (ordersUrl) {
      const r = await fetch(ordersUrl, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
      if (!r.ok) break;
      const { orders } = await r.json();
      for (const order of (orders || [])) {
        for (const item of (order.line_items || [])) {
          if (!variantIds.has(item.variant_id)) continue;
          const qty = item.fulfillable_quantity ?? item.quantity;
          if (qty <= 0) continue;
          committedMap[item.variant_id] = (committedMap[item.variant_id] || 0) + qty;
          if (!orderQtyMap[order.order_number]) orderQtyMap[order.order_number] = {};
          orderQtyMap[order.order_number][item.variant_id] =
            (orderQtyMap[order.order_number][item.variant_id] || 0) + qty;
        }
      }
      const link = r.headers.get('link');
      ordersUrl = null;
      if (link) {
        const m = link.match(/<([^>]+)>;\s*rel="next"/);
        if (m) ordersUrl = m[1];
      }
    }

    // 3. Query picking_item_states for WMS-picked items in those unfulfilled orders
    const wmsPickedMap = {}; // variantId → wms-picked qty
    const unfulfilledOrderNumbers = Object.keys(orderQtyMap).map(Number);
    if (unfulfilledOrderNumbers.length && variantIds.size) {
      const { rows: pickedRows } = await pool.query(
        `SELECT DISTINCT order_number, variant_id FROM picking_item_states
         WHERE picked = true
           AND order_number = ANY($1::int[])
           AND variant_id   = ANY($2::bigint[])`,
        [unfulfilledOrderNumbers, [...variantIds]]
      );
      for (const row of pickedRows) {
        const varId  = Number(row.variant_id);
        const orderN = Number(row.order_number);
        const qty    = (orderQtyMap[orderN] || {})[varId] || 0;
        wmsPickedMap[varId] = (wmsPickedMap[varId] || 0) + qty;
      }
    }

    // 4. Build per-variant breakdown
    const variants = (product.variants || []).map(v => {
      const available  = v.inventory_quantity || 0;
      const committed  = committedMap[v.id]  || 0;
      const wms_picked = wmsPickedMap[v.id]  || 0;
      const on_hand    = available + committed;
      const true_shelf = on_hand - wms_picked;
      return { id: v.id, title: v.title, sku: v.sku, available, committed, wms_picked, on_hand, true_shelf };
    });

    const totals = {
      available:  variants.reduce((s, v) => s + v.available,  0),
      committed:  variants.reduce((s, v) => s + v.committed,  0),
      wms_picked: variants.reduce((s, v) => s + v.wms_picked, 0),
      on_hand:    variants.reduce((s, v) => s + v.on_hand,    0),
      true_shelf: variants.reduce((s, v) => s + v.true_shelf, 0),
    };

    res.json({ variants, totals, product_title: product.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stock-receipts/:id/pdf', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [receiptRes, sizesRes, photosRes] = await Promise.all([
      pool.query('SELECT * FROM stock_receipts WHERE id=$1', [id]),
      pool.query('SELECT * FROM stock_receipt_sizes WHERE receipt_id=$1 ORDER BY sort_order', [id]),
      pool.query('SELECT id, filename, data FROM stock_receipt_photos WHERE receipt_id=$1 ORDER BY id', [id]),
    ]);
    if (!receiptRes.rows.length) return res.status(404).send('Not found');

    const r      = receiptRes.rows[0];
    const sizes  = sizesRes.rows;
    const photos = photosRes.rows;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="stock-receipt-${id}.pdf"`);

    const doc = new PDFDocument({ margin: 45, size: 'A4' });
    doc.pipe(res);

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const ML     = 45;
    const MR     = PAGE_W - ML;
    const W      = MR - ML;

    const C = {
      navy:    '#1e293b',
      dark:    '#334155',
      mid:     '#64748b',
      light:   '#94a3b8',
      border:  '#e2e8f0',
      borderD: '#cbd5e1',
      bgMid:   '#f1f5f9',
      green:   '#15803d',
      amber:   '#d97706',
    };

    function addPageIfNeeded(yPos, needed) {
      if (yPos + needed > PAGE_H - 80) { doc.addPage(); return ML; }
      return yPos;
    }

    function hLine(yPos, color, weight) {
      doc.moveTo(ML, yPos).lineTo(MR, yPos)
         .strokeColor(color || C.border).lineWidth(weight || 0.5).stroke();
    }

    function sectionBand(title, yPos) {
      doc.rect(ML, yPos, W, 22).fillColor(C.bgMid).fill();
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.mid)
         .text(title, ML + 8, yPos + 7, { width: W - 16, lineBreak: false });
      return yPos + 28;
    }

    function field(label, value, x, w, yPos) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.mid)
         .text(label, x, yPos, { width: w, lineBreak: false });
      doc.fontSize(11).font('Helvetica').fillColor(C.navy)
         .text(String(value || '—'), x, yPos + 11, { width: w, lineBreak: false });
    }

    // ── Header ──────────────────────────────────────────────────────
    let y = ML;

    doc.fontSize(8).font('Helvetica').fillColor(C.light)
       .text('THE SELF STYLER  ·  WAREHOUSE MANAGEMENT SYSTEM', ML, y, { width: W, lineBreak: false });
    y += 14;

    doc.fontSize(20).font('Helvetica-Bold').fillColor(C.navy)
       .text('STOCK RECEIPT FORM', ML, y, { lineBreak: false });

    const statusText  = r.status === 'complete'    ? 'COMPLETE'    :
                        r.status === 'in_progress' ? 'IN PROGRESS' :
                        r.status.toUpperCase().replace('_', ' ');
    const statusColor = r.status === 'complete' ? C.green : r.status === 'in_progress' ? C.amber : C.mid;
    const BW = 90, BH = 20;
    doc.rect(MR - BW, y + 2, BW, BH).strokeColor(statusColor).lineWidth(1).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(statusColor)
       .text(statusText, MR - BW, y + 7, { width: BW, align: 'center', lineBreak: false });
    y += 28;

    const headerParts = [`#${id}`, r.form_type_name, r.size_group_name,
                         r.receipt_type === 'new' ? 'New Product' : 'Restock'].filter(Boolean);
    doc.fontSize(10).font('Helvetica').fillColor(C.mid)
       .text(headerParts.join('  ·  '), ML, y, { width: W - BW - 10, lineBreak: false });
    y += 14;

    doc.moveTo(ML, y).lineTo(MR, y).strokeColor(C.navy).lineWidth(2).stroke();
    y += 14;

    // ── Receipt Details ─────────────────────────────────────────────
    y = sectionBand('RECEIPT DETAILS', y);

    const c3 = W / 3;
    field('RECEIPT DATE', r.receipt_date ? String(r.receipt_date).slice(0,10) : '—', ML,        c3 - 8, y);
    field('PROCESSED BY', r.processed_by,                                             ML + c3,   c3 - 8, y);
    field('TYPE',         r.receipt_type === 'new' ? 'New Product' : 'Restock',       ML + c3*2, c3 - 8, y);
    y += 34;

    const c4 = W / 4;
    field('STYLE NAME',   r.style_name,     ML,        c4 - 6, y);
    field('SUPPLIER',     r.supplier,       ML + c4,   c4 - 6, y);
    field('INVOICE #',    r.invoice_number, ML + c4*2, c4 - 6, y);
    field('PO NUMBER',    r.po_number,      ML + c4*3, c4 - 6, y);
    y += 34;

    field('PRODUCT CODE', r.product_code, ML, c4 - 6, y);
    y += 34 + 6;
    hLine(y);
    y += 10;

    // ── Pricing & Product Info ──────────────────────────────────────
    y = sectionBand('PRICING & PRODUCT INFO', y);

    field('COST PRICE',  r.cost_price       != null ? `$${Number(r.cost_price).toFixed(2)}`      : '—', ML,        c4 - 6, y);
    field('DISCOUNT',    r.discount_percent != null ? `${r.discount_percent}%`                   : '—', ML + c4,   c4 - 6, y);
    field('FREIGHT',     r.freight_price    != null ? `$${Number(r.freight_price).toFixed(2)}`   : '—', ML + c4*2, c4 - 6, y);
    field('FINAL COST PRICE', r.final_price != null ? `$${Number(r.final_price).toFixed(2)}`     : '—', ML + c4*3, c4 - 6, y);
    y += 34;

    const c2 = W / 2 - 6;
    field('FABRIC',             r.fabric,            ML,           c2, y);
    field('STRETCH ALLOWANCE',  r.stretch_allowance, ML + c2 + 12, c2, y);
    y += 34;

    field('STOCK MATCHES INVOICE',  r.stock_matches_invoice  == null ? '—' : (r.stock_matches_invoice  ? 'Yes ✓' : 'No ✗'), ML,           c2, y);
    field('ON RACK FOR PHOTOSHOOT', r.on_rack_for_photoshoot == null ? '—' : (r.on_rack_for_photoshoot ? 'Yes ✓' : 'No ✗'), ML + c2 + 12, c2, y);
    y += 34 + 6;
    hLine(y);
    y += 10;

    // ── Product Features ────────────────────────────────────────────
    const features = Array.isArray(r.product_features) ? r.product_features
      : (r.product_features ? JSON.parse(r.product_features) : []);
    const filled = features.filter(Boolean);
    if (filled.length) {
      y = addPageIfNeeded(y, 28 + filled.length * 17 + 16);
      y = sectionBand('PRODUCT FEATURES', y);
      filled.forEach(f => {
        doc.fontSize(10).font('Helvetica').fillColor(C.navy)
           .text(`•  ${f}`, ML + 4, y, { width: W - 8, lineBreak: false });
        y += 17;
      });
      y += 6;
      hLine(y);
      y += 10;
    }

    // ── Size Grid ───────────────────────────────────────────────────
    if (sizes.length) {
      const sampleM = (() => {
        for (const sz of sizes) {
          const m = typeof sz.measurements === 'string' ? JSON.parse(sz.measurements) : (sz.measurements || {});
          if (Object.keys(m).length > 0) return m;
        }
        return {};
      })();
      const mFields  = Object.keys(sampleM);
      const allCols  = ['SIZE', 'QTY', 'WEIGHT (G)', ...mFields.map(f => f.toUpperCase())];
      const HDRH     = 24;
      const ROW_H    = 26;
      const TOTH     = 26;
      const gridH    = HDRH + sizes.length * ROW_H + TOTH;

      y = addPageIfNeeded(y, 28 + gridH);
      y = sectionBand('SIZE QUANTITIES', y);

      const SIZE_W = Math.min(150, W * 0.30);
      const REST_W = (W - SIZE_W) / (2 + mFields.length); // qty + weight + measurements
      const colWidths = [SIZE_W, REST_W, REST_W, ...mFields.map(() => REST_W)];
      const colX = [];
      let cx = ML;
      colWidths.forEach(cw => { colX.push(cx); cx += cw; });

      const gridTop = y;

      // Header row
      doc.rect(ML, y, W, HDRH).fillColor(C.bgMid).fill();
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C.mid);
      allCols.forEach((col, ci) => {
        doc.text(col, colX[ci] + 8, y + 8, { width: colWidths[ci] - 10, lineBreak: false });
      });
      hLine(y + HDRH, C.borderD, 1);
      y += HDRH;

      // Data rows
      let totalQty = 0;
      sizes.forEach((s, idx) => {
        const m    = typeof s.measurements === 'string' ? JSON.parse(s.measurements) : (s.measurements || {});
        const vals = [s.size_label, s.qty != null ? String(s.qty) : '—',
                      s.weight_grams != null ? String(parseFloat(s.weight_grams)) : '—',
                      ...mFields.map(f => m[f] != null ? String(m[f]) : '—')];
        if (idx > 0) hLine(y, C.border, 0.5);
        vals.forEach((v, ci) => {
          doc.fontSize(12).font(ci === 0 ? 'Helvetica-Bold' : 'Helvetica').fillColor(C.navy)
             .text(v, colX[ci] + 8, y + 7, { width: colWidths[ci] - 10, lineBreak: false });
        });
        totalQty += s.qty || 0;
        y += ROW_H;
      });

      // Total row
      doc.rect(ML, y, W, TOTH).fillColor(C.bgMid).fill();
      hLine(y, C.dark, 1.5);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(C.navy)
         .text('TOTAL', colX[0] + 8, y + 8, { width: colWidths[0] - 10, lineBreak: false });
      doc.fontSize(14).font('Helvetica-Bold').fillColor(C.navy)
         .text(String(totalQty), colX[1] + 8, y + 6, { width: colWidths[1] - 10, lineBreak: false });
      y += TOTH;

      // Vertical column separators + outer box (drawn last, on top)
      for (let ci = 1; ci < allCols.length; ci++) {
        doc.moveTo(colX[ci], gridTop).lineTo(colX[ci], gridTop + gridH)
           .strokeColor(C.border).lineWidth(0.5).stroke();
      }
      doc.rect(ML, gridTop, W, gridH).strokeColor(C.borderD).lineWidth(0.75).stroke();

      y += 8;
      hLine(y);
      y += 10;
    }

    // ── Notes ───────────────────────────────────────────────────────
    if (r.notes) {
      doc.fontSize(10).font('Helvetica');
      const noteH = doc.heightOfString(r.notes, { width: W - 8 }) + 4;
      y = addPageIfNeeded(y, 28 + noteH + 16);
      y = sectionBand('NOTES', y);
      doc.fontSize(10).font('Helvetica').fillColor(C.navy)
         .text(r.notes, ML + 4, y, { width: W - 8 });
      y += noteH + 8;
      hLine(y);
      y += 10;
    }

    // ── Photos ──────────────────────────────────────────────────────
    if (photos.length) {
      y = addPageIfNeeded(y, 28 + 140);
      y = sectionBand(`PHOTOS (${photos.length})`, y);
      const photoW = Math.min(150, (W - (photos.length - 1) * 10) / photos.length);
      photos.forEach((photo, pi) => {
        try {
          let imgData = photo.data;
          if (imgData.includes(',')) imgData = imgData.split(',')[1];
          const buf = Buffer.from(imgData, 'base64');
          doc.image(buf, ML + pi * (photoW + 10), y, { fit: [photoW, 120] });
        } catch (_) { /* skip invalid image */ }
      });
      y += 130;
    }

    // ── Footer ──────────────────────────────────────────────────────
    doc.fontSize(7).font('Helvetica').fillColor(C.light)
       .text(
         `Generated ${new Date().toLocaleString('en-AU')}  ·  The Self Styler WMS  ·  Receipt #${id}`,
         ML, PAGE_H - 55, { align: 'center', width: W }
       );

    doc.end();
  } catch (err) {
    console.error('[srf] PDF error:', err.message);
    if (!res.headersSent) res.status(500).send('PDF error: ' + err.message);
  }
});

// ── Incorrect Orders (Customer Service) ─────────────────────────────

app.get('/api/incorrect-orders', requireAuth, async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = 'WHERE deleted_at IS NULL';
  if (status && status !== 'all') { where += ' AND status = $1'; params.push(status); }
  try {
    const { rows } = await pool.query(
      `SELECT * FROM incorrect_orders ${where} ORDER BY reported_date DESC, id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/incorrect-orders/shopify-order', requireAuth, async (req, res) => {
  const num = (req.query.num || '').replace(/^#/, '').trim();
  if (!num) return res.status(400).json({ error: 'Order number required' });
  try {
    const r = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?name=%23${encodeURIComponent(num)}&status=any&fields=id,name,note,note_attributes,created_at,customer,line_items`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
    );
    const data = await r.json();
    if (!data.orders || !data.orders.length) return res.json(null);
    const o = data.orders[0];
    res.json({
      id: o.id,
      name: o.name,
      note: o.note || null,
      customer_name: o.customer
        ? `${o.customer.first_name || ''} ${o.customer.last_name || ''}`.trim()
        : null,
      line_items: (o.line_items || []).map(li => ({
        title: li.title,
        variant_title: li.variant_title,
        product_id: li.product_id,
        sku: li.sku,
        quantity: li.quantity,
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/incorrect-orders', requireAuth, async (req, res) => {
  const { order_number, shopify_order_id, shopify_order_note, customer_name,
          reported_date, correct_item, correct_product_id, received_item,
          received_product_id, pick_pack_notes, notes } = req.body;
  if (!order_number) return res.status(400).json({ error: 'Order number required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO incorrect_orders
        (order_number, shopify_order_id, shopify_order_note, customer_name,
         reported_date, correct_item, correct_product_id, received_item,
         received_product_id, pick_pack_notes, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
      [order_number, shopify_order_id || null, shopify_order_note || null,
       customer_name || null, reported_date || new Date().toISOString().split('T')[0],
       correct_item || null, correct_product_id || null,
       received_item || null, received_product_id || null,
       pick_pack_notes || null, notes || null, req.user.email]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/incorrect-orders/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT io.*,
        COALESCE(json_agg(n ORDER BY n.added_at DESC) FILTER (WHERE n.id IS NOT NULL), '[]') AS timeline
       FROM incorrect_orders io
       LEFT JOIN incorrect_order_notes n ON n.order_id = io.id
       WHERE io.id = $1 AND io.deleted_at IS NULL
       GROUP BY io.id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/incorrect-orders/:id', requireAuth, async (req, res) => {
  const { order_number, shopify_order_id, shopify_order_note, customer_name,
          reported_date, correct_item, correct_product_id, correct_stock_counted,
          received_item, received_product_id, received_stock_counted,
          pick_pack_notes, notes, status, resolution, replacement_order } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE incorrect_orders SET
        order_number=$1, shopify_order_id=$2, shopify_order_note=$3, customer_name=$4,
        reported_date=$5, correct_item=$6, correct_product_id=$7,
        correct_stock_counted=$8, received_item=$9, received_product_id=$10,
        received_stock_counted=$11, pick_pack_notes=$12, notes=$13,
        status=$14, resolution=$15, replacement_order=$16,
        updated_at=NOW(), updated_by=$17
       WHERE id=$18 AND deleted_at IS NULL RETURNING *`,
      [order_number, shopify_order_id || null, shopify_order_note || null,
       customer_name || null, reported_date,
       correct_item || null, correct_product_id || null, !!correct_stock_counted,
       received_item || null, received_product_id || null, !!received_stock_counted,
       pick_pack_notes || null, notes || null,
       status || 'open', resolution || null, replacement_order || null,
       req.user.email, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/incorrect-orders/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE incorrect_orders SET deleted_at=NOW(), deleted_by=$1 WHERE id=$2',
      [req.user.email, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/incorrect-orders/:id/notes', requireAuth, async (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'Note required' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO incorrect_order_notes (order_id, note, added_by) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, note, req.user.email]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/incorrect-orders/:id/notify', requireAuth, async (req, res) => {
  const webhook = process.env.SLACK_CS_WEBHOOK_URL;
  if (!webhook) return res.status(503).json({ error: 'SLACK_CS_WEBHOOK_URL not configured' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM incorrect_orders WHERE id=$1 AND deleted_at IS NULL', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    const body = {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🚨 Incorrect Order — Urgent Stock Check' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Order:*\n${r.order_number}` },
            { type: 'mrkdwn', text: `*Customer:*\n${r.customer_name || '—'}` },
            { type: 'mrkdwn', text: `*Should have sent:*\n${r.correct_item || '—'}` },
            { type: 'mrkdwn', text: `*Incorrectly sent:*\n${r.received_item || '—'}` },
          ],
        },
        ...(r.pick_pack_notes ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Pick/Pack Note:* ${r.pick_pack_notes}` } }] : []),
        { type: 'section', text: { type: 'mrkdwn', text: `_Please check physical stock for both items and update the WMS._` } },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '→ Open Case in WMS' },
            url: `${process.env.APP_URL}/incorrect-order.html?id=${r.id}`,
            style: 'primary',
          }],
        },
      ],
    };
    const sr = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!sr.ok) throw new Error(`Slack responded ${sr.status}`);
    await pool.query('UPDATE incorrect_orders SET slack_notified_at=NOW() WHERE id=$1', [r.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Style Forecast (Reports) ────────────────────────────────────────
// Event-demand forecasting for one style: reference-period history (own or
// comparison style), demand amplification, current momentum, per-size order
// scenarios, and an AI read on the numbers.

const styleForecastCache = {}; // key → { at, data }

async function sfFetchOrderLines(startIso, endIso, productIds, onProgress) {
  // Returns line-item rows for the given products within the window
  const wanted = new Set(productIds.map(String));
  const rows = [];
  let scanned = 0;
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${startIso}&created_at_max=${endIso}` +
    `&limit=250&fields=id,created_at,cancelled_at,line_items`;
  while (url) {
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
    if (r.status === 429) {
      await new Promise(w => setTimeout(w, parseFloat(r.headers.get('retry-after') || '2') * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Shopify orders API ${r.status}`);
    const data = await r.json();
    scanned += (data.orders || []).length;
    if (onProgress) onProgress(scanned);
    for (const o of (data.orders || [])) {
      if (o.cancelled_at) continue;
      for (const li of (o.line_items || [])) {
        if (!wanted.has(String(li.product_id || ''))) continue;
        rows.push({
          product_id: String(li.product_id),
          size: li.variant_title || '—',
          qty: li.quantity || 0,
          price: parseFloat(li.price || 0),
          created_at: o.created_at,
        });
      }
    }
    const link = r.headers.get('link');
    const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return rows;
}

async function computeStyleForecast(q, job) {
  const DAY = 86400000;
  const PRE_DAYS = 42;
    const productId  = String(q.product_id || '');
    const compareId  = String(q.compare_product_id || '');
    const start      = new Date(q.start);
    const end        = new Date(q.end);
    const growthPct  = parseFloat(q.growth || 0);
    const eventStart = q.event_start ? new Date(q.event_start) : null;
    if (!productId || isNaN(start) || isNaN(end) || end <= start) {
      throw new Error('product_id, start and end (start < end) required');
    }
    end.setHours(23, 59, 59, 999);
    const periodDays = Math.max(1, Math.round((end - start) / DAY));
    const eventDays  = parseInt(q.event_days) || periodDays;

    const cacheKey = [productId, compareId, start.toISOString(), end.toISOString()].join('|');
    let base = styleForecastCache[cacheKey] && (Date.now() - styleForecastCache[cacheKey].at < 30 * 60 * 1000)
      ? styleForecastCache[cacheKey].data : null;

    // Persistent cache — survives deploys. Historical sales never change; the
    // current-velocity/stock portion is acceptable up to 24h old for planning.
    if (!base) {
      const { rows: dbCache } = await pool.query(
        `SELECT data, computed_at FROM style_forecast_cache
         WHERE cache_key = $1 AND computed_at > NOW() - INTERVAL '24 hours'`,
        [cacheKey]
      );
      if (dbCache.length) {
        base = dbCache[0].data;
        base.computed_at = dbCache[0].computed_at;
        styleForecastCache[cacheKey] = { at: Date.now(), data: base };
      }
    }

    if (!base) {
      if (job) job.progress = 'Loading product details…';
      // Product (and optional comparison product) with current stock per size
      const fetchProduct = async (id) => {
        const r = await fetch(
          `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products/${id}.json?fields=id,title,images,variants,published_at`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
        );
        if (!r.ok) throw new Error(`Product ${id}: Shopify ${r.status}`);
        return (await r.json()).product;
      };
      const target  = await fetchProduct(productId);
      const compare = compareId ? await fetchProduct(compareId) : null;
      const refProductId = compareId || productId;

      // Window scans: [start - 42d, end] for the reference product,
      // [now - 42d, now] for the target's current momentum
      const preStart = new Date(start.getTime() - PRE_DAYS * DAY);
      const now = new Date();
      const curStart = new Date(now.getTime() - PRE_DAYS * DAY);
      let refScanned = 0, curScanned = 0;
      const reportProgress = () => {
        if (job) job.progress = `Scanning order history… ${(refScanned + curScanned).toLocaleString()} orders read`;
      };
      const [refLines, curLines] = await Promise.all([
        sfFetchOrderLines(preStart.toISOString(), end.toISOString(), [refProductId], n => { refScanned = n; reportProgress(); }),
        sfFetchOrderLines(curStart.toISOString(), now.toISOString(), [productId], n => { curScanned = n; reportProgress(); }),
      ]);
      if (job) job.progress = 'Computing forecast…';

      const sizeAgg = (lines) => {
        const m = {};
        let units = 0, revenue = 0;
        for (const l of lines) {
          if (!m[l.size]) m[l.size] = { units: 0, revenue: 0 };
          m[l.size].units += l.qty;
          m[l.size].revenue += l.price * l.qty;
          units += l.qty;
          revenue += l.price * l.qty;
        }
        return { bySize: m, units, revenue };
      };

      const refPeriodLines = refLines.filter(l => new Date(l.created_at) >= start);
      const refPreLines    = refLines.filter(l => new Date(l.created_at) <  start);
      const refPeriod = sizeAgg(refPeriodLines);
      const refPre    = sizeAgg(refPreLines);
      const current   = sizeAgg(curLines);

      // Daily curve across the reference period (for the UI)
      const dailyCurve = {};
      refPeriodLines.forEach(l => {
        const d = String(l.created_at).slice(0, 10);
        dailyCurve[d] = (dailyCurve[d] || 0) + l.qty;
      });

      // Incoming confirmed POs for the target product, per size
      const { rows: poRows } = await pool.query(`
        SELECT po.po_number, po.delivery_date, pol.quantities, pol.total_qty
        FROM production_order_lines pol
        JOIN production_orders po ON po.id = pol.order_id
        WHERE po.status = 'confirmed' AND po.archived_at IS NULL
          AND pol.product_id = $1
          AND (po.delivery_date IS NULL OR po.delivery_date > NOW() - INTERVAL '7 days')`,
        [productId]
      );
      const incomingBySize = {};
      let incomingTotal = 0;
      for (const r2 of poRows) {
        for (const [k, v] of Object.entries(r2.quantities || {})) {
          incomingBySize[k] = (incomingBySize[k] || 0) + (parseInt(v) || 0);
          incomingTotal += parseInt(v) || 0;
        }
      }

      base = {
        target: {
          product_id: target.id, title: target.title,
          image: target.images?.[0]?.src || null,
          published_at: target.published_at,
          stock_by_size: Object.fromEntries(
            (target.variants || []).map(v => [v.title === 'Default Title' ? '—' : v.title, Math.max(0, v.inventory_quantity || 0)])
          ),
        },
        compare: compare ? { product_id: compare.id, title: compare.title, image: compare.images?.[0]?.src || null } : null,
        ref_product_id: refProductId,
        window: { start: start.toISOString(), end: end.toISOString(), period_days: periodDays, pre_days: PRE_DAYS },
        ref_period: refPeriod,
        ref_pre: refPre,
        current,
        daily_curve: dailyCurve,
        incoming: { by_size: incomingBySize, total: incomingTotal, pos: poRows.map(p => ({ po_number: p.po_number, delivery_date: p.delivery_date, total_qty: p.total_qty })) },
      };
      base.computed_at = new Date().toISOString();
      styleForecastCache[cacheKey] = { at: Date.now(), data: base };
      await pool.query(
        `INSERT INTO style_forecast_cache (cache_key, data, computed_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (cache_key) DO UPDATE SET data = EXCLUDED.data, computed_at = NOW()`,
        [cacheKey, JSON.stringify(base)]
      );
      await pool.query(`DELETE FROM style_forecast_cache WHERE computed_at < NOW() - INTERVAL '14 days'`);
    }

    // ── Model (computed fresh each request so growth %/event inputs apply) ──
    const refPeriodVel = base.ref_period.units / base.window.period_days;
    const refPreVel    = base.ref_pre.units / base.window.pre_days;
    const currentVel   = base.current.units / PRE_DAYS;
    const amplification = refPreVel > 0 ? refPeriodVel / refPreVel : null;
    const momentum      = refPreVel > 0 ? currentVel / refPreVel : null;

    const growth = 1 + (growthPct / 100);
    // Predicted event-period daily velocity = today's demand level, lifted by
    // the amplification the reference style showed last time, plus growth
    const predictedVel   = amplification !== null ? currentVel * amplification * growth : null;
    const predictedUnits = predictedVel !== null ? predictedVel * eventDays : null;

    // Size mix: how sizes actually sold during the reference event (fallback: current mix)
    const mixSource = base.ref_period.units >= 10 ? base.ref_period.bySize : base.current.bySize;
    const mixTotal  = Object.values(mixSource).reduce((s, v) => s + v.units, 0);

    const daysToEvent = eventStart ? Math.max(0, Math.round((eventStart - Date.now()) / DAY)) : 0;

    const allSizes = [...new Set([
      ...Object.keys(base.target.stock_by_size),
      ...Object.keys(mixSource),
    ])];
    const SCENARIOS = { conservative: 0.8, expected: 1.0, aggressive: 1.2 };
    const sizes = allSizes.map(size => {
      const mixShare   = mixTotal > 0 ? (mixSource[size]?.units || 0) / mixTotal : 0;
      const curSizeVel = (base.current.bySize[size]?.units || 0) / PRE_DAYS;
      const depletion  = Math.round(curSizeVel * daysToEvent);
      const stock      = base.target.stock_by_size[size] || 0;
      const incoming   = base.incoming.by_size[size] || 0;
      const row = {
        size,
        ref_units: base.ref_period.bySize[size]?.units || 0,
        current_42d: base.current.bySize[size]?.units || 0,
        stock, incoming, depletion,
        mix_pct: Math.round(mixShare * 1000) / 10,
      };
      for (const [name, mult] of Object.entries(SCENARIOS)) {
        const demand = predictedUnits !== null ? predictedUnits * mixShare * mult : null;
        row[name] = demand !== null
          ? Math.max(0, Math.ceil(demand + depletion - stock - incoming))
          : null;
        row[`${name}_demand`] = demand !== null ? Math.round(demand) : null;
      }
      return row;
    }).sort((a, b) => {
      const na = parseFloat(a.size), nb = parseFloat(b.size);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.size).localeCompare(String(b.size));
    });

    return {
      ...base,
      model: {
        growth_pct: growthPct,
        event_days: eventDays,
        event_start: eventStart ? eventStart.toISOString().slice(0, 10) : null,
        days_to_event: daysToEvent,
        ref_period_vel: Math.round(refPeriodVel * 100) / 100,
        ref_pre_vel: Math.round(refPreVel * 100) / 100,
        current_vel: Math.round(currentVel * 100) / 100,
        amplification: amplification !== null ? Math.round(amplification * 100) / 100 : null,
        momentum: momentum !== null ? Math.round(momentum * 100) / 100 : null,
        predicted_units: predictedUnits !== null ? Math.round(predictedUnits) : null,
        mix_from: base.ref_period.units >= 10 ? 'reference_period' : 'current_sales',
        insufficient_history: base.ref_period.units < 10,
      },
      sizes,
    };
}

// Long scans (BF windows) exceed request timeouts — run as a background job and poll
const sfJobs = {};

app.post('/api/style-forecast/run', requireAuth, (req, res) => {
  // Sweep jobs older than 30 minutes
  for (const [id, j] of Object.entries(sfJobs)) {
    if (Date.now() - j.startedAt > 30 * 60 * 1000) delete sfJobs[id];
  }
  const jobId = 'sf' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const job = { running: true, error: null, result: null, progress: 'Starting…', startedAt: Date.now() };
  sfJobs[jobId] = job;
  computeStyleForecast(req.body || {}, job)
    .then(result => { job.result = result; })
    .catch(err => { job.error = err.message; })
    .finally(() => { job.running = false; });
  res.json({ job: jobId });
});

app.get('/api/style-forecast/job/:id', requireAuth, (req, res) => {
  const j = sfJobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Unknown or expired job — run the forecast again' });
  res.json({ running: j.running, error: j.error, progress: j.progress, result: j.running ? null : j.result });
});

app.post('/api/style-forecast/insight', requireAuth, async (req, res) => {
  if (!anthropicClient) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const a = req.body.analysis;
    if (!a || !a.model) return res.status(400).json({ error: 'analysis payload required' });

    const prompt = `You are an inventory planning analyst for The Self Styler, an Australian womenswear e-commerce retailer, planning stock for this year's Black Friday sales period.

Business context and priorities, in order:
1. BIGGEST risk: over-ordering stock that won't clear after the event.
2. Second risk: under-ordering so customers can't buy during the event.

The style being planned: "${a.target.title}"${a.compare ? ` (no usable history of its own — using "${a.compare.title}" as the comparison/reference style)` : ''}.

DATA (JSON):
${JSON.stringify({
  reference_window: a.window,
  reference_period_sales: { units: a.ref_period.units, revenue: Math.round(a.ref_period.revenue), by_size: a.ref_period.bySize },
  reference_preperiod_velocity_per_day: a.model.ref_pre_vel,
  reference_period_velocity_per_day: a.model.ref_period_vel,
  demand_amplification: a.model.amplification,
  current_velocity_per_day_last_42d: a.model.current_vel,
  momentum_vs_last_year_preperiod: a.model.momentum,
  growth_assumption_pct: a.model.growth_pct,
  predicted_event_units: a.model.predicted_units,
  event: { start: a.model.event_start, days: a.model.event_days, days_until: a.model.days_to_event },
  current_stock_by_size: a.target.stock_by_size,
  incoming_pos: a.incoming,
  per_size_scenarios: a.sizes,
  daily_curve_reference_period: a.daily_curve,
}, null, 1)}

Write a concise planning read (plain text, short paragraphs and dot points, no markdown headers):
1. MOMENTUM READ — is this style trending above or below where the reference was before last year's event? What does that imply for the growth assumption?
2. DEMAND SHAPE — anything notable in the reference daily curve (early spike vs late) and size mix; call out sizes that look risky (fringe sizes with thin history are where over-ordering hides).
3. RECOMMENDATION — which scenario (conservative/expected/aggressive) to order, per the priorities above; state the total units and any per-size adjustments you'd make by hand. If momentum is weak, say so bluntly.
4. WATCH-OUTS — data caveats (e.g. comparison-style proxy, stockouts suppressing measured velocity, thin sample sizes).
Keep it under 400 words. Be direct and numeric.`;

    const message = await anthropicClient.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ insight: message.content[0]?.text || '', model_used: 'claude-sonnet-4-5' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Barcoding / GTIN Prep (Scanner) ─────────────────────────────────

// Separate cache from productsCache: includes draft + archived products
// (physical stock needing barcodes can sit on non-active products).
let barcodingCache = { products: null, fetchedAt: 0 };

async function fetchBarcodingProducts(force) {
  const MAX_AGE = 10 * 60 * 1000;
  if (!force && barcodingCache.products && Date.now() - barcodingCache.fetchedAt < MAX_AGE) {
    return barcodingCache.products;
  }
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&fields=id,title,status,images,variants`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify API error ${res.status}`);
    const data = await res.json();
    products.push(...data.products);
    const link = res.headers.get('link');
    const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  // Exclude internal adjustment products; keep archived only if stock remains
  // (physical stock is what needs a barcode — archived styles with zero stock
  // would otherwise flood the page with ~2,500 dead styles / 400+ junk prefixes)
  const filtered = products.filter(p => {
    if (/x-redo/i.test(p.title)) return false;
    if (p.status !== 'archived') return true;
    return (p.variants || []).some(v => (v.inventory_quantity || 0) > 0);
  });
  barcodingCache = { products: filtered, fetchedAt: Date.now() };
  return filtered;
}

// Everything before the first dash; fallback to first 2 chars for dash-less SKUs
function barcodingPrefix(sku) {
  const s = String(sku || '').trim().toUpperCase();
  if (!s) return null;
  const dash = s.indexOf('-');
  if (dash > 0) return s.slice(0, dash);
  return s.length >= 2 ? s.slice(0, 2) : s;
}

function barcodingProductPrefix(variants) {
  // Most common prefix across the product's variant SKUs
  const counts = {};
  for (const v of (variants || [])) {
    const pre = barcodingPrefix(v.sku);
    if (pre) counts[pre] = (counts[pre] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : '(NO SKU)';
}

async function buildBarcodingOverview(force) {
  const [shopifyProducts, supplierRows, productRows, crmRows] = await Promise.all([
    fetchBarcodingProducts(force),
    pool.query('SELECT * FROM barcoding_suppliers'),
    pool.query('SELECT * FROM barcoding_products'),
    pool.query('SELECT id, company_name, sku_prefixes FROM suppliers WHERE sku_prefixes IS NOT NULL'),
  ]);
  const supplierMap = {};
  supplierRows.rows.forEach(r => { supplierMap[r.prefix] = r; });

  // Supplier CRM prefixes (Production → Suppliers) — authoritative for names
  const crmByPrefix = {};
  crmRows.rows.forEach(s => {
    String(s.sku_prefixes).split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
      .forEach(px => { crmByPrefix[px] = { id: s.id, company_name: s.company_name }; });
  });
  const manualMap = {};
  productRows.rows.forEach(r => { manualMap[String(r.product_id)] = r.categorisation; });

  const products = shopifyProducts.map(p => {
    const prefix   = barcodingProductPrefix(p.variants);
    const supplier = supplierMap[prefix];
    const manual   = manualMap[String(p.id)] || null;
    const effective = manual || (supplier && supplier.default_categorisation) || null;
    const variants  = (p.variants || []).map(v => ({
      id: v.id, sku: v.sku || '', title: v.title, barcode: v.barcode || '',
      price: v.price,
    }));
    return {
      product_id: p.id,
      title: p.title,
      status: p.status,
      image: p.images && p.images[0] ? p.images[0].src : null,
      prefix,
      sku_count: variants.filter(v => v.sku).length,
      barcode_count: variants.filter(v => v.barcode).length,
      manual_categorisation: manual,
      effective,
      source: manual ? 'manual' : (effective ? 'supplier_default' : null),
      variants,
    };
  });

  // Prefix summary
  const prefixMap = {};
  for (const p of products) {
    if (!prefixMap[p.prefix]) {
      const s   = supplierMap[p.prefix] || {};
      const crm = crmByPrefix[p.prefix] || null;
      prefixMap[p.prefix] = {
        prefix: p.prefix,
        supplier_name: (crm && crm.company_name) || s.supplier_name || null,
        crm_supplier_id: crm ? crm.id : null,
        default_categorisation: s.default_categorisation || null,
        style_count: 0, sku_count: 0,
        exclusive_styles: 0, ots_styles: 0, unassigned_styles: 0,
      };
    }
    const row = prefixMap[p.prefix];
    row.style_count++;
    row.sku_count += p.sku_count;
    if (p.effective === 'exclusive') row.exclusive_styles++;
    else if (p.effective === 'off_the_shelf') row.ots_styles++;
    else row.unassigned_styles++;
  }
  const prefixes = Object.values(prefixMap).sort((a, b) => a.prefix.localeCompare(b.prefix));

  return { fetched_at: new Date(barcodingCache.fetchedAt).toISOString(), prefixes, products };
}

app.get('/api/barcoding/overview', requireAuth, async (req, res) => {
  try {
    const overview = await buildBarcodingOverview(req.query.refresh === '1');
    // Trim variants from the overview payload — the page works at style level
    res.json({
      ...overview,
      products: overview.products.map(({ variants, ...rest }) => rest),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/barcoding/suppliers/:prefix', requireAuth, async (req, res) => {
  const { supplier_name, default_categorisation, notes } = req.body;
  const cat = ['exclusive', 'off_the_shelf'].includes(default_categorisation) ? default_categorisation : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO barcoding_suppliers (prefix, supplier_name, default_categorisation, notes, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (prefix) DO UPDATE SET
         supplier_name = EXCLUDED.supplier_name,
         default_categorisation = EXCLUDED.default_categorisation,
         notes = EXCLUDED.notes,
         updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [req.params.prefix.toUpperCase(), supplier_name || null, cat, notes || null, req.user.email]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/barcoding/products/:productId', requireAuth, async (req, res) => {
  const { categorisation, product_title } = req.body;
  try {
    if (!categorisation) {
      // Clear manual override — falls back to supplier default
      await pool.query('DELETE FROM barcoding_products WHERE product_id=$1', [req.params.productId]);
      return res.json({ ok: true, cleared: true });
    }
    if (!['exclusive', 'off_the_shelf'].includes(categorisation)) {
      return res.status(400).json({ error: 'Invalid categorisation' });
    }
    const { rows } = await pool.query(
      `INSERT INTO barcoding_products (product_id, product_title, categorisation, updated_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (product_id) DO UPDATE SET
         product_title = EXCLUDED.product_title,
         categorisation = EXCLUDED.categorisation,
         updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING *`,
      [req.params.productId, product_title || null, categorisation, req.user.email]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV export — type=exclusive (GS1 prep) or type=off_the_shelf (&prefix=XX for one supplier)
app.get('/api/barcoding/export', requireAuth, async (req, res) => {
  const type = req.query.type;
  const prefix = (req.query.prefix || '').toUpperCase();
  if (!['exclusive', 'off_the_shelf'].includes(type)) {
    return res.status(400).json({ error: 'type must be exclusive or off_the_shelf' });
  }
  try {
    const { prefixes, products } = await buildBarcodingOverview(false);
    const supplierNames = {};
    prefixes.forEach(px => { supplierNames[px.prefix] = px.supplier_name || px.prefix; });

    let matching = products.filter(p => p.effective === type);
    if (prefix) matching = matching.filter(p => p.prefix === prefix);

    const csvEsc = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Title convention: "Style Name - Colour"
    const splitTitle = (title) => {
      const i = title.lastIndexOf(' - ');
      return i > 0 ? [title.slice(0, i), title.slice(i + 3)] : [title, ''];
    };

    const header = type === 'exclusive'
      ? ['SKU', 'Style Name', 'Colour', 'Size', 'RRP', 'Supplier', 'Prefix', 'Product Status', 'Existing Barcode']
      : ['SKU', 'Style Name', 'Colour', 'Size', 'RRP', 'GTIN'];

    const lines = [header.join(',')];
    for (const p of matching) {
      const [styleName, colour] = splitTitle(p.title);
      for (const v of p.variants) {
        if (!v.sku) continue;
        const size = v.title === 'Default Title' ? '' : v.title;
        const row = type === 'exclusive'
          ? [v.sku, styleName, colour, size, v.price, supplierNames[p.prefix] || p.prefix, p.prefix, p.status, v.barcode]
          : [v.sku, styleName, colour, size, v.price, v.barcode || ''];
        lines.push(row.map(csvEsc).join(','));
      }
    }

    const label = type === 'exclusive' ? 'exclusive-gs1' : `off-the-shelf${prefix ? '-' + prefix : ''}`;
    const stamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="barcoding-${label}-${stamp}.csv"`);
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Influencer Reporting (Marketing) ────────────────────────────────

// List campaigns with product summaries + latest organic snapshot
app.get('/api/influencer-campaigns', requireAuth, async (req, res) => {
  const { status } = req.query;
  const params = [];
  let where = 'WHERE c.deleted_at IS NULL';
  if (status && status !== 'all') { where += ' AND c.status = $1'; params.push(status); }
  try {
    const { rows } = await pool.query(
      `SELECT c.*,
        COALESCE(p.products, '[]') AS products,
        o.latest_organic
       FROM influencer_campaigns c
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
           'product_id', cp.product_id, 'product_title', cp.product_title, 'image_url', cp.image_url
         )) AS products
         FROM influencer_campaign_products cp WHERE cp.campaign_id = c.id
       ) p ON TRUE
       LEFT JOIN LATERAL (
         SELECT row_to_json(m) AS latest_organic
         FROM influencer_organic_metrics m
         WHERE m.campaign_id = c.id
         ORDER BY m.captured_at DESC LIMIT 1
       ) o ON TRUE
       ${where}
       ORDER BY c.post_datetime DESC NULLS FIRST, c.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/influencer-campaigns', requireAuth, async (req, res) => {
  const { creator_name, creator_handle, post_datetime, cta_used, hook,
          ad_live_start, ad_live_end, ad_live_ongoing, influencer_fee, discount_code,
          reporting_window_days, post_url, content_type, status, notes } = req.body;
  if (!creator_name) return res.status(400).json({ error: 'Creator name required' });
  try {
    const ongoing = !!ad_live_ongoing;
    const { rows } = await pool.query(
      `INSERT INTO influencer_campaigns
        (creator_name, creator_handle, post_datetime, cta_used, hook,
         ad_live_start, ad_live_end, ad_live_ongoing, influencer_fee, discount_code,
         reporting_window_days, post_url, content_type, status, notes,
         created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING *`,
      [creator_name, creator_handle || null, post_datetime || null,
       cta_used || null, hook || null, ad_live_start || null,
       ongoing ? null : (ad_live_end || null), ongoing,
       influencer_fee || 0, discount_code || null, reporting_window_days || 14,
       post_url || null, content_type || null, status || 'planned', notes || null,
       req.user.email]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/influencer-campaigns/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM influencer_campaigns WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const campaign = rows[0];

    const [products, organic, snapshots] = await Promise.all([
      pool.query(
        'SELECT * FROM influencer_campaign_products WHERE campaign_id=$1 ORDER BY id',
        [req.params.id]
      ),
      pool.query(
        'SELECT * FROM influencer_organic_metrics WHERE campaign_id=$1 ORDER BY captured_at DESC',
        [req.params.id]
      ),
      pool.query(
        `SELECT DISTINCT ON (variant_id) *
         FROM influencer_inventory_snapshots
         WHERE campaign_id=$1
         ORDER BY variant_id, snapshot_date ASC`,
        [req.params.id]
      ),
    ]);

    campaign.products           = products.rows;
    campaign.organic_metrics    = organic.rows;
    campaign.starting_inventory = snapshots.rows;
    res.json(campaign);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/influencer-campaigns/:id', requireAuth, async (req, res) => {
  const { creator_name, creator_handle, post_datetime, cta_used, hook,
          ad_live_start, ad_live_end, ad_live_ongoing, influencer_fee, discount_code,
          reporting_window_days, post_url, content_type, status, notes } = req.body;
  try {
    const ongoing = !!ad_live_ongoing;
    const { rows } = await pool.query(
      `UPDATE influencer_campaigns SET
        creator_name=$1, creator_handle=$2, post_datetime=$3, cta_used=$4, hook=$5,
        ad_live_start=$6, ad_live_end=$7, ad_live_ongoing=$8, influencer_fee=$9, discount_code=$10,
        reporting_window_days=$11, post_url=$12, content_type=$13, status=$14,
        notes=$15, updated_at=NOW(), updated_by=$16
       WHERE id=$17 AND deleted_at IS NULL RETURNING *`,
      [creator_name, creator_handle || null, post_datetime || null,
       cta_used || null, hook || null, ad_live_start || null,
       ongoing ? null : (ad_live_end || null), ongoing,
       influencer_fee || 0, discount_code || null, reporting_window_days || 14,
       post_url || null, content_type || null, status || 'planned', notes || null,
       req.user.email, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/influencer-campaigns/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE influencer_campaigns SET deleted_at=NOW(), updated_by=$1 WHERE id=$2',
      [req.user.email, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/influencer-campaigns/:id/archive', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE influencer_campaigns SET archived_at=NOW(), archived_by=$1, updated_at=NOW(), updated_by=$1
       WHERE id=$2 AND deleted_at IS NULL RETURNING *`,
      [req.user.email, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/influencer-campaigns/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE influencer_campaigns SET archived_at=NULL, archived_by=NULL, updated_at=NOW(), updated_by=$1
       WHERE id=$2 AND deleted_at IS NULL RETURNING *`,
      [req.user.email, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a featured product — also captures today's inventory snapshot for its variants
app.post('/api/influencer-campaigns/:id/products', requireAuth, async (req, res) => {
  const { product_id, product_title, image_url } = req.body;
  if (!product_id || !product_title) {
    return res.status(400).json({ error: 'product_id and product_title required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO influencer_campaign_products (campaign_id, product_id, product_title, image_url)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (campaign_id, product_id) DO UPDATE SET product_title=EXCLUDED.product_title
       RETURNING *`,
      [req.params.id, product_id, product_title, image_url || null]
    );

    // Snapshot current variant inventory (best-available "starting inventory")
    try {
      const r = await fetch(
        `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products/${product_id}.json?fields=id,variants`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } }
      );
      const data = await r.json();
      const today = new Date().toISOString().split('T')[0];
      for (const v of (data.product?.variants || [])) {
        await pool.query(
          `INSERT INTO influencer_inventory_snapshots
            (campaign_id, product_id, variant_id, variant_title, sku, snapshot_date, inventory_quantity)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (campaign_id, variant_id, snapshot_date) DO NOTHING`,
          [req.params.id, product_id, v.id, v.title, v.sku || null, today, v.inventory_quantity || 0]
        );
      }
    } catch (snapErr) {
      console.error('[influencer] Inventory snapshot failed:', snapErr.message);
    }

    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update per-product details (e.g. the size the influencer is wearing)
app.put('/api/influencer-campaigns/:id/products/:productId', requireAuth, async (req, res) => {
  const { size_worn } = req.body;
  try {
    const { rows } = await pool.query(
      `UPDATE influencer_campaign_products SET size_worn=$1
       WHERE campaign_id=$2 AND product_id=$3 RETURNING *`,
      [(size_worn || '').trim() || null, req.params.id, req.params.productId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/influencer-campaigns/:id/products/:productId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM influencer_campaign_products WHERE campaign_id=$1 AND product_id=$2',
      [req.params.id, req.params.productId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Record an organic metrics snapshot (manual entry for now; screenshot/API later)
app.post('/api/influencer-campaigns/:id/organic', requireAuth, async (req, res) => {
  const { source, reach, views, impressions, likes, comments, shares, saves,
          profile_visits, link_clicks, engagement_rate } = req.body;
  const num = (v) => (v === '' || v === null || v === undefined) ? null : parseInt(v, 10);
  try {
    let er = engagement_rate ? parseFloat(engagement_rate) : null;
    if (er === null && reach) {
      const eng = (num(likes) || 0) + (num(comments) || 0) + (num(shares) || 0) + (num(saves) || 0);
      if (eng > 0) er = Math.round((eng / num(reach)) * 100000) / 1000;
    }
    const { rows } = await pool.query(
      `INSERT INTO influencer_organic_metrics
        (campaign_id, source, captured_by, reach, views, impressions, likes,
         comments, shares, saves, profile_visits, link_clicks, engagement_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.id, source || 'manual', req.user.email,
       num(reach), num(views), num(impressions), num(likes), num(comments),
       num(shares), num(saves), num(profile_visits), num(link_clicks), er]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/influencer-campaigns/:id/organic/:metricId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM influencer_organic_metrics WHERE campaign_id=$1 AND id=$2',
      [req.params.id, req.params.metricId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Browse Meta ads for linking (searchable, with creative thumbnails)
app.get('/api/influencer-ads/browse', requireAuth, async (req, res) => {
  try {
    const ads = await metaAds.browseAds((req.query.q || '').trim());
    res.json(ads);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Link a Meta ad to a campaign — backfills 90 days of daily insights
app.post('/api/influencer-campaigns/:id/ads', requireAuth, async (req, res) => {
  const { ad_id, ad_name, adset_id, adset_name, campaign_meta_id, campaign_meta_name,
          creative_id, creative_thumb_url } = req.body;
  if (!ad_id) return res.status(400).json({ error: 'ad_id required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO influencer_campaign_ads
        (campaign_id, ad_id, ad_name, adset_id, adset_name, campaign_meta_id, campaign_meta_name, creative_id, creative_thumb_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (campaign_id, ad_id) DO UPDATE SET ad_name=EXCLUDED.ad_name
       RETURNING *`,
      [req.params.id, ad_id, ad_name || null, adset_id || null, adset_name || null,
       campaign_meta_id || null, campaign_meta_name || null, creative_id || null, creative_thumb_url || null]
    );
    try {
      await metaAds.syncInfluencerAdInsights([ad_id], 90);
    } catch (syncErr) {
      console.error('[influencer] Ad backfill failed:', syncErr.message);
      return res.json({ ...rows[0], sync_warning: syncErr.message });
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/influencer-campaigns/:id/ads/:adId', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM influencer_campaign_ads WHERE campaign_id=$1 AND ad_id=$2',
      [req.params.id, req.params.adId]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Linked ads with lifetime aggregates + combined totals (?refresh=1 re-syncs 90 days)
app.get('/api/influencer-campaigns/:id/ads', requireAuth, async (req, res) => {
  try {
    const { rows: links } = await pool.query(
      'SELECT * FROM influencer_campaign_ads WHERE campaign_id=$1 ORDER BY id', [req.params.id]
    );
    if (!links.length) return res.json({ ads: [], totals: null });

    let syncWarning = null;
    if (req.query.refresh === '1') {
      try { await metaAds.syncInfluencerAdInsights(links.map(l => l.ad_id), 90); }
      catch (e) { syncWarning = e.message; }
    }

    const { rows: agg } = await pool.query(
      `SELECT ad_id,
         SUM(spend) AS spend, SUM(impressions) AS impressions, SUM(clicks) AS clicks,
         SUM(reach) AS reach, SUM(purchases) AS purchases, SUM(purchase_value) AS purchase_value,
         SUM(video_3s_views) AS video_3s_views, SUM(thruplays) AS thruplays,
         MIN(date) AS first_date, MAX(date) AS last_date
       FROM influencer_ad_insights_daily
       WHERE ad_id = ANY($1::text[])
       GROUP BY ad_id`,
      [links.map(l => l.ad_id)]
    );
    const aggMap = {};
    agg.forEach(a => { aggMap[a.ad_id] = a; });

    const derive = (a) => {
      const spend = parseFloat(a.spend || 0), impr = parseInt(a.impressions || 0),
            clicks = parseInt(a.clicks || 0), pv = parseFloat(a.purchase_value || 0),
            v3s = parseInt(a.video_3s_views || 0), thru = parseInt(a.thruplays || 0);
      return {
        spend, impressions: impr, clicks,
        reach: parseInt(a.reach || 0),
        purchases: parseInt(a.purchases || 0),
        purchase_value: pv,
        roas: spend > 0 ? pv / spend : null,
        ctr: impr > 0 ? (clicks / impr) * 100 : null,
        cpc: clicks > 0 ? spend / clicks : null,
        cpm: impr > 0 ? (spend / impr) * 1000 : null,
        frequency: parseInt(a.reach || 0) > 0 ? impr / parseInt(a.reach) : null,
        thumb_stop: impr > 0 && v3s ? (v3s / impr) * 100 : null,
        hold_rate: v3s > 0 && thru ? (thru / v3s) * 100 : null,
        first_date: a.first_date || null, last_date: a.last_date || null,
      };
    };

    const ads = links.map(l => ({
      ...l,
      metrics: aggMap[l.ad_id] ? derive(aggMap[l.ad_id]) : null,
    }));

    // Combined totals across all linked ads
    const sum = (k) => agg.reduce((s, a) => s + parseFloat(a[k] || 0), 0);
    const totals = agg.length ? derive({
      spend: sum('spend'), impressions: sum('impressions'), clicks: sum('clicks'),
      reach: sum('reach'), purchases: sum('purchases'), purchase_value: sum('purchase_value'),
      video_3s_views: sum('video_3s_views'), thruplays: sum('thruplays'),
    }) : null;

    res.json({ ads, totals, sync_warning: syncWarning });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sales analysis: direct (discount code) + indirect (featured garments by size)
// Window: post date (or ad start) → ad end / post + reporting window; "now" if ongoing.
app.get('/api/influencer-campaigns/:id/sales', requireAuth, async (req, res) => {
  const DAY = 86400000;
  try {
    const { rows: crows } = await pool.query(
      'SELECT * FROM influencer_campaigns WHERE id=$1 AND deleted_at IS NULL', [req.params.id]
    );
    if (!crows.length) return res.status(404).json({ error: 'Not found' });
    const c = crows[0];

    const { rows: products } = await pool.query(
      'SELECT * FROM influencer_campaign_products WHERE campaign_id=$1 ORDER BY id', [req.params.id]
    );
    if (!products.length) return res.json({ no_products: true });
    if (!c.post_datetime && !c.ad_live_start) return res.json({ no_window: true });

    // Serve cached result unless a refresh is requested
    if (req.query.refresh !== '1') {
      const { rows: cached } = await pool.query(
        `SELECT summary, computed_at FROM influencer_sales_cache
         WHERE campaign_id=$1 AND computed_at > NOW() - INTERVAL '30 minutes'`,
        [req.params.id]
      );
      if (cached.length && cached[0].summary) {
        return res.json({ ...cached[0].summary, cached: true, computed_at: cached[0].computed_at });
      }
    }

    // Reporting window
    const now   = new Date();
    const start = new Date(c.post_datetime || c.ad_live_start);
    let end;
    if (c.ad_live_ongoing) {
      end = now;
    } else {
      const candidates = [new Date(start.getTime() + (c.reporting_window_days || 14) * DAY)];
      if (c.ad_live_end) {
        const adEnd = new Date(c.ad_live_end);
        adEnd.setHours(23, 59, 59, 999);
        candidates.push(adEnd);
      }
      end = new Date(Math.max(...candidates.map(d => d.getTime())));
    }
    if (end > now) end = now;
    let windowCapped = false;
    if (end.getTime() - start.getTime() > 90 * DAY) { end = new Date(start.getTime() + 90 * DAY); windowCapped = true; }

    // Scan window orders
    const orders = [];
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=any&created_at_min=${start.toISOString()}&created_at_max=${end.toISOString()}` +
      `&limit=250&fields=id,name,created_at,cancelled_at,total_price,discount_codes,line_items`;
    while (url) {
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
      if (r.status === 429) {
        await new Promise(w => setTimeout(w, parseFloat(r.headers.get('retry-after') || '2') * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`Shopify orders API ${r.status}`);
      const data = await r.json();
      orders.push(...(data.orders || []));
      const link = r.headers.get('link');
      const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    const code = (c.discount_code || '').trim().toUpperCase();
    const featuredIds = new Set(products.map(p => String(p.product_id)));
    const direct = { order_count: 0, revenue: 0, units: 0, orders: [] };
    const perProduct = {};
    products.forEach(p => {
      perProduct[String(p.product_id)] = {
        product_id: p.product_id, title: p.product_title, image_url: p.image_url,
        size_worn: p.size_worn, sizes: {}, total_units: 0, total_revenue: 0,
        order_count: 0, orders: [],
      };
    });

    let scanned = 0;
    for (const o of orders) {
      if (o.cancelled_at) continue;
      scanned++;

      // Structured items — `featured` marks garments promoted by the influencer
      const orderItems = (o.line_items || []).map(li => ({
        label: `${li.title}${li.variant_title ? ' (' + li.variant_title + ')' : ''} ×${li.quantity}`,
        featured: featuredIds.has(String(li.product_id || '')),
      }));
      const orderInfo = {
        name: o.name, created_at: o.created_at,
        total: parseFloat(o.total_price || 0),
        items: orderItems,
      };

      if (code && (o.discount_codes || []).some(d => (d.code || '').trim().toUpperCase() === code)) {
        direct.order_count++;
        direct.revenue += parseFloat(o.total_price || 0);
        direct.units   += (o.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
        if (direct.orders.length < 50) direct.orders.push(orderInfo);
      }

      const productsInOrder = new Set();
      for (const li of (o.line_items || [])) {
        const pp = perProduct[String(li.product_id || '')];
        if (!pp) continue;
        const size = li.variant_title || '—';
        if (!pp.sizes[size]) pp.sizes[size] = { units: 0, revenue: 0 };
        const rev = parseFloat(li.price || 0) * (li.quantity || 0);
        pp.sizes[size].units   += li.quantity || 0;
        pp.sizes[size].revenue += rev;
        pp.total_units   += li.quantity || 0;
        pp.total_revenue += rev;
        productsInOrder.add(String(li.product_id));
      }
      for (const pid of productsInOrder) {
        const pp = perProduct[pid];
        pp.order_count++;
        if (pp.orders.length < 25) pp.orders.push(orderInfo);
      }
    }

    const payload = {
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      window_ongoing: !!c.ad_live_ongoing,
      window_capped: windowCapped,
      orders_scanned: scanned,
      discount_code: c.discount_code || null,
      direct,
      products: Object.values(perProduct),
    };

    await pool.query(
      `INSERT INTO influencer_sales_cache (campaign_id, computed_at, window_start, window_end, summary)
       VALUES ($1, NOW(), $2, $3, $4)
       ON CONFLICT (campaign_id) DO UPDATE SET
         computed_at = NOW(), window_start = EXCLUDED.window_start,
         window_end = EXCLUDED.window_end, summary = EXCLUDED.summary`,
      [req.params.id, payload.window_start, payload.window_end, JSON.stringify(payload)]
    );

    res.json(payload);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    sellthroughAlerts.startCron(pool);

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
