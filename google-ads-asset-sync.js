'use strict';

/**
 * google-ads-asset-sync.js
 * Selects the top 10 new-arrivals products by sales velocity + stock level,
 * then uploads their best portrait and best landscape image to the
 * Google Ads Asset Library (max 20 images: 10 products × 2 orientations).
 *
 * Scoring: (units_sold_45d × 3) + min(stock_on_hand, 100)
 * Only products with ≥ MIN_STOCK total tracked stock are eligible.
 */

const fetch    = require('node-fetch');
const cron     = require('node-cron');
const { pool } = require('./db');

const API_VERSION   = '2024-01';
const ADS_VERSION   = process.env.GOOGLE_ADS_API_VERSION || 'v23';
const CRON_SCHEDULE = process.env.GOOGLE_ADS_ASSET_CRON || '0 6 * * *';
const MAX_BYTES     = 5 * 1024 * 1024; // 5 MB hard limit from Google
const MIN_DIM       = 300;             // 300 × 300 px minimum (Google requirement)
const TOP_N         = 10;              // number of products to select
const MIN_STOCK     = 15;              // minimum total stock to be eligible
const VELOCITY_DAYS = 45;             // sales lookback window in days

// Products whose type OR title contains any of these words (case-insensitive) are excluded
const EXCLUDED_KEYWORDS = [
  'accessory', 'accessories',
  'jewellery', 'jewelry',
  'earring', 'earrings',
  'necklace', 'bracelet', 'ring', 'rings',
];

let isRunning  = false;
let lastStatus = {
  lastRun:                null,
  uploaded:               0,
  skipped:                0,
  failed:                 0,
  productsSelected:       0,
  selectedProductTitles:  [],
  error:                  null,
};

// ── Utilities ──────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Shopify helpers ────────────────────────────────────────────────

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function findCollectionId(handle) {
  const shop = process.env.SHOPIFY_SHOP;
  for (const type of ['custom_collections', 'smart_collections']) {
    const r = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/${type}.json` +
      `?handle=${encodeURIComponent(handle)}&limit=1`,
      { headers: shopifyHeaders() }
    );
    if (!r.ok) continue;
    const data = await r.json();
    const list = data[type] || [];
    if (list.length > 0) return list[0].id;
  }
  return null;
}

/**
 * Fetch all products in a collection, including variants (for stock) and
 * images (which include width/height from Shopify API — no download needed).
 */
async function fetchCollectionProducts(collectionId) {
  const shop     = process.env.SHOPIFY_SHOP;
  const products = [];

  let url = `https://${shop}/admin/api/${API_VERSION}/collections/${collectionId}/products.json` +
            `?limit=250&fields=id,title,product_type,images,variants`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`Shopify collection products API ${r.status}`);
    const data = await r.json();
    products.push(...(data.products || []));

    const link = r.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  return products;
}

/**
 * Fetch paid orders from the last `days` days and return a map of
 * product_id → total units sold.
 */
async function fetchRecentSalesByProduct(days) {
  const shop  = process.env.SHOPIFY_SHOP;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const salesMap  = {}; // { [product_id]: units_sold }
  let   orderCount = 0;

  let url = `https://${shop}/admin/api/${API_VERSION}/orders.json` +
            `?status=any&financial_status=paid` +
            `&created_at_min=${encodeURIComponent(since.toISOString())}` +
            `&limit=250&fields=id,line_items`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`Shopify orders API ${r.status}`);
    const data = await r.json();

    for (const order of (data.orders || [])) {
      for (const item of (order.line_items || [])) {
        const pid = String(item.product_id || '');
        if (!pid || pid === 'null') continue;
        salesMap[pid] = (salesMap[pid] || 0) + (parseInt(item.quantity, 10) || 0);
      }
    }
    orderCount += (data.orders || []).length;

    const link = r.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  console.log(`[ads-assets] Fetched ${orderCount} orders (last ${days} days) for velocity scoring`);
  return salesMap;
}

/**
 * Calculate total stock for a Shopify product — sum all positive variant quantities.
 * No inventory_management filter here: for advertising selection we just want to know
 * if there's real stock to sell, regardless of how Shopify tracks it.
 */
function calcStock(product) {
  return (product.variants || []).reduce((sum, v) => {
    return sum + Math.max(0, parseInt(v.inventory_quantity, 10) || 0);
  }, 0);
}

