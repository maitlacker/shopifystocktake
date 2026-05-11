'use strict';

// ── Restock Planner Sync ────────────────────────────────────────────
// Runs daily at 9am AEST. Fetches Shopify orders for the analysis
// window, splits them into two equal halves to compute velocity trend,
// assigns a selling rating (AA+/A/B/C/F), calculates per-size runway
// accounting for pending purchase orders, and fires Slack alerts.
//
// Two alert tiers per product — one of each, never repeated until the
// corresponding restock order is marked 'received':
//   Sea: fires once when effective runway ≤ sea lead days  (F suppressed)
//   Air: fires once when effective runway ≤ air lead days  (F suppressed)

const fetch = require('node-fetch');
const cron  = require('node-cron');

let pool;
let isRunning = false;

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
}

// ── Shopify fetchers ───────────────────────────────────────────────
async function fetchAllProducts() {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json` +
    `?limit=250&status=active&fields=id,title,variants,images`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Shopify products: ${r.status}`);
    const data = await r.json();
    products.push(...(data.products || []));
    const link = r.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return products;
}

async function fetchOrdersSince(sinceDate) {
  const orders = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json` +
    `?status=any&created_at_min=${sinceDate.toISOString()}` +
    `&limit=250&fields=id,cancelled_at,created_at,line_items`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Shopify orders: ${r.status}`);
    const data = await r.json();
    orders.push(...(data.orders || []));
    const link = r.headers.get('link') || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return orders;
}

// ── Selling rating ─────────────────────────────────────────────────
// Based on velocity trend (recent half vs older half) + absolute volume.
// Returns 'AA+', 'A', 'B', 'C', 'F', or null (insufficient data).
function calculateRating(avgDailyVel, recentDailyVel, olderDailyVel, totalSold) {
  if (totalSold < 5) return null;  // too little history

  // trend ratio: how recent velocity compares to earlier
  const trendRatio = olderDailyVel > 0
    ? recentDailyVel / olderDailyVel
    : (recentDailyVel > 0 ? 2.0 : 0);

  if (recentDailyVel < 0.05 || trendRatio < 0.25) return 'F';   // sales stopped
  if (trendRatio < 0.55)                           return 'C';   // significant decline
  if (trendRatio < 0.80 || avgDailyVel < 0.30)    return 'B';   // slight decline / low vol
  if (trendRatio < 1.20)                           return 'A';   // stable
  return 'AA+';                                                   // accelerating
}

function trendArrow(trendRatio) {
  if (trendRatio === null || trendRatio === undefined) return '—';
  if (trendRatio >= 1.40) return '↑↑';
  if (trendRatio >= 1.10) return '↑';
  if (trendRatio >= 0.90) return '→';
  if (trendRatio >= 0.60) return '↓';
  return '↓↓';
}

