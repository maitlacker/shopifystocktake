'use strict';

// ── Operations Sync ────────────────────────────────────────────────
// Runs every 5 minutes. Fetches unfulfilled Shopify orders since the
// last AusPost manifest (= last fulfillment timestamp) and counts:
//   ordersToShip — unfulfilled orders in the current window
//   ordersPacked — those with "Picked" in their order note
// Results are cached in app_settings (key: ops_status).
// ordersPicked is derived live from picking_sessions + picked_orders.

const fetch = require('node-fetch');
const cron  = require('node-cron');

let pool;
let isRunning = false;

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

function baseUrl() {
  return `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}`;
}

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
}

// ── Cutoff time — start of today in AEST (UTC+10) ─────────────────
// We count unfulfilled orders created since AEST midnight today.
// This naturally excludes old backorders while capturing everything
// that arrived today and still needs to be picked / packed / shipped.
function getCutoffTime() {
  const AEST_OFFSET_MS = 10 * 60 * 60 * 1000; // UTC+10 (AEST)
  const now = new Date();
  // Shift to AEST, floor to midnight UTC, shift back
  const aestNow = new Date(now.getTime() + AEST_OFFSET_MS);
  aestNow.setUTCHours(0, 0, 0, 0);
  return new Date(aestNow.getTime() - AEST_OFFSET_MS).toISOString();
}

// ── Count unfulfilled orders in window ─────────────────────────────
async function getUnfulfilledCounts(cutoff) {
  let ordersToShip = 0;
  let ordersPacked = 0;

  let nextUrl = `${baseUrl()}/orders.json` +
    `?status=open&fulfillment_status=unfulfilled` +
    `&created_at_min=${encodeURIComponent(cutoff)}` +
    `&limit=250&fields=id,name,note`;

  while (nextUrl) {
    const r = await fetch(nextUrl, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Shopify orders (open): ${r.status}`);
    const data = await r.json();

    const orders = data.orders || [];
    ordersToShip += orders.length;
    ordersPacked += orders.filter((o) =>
      o.note && /\bpicked\b/i.test(o.note)
    ).length;

    // Link-header pagination
    const link  = r.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return { ordersToShip, ordersPacked };
}

// ── Main sync ──────────────────────────────────────────────────────
async function runSync() {
  if (isRunning) return;
  isRunning = true;

  try {
    const cutoffTime = getCutoffTime();
    const { ordersToShip, ordersPacked } = await getUnfulfilledCounts(cutoffTime);

    const result = {
      ordersToShip,
      ordersPacked,
      cutoffTime,
      lastSynced: new Date().toISOString(),
    };

    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('ops_status', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [JSON.stringify(result)]);

    console.log(`[ops-sync] ordersToShip=${ordersToShip} ordersPacked=${ordersPacked} cutoff=${cutoffTime}`);
  } catch (err) {
    console.error('[ops-sync] error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(dbPool) {
  pool = dbPool;
  runSync(); // run immediately on startup
  cron.schedule('*/5 * * * *', runSync);
  console.log('[ops-sync] cron started — every 5 minutes');
}

module.exports = { startCron, runSync };
