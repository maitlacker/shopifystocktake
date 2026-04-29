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

    // Build variant→image map from products cache
    const variantImageMap = {};
    for (const p of productsCache) {
      const productImg = p.images?.[0]?.src || null;
      for (const v of p.variants) {
        const variantImg = p.images?.find(img => img.id === v.image_id)?.src || productImg;
        variantImageMap[String(v.id)] = variantImg;
      }
    }

    // Fetch orders from Shopify (newest first), stop once order_number < start
    const items = [];
    const orderNumbersSeen = new Set();
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
      `?status=any&limit=250&fields=id,name,order_number,line_items`;
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
          items.push({
            orderNumber:  order.order_number,
            variantId:    item.variant_id,
            productId:    item.product_id,
            title:        item.title,
            variantTitle: (item.variant_title && item.variant_title !== 'Default Title') ? item.variant_title : null,
            sku:          item.sku || '',
            qty:          item.quantity,
            image:        variantImageMap[String(item.variant_id)] || null,
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

// ── Login page ─────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
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

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    startCron();
    googleAds.startCron();
    shopifyAnalytics.startCron();

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