// ── Slack ──────────────────────────────────────────────────────────
async function sendSlack(text) {
  const raw = process.env.SLACK_WEBHOOK_URL || '';
  const webhookUrl = raw.trim().replace(/^["']|["']$/g, '');
  if (!webhookUrl || !webhookUrl.startsWith('https://')) return;
  const r = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Slack: ${r.status}`);
}

function formatSlackAlert(product, alertType, coverWeeks) {
  const isAir    = alertType === 'air';
  const icon     = isAir ? '✈️' : '🚢';
  const modeStr  = isAir ? 'AIR FREIGHT' : 'SEA FREIGHT';
  const leadDays = isAir ? product.effectiveAirLeadDays : product.effectiveSeaLeadDays;
  const ratingEmoji = { 'AA+': '🚀', A: '✅', B: '📊', C: '⚠️', F: '⛔' };
  const re = ratingEmoji[product.rating] || '';

  const sugKey = isAir ? 'suggestedAirQty' : 'suggestedSeaQty';
  const variantLines = product.variants
    .filter(v => v.recentDailyVel > 0 || (v[sugKey] || 0) > 0)
    .map(v => {
      const qty  = v[sugKey] || 0;
      const days = v.effectiveDaysRemaining !== null ? `${v.effectiveDaysRemaining}d` : '∞';
      return `  ${v.title}: *${qty > 0 ? '+' + qty : 'covered'}*  (${days} runway)`;
    });

  const totalSuggested = product.variants.reduce((s, v) => s + (v[sugKey] || 0), 0);

  const incomingLines = product.incomingOrders.length
    ? product.incomingOrders.map(o =>
        `📦 Incoming ${o.freightMode.toUpperCase()}: ${o.totalQty} units · due ${o.expectedDelivery}`
      ).join('\n')
    : '📦 No pending orders for this style';

  return [
    `${icon} *${modeStr} ALERT*  —  ${product.title}`,
    `Rating: ${re} *${product.rating}*  ·  ${product.avgDailyVel.toFixed(2)} units/day  ${trendArrow(product.trendRatio)}`,
    '',
    `⏱ Shortest runway: *${product.minDaysRemaining} days* (${product.criticalVariant})`,
    `${icon} ${modeStr} lead time: ${leadDays} days  ←  _order now to avoid stockout_`,
    '',
    `Suggested reorder (${coverWeeks}-week post-delivery cover):`,
    ...variantLines,
    `  *Total: ${totalSuggested} units*`,
    '',
    incomingLines,
  ].join('\n');
}

// ── Core analysis ──────────────────────────────────────────────────
async function runAnalysis() {
  if (isRunning) {
    console.log('[restock] Analysis already running — skipping');
    return;
  }
  isRunning = true;

  try {
    console.log('[restock] Analysis started…');

    // 1. Settings
    const { rows: sRows } = await pool.query('SELECT * FROM restock_settings WHERE id = 1');
    const settings = sRows[0] || { sea_lead_days: 60, air_lead_days: 14, cover_weeks: 8, velocity_days: 42 };
    const { sea_lead_days, air_lead_days, cover_weeks, velocity_days } = settings;
    const halfDays = Math.floor(velocity_days / 2);

    // 2. Per-product configs
    const { rows: cfgRows } = await pool.query('SELECT * FROM product_restock_config');
    const configMap = {};
    for (const c of cfgRows) configMap[String(c.product_id)] = c;

    // 3. Pending purchase orders
    const { rows: orderRows } = await pool.query(
      `SELECT * FROM restock_orders WHERE status = 'pending' ORDER BY expected_delivery ASC`
    );
    const ordersByProduct = {};
    for (const o of orderRows) {
      const key = String(o.product_id);
      if (!ordersByProduct[key]) ordersByProduct[key] = [];
      ordersByProduct[key].push(o);
    }

    // 4. Alert log (already-sent alerts)
    const { rows: alertRows } = await pool.query(
      'SELECT product_id, alert_type FROM restock_alerts_log'
    );
    const alertSentSet = new Set(alertRows.map(r => `${r.product_id}:${r.alert_type}`));

    // 5. Shopify data
    const products = await fetchAllProducts();
    const since = new Date();
    since.setDate(since.getDate() - velocity_days);
    const orders = await fetchOrdersSince(since);

    // 6. Build per-variant sales maps — split at the half-period boundary
    const recentCutoff = new Date();
    recentCutoff.setDate(recentCutoff.getDate() - halfDays);

    const salesRecent = {};
    const salesOlder  = {};
    for (const order of orders) {
      if (order.cancelled_at) continue;
      const isRecent = new Date(order.created_at) >= recentCutoff;
      for (const item of (order.line_items || [])) {
        if (!item.variant_id) continue;
        const k = String(item.variant_id);
        if (isRecent) salesRecent[k] = (salesRecent[k] || 0) + item.quantity;
        else          salesOlder[k]  = (salesOlder[k]  || 0) + item.quantity;
      }
    }

    // 7. Analyse each product
    const analysedProducts = [];
    let seaAlertCount = 0;
    let airAlertCount = 0;

    for (const product of products) {
      const cfg = configMap[String(product.id)] || {};
      const restockEnabled       = cfg.restock_enabled !== false;
      const effectiveSeaLeadDays = cfg.sea_lead_days || sea_lead_days;
      const effectiveAirLeadDays = cfg.air_lead_days || air_lead_days;
      const effectiveCoverWeeks  = cfg.cover_weeks   || cover_weeks;

      const incoming = ordersByProduct[String(product.id)] || [];
      const incomingOrders = incoming.map(o => ({
        orderId:          o.id,
        freightMode:      o.freight_mode,
        expectedDelivery: o.expected_delivery instanceof Date
          ? o.expected_delivery.toISOString().slice(0, 10)
          : String(o.expected_delivery).slice(0, 10),
        totalQty:         o.total_qty,
        qtyByVariant:     o.qty_by_variant || {},
      }));

      // Per-variant analysis
      const variants = (product.variants || []).map(v => {
        const k          = String(v.id);
        const soldRecent = salesRecent[k] || 0;
        const soldOlder  = salesOlder[k]  || 0;
        const recentVel  = soldRecent / halfDays;
        const olderVel   = soldOlder  / halfDays;
        const avgVel     = (soldRecent + soldOlder) / velocity_days;

        // Sum incoming qty for this variant (matched by title, case-insensitive)
        const varTitle = (v.title === 'Default Title' ? '' : v.title) || '';
        const incomingQty = incoming.reduce((sum, o) => {
          const byV = o.qty_by_variant || {};
          // Try exact match, then case-insensitive
          const qty = byV[varTitle]
            ?? byV[String(v.id)]
            ?? Object.entries(byV).find(([k2]) => k2.toLowerCase() === varTitle.toLowerCase())?.[1]
            ?? 0;
          return sum + qty;
        }, 0);

        const currentStock           = Math.max(0, v.inventory_quantity || 0);
        const effectiveStock         = currentStock + incomingQty;
        const daysRemaining          = recentVel > 0 ? Math.round(currentStock   / recentVel) : null;
        const effectiveDaysRemaining = recentVel > 0 ? Math.round(effectiveStock / recentVel) : null;

        // Suggested order = units needed to reach cover target after delivery
        const coverTarget    = recentVel * effectiveCoverWeeks * 7;
        const projAtSea      = Math.max(0, effectiveStock - recentVel * effectiveSeaLeadDays);
        const projAtAir      = Math.max(0, effectiveStock - recentVel * effectiveAirLeadDays);
        const suggestedSeaQty = Math.max(0, Math.ceil(coverTarget - projAtSea));
        const suggestedAirQty = Math.max(0, Math.ceil(coverTarget - projAtAir));

        return {
          id:                    v.id,
          title:                 varTitle || 'Default',
          inventory:             currentStock,
          incomingQty,
          effectiveStock,
          soldRecent,
          soldOlder,
          recentDailyVel:        Math.round(recentVel * 1000) / 1000,
          olderDailyVel:         Math.round(olderVel  * 1000) / 1000,
          avgDailyVel:           Math.round(avgVel    * 1000) / 1000,
          daysRemaining,
          effectiveDaysRemaining,
          suggestedSeaQty,
          suggestedAirQty,
        };
      });

      // Style-level aggregates
      const totalSoldRecent = variants.reduce((s, v) => s + v.soldRecent, 0);
      const totalSoldOlder  = variants.reduce((s, v) => s + v.soldOlder,  0);
      const totalSold       = totalSoldRecent + totalSoldOlder;
      const styleRecentVel  = totalSoldRecent / halfDays;
      const styleOlderVel   = totalSoldOlder  / halfDays;
      const styleAvgVel     = totalSold       / velocity_days;
      const styleTrendRatio = styleOlderVel > 0
        ? styleRecentVel / styleOlderVel
        : (styleRecentVel > 0 ? 2.0 : 0);

      const rating = calculateRating(styleAvgVel, styleRecentVel, styleOlderVel, totalSold);

      // Effective runway = min days across variants that have recent sales
      const activeVars = variants.filter(v => v.recentDailyVel > 0);
      let minDaysRemaining = null;
      let criticalVariant  = null;
      if (activeVars.length) {
        const withDays = activeVars.filter(v => v.effectiveDaysRemaining !== null);
        if (withDays.length) {
          const minV       = withDays.reduce((m, v) => v.effectiveDaysRemaining < m.effectiveDaysRemaining ? v : m);
          minDaysRemaining = minV.effectiveDaysRemaining;
          criticalVariant  = minV.title;
        }
      }

      const seaAlertSent = alertSentSet.has(`${product.id}:sea`);
      const airAlertSent = alertSentSet.has(`${product.id}:air`);

      const analysed = {
        productId:            product.id,
        title:                product.title,
        image:                product.images?.[0]?.src || null,
        rating,
        trendRatio:           Math.round(styleTrendRatio * 100) / 100,
        avgDailyVel:          Math.round(styleAvgVel    * 100) / 100,
        recentDailyVel:       Math.round(styleRecentVel * 100) / 100,
        olderDailyVel:        Math.round(styleOlderVel  * 100) / 100,
        totalSold,
        minDaysRemaining,
        criticalVariant,
        totalInventory:       variants.reduce((s, v) => s + v.inventory, 0),
        restockEnabled,
        effectiveSeaLeadDays,
        effectiveAirLeadDays,
        effectiveCoverWeeks,
        seaAlertSent,
        airAlertSent,
        incomingOrders,
        variants,
      };

      analysedProducts.push(analysed);

      // ── Fire Slack alerts ──────────────────────────────────────────
      if (!restockEnabled || rating === 'F' || rating === null) continue;
      if (minDaysRemaining === null) continue;

      // Sea alert
      if (!seaAlertSent && minDaysRemaining <= effectiveSeaLeadDays) {
        try {
          await sendSlack(formatSlackAlert(analysed, 'sea', effectiveCoverWeeks));
          await pool.query(
            `INSERT INTO restock_alerts_log
               (product_id, product_title, alert_type, rating, days_remaining)
             VALUES ($1,$2,'sea',$3,$4)
             ON CONFLICT (product_id, alert_type) DO NOTHING`,
            [product.id, product.title, rating, minDaysRemaining]
          );
          alertSentSet.add(`${product.id}:sea`);
          analysed.seaAlertSent = true;
          seaAlertCount++;
          console.log(`[restock] Sea alert → ${product.title} (${minDaysRemaining}d, ${rating})`);
        } catch (e) {
          console.error(`[restock] Sea alert error for ${product.title}:`, e.message);
        }
      }

      // Air alert
      if (!airAlertSent && minDaysRemaining <= effectiveAirLeadDays) {
        try {
          await sendSlack(formatSlackAlert(analysed, 'air', effectiveCoverWeeks));
          await pool.query(
            `INSERT INTO restock_alerts_log
               (product_id, product_title, alert_type, rating, days_remaining)
             VALUES ($1,$2,'air',$3,$4)
             ON CONFLICT (product_id, alert_type) DO NOTHING`,
            [product.id, product.title, rating, minDaysRemaining]
          );
          alertSentSet.add(`${product.id}:air`);
          analysed.airAlertSent = true;
          airAlertCount++;
          console.log(`[restock] Air alert → ${product.title} (${minDaysRemaining}d, ${rating})`);
        } catch (e) {
          console.error(`[restock] Air alert error for ${product.title}:`, e.message);
        }
      }
    }

    // Sort: most urgent first (needs alert → fewest days remaining → everything else)
    analysedProducts.sort((a, b) => {
      const aUrgent = (a.rating && a.rating !== 'F' && a.minDaysRemaining !== null
        && a.minDaysRemaining <= a.effectiveSeaLeadDays && !a.seaAlertSent) ? 1 : 0;
      const bUrgent = (b.rating && b.rating !== 'F' && b.minDaysRemaining !== null
        && b.minDaysRemaining <= b.effectiveSeaLeadDays && !b.seaAlertSent) ? 1 : 0;
      if (bUrgent !== aUrgent) return bUrgent - aUrgent;
      if (a.minDaysRemaining !== null && b.minDaysRemaining !== null)
        return a.minDaysRemaining - b.minDaysRemaining;
      if (a.minDaysRemaining !== null) return -1;
      if (b.minDaysRemaining !== null) return 1;
      return (b.avgDailyVel || 0) - (a.avgDailyVel || 0);
    });

    // Cache to app_settings
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('restock_analysis', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify({
        generatedAt:   new Date().toISOString(),
        periodDays:    velocity_days,
        totalProducts: analysedProducts.length,
        totalOrders:   orders.filter(o => !o.cancelled_at).length,
        seaAlerts:     seaAlertCount,
        airAlerts:     airAlertCount,
        products:      analysedProducts,
      })]
    );

    console.log(`[restock] Done — ${analysedProducts.length} products, ` +
      `${seaAlertCount} sea alerts, ${airAlertCount} air alerts`);

  } catch (err) {
    console.error('[restock] Analysis error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(dbPool) {
  pool = dbPool;
  // 9am AEST = 23:00 UTC previous day
  cron.schedule('0 23 * * *', runAnalysis);
  console.log('[restock] cron started — daily at 9am AEST');
}

module.exports = { startCron, runAnalysis };
