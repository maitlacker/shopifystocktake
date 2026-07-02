'use strict';

// ── Restock Planner Sync ────────────────────────────────────────────
// Runs daily at 9am AEST. Fetches Shopify orders for the analysis
// window, splits them into two equal halves to compute velocity trend,
// assigns a selling rating (AA+/A/B/C/F), calculates per-size runway
// accounting for pending purchase orders, and fires Slack alerts.
//
// Three alert tiers per product — each fires at most once per product
// until the corresponding restock order is marked 'received':
//   Sea:      runway ≤ sea lead days      (B/A/AA+ only; C/F suppressed)
//   Air:      runway ≤ air lead days      (B/A/AA+ only; C/F suppressed)
//   Critical: runway ≤ CRITICAL_DAYS      (A/AA+ only; fires even if sea/air already sent)
//
// Alert triggers require 2+ active sizes (≥0.05 units/day) to be
// heading for stockout before delivery, OR the top-selling size alone.
// Products in the Final Sale collection are always excluded.
//
// Suggested order quantities include a velocity buffer:
//   AA+: +25%  |  A: +10%  |  B: no buffer
// This accounts for accelerating demand — the cover calculation
// undershoots when sales are growing quickly.

const fetch = require('node-fetch');
const cron  = require('node-cron');

let pool;
let isRunning = false;

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';
const APP_URL       = (process.env.APP_URL || '').replace(/\/$/, '');

// Name of the Shopify collection to exclude from restock alerts (case-insensitive).
// Override via FINAL_SALE_COLLECTION_TITLE env var if your collection has a different name.
const FINAL_SALE_TITLE = (process.env.FINAL_SALE_COLLECTION_TITLE || 'final sale').toLowerCase().trim();

// Runway threshold for the CRITICAL alert tier (days).
const CRITICAL_DAYS = 14;

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN };
}

function fmtDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Shopify fetchers ───────────────────────────────────────────────
async function fetchAllProducts() {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json` +
    `?limit=250&status=active&fields=id,title,variants,images,tags,published_at`;
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
    `&limit=250&fields=id,cancelled_at,created_at,line_items,refunds`;
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

// Returns the Set of Shopify product IDs in the Final Sale collection.
// Fails gracefully — returns an empty set if the collection isn't found.
async function fetchFinalSaleProductIds() {
  try {
    // Search custom collections for one matching FINAL_SALE_TITLE
    let colUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/custom_collections.json` +
      `?fields=id,title&limit=250`;
    let colId = null;
    while (colUrl && !colId) {
      const r = await fetch(colUrl, { headers: shopifyHeaders() });
      if (!r.ok) break;
      const data = await r.json();
      const match = (data.custom_collections || []).find(c =>
        c.title.toLowerCase().trim() === FINAL_SALE_TITLE
      );
      if (match) { colId = match.id; break; }
      const link = r.headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      colUrl = m ? m[1] : null;
    }
    if (!colId) {
      console.log(`[restock] Final Sale collection "${FINAL_SALE_TITLE}" not found — no exclusions`);
      return new Set();
    }
    // Collect all product IDs in that collection
    const productIds = new Set();
    let collectUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/collects.json` +
      `?collection_id=${colId}&fields=product_id&limit=250`;
    while (collectUrl) {
      const cr = await fetch(collectUrl, { headers: shopifyHeaders() });
      if (!cr.ok) break;
      const cd = await cr.json();
      (cd.collects || []).forEach(c => productIds.add(String(c.product_id)));
      const link = cr.headers.get('link') || '';
      const m = link.match(/<([^>]+)>;\s*rel="next"/);
      collectUrl = m ? m[1] : null;
    }
    console.log(`[restock] Final Sale collection: ${productIds.size} products excluded from alerts`);
    return productIds;
  } catch (e) {
    console.error('[restock] fetchFinalSaleProductIds error:', e.message);
    return new Set();
  }
}

// ── Selling rating ─────────────────────────────────────────────────
// Based on velocity trend (recent half vs older half) + absolute volume.
// Returns 'AA+', 'A', 'B', 'C', 'F', or null (insufficient data).
//
// AA+ requires BOTH high absolute velocity (≥3.0/day) AND a confirmed
// accelerating trend (≥1.20). When there is no older-period data (new
// product), trendRatio defaults to 1.0 (neutral/unknown) — not 2.0 —
// so a new product with no comparison baseline can reach A at most.
function calculateRating(avgDailyVel, recentDailyVel, olderDailyVel, totalSold) {
  if (totalSold < 5) return null;

  const trendRatio = olderDailyVel > 0
    ? recentDailyVel / olderDailyVel
    : (recentDailyVel > 0 ? 1.0 : 0);

  if (recentDailyVel < 0.05 || trendRatio < 0.25) return 'F';
  if (trendRatio < 0.55)                           return 'C';
  if (trendRatio < 0.80 || avgDailyVel < 0.30)    return 'B';
  if (trendRatio < 1.20 || avgDailyVel < 3.0)     return 'A';
  return 'AA+';
}

function trendArrow(trendRatio) {
  if (trendRatio === null || trendRatio === undefined) return '—';
  if (trendRatio >= 1.40) return '↑↑';
  if (trendRatio >= 1.10) return '↑';
  if (trendRatio >= 0.90) return '→';
  if (trendRatio >= 0.60) return '↓';
  return '↓↓';
}

// ── Coverage failure check ─────────────────────────────────────────
// Determines whether the alert trigger condition is met for a given
// lead time: 2+ active sizes will sell out before the restock arrives,
// OR the top-selling size alone will sell out.
// "Active" = selling at ≥0.05 units/day (filters out near-dead sizes).
function coverageFailure(variants, leadDays) {
  const active = variants.filter(v => v.demandDailyVel >= 0.05);
  if (!active.length) return false;

  const failing = active.filter(v =>
    v.effectiveDaysRemaining !== null && v.effectiveDaysRemaining <= leadDays
  );
  if (failing.length >= 2) return true;

  // Even a single failing size triggers if it's the top seller
  if (failing.length === 1) {
    const top = active.reduce((m, v) => v.demandDailyVel > m.demandDailyVel ? v : m, active[0]);
    if (failing[0].id === top.id) return true;
  }
  return false;
}

// ── Slack ──────────────────────────────────────────────────────────
async function sendSlack(text) {
  // RESTOCK_SLACK_WEBHOOK_URL lets you route restock alerts to a dedicated
  // #production channel; falls back to the shared SLACK_WEBHOOK_URL.
  const raw = (process.env.RESTOCK_SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL || '')
    .trim().replace(/^["']|["']$/g, '');
  if (!raw || !raw.startsWith('https://')) return;
  const r = await fetch(raw, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Slack: ${r.status}`);
}

