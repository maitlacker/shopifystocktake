require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express      = require('express');
const fetch        = require('node-fetch');
const path         = require('path');
const session      = require('express-session');
const PgSession    = require('connect-pg-simple')(session);

const { pool, initDb }          = require('./db');
const { configureAuth, requireAuth } = require('./auth');

const app = express();

// ── Sessions ───────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure:   isProduction,
    httpOnly: true,
    maxAge:   7 * 24 * 60 * 60 * 1000,  // 7 days
    sameSite: 'lax',
  },
}));

// ── Auth ───────────────────────────────────────────────────────────
configureAuth(app);
app.use(requireAuth);

// ── Static + body parsing ──────────────────────────────────────────
// Serve login.html without auth (requireAuth already exempts /login)
app.use(express.static('public'));
app.use(express.json());

const SHOPIFY_SHOP  = process.env.SHOPIFY_SHOP;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION   = '2024-01';

let productsCache = [];
let lastFetched   = null;

// ── History helpers (PostgreSQL) ───────────────────────────────────
async function readHistory() {
  const { rows } = await pool.query(
    'SELECT product_id AS "productId", product_title AS "productTitle", initials, created_at AS "timestamp" FROM stocktake_history ORDER BY created_at DESC'
  );
  return rows;
}

async function appendHistory(entry) {
  await pool.query(
    'INSERT INTO stocktake_history (product_id, product_title, initials, created_at) VALUES ($1, $2, $3, $4)',
    [entry.productId, entry.productTitle, entry.initials, entry.timestamp]
  );
}

// ── Shopify ────────────────────────────────────────────────────────
function shopifyHeaders() {
  return {
    'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    'Content-Type': 'application/json',
  };
}

