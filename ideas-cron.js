// ideas-cron.js — Daily Idea Factory automation
// Runs every morning, generates ideas via Claude, posts NEW ones to Slack
'use strict';

const cron  = require('node-cron');
const fetch = require('node-fetch');

// ── Module state ───────────────────────────────────────────────────
let _pool      = null;
let _anthropic = null;
let isRunning  = false;
let lastRunAt     = null;
let lastRunStatus = null;
let lastNewCount  = 0;

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

// Default thresholds (same as velocity page defaults)
const PERIOD_DAYS    = 30;
const LOW_STOCK_DAYS = 21;
const CRITICAL_DAYS  = 7;
const DEAD_MIN_SOLD  = 10;
const DEAD_MIN_INV   = 5;

function shopifyHeaders() {
  return { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };
}

// ── Shopify helpers ────────────────────────────────────────────────
async function fetchProducts() {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=active&fields=id,title,variants,images,tags,product_type`;
  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });
    if (!res.ok) throw new Error(`Products API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    products.push(...data.products);
    const link = res.headers.get('link');
    url = null;
    if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return products;
}

async function fetchOrders(sinceDate) {
  const orders = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${sinceDate.toISOString()}&limit=250&fields=id,cancelled_at,line_items`;
  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) throw new Error(`Orders API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    orders.push(...data.orders);
    const link = r.headers.get('link');
    url = null;
    if (link) { const m = link.match(/<([^>]+)>;\s*rel="next"/); if (m) url = m[1]; }
  }
  return orders;
}