// ── Slack message formatters ───────────────────────────────────────
function formatSlackAlert(product, alertType, coverWeeks) {
  const isAir    = alertType === 'air';
  const icon     = isAir ? '✈️' : '🚢';
  const modeStr  = isAir ? 'AIR FREIGHT' : 'SEA FREIGHT';
  const leadDays = isAir ? product.effectiveAirLeadDays : product.effectiveSeaLeadDays;
  const leadWks  = Math.round(leadDays / 7);
  const deliveryStr = fmtDate(leadDays);

  const ratingEmoji = { 'AA+': '🚀', A: '✅', B: '📊', C: '⚠️', F: '⛔' };
  const re = ratingEmoji[product.rating] || '';

  // Velocity buffer: AA+ orders 25% more, A orders 10% more
  const buffer  = product.velocityBuffer || 1.0;
  const bufNote = buffer > 1.0 ? ` _(incl. ${Math.round((buffer - 1) * 100)}% ${product.rating} buffer)_` : '';

  const sugKey    = isAir ? 'suggestedAirQty' : 'suggestedSeaQty';
  const totalVel  = product.variants.reduce((s, v) => s + (v.demandDailyVel || 0), 0);

  const variantLines = product.variants
    .filter(v => v.demandDailyVel >= 0.05 || (v[sugKey] || 0) > 0)
    .sort((a, b) => (b.demandDailyVel || 0) - (a.demandDailyVel || 0))
    .map(v => {
      const rawQty = v[sugKey] || 0;
      const qty    = Math.ceil(rawQty * buffer);
      const days   = v.effectiveDaysRemaining !== null ? `${v.effectiveDaysRemaining}d runway` : '∞';
      const velPct = totalVel > 0 ? Math.round((v.demandDailyVel / totalVel) * 100) : 0;
      const pct    = velPct > 0 ? ` · ${velPct}% of sales` : '';
      const oosWarn = (v.effectiveDaysRemaining !== null && v.effectiveDaysRemaining <= leadDays)
        ? ' ⚠' : '';
      return `  ${v.title}: *+${qty > 0 ? qty : 'covered'}* units  (${days}${pct}${oosWarn})`;
    });

  const totalRaw       = product.variants.reduce((s, v) => s + (v[sugKey] || 0), 0);
  const totalBuffered  = Math.ceil(totalRaw * buffer);

  const incomingLines = product.incomingOrders.length
    ? product.incomingOrders.map(o =>
        `📦 Incoming ${o.freightMode.toUpperCase()}: ${o.totalQty} units · due ${o.expectedDelivery}`
      ).join('\n')
    : '📦 No pending orders — order now';

  const supplierLine = product.supplierName
    ? `🏭 Supplier: *${product.supplierName}*`
    : null;

  const plannerLink = APP_URL
    ? `📋 <${APP_URL}/restock.html|Open Restock Planner>`
    : null;

  return [
    `${icon} *${modeStr} RESTOCK ALERT*  —  ${product.title}`,
    `${re} Rating: *${product.rating}*  ·  ${product.avgDailyVel.toFixed(2)} units/day  ${trendArrow(product.trendRatio)}`,
    '',
    `⏱ Shortest runway: *${product.minDaysRemaining} days* (size ${product.criticalVariant})`,
    `${icon} ${modeStr} lead time: *~${leadWks} weeks*  →  order today, stock arrives *~${deliveryStr}*`,
    ...(supplierLine ? [supplierLine] : []),
    '',
    `*Suggested reorder* (${coverWeeks}-week cover after delivery)${bufNote}:`,
    ...variantLines,
    `  ──────────────────────────`,
    `  *Total: ${totalBuffered} units*`,
    '',
    incomingLines,
    ...(plannerLink ? ['', plannerLink] : []),
  ].join('\n');
}

