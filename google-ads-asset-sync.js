'use strict';

/**
 * google-ads-asset-sync.js
 * Syncs product images from the Shopify 'new-arrivals' collection
 * into the Google Ads Asset Library as IMAGE assets.
 * Runs at 06:00 AM daily; can also be triggered manually.
 */

const fetch    = require('node-fetch');
const cron     = require('node-cron');
const { pool } = require('./db');

const API_VERSION   = '2024-01';
const ADS_VERSION   = process.env.GOOGLE_ADS_API_VERSION || 'v23';
const CRON_SCHEDULE = process.env.GOOGLE_ADS_ASSET_CRON || '0 6 * * *';
const MAX_BYTES     = 5 * 1024 * 1024; // 5 MB
const MIN_DIM       = 300;             // 300 × 300 px minimum

let isRunning  = false;
let lastStatus = { lastRun: null, uploaded: 0, skipped: 0, failed: 0, error: null };

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

async function fetchCollectionImages(collectionId) {
  const shop   = process.env.SHOPIFY_SHOP;
  const images = []; // { imageId, productId, productTitle, imageUrl }

  let url = `https://${shop}/admin/api/${API_VERSION}/collections/${collectionId}/products.json` +
            `?limit=250&fields=id,title,images`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (r.status === 429) {
      const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
      console.log(`[ads-assets] Rate limited — waiting ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!r.ok) throw new Error(`Shopify products API ${r.status}`);
    const data = await r.json();

    for (const product of (data.products || [])) {
      for (const img of (product.images || [])) {
        if (!img.src) continue;
        images.push({
          imageId:      String(img.id),
          productId:    String(product.id),
          productTitle: product.title,
          imageUrl:     img.src.split('?')[0], // strip query params (e.g. ?v=...)
        });
      }
    }

    const link = r.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }

  return images;
}

// ── Image validation (no external libraries) ───────────────────────
// Parses magic bytes to determine MIME type and dimensions.

function parseImageInfo(buf) {
  // PNG: 89 50 4E 47 0D 0A 1A 0A — IHDR chunk starts at byte 8 (width @ 16, height @ 20)
  if (buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 &&
      buf[2] === 0x4E && buf[3] === 0x47) {
    return {
      mime:   'image/png',
      width:  buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
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
      // SOI / EOI — stop
      if (marker === 0xD8 || marker === 0xD9) break;
      if (offset + 4 > buf.length) break;
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
    return { mime: 'image/jpeg', width: null, height: null }; // valid JPEG, couldn't parse dims
  }

  // GIF: 47 49 46 — logical screen descriptor has width @ 6 (LE), height @ 8 (LE)
  if (buf.length >= 10 &&
      buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return {
      mime:   'image/gif',
      width:  buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
    };
  }

  return null; // unsupported format
}

async function fetchAndValidateImage(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Fetch failed (${r.status}): ${url}`);

  // node-fetch v2 exposes .buffer() directly — returns a Buffer
  const buffer = await r.buffer();

  if (buffer.length > MAX_BYTES) {
    throw new Error(
      `Too large: ${(buffer.length / 1024 / 1024).toFixed(1)} MB (max 5 MB)`
    );
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
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(
      `Google Ads Asset API non-JSON (${res.status}): ${rawText.slice(0, 200)}`
    );
  }

  if (!res.ok) {
    // Dig out a useful error message from the nested Google Ads error structure
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
    throw new Error('Google Ads not configured — connect Google Ads via Syncing page first');
  }

  isRunning = true;
  const startedAt = new Date();
  let uploaded = 0, skipped = 0, failed = 0;

  try {
    // 1. Find the 'new-arrivals' collection
    console.log('[ads-assets] Finding new-arrivals collection…');
    const collectionId = await findCollectionId('new-arrivals');
    if (!collectionId) {
      throw new Error("Shopify collection 'new-arrivals' not found — check the handle in Shopify");
    }
    console.log(`[ads-assets] Collection ID: ${collectionId}`);

    // 2. Fetch all product images in the collection
    const images = await fetchCollectionImages(collectionId);
    console.log(`[ads-assets] ${images.length} total images in collection`);

    if (images.length === 0) {
      lastStatus = { lastRun: startedAt, uploaded, skipped, failed, error: null };
      return { uploaded, skipped, failed };
    }

    // 3. Find which image IDs are already in our DB
    const { rows: existing } = await pool.query(
      'SELECT shopify_image_id FROM google_ads_assets'
    );
    const uploadedSet = new Set(existing.map(r => r.shopify_image_id));

    const toUpload = images.filter(img => !uploadedSet.has(img.imageId));
    skipped = images.length - toUpload.length;
    console.log(
      `[ads-assets] ${toUpload.length} new to upload, ${skipped} already synced`
    );

    if (toUpload.length === 0) {
      lastStatus = { lastRun: startedAt, uploaded, skipped, failed, error: null };
      return { uploaded, skipped, failed };
    }

    // 4. Get access token once for the whole batch
    const accessToken = await getAccessToken();

    // 5. Download, validate, upload each new image
    for (const img of toUpload) {
      try {
        // Download image and validate dimensions + size + format
        const { buffer } = await fetchAndValidateImage(img.imageUrl);

        // Build a clean asset name (max 255 chars)
        const safeName  = img.productTitle.replace(/[^\w\s\-]/g, '').trim().slice(0, 180);
        const assetName = `${safeName} [${img.imageId}]`;

        // Upload to Google Ads Asset Library
        const resourceName = await uploadImageAsset(accessToken, assetName, buffer);

        // Record in DB
        await pool.query(`
          INSERT INTO google_ads_assets
            (shopify_image_id, product_id, product_title, image_url, asset_name, resource_name)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (shopify_image_id) DO UPDATE SET
            product_title  = EXCLUDED.product_title,
            image_url      = EXCLUDED.image_url,
            asset_name     = EXCLUDED.asset_name,
            resource_name  = EXCLUDED.resource_name,
            synced_at      = NOW()
        `, [img.imageId, img.productId, img.productTitle, img.imageUrl, assetName, resourceName]);

        uploaded++;
        console.log(`[ads-assets] ✓ ${assetName}`);
      } catch (err) {
        failed++;
        console.warn(`[ads-assets] ✗ ${img.imageId} (${img.productTitle}): ${err.message}`);
      }

      // Small throttle between uploads
      await sleep(300);
    }

    const result = { uploaded, skipped, failed };
    lastStatus = { lastRun: startedAt, ...result, error: null };
    console.log(`[ads-assets] Done — uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed}`);
    return result;

  } catch (err) {
    lastStatus = { lastRun: startedAt, uploaded, skipped, failed, error: err.message };
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