async function fetchAllProducts() {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=active&fields=id,title,variants,images`;

  while (url) {
    const res = await fetch(url, { headers: shopifyHeaders() });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    products.push(...data.products);

    const linkHeader = res.headers.get('link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return products;
}

async function fetchInventoryCosts(inventoryItemIds) {
  const costs = {};
  const ids = [...inventoryItemIds];
  const totalBatches = Math.ceil(ids.length / 100);
  console.log(`[costs] fetching costs for ${ids.length} inventory items in ${totalBatches} batches`);

  for (let i = 0; i < ids.length; i += 100) {
    const batchNum = i / 100 + 1;
    const batch = ids.slice(i, i + 100).join(',');
    const url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/inventory_items.json?ids=${batch}&fields=id,cost`;

    let attempts = 0;
    while (attempts < 3) {
      try {
        const res = await fetch(url, { headers: shopifyHeaders() });
        if (res.status === 429) {
          const retryAfter = parseFloat(res.headers.get('retry-after') || '2');
          console.warn(`[costs] batch ${batchNum} rate limited, retrying after ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          attempts++;
          continue;
        }
        if (!res.ok) {
          const body = await res.text();
          console.warn(`[costs] batch ${batchNum} failed (${res.status}): ${body.slice(0, 200)}`);
          break;
        }
        const data = await res.json();
        const withCost = (data.inventory_items || []).filter((item) => item.cost != null);
        console.log(`[costs] batch ${batchNum}/${totalBatches}: ${withCost.length}/${data.inventory_items?.length ?? 0} items have cost`);
        for (const item of withCost) {
          costs[String(item.id)] = parseFloat(item.cost);
        }
        break;
      } catch (err) {
        console.warn(`[costs] batch ${batchNum} error:`, err.message);
        break;
      }
    }

    if (i + 100 < ids.length) await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[costs] done — ${Object.keys(costs).length} variants with cost`);
  return costs;
}

// ── Login page ─────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Product routes ─────────────────────────────────────────────────
app.get('/api/products/refresh', async (req, res) => {
  try {
    productsCache = await fetchAllProducts();
    lastFetched = new Date();
    res.json({ count: productsCache.length, lastFetched });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/status', (req, res) => {
  res.json({ count: productsCache.length, lastFetched });
});

app.get('/api/debug/costs', async (req, res) => {
  const title = (req.query.title || '').toLowerCase();
  const product = productsCache.find((p) => p.title.toLowerCase().includes(title));
  if (!product) return res.json({ error: 'product not found in cache' });

  const iids = product.variants.map((v) => ({
    variant_id: v.id,
    variant_title: v.title,
    inventory_item_id: v.inventory_item_id,
    inventory_item_id_type: typeof v.inventory_item_id,
  }));

  const ids = product.variants.map((v) => v.inventory_item_id).filter(Boolean);
  const costMap = await fetchInventoryCosts(ids);

  res.json({ product: product.title, variants: iids, costMap });
});

app.get('/api/products/search', async (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();

  if (!query) return res.json([]);

  const history = await readHistory();

  const results = productsCache.filter((product) => {
    if (product.title.toLowerCase().includes(query)) return true;
    return product.variants.some(
      (v) => v.sku && v.sku.toLowerCase().includes(query)
    );
  });

  const formatted = results.slice(0, 100).map((product) => {
    const skuMatch = product.variants.some(
      (v) => v.sku && v.sku.toLowerCase().includes(query)
    );
    const variants = skuMatch
      ? [...product.variants].sort((a, b) => {
          const aMatch = a.sku && a.sku.toLowerCase().includes(query) ? -1 : 1;
          const bMatch = b.sku && b.sku.toLowerCase().includes(query) ? -1 : 1;
          return aMatch - bMatch;
        })
      : product.variants;

    const image =
      product.images && product.images.length > 0
        ? product.images[0].src
        : null;

    const checks = history
      .filter((h) => String(h.productId) === String(product.id))
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const lastCheck = checks.length > 0 ? checks[0] : null;

    return { id: product.id, title: product.title, image, variants, lastCheck };
  });

  res.json(formatted);
});

// ── Stocktake history routes ───────────────────────────────────────
app.post('/api/stocktake/submit', async (req, res) => {
  const { productId, productTitle, initials } = req.body;

  if (!productId || !productTitle || !initials) {
    return res.status(400).json({ error: 'productId, productTitle and initials are required' });
  }

  const entry = {
    productId,
    productTitle,
    initials: initials.toUpperCase().trim(),
    timestamp: new Date().toISOString(),
  };

  await appendHistory(entry);
  res.json({ ok: true, entry });
});

app.get('/api/stocktake/history', async (req, res) => {
  const query = (req.query.q || '').toLowerCase().trim();
  let history = await readHistory();

  if (query) {
    history = history.filter((h) =>
      h.productTitle.toLowerCase().includes(query)
    );
  }

  res.json(history);
});

app.get('/api/stocktake/last-checks', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (product_id)
      product_id AS "productId",
      product_title AS "productTitle",
      initials,
      created_at AS "timestamp"
    FROM stocktake_history
    ORDER BY product_id, created_at DESC
  `);
  res.json(rows);
});

// ── Draft + Archived products with stock ──────────────────────────
async function fetchProductsByStatus(status) {
  const products = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=250&status=${status}&fields=id,title,variants,images`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Shopify API error ${r.status}: ${body}`);
    }
    const data = await r.json();
    data.products.forEach((p) => { p._status = status; });
    products.push(...data.products);

    const linkHeader = r.headers.get('link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return products;
}

app.get('/api/reports/draft-with-stock', async (req, res) => {
  try {
    const [draftProducts, archivedProducts] = await Promise.all([
      fetchProductsByStatus('draft'),
      fetchProductsByStatus('archived'),
    ]);

    const all = [...draftProducts, ...archivedProducts];

    const withStock = all
      .filter((p) => p.variants.some((v) => (v.inventory_quantity || 0) > 0))
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p._status,
        image: p.images && p.images.length > 0 ? p.images[0].src : null,
        totalStock: p.variants.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0),
        variants: p.variants
          .filter((v) => (v.inventory_quantity || 0) > 0)
          .map((v) => ({
            id: v.id,
            title: v.title,
            sku: v.sku,
            inventory_quantity: v.inventory_quantity,
          })),
      }))
      .sort((a, b) => b.totalStock - a.totalStock);

    res.json({ count: withStock.length, products: withStock });
  } catch (err) {
    console.error('Draft/archived report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sales Velocity ────────────────────────────────────────────────
async function fetchOrdersSince(sinceDate) {
  const orders = [];
  let url = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/orders.json?status=any&created_at_min=${sinceDate.toISOString()}&limit=250&fields=id,cancelled_at,line_items`;

  while (url) {
    const r = await fetch(url, { headers: shopifyHeaders() });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Shopify Orders API error ${r.status}: ${body}`);
    }
    const data = await r.json();
    orders.push(...data.orders);

    const linkHeader = r.headers.get('link');
    url = null;
    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) url = nextMatch[1];
    }
  }

  return orders;
}

app.get('/api/velocity', async (req, res) => {
  try {
    const days             = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const lowStockDays     = parseFloat(req.query.low_stock_days) || 21;
    const criticalDays     = parseFloat(req.query.critical_days) || 7;
    const deadVelocity     = parseFloat(req.query.dead_velocity) || 0.1;
    const deadMinInventory = parseInt(req.query.dead_inventory) || 5;

    const since = new Date();
    since.setDate(since.getDate() - days);

    if (!productsCache || productsCache.length === 0) {
      productsCache = await fetchAllProducts();
      lastFetched = new Date();
    }

    const orders = await fetchOrdersSince(since);

    const variantSales = {};
    for (const order of orders) {
      if (order.cancelled_at) continue;
      for (const item of (order.line_items || [])) {
        if (!item.variant_id) continue;
        const key = String(item.variant_id);
        variantSales[key] = (variantSales[key] || 0) + item.quantity;
      }
    }

    const allInventoryItemIds = productsCache.flatMap((p) =>
      p.variants.map((v) => v.inventory_item_id).filter(Boolean)
    );
    const costMap = await fetchInventoryCosts(allInventoryItemIds);

    const styles = productsCache.map((product) => {
      const variants = product.variants.map((v) => {
        const sold      = variantSales[String(v.id)] || 0;
        const inventory = Math.max(0, v.inventory_quantity || 0);
        const dailyVel  = sold / days;
        const daysStock = dailyVel > 0 ? inventory / dailyVel : null;

        const cost  = costMap[String(v.inventory_item_id)] ?? null;
        const price = v.price != null ? Math.round(parseFloat(v.price) * 100) / 100 : null;
        const margin     = (price !== null && cost !== null) ? Math.round((price - cost) * 100) / 100 : null;
        const margin_pct = (price !== null && cost !== null && price > 0)
          ? Math.round(((price - cost) / price) * 10000) / 100
          : null;

        return {
          id: v.id,
          title: v.title,
          sku: v.sku || '',
          inventory,
          sold,
          daily_velocity: Math.round(dailyVel * 100) / 100,
          days_of_stock: daysStock !== null ? Math.round(daysStock) : null,
          cost,
          price,
          margin,
          margin_pct,
        };
      });

      const totalInventory  = variants.reduce((s, v) => s + v.inventory, 0);
      const totalSold       = variants.reduce((s, v) => s + v.sold, 0);
      const styleDailyVel   = totalSold / days;
      const styleDaysStock  = styleDailyVel > 0 ? totalInventory / styleDailyVel : null;

      const variantsWithMargin = variants.filter((v) => v.margin !== null);
      const avg_margin_pct = variantsWithMargin.length > 0
        ? Math.round(variantsWithMargin.reduce((s, v) => s + v.margin_pct, 0) / variantsWithMargin.length * 100) / 100
        : null;
      const total_markup_on_hand = variantsWithMargin.length > 0
        ? Math.round(variantsWithMargin.reduce((s, v) => s + v.margin * v.inventory, 0) * 100) / 100
        : null;

      const soldOutVariants = variants.filter((v) => v.inventory === 0);
      const inStockVariants = variants.filter((v) => v.inventory > 0);
      const soldOutRatio    = variants.length > 0 ? soldOutVariants.length / variants.length : 0;

      let status      = 'green';
      let alertType   = 'ok';
      let priorityTier = 0;
      let sortKey     = -(styleDailyVel);

      if (totalInventory === 0 && totalSold === 0) {
        status = 'grey'; alertType = 'no_activity'; priorityTier = -1; sortKey = 0;
      } else if (styleDaysStock !== null && styleDaysStock <= criticalDays) {
        status = 'red';    alertType = 'critical_stock'; priorityTier = 4; sortKey = styleDaysStock;
      } else if (styleDaysStock !== null && styleDaysStock <= lowStockDays) {
        status = 'amber';  alertType = 'low_stock';      priorityTier = 3; sortKey = styleDaysStock;
      } else if (soldOutVariants.length > 0 && inStockVariants.length > 0 && totalInventory >= deadMinInventory) {
        status = 'yellow'; alertType = 'imbalanced';     priorityTier = 2; sortKey = -soldOutRatio;
      } else if (styleDailyVel < deadVelocity && totalInventory >= deadMinInventory) {
        status = 'blue';   alertType = 'dead_stock';     priorityTier = 1; sortKey = -totalInventory;
      }

      return {
        id: product.id,
        title: product.title,
        image: product.images && product.images.length > 0 ? product.images[0].src : null,
        total_inventory: totalInventory,
        total_sold: totalSold,
        daily_velocity: Math.round(styleDailyVel * 100) / 100,
        days_of_stock: styleDaysStock !== null ? Math.round(styleDaysStock) : null,
        avg_margin_pct,
        total_markup_on_hand,
        variants,
        variant_sold_out_count: soldOutVariants.length,
        variant_in_stock_count: inStockVariants.length,
        variant_total_count: variants.length,
        status,
        alert_type: alertType,
        priority_tier: priorityTier,
        sort_key: sortKey,
      };
    });

    styles.sort((a, b) => {
      if (b.priority_tier !== a.priority_tier) return b.priority_tier - a.priority_tier;
      return a.sort_key - b.sort_key;
    });

    const summary = {
      critical_stock: styles.filter((s) => s.alert_type === 'critical_stock').length,
      low_stock:      styles.filter((s) => s.alert_type === 'low_stock').length,
      imbalanced:     styles.filter((s) => s.alert_type === 'imbalanced').length,
      dead_stock:     styles.filter((s) => s.alert_type === 'dead_stock').length,
      ok:             styles.filter((s) => s.alert_type === 'ok').length,
      no_activity:    styles.filter((s) => s.alert_type === 'no_activity').length,
    };

    res.json({
      period_days: days,
      generated_at: new Date().toISOString(),
      total_orders_analysed: orders.filter((o) => !o.cancelled_at).length,
      thresholds: { low_stock_days: lowStockDays, critical_days: criticalDays, dead_velocity: deadVelocity, dead_min_inventory: deadMinInventory },
      summary,
      styles,
    });
  } catch (err) {
    console.error('Velocity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Warehouse Studio running at http://localhost:${PORT}`);
      if (!SHOPIFY_SHOP || !SHOPIFY_TOKEN) {
        console.warn('WARNING: SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN not set');
      }
    });
  })
  .catch((err) => {
    console.error('Database init failed:', err.message);
    process.exit(1);
  });
