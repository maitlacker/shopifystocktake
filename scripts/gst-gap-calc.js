#!/usr/bin/env node
'use strict';

// GST Gap Calculator — Flynn & Noah Products
// Australian Tax Year: 1 July 2025 – present
// Usage: node scripts/gst-gap-calc.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

const FROM = '2025-07-01T00:00:00+10:00';
const TO   = '2026-05-27T23:59:59+10:00';

// Match product titles containing these keywords (case-insensitive)
const KEYWORDS = ['flynn', 'noah'];

// Only pull the fields we actually need — dramatically reduces payload size
const FIELDS = 'id,name,created_at,financial_status,cancelled_at,' +
               'taxes_included,shipping_address,billing_address,line_items';

const wait = (ms) => new Promise(res => setTimeout(res, ms));

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
}
function isAU(order) {
  const addr = order.shipping_address || order.billing_address;
  return !addr || (addr.country_code || '').toUpperCase() === 'AU';
}
function matchesKeyword(str) {
  const s = (str || '').toLowerCase();
  return KEYWORDS.some(k => s.includes(k));
}
function r2(n) { return Math.round((n || 0) * 100) / 100; }
function fmt(n) { return r2(n).toFixed(2); }
function padL(s, n) { return String(s).padStart(n); }
function padR(s, n) { return String(s).padEnd(n); }