/**
 * Returns true if a product should be excluded from ad assets based on
 * product_type or title containing accessory/jewellery/earring keywords.
 */
function isExcluded(product) {
  const haystack = [
    (product.product_type || ''),
    (product.title        || ''),
  ].join(' ').toLowerCase();
  return EXCLUDED_KEYWORDS.some(kw => haystack.includes(kw));
}

/**
 * Score, filter, and rank products. Returns top N with _stock, _sales, _score attached.
 *
 * Formula: (units_sold_45d × 3) + min(stock, 100)
 * This rewards products that are both selling well AND have plenty of stock.
 * Products with fewer than MIN_STOCK units are excluded.
 */
function selectTopProducts(products, salesMap) {
  const scored = products.map(p => {
    const stock = calcStock(p);
    const sales = salesMap[String(p.id)] || 0;
    const score = (sales * 3) + Math.min(stock, 100);
    return { ...p, _stock: stock, _sales: sales, _score: score };
  });

  const eligible = scored.filter(p => p._stock >= MIN_STOCK && !isExcluded(p));
  const top      = eligible.sort((a, b) => b._score - a._score).slice(0, TOP_N);

  // Log the selection so it's visible in Railway logs
  const excluded = scored.filter(p => isExcluded(p));
  if (excluded.length > 0) {
    console.log(`[ads-assets] Excluded ${excluded.length} accessory/jewellery products: ${excluded.map(p => p.title).join(', ')}`);
  }
  console.log(`[ads-assets] ${products.length} products in collection, ${eligible.length} eligible (≥${MIN_STOCK} stock, not excluded)`);
  for (const p of top) {
    console.log(`[ads-assets]   → ${p.title} | stock: ${p._stock} | sales: ${p._sales} | score: ${p._score}`);
  }

  return top;
}

/**
 * From a product's images array (which includes width/height from Shopify API),
 * select the best portrait and best landscape image.
 *
 * Portrait:  height >= width  (tallest aspect ratio, highest resolution wins)
 * Landscape: width  >  height (widest aspect ratio, highest resolution wins)
 *
 * Returns { portrait: imageObj|null, landscape: imageObj|null }
 */
function selectBestImages(product) {
  const byResDesc = (a, b) => (b.width * b.height) - (a.width * a.height);

  // Only consider images with valid dimensions from the API
  const withDims = (product.images || []).filter(
    img => img.src && img.width > 0 && img.height > 0
  );

  const portraits  = withDims.filter(img => img.height >= img.width).sort(byResDesc);
  const landscapes = withDims.filter(img => img.width  >  img.height).sort(byResDesc);

  return {
    portrait:  portraits[0]  || null,
    landscape: landscapes[0] || null,
  };
}

// ── Image download + validation (no external libraries) ───────────
// Uses magic bytes to confirm format and parse dimensions.

function parseImageInfo(buf) {
  // PNG: 89 50 4E 47 — IHDR chunk at byte 8, width @ 16, height @ 20
  if (buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 &&
      buf[2] === 0x4E && buf[3] === 0x47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: FF D8 — scan for SOF0/SOF1/SOF2 marker (C0/C1/C2)
  if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset + 8 < buf.length) {
      if (buf[offset] !== 0xFF) break;
      const marker = buf[offset + 1];
      if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
        return {
          mime:   'image/jpeg',
          height: buf.readUInt16BE(offset + 5),
          width:  buf.readUInt16BE(offset + 7),
        };
      }
      if (marker === 0xD8 || marker === 0xD9) break;
      if (offset + 4 > buf.length) break;
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }

  // GIF: 47 49 46 — width @ 6 (LE), height @ 8 (LE)
  if (buf.length >= 10 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  return null;
}

async function fetchAndValidateImage(url) {
  const r = await fetch(url.split('?')[0]); // strip Shopify CDN query params
  if (!r.ok) throw new Error(`Fetch failed (${r.status})`);

  const buffer = await r.buffer(); // node-fetch v2 native Buffer

  if (buffer.length > MAX_BYTES) {
    throw new Error(`Too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (max 5 MB)`);
  }

  const info = parseImageInfo(buffer);
  if (!info) throw new Error('Unsupported format — must be JPEG, PNG, or GIF');

  if (info.width !== null && info.height !== null) {
    if (info.width < MIN_DIM || info.height < MIN_DIM) {
      throw new Error(`Too small: ${info.width}×${info.height}px (min ${MIN_DIM}×${MIN_DIM})`);
    }
  }

  return { buffer, mime: info.mime, width: info.width, height: info.height };
}