async function fetchCosts(inventoryItemIds) {
  const costs = {};
  const ids = [...inventoryItemIds];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100).join(',');
    const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/inventory_items.json?ids=${batch}&limit=100&fields=id,cost`;
    let attempts = 0;
    while (attempts < 3) {
      const res = await fetch(url, { headers: shopifyHeaders() });
      if (res.status === 429) {
        const wait = parseFloat(res.headers.get('retry-after') || '2');
        await new Promise(r => setTimeout(r, wait * 1000));
        attempts++;
        continue;
      }
      if (!res.ok) break;
      const data = await res.json();
      for (const item of (data.inventory_items || [])) {
        if (item.cost != null) costs[String(item.id)] = parseFloat(item.cost);
      }
      break;
    }
    if (i + 100 < ids.length) await new Promise(r => setTimeout(r, 300));
  }
  return costs;
}

// ── Velocity calculation ───────────────────────────────────────────
async function computeStyles() {
  const since = new Date();
  since.setDate(since.getDate() - PERIOD_DAYS);

  console.log('[ideas-cron] Fetching products and orders in parallel…');
  const [products, orders] = await Promise.all([fetchProducts(), fetchOrders(since)]);
  console.log(`[ideas-cron] ${products.length} products, ${orders.filter(o => !o.cancelled_at).length} orders`);

  const variantSales = {};
  for (const order of orders) {
    if (order.cancelled_at) continue;
    for (const item of (order.line_items || [])) {
      if (!item.variant_id) continue;
      variantSales[String(item.variant_id)] = (variantSales[String(item.variant_id)] || 0) + item.quantity;
    }
  }

  const allInventoryItemIds = products.flatMap(p => p.variants.map(v => v.inventory_item_id).filter(Boolean));
  const costMap = await fetchCosts(allInventoryItemIds);

  return products.map(product => {
    const variants = product.variants.map(v => {
      const sold      = variantSales[String(v.id)] || 0;
      const inventory = Math.max(0, v.inventory_quantity || 0);
      const dailyVel  = sold / PERIOD_DAYS;
      const daysStock = dailyVel > 0 ? inventory / dailyVel : null;
      const cost      = costMap[String(v.inventory_item_id)] ?? null;
      const price     = v.price != null ? Math.round(parseFloat(v.price) * 100) / 100 : null;
      const margin     = (price !== null && cost !== null) ? Math.round((price - cost) * 100) / 100 : null;
      const margin_pct = (price !== null && cost !== null && price > 0)
        ? Math.round(((price - cost) / price) * 10000) / 100 : null;
      return { id: v.id, title: v.title, sku: v.sku || '', inventory, sold,
        daily_velocity: Math.round(dailyVel * 100) / 100,
        days_of_stock: daysStock !== null ? Math.round(daysStock) : null,
        cost, price, margin, margin_pct };
    });

    const totalInventory = variants.reduce((s, v) => s + v.inventory, 0);
    const totalSold      = variants.reduce((s, v) => s + v.sold, 0);
    const styleDailyVel  = totalSold / PERIOD_DAYS;
    const styleDaysStock = styleDailyVel > 0 ? totalInventory / styleDailyVel : null;

    const variantsWithMargin = variants.filter(v => v.margin !== null);
    const avg_margin_pct = variantsWithMargin.length > 0
      ? Math.round(variantsWithMargin.reduce((s, v) => s + v.margin_pct, 0) / variantsWithMargin.length * 100) / 100
      : null;

    const soldOutVariants = variants.filter(v => v.inventory === 0);
    const inStockVariants = variants.filter(v => v.inventory > 0);
    const soldOutRatio    = variants.length > 0 ? soldOutVariants.length / variants.length : 0;

    let alertType = 'ok';
    if (totalInventory === 0 && totalSold === 0) {
      alertType = 'no_activity';
    } else if (styleDaysStock !== null && styleDaysStock <= CRITICAL_DAYS) {
      alertType = 'critical_stock';
    } else if (styleDaysStock !== null && styleDaysStock <= LOW_STOCK_DAYS) {
      alertType = 'low_stock';
    } else if (soldOutVariants.length > 0 && inStockVariants.length > 0 && totalInventory >= DEAD_MIN_INV) {
      alertType = 'imbalanced';
    } else if (totalSold < DEAD_MIN_SOLD && totalInventory >= DEAD_MIN_INV) {
      alertType = 'dead_stock';
    }

    return { id: product.id, title: product.title,
      tags: product.tags || '', product_type: product.product_type || '',
      total_inventory: totalInventory, total_sold: totalSold,
      daily_velocity: Math.round(styleDailyVel * 100) / 100,
      days_of_stock: styleDaysStock !== null ? Math.round(styleDaysStock) : null,
      avg_margin_pct, variants,
      variant_sold_out_count: soldOutVariants.length,
      variant_in_stock_count: inStockVariants.length,
      variant_total_count: variants.length,
      alert_type: alertType };
  });
}

// ── Prompt builder (mirrors server.js idea-factory logic) ──────────
function buildPromptContext(styles) {
  const deadStock  = styles.filter(s => s.alert_type === 'dead_stock')
    .sort((a, b) => b.total_inventory - a.total_inventory).slice(0, 15);
  const finalSizes = styles.filter(s => s.alert_type === 'imbalanced')
    .sort((a, b) => b.variant_sold_out_count - a.variant_sold_out_count).slice(0, 12);
  const lowStock   = styles.filter(s => ['critical_stock', 'low_stock'].includes(s.alert_type))
    .sort((a, b) => (a.days_of_stock ?? 999) - (b.days_of_stock ?? 999)).slice(0, 10);
  const topSellers = styles.filter(s => s.alert_type === 'ok' && s.daily_velocity > 0)
    .sort((a, b) => b.daily_velocity - a.daily_velocity).slice(0, 10);

  const productsAnalysed = deadStock.length + finalSizes.length + lowStock.length + topSellers.length;
  if (productsAnalysed < 3) return null;

  function fmtPrice(s) {
    const p = s.variants?.[0]?.price;
    return p != null ? `$${Number(p).toFixed(2)}` : '';
  }
  function fmtMargin(s) {
    return s.avg_margin_pct != null ? ` ${s.avg_margin_pct.toFixed(0)}% margin` : '';
  }
  function fmtVariants(s) {
    if (!s.variants || s.variants.length <= 1) return '';
    const parts = s.variants.map(v => {
      const label = v.title !== 'Default Title' ? v.title : null;
      return label ? `${label}: ${v.inventory === 0 ? 'SOLD OUT' : v.inventory + ' left'}` : null;
    }).filter(Boolean).slice(0, 8);
    return parts.length ? `\n    Sizes: ${parts.join(' | ')}` : '';
  }
  function fmtFinalSize(s) {
    const price = fmtPrice(s), margin = fmtMargin(s);
    if (!s.variants || s.variants.length <= 1) {
      return `  • "${s.title}" — ${price},${margin} ONLY ${s.total_inventory} unit(s) left, ${s.total_sold} sold in ${PERIOD_DAYS}d`;
    }
    const inStock   = s.variants.filter(v => v.inventory > 0 && v.title !== 'Default Title');
    const soldOut   = s.variants.filter(v => v.inventory === 0 && v.title !== 'Default Title');
    const totalLeft = inStock.reduce((sum, v) => sum + v.inventory, 0);
    const leftList  = inStock.map(v => `${v.title}: ${v.inventory}`).join(', ');
    const goneList  = soldOut.length ? ` | GONE: ${soldOut.map(v => v.title).join(', ')}` : '';
    return `  • "${s.title}" — ${price},${margin} ONLY ${totalLeft} unit(s) left → ${leftList}${goneList} (${s.total_sold} sold in ${PERIOD_DAYS}d)`;
  }
  function fmtBlock(arr, label) {
    if (!arr.length) return '';
    const lines = arr.map(s =>
      `  • "${s.title}" — ${fmtPrice(s)},${fmtMargin(s)}, stock: ${s.total_inventory}, sold: ${s.total_sold} in ${PERIOD_DAYS}d, velocity: ${s.daily_velocity.toFixed(2)}/day${fmtVariants(s)}`
    ).join('\n');
    return `${label}\n${lines}\n`;
  }

  const context = [
    fmtBlock(deadStock,  `═══ DEAD STOCK (sitting still — needs to move) ═══`),
    finalSizes.length ? `═══ FINAL SIZES (orphaned sizes — most variants sold out, last units stranded) ═══\n${finalSizes.map(fmtFinalSize).join('\n')}\n` : '',
    fmtBlock(lowStock,   `═══ RUNNING LOW (selling fast — restock or capitalise now) ═══`),
    fmtBlock(topSellers, `═══ TOP SELLERS (healthy performers — push harder) ═══`),
  ].filter(Boolean).join('\n');

  return { context, productsAnalysed };
}

// ── Slack Block Kit message ────────────────────────────────────────
async function postToSlack(headline, newIdeas, totalIdeas) {
  const webhookUrl = (process.env.SLACK_IDEAS_WEBHOOK_URL || '').trim().replace(/^["']|["']$/g, '');
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    console.warn('[ideas-cron] SLACK_IDEAS_WEBHOOK_URL not set — skipping Slack post');
    return false;
  }

  const high   = newIdeas.filter(i => i.priority === 'high');
  const medium = newIdeas.filter(i => i.priority === 'medium');
  const low    = newIdeas.filter(i => i.priority === 'low');
  const dateStr = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
  const appUrl  = (process.env.APP_URL || '').replace(/\/$/, '');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `💡 Idea Factory — ${dateStr}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `_${headline}_\n*${newIdeas.length} new idea${newIdeas.length !== 1 ? 's' : ''} today* (${totalIdeas} total generated)`,
      },
    },
    { type: 'divider' },
  ];

  if (high.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🔴 *High Priority*` } });
    for (const idea of high.slice(0, 5)) {
      const productLine = idea.products?.length
        ? `\n_${idea.products.slice(0, 3).join(' · ')}${idea.products.length > 3 ? '…' : ''}_`
        : '';
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${idea.icon || '💡'} *${idea.title}*\n${idea.action}${productLine}` },
      });
    }
    if (high.length > 5) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_…and ${high.length - 5} more high priority ideas_` } });
    }
  }

  if (medium.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🟡 *Medium Priority (${medium.length})*` } });
    for (const idea of medium.slice(0, 3)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${idea.icon || '💡'} *${idea.title}* — ${idea.action}` },
      });
    }
    if (medium.length > 3) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `_…and ${medium.length - 3} more_` } });
    }
  }

  if (low.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🟢 ${low.length} low priority idea${low.length !== 1 ? 's' : ''} also generated` } });
  }

  if (appUrl) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `<${appUrl}/velocity.html|View full Idea Factory in the WMS →>` },
    });
  }

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ blocks }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[ideas-cron] Slack post failed ${res.status}: ${body.slice(0, 200)}`);
    return false;
  }

  console.log('[ideas-cron] Slack message posted successfully');
  return true;
}

// ── Main daily run ─────────────────────────────────────────────────
async function runIdeaCron() {
  if (isRunning) {
    console.log('[ideas-cron] Already running — skipping');
    return { skipped: true };
  }
  if (!_anthropic) {
    console.warn('[ideas-cron] ANTHROPIC_API_KEY not configured — skipping');
    lastRunStatus = 'skipped — ANTHROPIC_API_KEY not set';
    return { skipped: true };
  }

  isRunning = true;
  console.log('[ideas-cron] Starting daily idea generation…');

  try {
    // ── Grab previous run's idea titles for deduplication ──────────
    const { rows: prevRows } = await _pool.query(
      `SELECT ideas_json FROM velocity_ideas WHERE period_days = $1 ORDER BY generated_at DESC LIMIT 1`,
      [PERIOD_DAYS]
    );
    const prevTitles = new Set(
      (prevRows[0]?.ideas_json || []).map(i => (i.title || '').toLowerCase().trim()).filter(Boolean)
    );
    const isFirstRun = prevRows.length === 0;

    // ── Compute velocity ───────────────────────────────────────────
    const styles   = await computeStyles();
    const prepared = buildPromptContext(styles);

    if (!prepared) {
      lastRunAt     = new Date();
      lastRunStatus = 'skipped — insufficient product data';
      console.log('[ideas-cron] Not enough data to generate ideas');
      return { skipped: true };
    }

    const { context, productsAnalysed } = prepared;

    // ── Call Claude ────────────────────────────────────────────────
    const prompt = `You are a senior retail strategist and digital marketing expert advising The Self Styler, an Australian women's fashion e-commerce retailer (dresses, tops, shoes, accessories, approx $50–$300 price range).

