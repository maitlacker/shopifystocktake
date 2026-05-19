'use strict';

/**
 * stock-value-sync.js
 * Daily snapshot of total inventory value at RRP and cost price.
 * Runs at 03:00 AM every day; can also be triggered manually.
 */

const fetch = require('node-fetch');
const cron  = require('node-cron');

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let isRunning = false;

async function runSync(pool) {
  if (isRunning) {
    console.log('[stock-value] Already running — skipped');
    return { skipped: true };
  }
  isRunning = true;

  try {
    if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN) {
      throw new Error('SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN not configured');
    }

    // ── 1. Paginate all active products ─────────────────────────────
    console.log('[stock-value] Fetching all active products…');
    const variants = [];  // { inventory_item_id, price, qty }
    let skippedUntracked = 0;
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json` +
              `?status=active&limit=250&fields=id,title,variants`;

    while (url) {
      const r = await fetch(url, { headers: shopifyHeaders() });
      if (r.status === 429) {
        const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
        console.log(`[stock-value] Rate limited — waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`Products API ${r.status}`);
      const data = await r.json();

      for (const p of (data.products || [])) {
        // Exclude internal/adjustment products
        if ((p.title || '').toLowerCase().includes('x-redo')) continue;

        for (const v of (p.variants || [])) {
          const qty = parseInt(v.inventory_quantity, 10) || 0;
          if (qty <= 0) continue;

          // Skip untracked variants — their inventory_quantity is not managed
          // by Shopify and will not appear in Shopify's own inventory reports.
          if (v.inventory_management !== 'shopify') {
            skippedUntracked++;
            continue;
          }

          variants.push({
            inventory_item_id: v.inventory_item_id,
            price: parseFloat(v.price) || 0,
            qty,
          });
        }
      }

      // Parse Link header for next page
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    if (skippedUntracked > 0) {
      console.log(`[stock-value] Skipped ${skippedUntracked} untracked variants (inventory_management ≠ shopify)`);
    }

    console.log(`[stock-value] ${variants.length} variants with positive stock`);

    // ── 2. Fetch inventory items for cost (batches of 100) ───────────
    console.log('[stock-value] Fetching cost prices…');
    const costMap = {};   // inventory_item_id → cost (number)
    const ids = variants.map(v => v.inventory_item_id);

    for (let i = 0; i < ids.length; i += 100) {
      const batch    = ids.slice(i, i + 100);
      let itemUrl    = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/inventory_items.json` +
                       `?ids=${batch.join(',')}&limit=100`;

      while (itemUrl) {
        const r = await fetch(itemUrl, { headers: shopifyHeaders() });
        if (r.status === 429) {
          const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
          await sleep(wait);
          continue;
        }
        if (!r.ok) {
          console.warn(`[stock-value] Inventory items batch ${i}–${i+100} failed (${r.status}) — skipping`);
          break;
        }
        const data = await r.json();
        for (const item of (data.inventory_items || [])) {
          costMap[item.id] = parseFloat(item.cost) || 0;
        }
        const link = r.headers.get('link') || '';
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        itemUrl = next ? next[1] : null;
      }

      // Throttle between batches to avoid rate limit bursts
      if (i + 100 < ids.length) await sleep(400);
    }

    // ── 3. Calculate totals ──────────────────────────────────────────
    let totalRrp  = 0;
    let totalCost = 0;

    for (const v of variants) {
      totalRrp  += v.price * v.qty;
      totalCost += (costMap[v.inventory_item_id] || 0) * v.qty;
    }

    // Use Sydney date (AEST/AEDT) so the snapshot is labelled with the correct
    // Australian business day regardless of when the cron fires in UTC.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD

    // ── 4. Upsert today's snapshot ───────────────────────────────────
    await pool.query(`
      INSERT INTO stock_value_history (date, total_rrp, total_cost, variant_count)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (date) DO UPDATE SET
        total_rrp     = EXCLUDED.total_rrp,
        total_cost    = EXCLUDED.total_cost,
        variant_count = EXCLUDED.variant_count,
        synced_at     = NOW()
    `, [today, totalRrp.toFixed(2), totalCost.toFixed(2), variants.length]);

    const result = {
      ok:           true,
      date:         today,
      totalRrp:     Math.round(totalRrp),
      totalCost:    Math.round(totalCost),
      variantCount: variants.length,
      costCoverage: ids.length > 0
        ? Math.round((Object.keys(costMap).length / ids.length) * 100)
        : 0,
    };
    console.log(`[stock-value] Snapshot saved — RRP $${result.totalRrp.toLocaleString()}, ` +
                `Cost $${result.totalCost.toLocaleString()}, ` +
                `${result.variantCount} variants, ${result.costCoverage}% with cost data`);
    return result;

  } catch (err) {
    console.error('[stock-value] Sync error:', err.message);
    throw err;
  } finally {
    isRunning = false;
  }
}

function getIsRunning() { return isRunning; }

function startCron(pool) {
  // 17:00 UTC daily = 03:00 AEST (UTC+10) / 04:00 AEDT (UTC+11)
  // Running overnight Australian time means fresh data is ready each morning.
  cron.schedule('0 17 * * *', async () => {
    console.log('[stock-value] Daily cron starting…');
    try {
      await runSync(pool);
    } catch (err) {
      console.error('[stock-value] Daily cron error:', err.message);
    }
  });
  console.log('[stock-value] Cron scheduled: daily at 17:00 UTC (03:00 AEST)');
}

module.exports = { runSync, getIsRunning, startCron };
