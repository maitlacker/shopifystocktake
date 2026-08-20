'use strict';

// ── Shopify Orders Warehouse ───────────────────────────────────────
// Mirrors order headers + line items into Postgres so reports (style
// forecast, restock, influencer sales) can query locally instead of
// re-scanning the Shopify API at 2 req/s every time.
//
// - Backfill: walks backwards in 30-day chunks from the oldest synced
//   order until ORDERS_BACKFILL_FROM (default 2024-01-01). Runs on
//   startup and resumes automatically after restarts.
// - Incremental: every 15 minutes, pulls orders updated since the last
//   cursor (new orders, cancellations, edits) and upserts them.

const fetch = require('node-fetch');
const cron  = require('node-cron');

let pool;
let running   = false;
let lastError = null;
let lastRunAt = null;
let progress  = null;

const SHOP        = process.env.SHOPIFY_SHOP;
const TOKEN       = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-01';
const TARGET      = process.env.ORDERS_BACKFILL_FROM || '2024-01-01';
const DAY         = 86400000;

async function getState() {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key='orders_sync_state'`);
  return rows.length ? JSON.parse(rows[0].value) : { oldest_synced: null, newest_cursor: null };
}

async function saveState(state) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('orders_sync_state', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(state)]
  );
}

async function fetchPage(url) {
  while (true) {
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': TOKEN } });
    if (r.status === 429) {
      await new Promise(w => setTimeout(w, parseFloat(r.headers.get('retry-after') || '2') * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`Shopify orders API ${r.status}`);
    const data = await r.json();
    const link = r.headers.get('link');
    const m = link && link.match(/<([^>]+)>;\s*rel="next"/);
    return { orders: data.orders || [], next: m ? m[1] : null };
  }
}

const ORDER_FIELDS = 'id,name,created_at,updated_at,cancelled_at,total_price,discount_codes,line_items';

async function upsertOrders(orders) {
  if (!orders.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of orders) {
      await client.query(
        `INSERT INTO shopify_orders (id, order_number, created_at, cancelled_at, total_price, discount_codes, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())
         ON CONFLICT (id) DO UPDATE SET
           cancelled_at = EXCLUDED.cancelled_at,
           total_price  = EXCLUDED.total_price,
           discount_codes = EXCLUDED.discount_codes,
           synced_at = NOW()`,
        [o.id, o.name || null, o.created_at, o.cancelled_at || null,
         parseFloat(o.total_price || 0),
         JSON.stringify((o.discount_codes || []).map(d => d.code))]
      );
      for (const li of (o.line_items || [])) {
        await client.query(
          `INSERT INTO shopify_order_lines
             (id, order_id, created_at, cancelled, product_id, variant_id, variant_title, title, sku, quantity, price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (id) DO UPDATE SET
             cancelled = EXCLUDED.cancelled,
             quantity  = EXCLUDED.quantity,
             price     = EXCLUDED.price`,
          [li.id, o.id, o.created_at, !!o.cancelled_at,
           li.product_id || null, li.variant_id || null,
           li.variant_title || null, li.title || null, li.sku || null,
           li.quantity || 0, parseFloat(li.price || 0)]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// New orders + updates (cancellations, edits) since the cursor
async function incrementalSync(state) {
  const since = state.newest_cursor
    ? new Date(new Date(state.newest_cursor).getTime() - 5 * 60 * 1000) // 5-min overlap
    : new Date(Date.now() - 60 * 60 * 1000);
  let url = `https://${SHOP}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&updated_at_min=${since.toISOString()}&limit=250&fields=${ORDER_FIELDS}`;
  let maxUpdated = state.newest_cursor ? new Date(state.newest_cursor) : since;
  let count = 0;
  while (url) {
    const { orders, next } = await fetchPage(url);
    await upsertOrders(orders);
    count += orders.length;
    for (const o of orders) {
      const u = new Date(o.updated_at || o.created_at);
      if (u > maxUpdated) maxUpdated = u;
    }
    url = next;
  }
  state.newest_cursor = maxUpdated.toISOString();
  if (!state.oldest_synced) state.oldest_synced = new Date().toISOString();
  await saveState(state);
  if (count) console.log(`[orders-sync] Incremental: ${count} orders upserted`);
  return count;
}

// One 30-day chunk backwards; returns true when the backfill target is reached
async function backfillChunk(state) {
  const target = new Date(TARGET);
  const chunkEnd = new Date(state.oldest_synced);
  if (chunkEnd <= target) return true;
  const chunkStart = new Date(Math.max(target.getTime(), chunkEnd.getTime() - 30 * DAY));
  progress = `Backfilling ${chunkStart.toISOString().slice(0, 10)} → ${chunkEnd.toISOString().slice(0, 10)}…`;
  let url = `https://${SHOP}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${chunkStart.toISOString()}&created_at_max=${chunkEnd.toISOString()}` +
    `&limit=250&fields=${ORDER_FIELDS}`;
  let count = 0;
  while (url) {
    const { orders, next } = await fetchPage(url);
    await upsertOrders(orders);
    count += orders.length;
    url = next;
  }
  state.oldest_synced = chunkStart.toISOString();
  await saveState(state);
  console.log(`[orders-sync] Backfill chunk done: ${count} orders (now back to ${state.oldest_synced.slice(0, 10)})`);
  return chunkStart <= target;
}

async function runSync({ fullBackfill } = {}) {
  if (running) return;
  running = true;
  progress = 'Incremental sync…';
  try {
    const state = await getState();
    await incrementalSync(state);
    // Chew through the backfill — all remaining chunks when fullBackfill,
    // otherwise one chunk per run so the cron makes steady progress
    let done = new Date(state.oldest_synced) <= new Date(TARGET);
    let chunks = 0;
    while (!done && (fullBackfill || chunks < 1)) {
      done = await backfillChunk(state);
      chunks++;
    }
    lastError = null;
    progress = done ? null : 'Backfill in progress';
  } catch (err) {
    console.error('[orders-sync] Error:', err.message);
    lastError = err.message;
  } finally {
    running = false;
    lastRunAt = new Date().toISOString();
  }
}

async function getCoverage() {
  const state = await getState();
  return {
    oldest_synced: state.oldest_synced,
    newest_cursor: state.newest_cursor,
    backfill_target: TARGET,
    backfill_complete: !!state.oldest_synced && new Date(state.oldest_synced) <= new Date(TARGET),
  };
}

async function getStatus() {
  const coverage = await getCoverage();
  let counts = null;
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM shopify_orders) AS orders,
              (SELECT COUNT(*) FROM shopify_order_lines) AS lines`
    );
    counts = rows[0];
  } catch (_) {}
  return { running, progress, lastError, lastRunAt, coverage, counts };
}

function startCron(dbPool) {
  pool = dbPool;
  cron.schedule('*/15 * * * *', () => runSync({ fullBackfill: false }));
  // Kick a full backfill shortly after boot — resumes wherever it left off
  setTimeout(() => runSync({ fullBackfill: true }), 60 * 1000);
  console.log(`[orders-sync] cron started — incremental every 15 min, backfill target ${TARGET}`);
}

module.exports = { startCron, runSync, getCoverage, getStatus };