Here is the live inventory and sales performance snapshot from the last ${PERIOD_DAYS} days:

${context}

Generate 10–15 specific, high-impact action ideas to maximise revenue, clear stagnant stock, and grow the business. Think like an experienced retail merchandiser AND a performance marketing specialist.

Ideas must span multiple tactics — include a mix from: clearance/markdown pricing, final-size bundles, Meta/Instagram ad campaigns, email marketing, flash sales, site promotions, urgency messaging, restock decisions, product page tweaks.

Rules:
- Name ACTUAL products from the lists above — never give generic advice
- Be SPECIFIC and DIRECT — tell us exactly what to do, not vague advice
- FINAL SIZES: for every orphaned product, give a concrete action: "You have X [size] left in [Product] — drop to $Y and clear them." These are shelf-hogging dead weight; one idea per product if warranted
- Dead stock needs CREATIVE solutions (bundles, deep discounts, styled collections, gift-with-purchase)
- Top sellers deserve more ad budget, urgency copy ("selling fast"), and restock consideration
- Think about the cost of holding unsold stock — physical space and cash tied up
- If a product has only 1-3 units of a single size left, say so explicitly and recommend a specific price or action

Return ONLY raw JSON (absolutely no markdown fences):
{
  "headline": "Honest 1-2 sentence assessment of the overall inventory health and biggest opportunity right now",
  "ideas": [
    {
      "category": "Clearance|Final Sizes|Bundle Deal|Meta Ads|Email Campaign|Flash Sale|Pricing|Restock|Promotion|Site Merch",
      "icon": "single relevant emoji",
      "title": "Short punchy idea title (6 words max)",
      "action": "Exactly what to do — be specific and direct (2-3 sentences)",
      "products": ["Exact product name 1", "Exact product name 2"],
      "rationale": "Why this, why now — one sentence",
      "priority": "high|medium|low"
    }
  ]
}