function formatCriticalAlert(product, coverWeeks) {
  const ratingEmoji = { 'AA+': '🚀', A: '✅', B: '📊', C: '⚠️', F: '⛔' };
  const re = ratingEmoji[product.rating] || '';
  const buffer      = product.velocityBuffer || 1.0;
  const airDelivery = fmtDate(product.effectiveAirLeadDays);
  const seaDelivery = fmtDate(product.effectiveSeaLeadDays);
  const airWks      = Math.round(product.effectiveAirLeadDays / 7);

  const totalVel  = product.variants.reduce((s, v) => s + (v.demandDailyVel || 0), 0);
  const variantLines = product.variants
    .filter(v => v.demandDailyVel >= 0.05 || (v.suggestedAirQty || 0) > 0)
    .sort((a, b) => (b.demandDailyVel || 0) - (a.demandDailyVel || 0))
    .map(v => {
      const qty    = Math.ceil((v.suggestedAirQty || 0) * buffer);
      const days   = v.effectiveDaysRemaining !== null ? `${v.effectiveDaysRemaining}d` : '∞';
      const velPct = totalVel > 0 ? Math.round((v.demandDailyVel / totalVel) * 100) : 0;
      const pct    = velPct > 0 ? ` · ${velPct}%` : '';
      return `  ${v.title}: *+${qty > 0 ? qty : '—'}* units  (${days} runway${pct})`;
    });

  const totalRaw      = product.variants.reduce((s, v) => s + (v.suggestedAirQty || 0), 0);
  const totalBuffered = Math.ceil(totalRaw * buffer);

  const incomingLines = product.incomingOrders.length
    ? product.incomingOrders.map(o =>
        `📦 Incoming ${o.freightMode.toUpperCase()}: ${o.totalQty} units · due ${o.expectedDelivery}`
      ).join('\n')
    : '📦 *No orders placed* — immediate action required';

  const supplierLine = product.supplierName
    ? `🏭 Supplier: *${product.supplierName}*`
    : null;

  const plannerLink = APP_URL
    ? `📋 <${APP_URL}/restock.html|Open Restock Planner>`
    : null;

  return [
    `🚨 *CRITICAL STOCK ALERT*  —  ${product.title}`,
    `${re} Rating: *${product.rating}*  ·  ${product.avgDailyVel.toFixed(2)} units/day  ${trendArrow(product.trendRatio)}`,
    '',
    `⚠️ *Only ${product.minDaysRemaining} days of stock remaining* (size ${product.criticalVariant})`,
    `✈️ AIR FREIGHT only window: *~${airWks} weeks* → stock arrives *~${airDelivery}*`,
    `🚢 SEA FREIGHT would arrive *~${seaDelivery}* — too late`,
    ...(supplierLine ? [supplierLine] : []),
    '',
    `*Emergency reorder* (${coverWeeks}-week cover):`,
    ...variantLines,
    `  ──────────────────────────`,
    `  *Total: ${totalBuffered} units*`,
    '',
    incomingLines,
    ...(plannerLink ? ['', plannerLink] : []),
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
    const settings = sRows[0] || { sea_lead_days: 49, air_lead_days: 28, cover_weeks: 8, velocity_days: 42 };
    const { sea_lead_days, air_lead_days, cover_weeks, velocity_days } = settings;
    const halfDays = Math.floor(velocity_days / 2);

    // 2. Per-product configs
    const { rows: cfgRows } = await pool.query('SELECT * FROM product_restock_config');
    const configMap = {};
    for (const c of cfgRows) configMap[String(c.product_id)] = c;

    // 3. Supplier lead times (via most-recent production order per product)
    const { rows: supplierLinkRows } = await pool.query(`
      SELECT DISTINCT ON (pol.product_id)
        pol.product_id,
        s.company_name,
        s.lead_time_sea,
        s.lead_time_air
      FROM production_order_lines pol
      JOIN production_orders po ON po.id = pol.order_id
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE pol.product_id IS NOT NULL AND po.supplier_id IS NOT NULL
      ORDER BY pol.product_id, po.created_at DESC
    `);
    const supplierLeadMap = {};
    for (const r of supplierLinkRows) {
      supplierLeadMap[String(r.product_id)] = {
        name:    r.company_name,
        seaDays: r.lead_time_sea ? r.lead_time_sea * 7 : null,
        airDays: r.lead_time_air ? r.lead_time_air * 7 : null,
      };
    }

    // 4. Pending purchase orders
    const { rows: orderRows } = await pool.query(
      `SELECT * FROM restock_orders WHERE status = 'pending' ORDER BY expected_delivery ASC`
    );
    const ordersByProduct = {};
    for (const o of orderRows) {
      const key = String(o.product_id);
      if (!ordersByProduct[key]) ordersByProduct[key] = [];
      ordersByProduct[key].push(o);
    }

    // 5. Alert log (already-sent alerts per product+type)
    const { rows: alertRows } = await pool.query(
      'SELECT product_id, alert_type FROM restock_alerts_log'
    );
    const alertSentSet = new Set(alertRows.map(r => `${r.product_id}:${r.alert_type}`));

    // 6. Final Sale collection — products in here are never alerted
    const finalSaleIds = await fetchFinalSaleProductIds();

    // 7. Shopify data
    const products = await fetchAllProducts();
    const since = new Date();
    since.setDate(since.getDate() - velocity_days);
    const orders = await fetchOrdersSince(since);

    // 8. Build per-variant sales maps — split at the half-period boundary
    const recentCutoff = new Date();
    recentCutoff.setDate(recentCutoff.getDate() - halfDays);

    // Precompute millisecond timestamps used in every variant's effective-window calc
    const windowStartMs  = since.getTime();
    const recentCutoffMs = recentCutoff.getTime();
    const analysisNowMs  = Date.now();

    const salesRecent        = {};
    const salesOlder         = {};
    const lastSaleDateByVariant = {}; // variantId → ms timestamp of most-recent sale
    const returnsByVariant   = {};
    let totalRefundsSeen = 0;
    let totalReturnLinesSeen = 0;
    for (const order of orders) {
      if (order.cancelled_at) continue;
      const isRecent = new Date(order.created_at) >= recentCutoff;

      const orderDateMs  = new Date(order.created_at).getTime();
      const liVariantMap = {};
      for (const item of (order.line_items || [])) {
        if (!item.variant_id) continue;
        const k = String(item.variant_id);
        liVariantMap[String(item.id)] = k;
        if (isRecent) salesRecent[k] = (salesRecent[k] || 0) + item.quantity;
        else          salesOlder[k]  = (salesOlder[k]  || 0) + item.quantity;
        // Track most-recent sale date per variant (used to trim OOS windows)
        if (!lastSaleDateByVariant[k] || orderDateMs > lastSaleDateByVariant[k]) {
          lastSaleDateByVariant[k] = orderDateMs;
        }
      }
      for (const refund of (order.refunds || [])) {
        totalRefundsSeen++;
        for (const rli of (refund.refund_line_items || [])) {
          totalReturnLinesSeen++;
          if (rli.restock_type !== 'return') continue;
          const vid = String(
            (rli.line_item && rli.line_item.variant_id) ||
            rli.variant_id ||
            liVariantMap[String(rli.line_item_id)] ||
            ''
          );
          if (!vid || vid === 'null') continue;
          returnsByVariant[vid] = (returnsByVariant[vid] || 0) + (rli.quantity || 0);
        }
      }
    }
    const totalReturnsFound = Object.values(returnsByVariant).reduce((s, n) => s + n, 0);
    console.log(`[restock] Returns debug — refunds seen: ${totalRefundsSeen}, ` +
      `refund_line_items seen: ${totalReturnLinesSeen}, ` +
      `return-type units tallied: ${totalReturnsFound}, ` +
      `variants with returns: ${Object.keys(returnsByVariant).length}`);

    // 9. Analyse each product
    const analysedProducts = [];
    let seaAlertCount      = 0;
    let airAlertCount      = 0;
    let criticalAlertCount = 0;

    for (const product of products) {
      const cfg          = configMap[String(product.id)] || {};
      const supplierInfo = supplierLeadMap[String(product.id)];
      const restockEnabled       = cfg.restock_enabled !== false;
      // Priority: per-product override → supplier lead time → global default
      const effectiveSeaLeadDays = cfg.sea_lead_days || supplierInfo?.seaDays || sea_lead_days;
      const effectiveAirLeadDays = cfg.air_lead_days || supplierInfo?.airDays || air_lead_days;
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

        const varTitle = (v.title === 'Default Title' ? '' : v.title) || '';
        const incomingQty = incoming.reduce((sum, o) => {
          const byV = o.qty_by_variant || {};
          const qty = byV[varTitle]
            ?? byV[String(v.id)]
            ?? Object.entries(byV).find(([k2]) => k2.toLowerCase() === varTitle.toLowerCase())?.[1]
            ?? 0;
          return sum + qty;
        }, 0);

        const currentStock   = Math.max(0, v.inventory_quantity || 0);
        const effectiveStock = currentStock + incomingQty;
        const isOos          = currentStock === 0 && incomingQty === 0;

        // ── Effective selling window ──────────────────────────────────
        // Start: latest of velocity window start, product publish date, variant
        //        create date. Ensures new products aren't penalised by dividing
        //        their sales over a 42-day window when they've only been live 5 days.
        const publishedMs  = product.published_at ? new Date(product.published_at).getTime() : 0;
        const varCreatedMs = v.created_at ? new Date(v.created_at).getTime() : 0;
        const sellStartMs  = Math.max(windowStartMs, publishedMs, varCreatedMs);

        // End: if the variant is OOS, cap the window at its last sale date.
        // Days with zero stock have zero sales by definition — including them
        // in the denominator artificially deflates the measured velocity.
        const lastSaleMs = lastSaleDateByVariant[k] || null;
        const sellEndMs  = (isOos && lastSaleMs) ? lastSaleMs : analysisNowMs;

        const effectiveTotalDays  = Math.max(1, (sellEndMs - sellStartMs) / 86400000);
        const effectiveRecentDays = Math.max(0, (sellEndMs  - Math.max(recentCutoffMs, sellStartMs)) / 86400000);
        const effectiveOlderDays  = Math.max(0, (Math.min(recentCutoffMs, sellEndMs) - sellStartMs) / 86400000);

        const recentVel = effectiveRecentDays > 0 ? soldRecent / effectiveRecentDays : 0;
        const olderVel  = effectiveOlderDays  > 0 ? soldOlder  / effectiveOlderDays  : 0;
        const avgVel    = (soldRecent + soldOlder) / effectiveTotalDays;

        // For OOS variants use the full-window average — the recent period may be
        // a partial window (sold out mid-period) so recentVel alone undershoots.
        const demandVel = isOos ? avgVel : recentVel;

        const daysRemaining          = demandVel > 0 ? Math.round(currentStock   / demandVel) : null;
        const effectiveDaysRemaining = demandVel > 0 ? Math.round(effectiveStock / demandVel) : null;

        const coverTarget     = demandVel * effectiveCoverWeeks * 7;
        const projAtSea       = Math.max(0, effectiveStock - demandVel * effectiveSeaLeadDays);
        const projAtAir       = Math.max(0, effectiveStock - demandVel * effectiveAirLeadDays);
        const suggestedSeaQty = Math.max(0, Math.ceil(coverTarget - projAtSea));
        const suggestedAirQty = Math.max(0, Math.ceil(coverTarget - projAtAir));

        const returnedUnits = returnsByVariant[k] || 0;
        const totalSoldV    = soldRecent + soldOlder;
        const returnRate    = totalSoldV > 0
          ? Math.round((returnedUnits / totalSoldV) * 100)
          : 0;

        return {
          id:                    v.id,
          title:                 varTitle || 'Default',
          inventory:             currentStock,
          incomingQty,
          effectiveStock,
          soldRecent,
          soldOlder,
          returnedUnits,
          returnRate,
          isOos,
          recentDailyVel:        Math.round(recentVel  * 1000) / 1000,
          olderDailyVel:         Math.round(olderVel   * 1000) / 1000,
          demandDailyVel:        Math.round(demandVel  * 1000) / 1000,
          avgDailyVel:           Math.round(avgVel     * 1000) / 1000,
          daysRemaining,
          effectiveDaysRemaining,
          suggestedSeaQty,
          suggestedAirQty,
        };
      });

      // Style-level aggregates — use effective selling window (same logic as per-variant).
      // A product published 6 days ago divides by 6, not 42 — otherwise velocity is
      // massively understated and the rating is wrong for new styles.
      const totalSoldRecent = variants.reduce((s, v) => s + v.soldRecent, 0);
      const totalSoldOlder  = variants.reduce((s, v) => s + v.soldOlder,  0);
      const totalSold       = totalSoldRecent + totalSoldOlder;

      const stylePublishedMs    = product.published_at ? new Date(product.published_at).getTime() : 0;
      const styleStartMs        = Math.max(windowStartMs, stylePublishedMs);
      const effectiveStyleDays  = Math.max(1, (analysisNowMs - styleStartMs) / 86400000);
      const effectiveStyleRecent = Math.max(0, (analysisNowMs - Math.max(recentCutoffMs, styleStartMs)) / 86400000);
      const effectiveStyleOlder  = Math.max(0, (Math.min(recentCutoffMs, analysisNowMs) - styleStartMs) / 86400000);

      const styleRecentVel  = effectiveStyleRecent > 0 ? totalSoldRecent / effectiveStyleRecent : 0;
      const styleOlderVel   = effectiveStyleOlder  > 0 ? totalSoldOlder  / effectiveStyleOlder  : 0;
      const styleAvgVel     = totalSold / effectiveStyleDays;

      // Adjusted velocity: sums each variant's frozen demand velocity (OOS variants
      // contribute their last-known rate, not zero). Reflects true demand including
      // sizes that have sold out, so it's always >= styleAvgVel when any size is OOS.
      const adjustedDailyVel = Math.round(
        variants.reduce((s, v) => s + v.demandDailyVel, 0) * 100
      ) / 100;

      const oosVariantCount = variants.filter(v => v.isOos).length;
      const broadlyOos = oosVariantCount > 0 && oosVariantCount >= Math.ceil(variants.length * 0.5);
      const ratingRecentVel = broadlyOos ? Math.max(styleRecentVel, styleOlderVel) : styleRecentVel;

      const styleTrendRatio = styleOlderVel > 0
        ? ratingRecentVel / styleOlderVel
        : (ratingRecentVel > 0 ? 1.0 : 0);

      // Use adjustedDailyVel for the volume threshold — true demand matters for
      // restock decisions, not just what managed to sell while some sizes were OOS.
      let rating = calculateRating(adjustedDailyVel, ratingRecentVel, styleOlderVel, totalSold);
      if (finalSaleIds.has(String(product.id))) rating = 'F';

      // Velocity buffer for suggested order quantities:
      //   AA+ (accelerating) → +25%   A (stable/growing) → +10%   B → no buffer
      const velocityBuffer = rating === 'AA+' ? 1.25 : rating === 'A' ? 1.10 : 1.0;

      // Minimum runway across active variants (those with real demand)
      const activeVars = variants.filter(v => v.demandDailyVel > 0);
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

      const seaAlertSent      = alertSentSet.has(`${product.id}:sea`);
      const airAlertSent      = alertSentSet.has(`${product.id}:air`);
      const criticalAlertSent = alertSentSet.has(`${product.id}:critical`);

      const totalReturnedUnits = variants.reduce((s, v) => s + v.returnedUnits, 0);
      const returnRate = totalSold > 0
        ? Math.round((totalReturnedUnits / totalSold) * 100)
        : 0;

      const analysed = {
        productId:            product.id,
        title:                product.title,
        image:                product.images?.[0]?.src || null,
        supplierName:         supplierInfo?.name || null,
        isFinalSale:          finalSaleIds.has(String(product.id)),
        rating,
        velocityBuffer,
        trendRatio:           Math.round(styleTrendRatio * 100) / 100,
        avgDailyVel:          Math.round(styleAvgVel     * 100) / 100,
        adjustedDailyVel,
        recentDailyVel:       Math.round(styleRecentVel * 100) / 100,
        olderDailyVel:        Math.round(styleOlderVel  * 100) / 100,
        totalSold,
        totalReturnedUnits,
        returnRate,
        minDaysRemaining,
        criticalVariant,
        totalInventory:       variants.reduce((s, v) => s + v.inventory, 0),
        restockEnabled,
        effectiveSeaLeadDays,
        effectiveAirLeadDays,
        effectiveCoverWeeks,
        seaAlertSent,
        airAlertSent,
        criticalAlertSent,
        incomingOrders,
        variants,
      };

      analysedProducts.push(analysed);

      // ── Alert gate ─────────────────────────────────────────────────
      // Skip: restock disabled, Final Sale collection, declining/dead ratings,
      // or no runway data.
      if (!restockEnabled) continue;
      if (finalSaleIds.has(String(product.id))) continue;
      // C = significant decline, F = sales stopped, null = not enough data
      if (!rating || rating === 'C' || rating === 'F') continue;
      if (minDaysRemaining === null) continue;

      // ── Sea alert (B/A/AA+): 2+ active sizes will OOS before SEA delivery ──
      if (!seaAlertSent && coverageFailure(variants, effectiveSeaLeadDays)) {
        try {
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
          await sendSlack(formatSlackAlert(analysed, 'sea', effectiveCoverWeeks));
        } catch (e) {
          console.error(`[restock] Sea alert error for ${product.title}:`, e.message);
        }
      }

      // ── Air alert (B/A/AA+): 2+ active sizes will OOS before AIR delivery ──
      if (!airAlertSent && coverageFailure(variants, effectiveAirLeadDays)) {
        try {
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
          await sendSlack(formatSlackAlert(analysed, 'air', effectiveCoverWeeks));
        } catch (e) {
          console.error(`[restock] Air alert error for ${product.title}:`, e.message);
        }
      }

      // ── Critical alert (A/AA+ only): runway ≤ CRITICAL_DAYS ──────────────
      // Fires even if sea/air already sent — this is the escalation.
      if (!criticalAlertSent && (rating === 'AA+' || rating === 'A') &&
          minDaysRemaining <= CRITICAL_DAYS) {
        try {
          await pool.query(
            `INSERT INTO restock_alerts_log
               (product_id, product_title, alert_type, rating, days_remaining)
             VALUES ($1,$2,'critical',$3,$4)
             ON CONFLICT (product_id, alert_type) DO NOTHING`,
            [product.id, product.title, rating, minDaysRemaining]
          );
          alertSentSet.add(`${product.id}:critical`);
          analysed.criticalAlertSent = true;
          criticalAlertCount++;
          console.log(`[restock] Critical alert → ${product.title} (${minDaysRemaining}d, ${rating})`);
          await sendSlack(formatCriticalAlert(analysed, effectiveCoverWeeks));
        } catch (e) {
          console.error(`[restock] Critical alert error for ${product.title}:`, e.message);
        }
      }
    }

    // Sort: critical first → sea-alert-needed → fewest days → velocity
    analysedProducts.sort((a, b) => {
      const score = p => {
        if (!p.rating || p.rating === 'C' || p.rating === 'F') return 0;
        if (p.minDaysRemaining !== null && p.minDaysRemaining <= CRITICAL_DAYS && !p.criticalAlertSent) return 3;
        if (p.minDaysRemaining !== null && p.minDaysRemaining <= p.effectiveSeaLeadDays && !p.seaAlertSent) return 2;
        if (p.minDaysRemaining !== null && p.minDaysRemaining <= p.effectiveAirLeadDays && !p.airAlertSent) return 1;
        return 0;
      };
      const sa = score(a), sb = score(b);
      if (sb !== sa) return sb - sa;
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
        generatedAt:    new Date().toISOString(),
        periodDays:     velocity_days,
        totalProducts:  analysedProducts.length,
        totalOrders:    orders.filter(o => !o.cancelled_at).length,
        seaAlerts:      seaAlertCount,
        airAlerts:      airAlertCount,
        criticalAlerts: criticalAlertCount,
        products:       analysedProducts,
      })]
    );

    console.log(`[restock] Done — ${analysedProducts.length} products, ` +
      `${seaAlertCount} sea / ${airAlertCount} air / ${criticalAlertCount} critical alerts`);

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
