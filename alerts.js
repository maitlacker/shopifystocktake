const cron      = require('node-cron');
const fetch     = require('node-fetch');
const { pool }  = require('./db');

const THRESHOLD      = 2;
const API_VERSION    = '2024-01';
const CRON_SCHEDULE  = process.env.STOCK_ALERT_CRON || '*/30 * * * *';

// In-memory run state (for status API)
let isRunning      = false;
let lastRun        = null;
let lastRunResult  = null;

// ── Shopify ────────────────────────────────────────────────────────
async function fetchAllVariants() {
  const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
  const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  const headers = {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
  };

  const variants = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=active&fields=id,title,variants`;

  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Shopify API error ${res.status}`);
    const data = await res.json();

    for (const product of data.products) {
      for (const v of product.variants) {
        variants.push({
          productId:    product.id,
          productTitle: product.title,
          variantId:    v.id,
          variantTitle: v.title,
          sku:          v.sku || '',
          inventory:    v.inventory_quantity ?? 0,
        });
      }
    }

    const link = res.headers.get('link');
    url = null;
    if (link) {
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      if (m) url = m[1];
    }
  }

  return variants;
}

// ── Slack ──────────────────────────────────────────────────────────
async function sendSlackAlert(variant) {
  const raw = process.env.SLACK_WEBHOOK_URL || '';
  // Strip any accidental surrounding quotes or whitespace
  const webhookUrl = raw.trim().replace(/^["']|["']$/g, '');

  if (!webhookUrl) {
    console.warn('[alerts] SLACK_WEBHOOK_URL not set — skipping Slack notification');
    return;
  }

  if (!webhookUrl.startsWith('https://')) {
    console.error(`[alerts] SLACK_WEBHOOK_URL looks invalid — starts with: "${webhookUrl.slice(0, 30)}"`);
    return;
  }

  const variantSuffix = variant.variantTitle && variant.variantTitle !== 'Default Title'
    ? ` – ${variant.variantTitle}`
    : '';
  const skuSuffix = variant.sku ? ` (SKU: ${variant.sku})` : '';

  const payload = {
    text: `⚠️ *Low Stock Alert* — please check *${variant.productTitle}${variantSuffix}*${skuSuffix} as we now appear to only have limited stock left (${THRESHOLD}).`,
  };

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Slack webhook error ${res.status}: ${await res.text()}`);
}

// ── Core check ─────────────────────────────────────────────────────
async function runStockCheck() {
  if (isRunning) {
    console.log('[alerts] Check already in progress — skipping');
    return { skipped: true };
  }

  isRunning = true;
  const started = new Date();

  try {
    console.log('[alerts] Starting stock check…');
    const variants = await fetchAllVariants();
    let alertsSent = 0, alertsSkipped = 0, alertsResolved = 0;

    for (const v of variants) {
      if (v.inventory === THRESHOLD) {
        // Only alert if no unresolved alert already exists for this variant
        const { rows } = await pool.query(
          'SELECT id FROM stock_alerts WHERE variant_id = $1 AND resolved = false',
          [v.variantId]
        );

        if (rows.length === 0) {
          try {
            await sendSlackAlert(v);
            await pool.query(
              `INSERT INTO stock_alerts
                (variant_id, product_title, variant_title, sku, stock_at_alert, alerted_at)
               VALUES ($1, $2, $3, $4, $5, NOW())`,
              [v.variantId, v.productTitle, v.variantTitle, v.sku, v.inventory]
            );
            alertsSent++;
            console.log(`[alerts] Alert sent: ${v.productTitle} – ${v.variantTitle}`);
          } catch (err) {
            console.error(`[alerts] Failed for variant ${v.variantId}:`, err.message);
          }
        } else {
          alertsSkipped++;
        }

      } else if (v.inventory > THRESHOLD) {
        // Stock recovered — resolve the alert so it can fire again if it drops back
        const { rowCount } = await pool.query(
          `UPDATE stock_alerts
           SET resolved = true, resolved_at = NOW()
           WHERE variant_id = $1 AND resolved = false`,
          [v.variantId]
        );
        if (rowCount > 0) alertsResolved++;
      }
    }

    lastRunResult = {
      variantsChecked: variants.length,
      alertsSent,
      alertsSkipped,
      alertsResolved,
    };
    lastRun = started;

    console.log(`[alerts] Done — sent: ${alertsSent}, skipped: ${alertsSkipped}, resolved: ${alertsResolved}`);
    return lastRunResult;

  } finally {
    isRunning = false;
  }
}

// ── Status ─────────────────────────────────────────────────────────
function getStatus() {
  return { isRunning, lastRun, lastRunResult, schedule: CRON_SCHEDULE };
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron() {
  if (!process.env.SHOPIFY_SHOP || !process.env.SHOPIFY_ACCESS_TOKEN) {
    console.warn('[alerts] Shopify credentials missing — stock alert cron disabled');
    return;
  }

  cron.schedule(CRON_SCHEDULE, () => {
    runStockCheck().catch((err) => console.error('[alerts] Cron error:', err.message));
  });

  console.log(`[alerts] Stock alert cron scheduled: ${CRON_SCHEDULE}`);
}

module.exports = { startCron, runStockCheck, getStatus };
