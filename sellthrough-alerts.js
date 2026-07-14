'use strict';
const fetch = require('node-fetch');
const cron  = require('node-cron');

const API_VERSION = '2024-01';
function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' };
}

async function fetchProducts() {
  const products = [];
  let url = `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=active&fields=id,title,product_type,images,variants,published_at`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Shopify products ${r.status}`);
    const d = await r.json();
    products.push(...d.products);
    const link = r.headers.get('link');
    url = null;
    if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return products;
}

async function fetchOrders(sinceDate) {
  const orders = [];
  let url = `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${sinceDate.toISOString()}&limit=250&fields=id,cancelled_at,created_at,line_items`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Shopify orders ${r.status}`);
    const d = await r.json();
    orders.push(...d.orders);
    const link = r.headers.get('link');
    url = null;
    if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return orders;
}

// ── Core sell-through calculation ───────────────────────────────────────────
function calcSellThrough(product, variantSales, recentVariantSales, seasonStart, seasonEnd) {
  const publishedAt    = product.published_at ? new Date(product.published_at) : null;
  const effectiveStart = (publishedAt && publishedAt > seasonStart) ? publishedAt : seasonStart;
  const weeksLive      = Math.max(0.1, (Date.now() - effectiveStart.getTime()) / (7 * 24 * 60 * 60 * 1000));

  const variants = product.variants.map(v => {
    const sold  = variantSales[String(v.id)] || 0;
    const stock = Math.max(0, v.inventory_quantity || 0);
    const start = sold + stock;
    return {
      id: v.id, title: v.title, sku: v.sku || '',
      units_sold: sold, current_stock: stock, starting_stock: start,
      sell_through_pct: start > 0 ? Math.round((sold / start) * 1000) / 10 : 0,
    };
  });

  const unitsSold     = variants.reduce((s, v) => s + v.units_sold,    0);
  const currentStock  = variants.reduce((s, v) => s + v.current_stock, 0);
  const startingStock = unitsSold + currentStock;
  const stPct         = startingStock > 0 ? (unitsSold / startingStock) * 100 : 0;
  const weeklyRate    = unitsSold / weeksLive;
  const weeklyPct     = startingStock > 0 ? (weeklyRate / startingStock) * 100 : 0;
  const weeksToClear  = weeklyRate > 0.05 ? currentStock / weeklyRate : null;

  // Stalling: recent 2-week weekly rate vs overall weekly rate
  const recentSold       = variants.reduce((s, v) => s + (recentVariantSales[String(v.id)] || 0), 0);
  const recentWeeklyRate = recentSold / 2;
  const stalling         = weeksLive >= 4 && weeklyRate >= 0.3 && recentWeeklyRate < weeklyRate * 0.25;

  // Tier
  const tier = stPct >= 80 ? 'healthy' : stPct >= 50 ? 'monitor' : stPct >= 30 ? 'action' : 'critical';

  // Flags
  const flags = [];
  if (stPct < 30 && weeksLive >= 6)                          flags.push('stale');
  if (stalling)                                              flags.push('stalling');
  if (weeksToClear !== null && weeksToClear > 52)            flags.push('excess_stock');
  if (seasonEnd && weeksToClear !== null) {
    const weeksToEnd = (seasonEnd.getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000);
    if (weeksToEnd > 0 && weeksToClear > weeksToEnd)         flags.push('deadline_risk');
  }
  // Size imbalance: only if 3+ variants with meaningful starting stock
  const meaningful = variants.filter(v => v.starting_stock >= 5);
  if (meaningful.length >= 3) {
    const stPcts = meaningful.map(v => v.sell_through_pct);
    const mx = Math.max(...stPcts), mn = Math.min(...stPcts);
    if (mx >= 60 && mn <= 20 && mx >= mn * 3) flags.push('size_imbalance');
  }

  return {
    unitsSold, currentStock, startingStock,
    sell_through_pct: Math.round(stPct * 10) / 10,
    weekly_rate:      Math.round(weeklyRate * 10) / 10,
    weekly_pct:       Math.round(weeklyPct * 100) / 100,
    weeks_live:       Math.round(weeksLive * 10) / 10,
    weeks_to_clear:   weeksToClear !== null ? Math.round(weeksToClear) : null,
    tier, flags, variants,
  };
}

