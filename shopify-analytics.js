const fetch    = require('node-fetch');
const cron     = require('node-cron');
const { pool } = require('./db');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const DAILY_CRON  = '0 3 * * *'; // 3am — after midnight order data is settled

let isRunning     = false;
let lastRun       = null;
let lastRunResult = null;

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  };
}

function shopifyBase() {
  return `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}`;
}

// ── Orders (revenue, order count, items sold) ──────────────────────
async function fetchOrdersInRange(startDate, endDate) {
  const orders = [];
  let url = `${shopifyBase()}/orders.json?status=any` +
    `&created_at_min=${startDate}T00:00:00` +
    `&created_at_max=${endDate}T23:59:59` +
    `&limit=250&fields=id,created_at,cancelled_at,total_price,line_items`;

  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Shopify Orders API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    orders.push(...data.orders);

    const link = res.headers.get('link');
    url = null;
    if (link) {
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      if (m) url = m[1];
    }
  }
  return orders;
}

// ── Sessions (requires read_analytics scope) ───────────────────────
async function fetchSessionsInRange(startDate, endDate) {
  const shopifyqlQuery = `FROM sessions SHOW sessions SINCE ${startDate} UNTIL ${endDate} GROUP BY day ORDER BY day`;

  const graphql = `{
    shopifyqlQuery(query: "${shopifyqlQuery}") {
      __typename
      ... on TableResponse {
        tableData {
          rowData
          columns { name dataType }
        }
      }
      parseErrors { code message }
    }
  }`;

  const res = await fetch(`${shopifyBase()}/graphql.json`, {
    method:  'POST',
    headers: shopifyHeaders(),
    body:    JSON.stringify({ query: graphql }),
  });

  if (!res.ok) throw new Error(`Shopify GraphQL error ${res.status}`);
  const data = await res.json();

  if (data.errors) throw new Error(`GraphQL error: ${data.errors[0]?.message}`);

  const result = data.data?.shopifyqlQuery;
  if (result?.parseErrors?.length) throw new Error(`ShopifyQL: ${result.parseErrors[0].message}`);
  if (result?.__typename !== 'TableResponse') throw new Error('Unexpected ShopifyQL response');

  const columns = result.tableData.columns;
  const dateIdx = columns.findIndex(c => c.name === 'day');
  const sessIdx = columns.findIndex(c => c.name === 'sessions');

  const sessions = {};
  for (const row of result.tableData.rowData) {
    if (row[dateIdx]) sessions[row[dateIdx]] = parseInt(row[sessIdx]) || 0;
  }
  return sessions;
}

// ── Core sync ──────────────────────────────────────────────────────
async function syncDateRange(startDate, endDate) {
  // Aggregate orders by day
  const orders   = await fetchOrdersInRange(startDate, endDate);
  const byDay    = {};

  for (const order of orders) {
    if (order.cancelled_at) continue;
    const date = order.created_at.split('T')[0];
    if (!byDay[date]) byDay[date] = { revenue: 0, orders: 0, items: 0 };
    byDay[date].revenue += parseFloat(order.total_price || 0);
    byDay[date].orders  += 1;
    byDay[date].items   += (order.line_items || []).reduce((s, l) => s + (l.quantity || 0), 0);
  }

  // Try sessions — fail gracefully if scope missing
  let sessions     = {};
  let sessionsNote = null;
  try {
    sessions = await fetchSessionsInRange(startDate, endDate);
  } catch (err) {
    sessionsNote = err.message;
    console.warn(`[shopify-analytics] Sessions unavailable: ${err.message}`);
  }

  // Upsert every date in range (zero rows for days with no orders)
  let upserted = 0;
  const cursor = new Date(startDate + 'T00:00:00Z');
  const stop   = new Date(endDate   + 'T00:00:00Z');

  while (cursor <= stop) {
    const d   = cursor.toISOString().split('T')[0];
    const day = byDay[d] || { revenue: 0, orders: 0, items: 0 };

    await pool.query(
      `INSERT INTO shopify_daily (date, revenue, orders, items_sold, sessions)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (date) DO UPDATE SET
         revenue   = EXCLUDED.revenue,
         orders    = EXCLUDED.orders,
         items_sold = EXCLUDED.items_sold,
         sessions  = EXCLUDED.sessions,
         synced_at = NOW()`,
      [d, day.revenue.toFixed(2), day.orders, day.items, sessions[d] ?? null]
    );
    upserted++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    ordersProcessed:   orders.filter(o => !o.cancelled_at).length,
    daysUpserted:      upserted,
    sessionsAvailable: Object.keys(sessions).length > 0,
    sessionsNote,
  };
}

async function runSync(days = 90) {
  if (isRunning) return { skipped: true };
  isRunning = true;
  const started = new Date();

  try {
    console.log(`[shopify-analytics] Syncing last ${days} days…`);
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);

    const result  = await syncDateRange(
      start.toISOString().split('T')[0],
      end.toISOString().split('T')[0]
    );
    lastRunResult = { ...result, days };
    lastRun       = started;
    console.log(`[shopify-analytics] Done — ${result.daysUpserted} days upserted`);
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

function getStatus() {
  return { isRunning, lastRun, lastRunResult };
}

function startCron() {
  cron.schedule(DAILY_CRON, () => {
    runSync(2).catch(err => console.error('[shopify-analytics] Cron error:', err.message));
  });
  console.log(`[shopify-analytics] Daily sync cron scheduled: ${DAILY_CRON}`);
}

module.exports = { runSync, getStatus, startCron };
