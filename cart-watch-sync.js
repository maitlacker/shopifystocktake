'use strict';

/**
 * cart-watch-sync.js
 * Mirrors Shopify's open (abandoned) checkouts into Postgres so we can
 * report on what customers currently have sitting in their carts.
 *
 * Shopify has no API for raw browser carts — a checkout record is created
 * the moment a shopper reaches the checkout page, and it keeps updating as
 * they edit their cart. status=open means it hasn't converted to an order.
 *
 * Runs every 30 minutes; can also be triggered manually from Cart Watch.
 */

const fetch = require('node-fetch');
const cron  = require('node-cron');

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';
const WINDOW_DAYS   = 35; // fetch window — keeps the 30-day report view complete

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let isRunning = false;

async function runSync(pool) {
  if (isRunning) return { skipped: true };
  isRunning = true;
  const startedAt = Date.now();

  try {
    if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN) {
      throw new Error('SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN not configured');
    }

    const seenAt = new Date(); // one timestamp for the whole run
    const minIso = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/checkouts.json` +
              `?status=open&limit=250&updated_at_min=${encodeURIComponent(minIso)}`;

    let checkouts = 0, lines = 0, pages = 0;
    while (url) {
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
      if (r.status === 429) {
        const wait = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`Checkouts API ${r.status}`);
      const data = await r.json();
      pages++;

      for (const c of (data.checkouts || [])) {
        const name = [c.customer?.first_name, c.customer?.last_name]
          .filter(Boolean).join(' ') || null;
        await pool.query(`
          INSERT INTO cart_checkouts (id, email, customer_name, total_price, currency,
                                      created_at, updated_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email, customer_name = EXCLUDED.customer_name,
            total_price = EXCLUDED.total_price, currency = EXCLUDED.currency,
            updated_at = EXCLUDED.updated_at, last_seen_at = EXCLUDED.last_seen_at
        `, [c.id, c.email || null, name, c.total_price || null, c.currency || null,
            c.created_at, c.updated_at, seenAt]);

        await pool.query('DELETE FROM cart_checkout_lines WHERE checkout_id = $1', [c.id]);
        for (const l of (c.line_items || [])) {
          await pool.query(`
            INSERT INTO cart_checkout_lines
              (checkout_id, product_id, variant_id, title, variant_title, sku, quantity, price)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `, [c.id, l.product_id || null, l.variant_id || null, l.title || null,
              l.variant_title || null, l.sku || null, l.quantity || 0, l.price || null]);
          lines++;
        }
        checkouts++;
      }

      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }

    // A checkout inside the fetch window that Shopify no longer returns has
    // converted to an order (or been closed) — drop it so it stops counting.
    const { rowCount: converted } = await pool.query(
      `DELETE FROM cart_checkouts WHERE updated_at >= $1 AND last_seen_at < $2`,
      [minIso, seenAt]);
    // And age out anything older than the fetch window entirely.
    const { rowCount: aged } = await pool.query(
      `DELETE FROM cart_checkouts WHERE updated_at < NOW() - INTERVAL '60 days'`);

    const summary = {
      at: seenAt.toISOString(),
      checkouts, lines, pages,
      removedConverted: converted,
      removedAged: aged,
      ms: Date.now() - startedAt,
    };
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('cart_watch_last_sync', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
      [JSON.stringify(summary)]);
    console.log(`[cart-watch] Synced ${checkouts} open carts (${lines} lines, ${pages} pages, ` +
                `-${converted} converted) in ${summary.ms}ms`);
    return summary;
  } catch (err) {
    console.error('[cart-watch] Sync error:', err.message);
    throw err;
  } finally {
    isRunning = false;
  }
}

function getIsRunning() { return isRunning; }

function startCron(pool) {
  cron.schedule('*/30 * * * *', async () => {
    try { await runSync(pool); }
    catch (err) { console.error('[cart-watch] Cron error:', err.message); }
  });
  console.log('[cart-watch] Cron scheduled: every 30 minutes');

  // First-boot convenience: if the mirror is empty, populate it shortly after startup
  setTimeout(async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM cart_checkouts');
      if (rows[0].n === 0) {
        console.log('[cart-watch] Mirror empty — running initial sync');
        await runSync(pool);
      }
    } catch (err) { console.error('[cart-watch] Initial sync check failed:', err.message); }
  }, 25000);
}

module.exports = { runSync, getIsRunning, startCron };