async function fetchPage(url) {
  let attempts = 0;
  while (true) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (r.status === 429) {
      const delay = parseInt(r.headers.get('retry-after') || '2', 10) * 1000;
      await wait(delay); continue;
    }
    if (r.status === 503 || r.status === 502) {
      if (++attempts > 5) throw new Error(`Shopify ${r.status} after 5 retries`);
      const delay = Math.min(2000 * attempts, 16000);
      process.stdout.write(`\r  [${r.status}] Retry ${attempts} in ${delay / 1000}s...   `);
      await wait(delay); continue;
    }
    if (!r.ok) throw new Error(`Shopify orders ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }
}

async function main() {
  if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN) {
    console.error('ERROR: SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN not set in .env');
    process.exit(1);
  }

  // ── 1. Fetch paid + partially_refunded orders only ───────────────
  // Using financial_status filter server-side avoids pulling the full
  // order history (which includes tens of thousands of cancelled/pending orders).
  console.log('Fetching paid orders for 1 Jul 2025 – 27 May 2026...\n');
  const allOrders = [];

  for (const fs of ['paid', 'partially_refunded']) {
    let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json`
      + `?financial_status=${fs}`
      + `&created_at_min=${encodeURIComponent(FROM)}`
      + `&created_at_max=${encodeURIComponent(TO)}`
      + `&limit=250`
      + `&fields=${encodeURIComponent(FIELDS)}`;

    while (url) {
      const r    = await fetchPage(url);
      const data = await r.json();
      allOrders.push(...(data.orders || []));
      const link = r.headers.get('link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
      process.stdout.write(`\r  [${fs}] Fetched ${allOrders.length} orders...   `);
    }
    console.log('');
  }
  console.log(`\n  Total revenue orders: ${allOrders.length}\n`);

  // Non-cancelled only (unlikely to have cancelled paid orders, but just in case)
  const revenueOrders = allOrders.filter(o => !o.cancelled_at);

  // ── 2. Scan line items ───────────────────────────────────────────
  let totalMissingGST    = 0;
  let totalRevenue       = 0;
  let totalUnits         = 0;
  let affectedOrderCount = 0;

  const byProduct = {};   // keyed by product_id
  const byMonth   = {};   // keyed by YYYY-MM

  for (const o of revenueOrders) {
    if (!isAU(o)) continue;   // domestic AU only

    const month = o.created_at.slice(0, 7);
    let orderAffected = false;

    for (const li of (o.line_items || [])) {
      // Only line items where Shopify set taxable:false
      if (li.taxable !== false) continue;

      // Only Flynn / Noah products
      if (!matchesKeyword(li.title)) continue;

      const lineTotal  = parseFloat(li.price) * (li.quantity || 1);
      const missingGST = lineTotal / 11;
      const qty        = li.quantity || 1;

      totalRevenue    += lineTotal;
      totalMissingGST += missingGST;
      totalUnits      += qty;
      orderAffected    = true;

      // ── group by product ─────────────────────────────────────────
      const pid = String(li.product_id || li.title);
      if (!byProduct[pid]) {
        byProduct[pid] = { title: li.title, revenue: 0, missingGST: 0, units: 0, variants: {} };
      }
      byProduct[pid].revenue    += lineTotal;
      byProduct[pid].missingGST += missingGST;
      byProduct[pid].units      += qty;

      const vk = li.variant_title || 'Default';
      if (!byProduct[pid].variants[vk]) {
        byProduct[pid].variants[vk] = { sku: li.sku || '—', units: 0, revenue: 0, missingGST: 0 };
      }
      byProduct[pid].variants[vk].units      += qty;
      byProduct[pid].variants[vk].revenue    += lineTotal;
      byProduct[pid].variants[vk].missingGST += missingGST;

      // ── group by month ───────────────────────────────────────────
      if (!byMonth[month]) byMonth[month] = { orders: new Set(), revenue: 0, missingGST: 0 };
      byMonth[month].revenue    += lineTotal;
      byMonth[month].missingGST += missingGST;
      byMonth[month].orders.add(o.name);
    }

    if (orderAffected) affectedOrderCount++;
  }

  // ── 3. Print report ──────────────────────────────────────────────
  const DIV = '═'.repeat(62);
  const div = '─'.repeat(62);

  console.log('\n' + DIV);
  console.log('  GST GAP REPORT — Flynn & Noah Products');
  console.log('  Australian Tax Year  1 July 2025 – 27 May 2026');
  console.log(DIV);
  console.log(`  Affected AU orders :  ${affectedOrderCount}`);
  console.log(`  Units sold         :  ${totalUnits}`);
  console.log(`  Revenue (no GST)   :  $${fmt(totalRevenue)}`);
  console.log(`  MISSING GST        :  $${fmt(totalMissingGST)}  ← report to ATO`);
  console.log(DIV);

  // By product
  console.log('\n  BY PRODUCT\n' + div);
  const prods = Object.values(byProduct).sort((a, b) => b.missingGST - a.missingGST);
  for (const p of prods) {
    console.log(`\n  ${p.title}`);
    for (const vk of Object.keys(p.variants).sort()) {
      const v = p.variants[vk];
      console.log(
        `    ${padR(vk, 32)}` +
        `${padL(v.units, 4)} units   ` +
        `$${padL(fmt(v.revenue), 10)}   ` +
        `missing GST: $${fmt(v.missingGST)}`
      );
    }
    console.log(
      `    ${padR('── SUBTOTAL', 32)}` +
      `${padL(p.units, 4)} units   ` +
      `$${padL(fmt(p.revenue), 10)}   ` +
      `missing GST: $${fmt(p.missingGST)}`
    );
  }

  // By month
  console.log('\n\n  BY MONTH\n' + div);
  for (const m of Object.keys(byMonth).sort()) {
    const d     = byMonth[m];
    const label = new Date(m + '-15').toLocaleString('en-AU', { month: 'short', year: 'numeric' });
    console.log(
      `  ${padR(label, 10)}` +
      `${padL(d.orders.size, 5)} orders   ` +
      `revenue: $${padL(fmt(d.revenue), 10)}   ` +
      `missing GST: $${fmt(d.missingGST)}`
    );
  }

  console.log('\n' + DIV);
  console.log(`  TOTAL GST TO REPORT TO ATO:  $${fmt(totalMissingGST)}`);
  console.log(DIV + '\n');

  if (affectedOrderCount === 0) {
    console.log('  NOTE: Zero affected orders found. Check that the product titles');
    console.log('  contain "Flynn" or "Noah" and that taxable:false is set on those variants.\n');
  }
}

main().catch(err => { console.error('\nError:', err.message); process.exit(1); });