Prioritise the ideas that will have the most immediate financial impact.`;

    console.log(`[ideas-cron] Calling Claude Sonnet: ${productsAnalysed} products`);
    const message = await _anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 4096,
      messages:   [{ role: 'user', content: prompt }],
    });

    const rawText  = message.content[0]?.text || '';
    const jsonText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[ideas-cron] JSON parse failed:', jsonText.slice(0, 300));
      lastRunAt     = new Date();
      lastRunStatus = 'error — Claude returned malformed JSON';
      return { error: true };
    }

    const ideas    = parsed.ideas || [];
    const headline = parsed.headline || '';

    // ── Save to DB ─────────────────────────────────────────────────
    await _pool.query(
      `INSERT INTO velocity_ideas (period_days, products_analysed, headline, ideas_json, model_used)
       VALUES ($1, $2, $3, $4, $5)`,
      [PERIOD_DAYS, productsAnalysed, headline, JSON.stringify(ideas), message.model || 'claude-sonnet-4-5']
    );

    // ── Find new ideas ─────────────────────────────────────────────
    // On first ever run, all high/medium ideas are "new" — don't flood with everything
    const newIdeas = isFirstRun
      ? ideas.filter(i => i.priority === 'high' || i.priority === 'medium')
      : ideas.filter(i => !prevTitles.has((i.title || '').toLowerCase().trim()));

    lastNewCount = newIdeas.length;
    console.log(`[ideas-cron] ${ideas.length} ideas generated, ${newIdeas.length} are new`);

    // ── Post to Slack if worthwhile ────────────────────────────────
    const actionable = newIdeas.filter(i => i.priority === 'high' || i.priority === 'medium');
    let slackSent = false;

    if (actionable.length > 0) {
      slackSent = await postToSlack(headline, newIdeas, ideas);
      lastRunStatus = slackSent
        ? `ok — ${newIdeas.length} new ideas posted to Slack`
        : `ok — ${newIdeas.length} new ideas (Slack post failed)`;
    } else if (newIdeas.length > 0) {
      lastRunStatus = `ok — ${newIdeas.length} new low-priority ideas (not posted to Slack)`;
    } else {
      lastRunStatus = 'ok — no new ideas vs yesterday (Slack not notified)';
    }

    lastRunAt = new Date();
    console.log(`[ideas-cron] Done: ${lastRunStatus}`);
    return { ok: true, newIdeas: newIdeas.length, total: ideas.length, slackSent };

  } catch (err) {
    console.error('[ideas-cron] Error:', err.message);
    lastRunAt     = new Date();
    lastRunStatus = `error — ${err.message}`;
    return { error: true, message: err.message };
  } finally {
    isRunning = false;
  }
}

// ── Exports ────────────────────────────────────────────────────────
function startCron(pool, anthropicClient) {
  _pool      = pool;
  _anthropic = anthropicClient;

  // Default: 9pm UTC = 7am AEST (UTC+10). Set IDEAS_CRON env var to override.
  const schedule = process.env.IDEAS_CRON || '0 21 * * *';
  cron.schedule(schedule, () => {
    console.log('[ideas-cron] Cron fired');
    runIdeaCron().catch(err => console.error('[ideas-cron] Uncaught error:', err.message));
  });

  console.log(`[ideas-cron] Scheduled: ${schedule}`);
}

function getStatus() {
  return {
    isRunning,
    lastRunAt:    lastRunAt ? lastRunAt.toISOString() : null,
    lastRunStatus,
    lastNewCount,
    schedule:     process.env.IDEAS_CRON || '0 21 * * *',
    slackConfigured: !!(process.env.SLACK_IDEAS_WEBHOOK_URL || '').trim(),
  };
}

module.exports = { startCron, runIdeaCron, getStatus };
