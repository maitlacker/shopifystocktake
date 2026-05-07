'use strict';

// ── Operations Sync ────────────────────────────────────────────────
// Runs every 5 minutes. Scans Shopify orders newest-to-oldest looking
// for the last AusPost manifest — detected as the first run of
// BATCH_THRESHOLD+ consecutive fulfilled orders. Everything unfulfilled
// above that batch = "Orders to Ship". Old backorders sit below the
// batch and are never counted.
//
// Falls back to AEST midnight if no clear batch is found yet (e.g.
// early morning before the day's manifest has run).

const fetch = require('node-fetch');
const cron  = require('node-cron');

let pool;
let isRunning = false;

const SHOPIFY_SHOP    = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION     = '2024-01';
const BATCH_THRESHOLD = 5;   // consecutive fulfilled orders = manifest batch
const MAX_PAGES       = 10;  // safety cap — covers 2 500 orders

function baseUrl() {
  return `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}`;
}
function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
}

// Start of today in AEST (UTC+10) — used as fallback cutoff
function getAestMidnight() {
  const AEST_MS = 10 * 60 * 60 * 1000;
  const aestNow = new Date(Date.now() + AEST_MS);
  aestNow.setUTCHours(0, 0, 0, 0);
  return new Date(aestNow.getTime() - AEST_MS).toISOString();
}

// ── Batch detection & count ────────────────────────────────────────
// Fetches orders by order_number DESC. Tracks consecutive fulfilled
// runs. When a run reaches BATCH_THRESHOLD, the batch is found.
// Returns counts of unfulfilled orders with order_number > batchStart.
async function getOpsCounts() {
  const allOrders = [];
  let consecutiveFulfilled = 0;
  let batchStartNumber     = null; // highest order_number in current run
  let batchFound           = false;

  let nextUrl = `${baseUrl()}/orders.json` +
    `?status=any&limit=250&order=order_number+DESC` +
    `&fields=id,order_number,fulfillment_status,note,created_at`;

  let pages = 0;
  while (nextUrl && !batchFound && pages < MAX_PAGES) {
    pages++;
    const r = await fetch(nextUrl, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Shopify orders (scan): ${r.status}`);
    const data = await r.json();
    const orders = data.orders || [];

    for (const order of orders) {
      allOrders.push(order);
      const fulfilled = order.fulfillment_status === 'fulfilled';

      if (fulfilled) {
        if (consecutiveFulfilled === 0) {
          batchStartNumber = order.order_number; // highest (newest) in this run
        }
        consecutiveFulfilled++;
        if (consecutiveFulfilled >= BATCH_THRESHOLD) {
          batchFound = true;
          break;
        }
      } else {
        // Unfulfilled order breaks the consecutive run
        consecutiveFulfilled = 0;
        batchStartNumber     = null;
      }
    }

    if (!batchFound) {
      const link  = r.headers.get('link') || '';
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      nextUrl = match ? match[1] : null;
    }
  }

  if (batchFound && batchStartNumber != null) {
    // Unfulfilled orders above the manifest batch = to ship
    const toShip = allOrders.filter(
      o => o.order_number > batchStartNumber && o.fulfillment_status !== 'fulfilled'
    );
    const packed = toShip.filter(o => o.note && /\bpicked\b/i.test(o.note));

    // Use the created_at of the batch-start order as a time-based cutoff
    // (used by picking_sessions query in /api/ops/status)
    const batchOrder = allOrders.find(o => o.order_number === batchStartNumber);
    const cutoffTime = batchOrder ? batchOrder.created_at : getAestMidnight();

    console.log(
      `[ops-sync] batch at #${batchStartNumber} (run ${consecutiveFulfilled}+)` +
      ` — toShip=${toShip.length} packed=${packed.length}`
    );

    return {
      ordersToShip:      toShip.length,
      ordersPacked:      packed.length,
      cutoffTime,
      cutoffOrderNumber: batchStartNumber,
      method:            'batch',
    };
  }

  // ── Fallback: no clear batch found ───────────────────────────────
  // Counts unfulfilled orders from today's fetched data that arrived
  // after AEST midnight. Handles early-morning runs before first manifest.
  const cutoffTime = getAestMidnight();
  const toShip = allOrders.filter(
    o => new Date(o.created_at) >= new Date(cutoffTime) &&
         o.fulfillment_status !== 'fulfilled'
  );
  const packed = toShip.filter(o => o.note && /\bpicked\b/i.test(o.note));

  console.log(`[ops-sync] no batch found — AEST midnight fallback, toShip=${toShip.length}`);

  return {
    ordersToShip:      toShip.length,
    ordersPacked:      packed.length,
    cutoffTime,
    cutoffOrderNumber: null,
    method:            'midnight',
  };
}

// ── Main sync ──────────────────────────────────────────────────────
async function runSync() {
  if (isRunning) return;
  isRunning = true;
  try {
    const counts = await getOpsCounts();
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('ops_status', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [JSON.stringify({
      ordersToShip:      counts.ordersToShip,
      ordersPacked:      counts.ordersPacked,
      cutoffTime:        counts.cutoffTime,
      cutoffOrderNumber: counts.cutoffOrderNumber,
      method:            counts.method,
      lastSynced:        new Date().toISOString(),
    })]);
  } catch (err) {
    console.error('[ops-sync] error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(dbPool) {
  pool = dbPool;
  runSync();
  cron.schedule('*/5 * * * *', runSync);
  console.log('[ops-sync] cron started — every 5 minutes');
}

module.exports = { startCron, runSync };