// ── Google Ads credentials — same pattern as google-ads-sync.js ────

async function getSetting(key) {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM app_settings WHERE key = $1', [key]
    );
    return rows[0]?.value || null;
  } catch { return null; }
}

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

async function getAccessToken() {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('Google Ads not connected — no refresh token');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
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

// ── Google Ads Asset Library upload ───────────────────────────────

async function uploadImageAsset(accessToken, assetName, buffer) {
  const customerId = getCustomerId();
  const devToken   = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const loginId    = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  const headers = {
    'Authorization':   `Bearer ${accessToken}`,
    'developer-token': devToken,
    'Content-Type':    'application/json',
  };
  if (loginId) headers['login-customer-id'] = loginId.replace(/-/g, '');

  const body = {
    operations: [{
      create: {
        name:       assetName,
        type:       'IMAGE',
        imageAsset: { data: buffer.toString('base64') },
      },
    }],
  };

  const res = await fetch(
    `https://googleads.googleapis.com/${ADS_VERSION}/customers/${customerId}/assets:mutate`,
    { method: 'POST', headers, body: JSON.stringify(body) }
  );

  const rawText = await res.text();
  let data;
  try { data = JSON.parse(rawText); }
  catch {
    throw new Error(
      `Google Ads Asset API non-JSON (${res.status}): ${rawText.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    const msg = data.error?.message
      || data.error?.details?.[0]?.errors?.[0]?.message
      || JSON.stringify(data).slice(0, 300);
    throw new Error(`Google Ads Asset API ${res.status}: ${msg}`);
  }

  return data.results?.[0]?.resourceName || null;
}

// ── Core sync ──────────────────────────────────────────────────────

async function runSync() {
  if (isRunning) {
    console.log('[ads-assets] Already running — skipped');
    return { skipped: true };
  }

  if (!process.env.SHOPIFY_SHOP || !process.env.SHOPIFY_ACCESS_TOKEN) {
    throw new Error('SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN not configured');
  }
  if (!await isConfigured()) {
    throw new Error('Google Ads not configured — connect Google Ads via the Syncing page first');
  }

  isRunning = true;
  const startedAt = new Date();
  let uploaded = 0, skipped = 0, failed = 0;

  try {
    // ── 1. Find the collection ─────────────────────────────────────
    console.log('[ads-assets] Finding new-arrivals collection…');
    const collectionId = await findCollectionId('new-arrivals');
    if (!collectionId) {
      throw new Error(
        "Shopify collection 'new-arrivals' not found — check the handle in Shopify admin"
      );
    }
    console.log(`[ads-assets] Collection ID: ${collectionId}`);

    // ── 2. Fetch products (with variants for stock, images for orientation) ──
    console.log('[ads-assets] Fetching collection products…');
    const products = await fetchCollectionProducts(collectionId);
    console.log(`[ads-assets] ${products.length} products in collection`);

    if (products.length === 0) {
      lastStatus = {
        lastRun: startedAt, uploaded, skipped, failed,
        productsSelected: 0, selectedProductTitles: [], error: null,
      };
      return { uploaded, skipped, failed, productsSelected: 0 };
    }

    // ── 3. Fetch recent sales for velocity scoring ─────────────────
    console.log(`[ads-assets] Fetching orders (last ${VELOCITY_DAYS} days)…`);
    const salesMap = await fetchRecentSalesByProduct(VELOCITY_DAYS);

    // ── 4. Score + rank → top 10 ───────────────────────────────────
    const topProducts = selectTopProducts(products, salesMap);

    if (topProducts.length === 0) {
      throw new Error(
        `No eligible products found — all products had fewer than ${MIN_STOCK} units of tracked stock`
      );
    }

    // ── 5. Build target image list (max 20: best portrait + landscape per product) ──
    const targetImages = []; // { imageId, productId, productTitle, imageUrl, role }

    for (const p of topProducts) {
      const { portrait, landscape } = selectBestImages(p);

      if (portrait) {
        targetImages.push({
          imageId:      String(portrait.id),
          productId:    String(p.id),
          productTitle: p.title,
          imageUrl:     portrait.src,
          role:         'portrait',
          apiWidth:     portrait.width,
          apiHeight:    portrait.height,
        });
      } else {
        console.log(`[ads-assets] No portrait image for: ${p.title}`);
      }

      if (landscape) {
        targetImages.push({
          imageId:      String(landscape.id),
          productId:    String(p.id),
          productTitle: p.title,
          imageUrl:     landscape.src,
          role:         'landscape',
          apiWidth:     landscape.width,
          apiHeight:    landscape.height,
        });
      } else {
        console.log(`[ads-assets] No landscape image for: ${p.title}`);
      }
    }

    console.log(
      `[ads-assets] ${targetImages.length} target images across ${topProducts.length} products ` +
      `(${targetImages.filter(i => i.role === 'portrait').length} portrait, ` +
      `${targetImages.filter(i => i.role === 'landscape').length} landscape)`
    );

    // ── 6. Check which are already uploaded ────────────────────────
    const { rows: existing } = await pool.query(
      'SELECT shopify_image_id FROM google_ads_assets'
    );
    const uploadedSet = new Set(existing.map(r => r.shopify_image_id));

    const toUpload = targetImages.filter(img => !uploadedSet.has(img.imageId));
    skipped = targetImages.length - toUpload.length;
    console.log(`[ads-assets] ${toUpload.length} new images to upload, ${skipped} already synced`);

    if (toUpload.length === 0) {
      lastStatus = {
        lastRun: startedAt, uploaded, skipped, failed,
        productsSelected: topProducts.length,
        selectedProductTitles: topProducts.map(p => p.title),
        error: null,
      };
      return { uploaded, skipped, failed, productsSelected: topProducts.length };
    }

    // ── 7. Get access token once for the whole batch ───────────────
    const accessToken = await getAccessToken();

    // ── 8. Download, validate, upload each new image ───────────────
    for (const img of toUpload) {
      try {
        const { buffer } = await fetchAndValidateImage(img.imageUrl);

        // e.g. "Product Title – portrait [imageId]"
        const safeName  = img.productTitle.replace(/[^\w\s\-]/g, '').trim().slice(0, 160);
        const assetName = `${safeName} – ${img.role} [${img.imageId}]`;

        const resourceName = await uploadImageAsset(accessToken, assetName, buffer);

        await pool.query(`
          INSERT INTO google_ads_assets
            (shopify_image_id, product_id, product_title, image_url, asset_name, resource_name, image_role)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (shopify_image_id) DO UPDATE SET
            product_title  = EXCLUDED.product_title,
            image_url      = EXCLUDED.image_url,
            asset_name     = EXCLUDED.asset_name,
            resource_name  = EXCLUDED.resource_name,
            image_role     = EXCLUDED.image_role,
            synced_at      = NOW()
        `, [
          img.imageId, img.productId, img.productTitle,
          img.imageUrl, assetName, resourceName, img.role,
        ]);

        uploaded++;
        console.log(`[ads-assets] ✓ ${assetName}`);
      } catch (err) {
        failed++;
        console.warn(
          `[ads-assets] ✗ ${img.role} for ${img.productTitle} ` +
          `(image ${img.imageId}): ${err.message}`
        );
      }

      await sleep(300); // throttle between uploads
    }

    const result = {
      uploaded,
      skipped,
      failed,
      productsSelected: topProducts.length,
    };
    lastStatus = {
      lastRun: startedAt,
      ...result,
      selectedProductTitles: topProducts.map(p => p.title),
      error: null,
    };
    console.log(
      `[ads-assets] Done — uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}, ` +
      `products: ${topProducts.length}`
    );
    return result;

  } catch (err) {
    lastStatus = {
      lastRun: startedAt, uploaded, skipped, failed,
      productsSelected: 0, selectedProductTitles: [], error: err.message,
    };
    console.error('[ads-assets] Sync error:', err.message);
    throw err;
  } finally {
    isRunning = false;
  }
}

// ── Status ─────────────────────────────────────────────────────────

function getStatus() {
  return { isRunning, ...lastStatus };
}

// ── Cron ───────────────────────────────────────────────────────────

function startCron() {
  cron.schedule(CRON_SCHEDULE, async () => {
    console.log('[ads-assets] Daily cron starting…');
    try {
      await runSync();
    } catch (err) {
      console.error('[ads-assets] Cron error:', err.message);
    }
  });
  console.log(`[ads-assets] Cron scheduled: ${CRON_SCHEDULE}`);
}

module.exports = { runSync, getStatus, startCron };
