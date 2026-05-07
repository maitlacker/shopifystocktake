'use strict';

// ── Operations Sync ────────────────────────────────────────────────
// Runs every 5 minutes. Fetches unfulfilled Shopify orders since the
// last AusPost manifest (= last fulfillment timestamp) and counts:
//   ordersToShip — unfulfilled orders in the current window
//   ordersPacked — those with "Picked" in their order note
// Results are cached in app_settings (key: ops_status).
// ordersPicked is queried live from the picked_orders table.

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

// ── Find cutoff time (last AusPost manifest) ───────────────────────
// Returns the created_at of the most recent fulfillment across the
// last 10 closed orders, or start-of-today as a fallback.
async function getCutoffTime() {
  const url = `${baseUrl()}/orders.json?status=closed&limit=10&order=updated_at+DESC&fields=id,fulfillments`;
  const r   = await fetch(url, { headers: shopifyHeaders() });
  if (!r.ok) throw new Error(`Shopify orders (closed): ${r.status}`);
  const data = await r.json();

  let cutoff = null;
  for (const order of (data.orders || [])) {
    for (const f of (order.fulfillments || [])) {
      if (!cutoff || new Date(f.created_at) > new Date(cutoff)) {
        cutoff = f.created_at;
      }
    }
  }

  if (!cutoff) {
    // Fallback: midnight today AEST (UTC+10)
    const d = new Date();
    d.setUTCHours(d.getUTCHours() - 10);          // shift to AEST
    d.setHours(0, 0, 0, 0);
    d.setUTCHours(d.getUTCHours() + 10);           // back to UTC
    cutoff = d.toISOString();
  }

  return cutoff;
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
    const cutoffTime = await getCutoffTime();
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