// ── Slack helpers ────────────────────────────────────────────────────────────
const TIER_ORDER = { critical: 4, action: 3, monitor: 2, healthy: 1 };
const TIER_EMOJI = { critical: '🔴', action: '🟠', monitor: '🟡', healthy: '🟢' };
const TIER_LABEL = {
  critical: 'Strong Sale Candidate (<30%)',
  action:   'Consider Promotion (30–50%)',
  monitor:  'Monitor (50–80%)',
  healthy:  'Healthy (80%+)',
};
const TIER_SUGGESTION = {
  critical: 'Strong sale candidate — consider a 30–50% discount immediately.',
  action:   'Consider a 20–30% promotional discount to accelerate sell-through.',
  monitor:  'Monitor closely — consider a targeted promotion if the rate continues to slow.',
  healthy:  'Performing well — keep at full price.',
};
const FLAG_LABELS = {
  stale:          '⚠️ Stale (6+ weeks at low sell-through)',
  stalling:       '📉 Momentum stalling (recent weekly sales well below average)',
  excess_stock:   '📦 Excess stock (>52 weeks of supply)',
  size_imbalance: '📐 Size sell-through heavily imbalanced',
  deadline_risk:  '⏰ Projected to miss season deadline',
};

async function slackPost(text) {
  const webhook = process.env.SLACK_SELLTHROUGH_WEBHOOK_URL;
  if (!webhook) return;
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

async function sendTierAlert(product, result, previousTier) {
  const clearIn   = result.weeks_to_clear
    ? `clears in ~${result.weeks_to_clear} wks at current rate`
    : 'will not clear at current rate';
  const flagLines = result.flags.map(f => `• ${FLAG_LABELS[f] || f}`).join('\n');
  const change    = previousTier ? ` _(moved from ${TIER_EMOJI[previousTier]} ${previousTier})_` : '';

  const text = [
    `${TIER_EMOJI[result.tier]} *Sell-Through Alert — ${TIER_LABEL[result.tier]}*${change}`,
    `*${product.title}*`,
    `• Sell-through: *${result.sell_through_pct}%*  ·  ${result.unitsSold} sold / ${result.startingStock} starting stock`,
    `• In stock: ${result.currentStock} units  ·  Weeks live: ${result.weeks_live}`,
    `• Weekly rate: ${result.weekly_rate} units/wk  ·  ${clearIn}`,
    flagLines || null,
    `💡 ${TIER_SUGGESTION[result.tier]}`,
  ].filter(Boolean).join('\n');

  await slackPost(text);
}

async function sendWeeklySummary(products, results) {
  const byTier = { critical: [], action: [], monitor: [], healthy: [] };
  products.forEach((p, i) => { if (results[i]) byTier[results[i].tier].push({ p, r: results[i] }); });

  const needsAction = [...byTier.critical, ...byTier.action]
    .sort((a, b) => a.r.sell_through_pct - b.r.sell_through_pct)
    .slice(0, 12);

  const totalAtRisk = [...byTier.critical, ...byTier.action]
    .reduce((s, { r }) => s + r.currentStock, 0);

  const lines = [
    `📊 *Weekly Sell-Through Summary*`,
    ``,
    `${TIER_EMOJI.critical} Critical (<30%):  *${byTier.critical.length}* products`,
    `${TIER_EMOJI.action}  Action (30–50%): *${byTier.action.length}* products`,
    `${TIER_EMOJI.monitor} Monitor (50–80%): *${byTier.monitor.length}* products`,
    `${TIER_EMOJI.healthy} Healthy (80%+):  *${byTier.healthy.length}* products`,
    ``,
    `*${totalAtRisk.toLocaleString()} units in critical/action tiers*`,
  ];

  if (needsAction.length > 0) {
    lines.push(``, `*Products needing attention:*`);
    needsAction.forEach(({ p, r }) => {
      const clear = r.weeks_to_clear ? `${r.weeks_to_clear} wks to clear` : 'will not clear';
      lines.push(`• *${p.title}* — ${r.sell_through_pct}% sell-through · ${r.currentStock} units · ${r.weeks_live} wks live · ${clear}`);
    });
  }

  await slackPost(lines.join('\n'));
}

// ── Alert check (daily) ──────────────────────────────────────────────────────
async function runAlertCheck(pool) {
  const seasonStart  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const MIN_STARTING = 10;

  const [products, orders] = await Promise.all([fetchProducts(), fetchOrders(seasonStart)]);

  const variantSales = {}, recentVariantSales = {};
  for (const order of orders) {
    if (order.cancelled_at) continue;
    const isRecent = new Date(order.created_at) >= twoWeeksAgo;
    for (const item of (order.line_items || [])) {
      if (!item.variant_id) continue;
      const k = String(item.variant_id);
      variantSales[k]       = (variantSales[k] || 0) + item.quantity;
      if (isRecent) recentVariantSales[k] = (recentVariantSales[k] || 0) + item.quantity;
    }
  }

  const { rows: logRows } = await pool.query('SELECT product_id, tier FROM sellthrough_alerts_log');
  const prevTiers = Object.fromEntries(logRows.map(r => [r.product_id, r.tier]));

  let alertCount = 0;
  for (const product of products) {
    const result = calcSellThrough(product, variantSales, recentVariantSales, seasonStart, null);
    if (result.startingStock < MIN_STARTING) continue;
    if (result.currentStock === 0 && result.unitsSold === 0) continue;

    const pid      = String(product.id);
    const prevTier = prevTiers[pid];
    const dropped  = prevTier && TIER_ORDER[result.tier] > TIER_ORDER[prevTier];
    const first    = !prevTier && result.tier !== 'healthy';

    if (dropped || first) {
      try {
        await sendTierAlert(product, result, dropped ? prevTier : null);
        alertCount++;
      } catch (e) {
        console.error(`[sellthrough] Alert error for ${product.title}:`, e.message);
      }
    }

    await pool.query(`
      INSERT INTO sellthrough_alerts_log (product_id, product_title, tier, sell_through_pct, alerted_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (product_id) DO UPDATE
        SET product_title    = EXCLUDED.product_title,
            tier             = EXCLUDED.tier,
            sell_through_pct = EXCLUDED.sell_through_pct,
            alerted_at       = NOW()
    `, [pid, product.title, result.tier, result.sell_through_pct]);
  }

  console.log(`[sellthrough] Daily check done. ${alertCount} alerts sent.`);
}

async function runWeeklySummaryJob(pool) {
  const seasonStart  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const MIN_STARTING = 10;

  const [products, orders] = await Promise.all([fetchProducts(), fetchOrders(seasonStart)]);

  const variantSales = {}, recentVariantSales = {};
  for (const order of orders) {
    if (order.cancelled_at) continue;
    const isRecent = new Date(order.created_at) >= twoWeeksAgo;
    for (const item of (order.line_items || [])) {
      if (!item.variant_id) continue;
      const k = String(item.variant_id);
      variantSales[k] = (variantSales[k] || 0) + item.quantity;
      if (isRecent) recentVariantSales[k] = (recentVariantSales[k] || 0) + item.quantity;
    }
  }

  const filtered = products.filter(p => {
    const r = calcSellThrough(p, variantSales, recentVariantSales, seasonStart, null);
    return r.startingStock >= MIN_STARTING && !(r.currentStock === 0 && r.unitsSold === 0);
  });
  const results = filtered.map(p => calcSellThrough(p, variantSales, recentVariantSales, seasonStart, null));

  await sendWeeklySummary(filtered, results);
  console.log('[sellthrough] Weekly summary sent.');
}

function startCron(pool) {
  // Daily tier-change alerts — 9am AEST (23:00 UTC)
  cron.schedule('0 23 * * *', async () => {
    console.log('[sellthrough] Running daily alert check...');
    try { await runAlertCheck(pool); }
    catch (e) { console.error('[sellthrough] Daily check failed:', e.message); }
  });
  // Weekly summary — 8am AEST Monday (22:00 UTC Sunday)
  cron.schedule('0 22 * * 0', async () => {
    console.log('[sellthrough] Running weekly summary...');
    try { await runWeeklySummaryJob(pool); }
    catch (e) { console.error('[sellthrough] Weekly summary failed:', e.message); }
  });
  console.log('[sellthrough] Cron started (daily 9am AEST alerts + Monday 8am AEST summary).');
}

module.exports = { calcSellThrough, startCron };
