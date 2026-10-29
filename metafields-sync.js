// ── Product Metafields Sync ─────────────────────────────────────────
// Imports every product metafield from Shopify (GraphQL Admin API) into
// Postgres for the Ecommerce Management Studio. Also snapshots the
// status + inventory of every product referenced by a product_reference
// metafield (You may also like / Complete the look / Colour Variants)
// so reports can flag sold-out, low-stock, inactive or deleted refs.
//
// Read-only against Shopify — this module never writes to the store.

const fetch = require('node-fetch');
const cron = require('node-cron');

let pool = null;

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-01';

const state = {
  running: false,
  phase: 'idle',       // idle | products | references | saving | done | error
  done: 0,
  total: 0,
  error: null,
  startedAt: null,
  finishedAt: null,
  lastResult: null,
};

function getStatus() { return { ...state }; }

// GraphQL request with throttle handling (Shopify cost bucket)
async function gql(query, variables, attempt = 0) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 && attempt < 6) {
    await new Promise(r => setTimeout(r, 4000));
    return gql(query, variables, attempt + 1);
  }
  const body = await res.json();
  if (body.errors) {
    const throttled = body.errors.some(e => e.extensions?.code === 'THROTTLED');
    if (throttled && attempt < 6) {
      const cost = body.extensions?.cost;
      const waitMs = cost
        ? Math.ceil((cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable) /
                    cost.throttleStatus.restoreRate) * 1000 + 500
        : 4000;
      await new Promise(r => setTimeout(r, Math.min(Math.max(waitMs, 1000), 20000)));
      return gql(query, variables, attempt + 1);
    }
    throw new Error('GraphQL: ' + JSON.stringify(body.errors).slice(0, 300));
  }
  return body.data;
}

function gidToId(gid) {
  const m = String(gid || '').match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Parse a product_reference / list.product_reference value into numeric ids
function refIdsFromValue(type, value) {
  if (!value) return [];
  try {
    if (type === 'product_reference') {
      const id = gidToId(value);
      return id ? [id] : [];
    }
    if (type === 'list.product_reference') {
      const arr = JSON.parse(value);
      return (Array.isArray(arr) ? arr : []).map(gidToId).filter(Boolean);
    }
  } catch { /* unparseable value — treat as no refs */ }
  return [];
}

const PRODUCT_FIELDS = `
  id legacyResourceId title handle status productType
  tracksInventory totalInventory
  featuredImage { url }
`;

async function fetchActiveProductsWithMetafields() {
  const products = [];
  let cursor = null;
  for (;;) {
    const data = await gql(`
      query($cursor: String) {
        products(first: 50, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            ${PRODUCT_FIELDS}
            metafields(first: 60) {
              nodes { namespace key type value definition { name } }
            }
          }
        }
      }`, { cursor });
    const page = data.products;
    products.push(...page.nodes);
    state.done = products.length;
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return products;
}

async function fetchProductsByIds(numericIds) {
  const out = [];
  for (let i = 0; i < numericIds.length; i += 50) {
    const gids = numericIds.slice(i, i + 50).map(id => `gid://shopify/Product/${id}`);
    const data = await gql(`
      query($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } }
      }`, { ids: gids });
    out.push(...(data.nodes || []).filter(n => n && n.id));
    state.done = Math.min(i + 50, numericIds.length);
  }
  return out;
}

function productRow(p, isOwner) {
  return [
    Number(p.legacyResourceId),
    p.title || '',
    p.handle || '',
    p.status || '',
    p.productType || '',
    p.tracksInventory !== false,
    Number.isFinite(Number(p.totalInventory)) ? Number(p.totalInventory) : null,
    p.featuredImage?.url || null,
    isOwner,
  ];
}

async function syncMetafields() {
  if (state.running) return { skipped: true, reason: 'already running' };
  if (!SHOP || !TOKEN) throw new Error('SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN not configured');
  state.running = true;
  state.phase = 'products';
  state.done = 0; state.total = 0;
  state.error = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;

  try {
    const owners = await fetchActiveProductsWithMetafields();

    // Collect product ids referenced by product_reference metafields that
    // aren't themselves in the active set (archived / draft / deleted refs).
    const ownerIds = new Set(owners.map(p => Number(p.legacyResourceId)));
    const referenced = new Set();
    for (const p of owners) {
      for (const m of p.metafields.nodes) {
        for (const id of refIdsFromValue(m.type, m.value)) {
          if (!ownerIds.has(id)) referenced.add(id);
        }
      }
    }

    state.phase = 'references';
    state.done = 0; state.total = referenced.size;
    const refProducts = referenced.size ? await fetchProductsByIds([...referenced]) : [];

    state.phase = 'saving';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM product_metafields');
      await client.query('DELETE FROM metafield_products');

      const prodRows = [
        ...owners.map(p => productRow(p, true)),
        ...refProducts.map(p => productRow(p, false)),
      ];
      for (let i = 0; i < prodRows.length; i += 200) {
        const chunk = prodRows.slice(i, i + 200);
        const values = [];
        const params = [];
        chunk.forEach((row, j) => {
          const base = j * 9;
          values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9})`);
          params.push(...row);
        });
        await client.query(
          `INSERT INTO metafield_products
             (product_id, title, handle, status, product_type, tracks_inventory, total_inventory, image_url, is_owner)
           VALUES ${values.join(',')}
           ON CONFLICT (product_id) DO UPDATE SET
             title=EXCLUDED.title, handle=EXCLUDED.handle, status=EXCLUDED.status,
             product_type=EXCLUDED.product_type, tracks_inventory=EXCLUDED.tracks_inventory,
             total_inventory=EXCLUDED.total_inventory, image_url=EXCLUDED.image_url,
             is_owner=metafield_products.is_owner OR EXCLUDED.is_owner`,
          params
        );
      }

      let mfCount = 0;
      for (const p of owners) {
        const pid = Number(p.legacyResourceId);
        const rows = p.metafields.nodes;
        for (let i = 0; i < rows.length; i += 100) {
          const chunk = rows.slice(i, i + 100);
          const values = [];
          const params = [];
          chunk.forEach((m, j) => {
            const base = j * 6;
            values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`);
            params.push(pid, m.namespace, m.key, m.type, m.value, m.definition?.name || null);
          });
          await client.query(
            `INSERT INTO product_metafields (product_id, namespace, key, type, value, definition_name)
             VALUES ${values.join(',')}
             ON CONFLICT (product_id, namespace, key) DO UPDATE SET
               type=EXCLUDED.type, value=EXCLUDED.value,
               definition_name=EXCLUDED.definition_name, updated_at=NOW()`,
            params
          );
          mfCount += chunk.length;
        }
      }

      const summary = {
        at: new Date().toISOString(),
        activeProducts: owners.length,
        metafieldRows: mfCount,
        referencedProducts: refProducts.length,
        deletedRefs: referenced.size - refProducts.length,
      };
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('metafields_last_sync', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
        [JSON.stringify(summary)]
      );
      await client.query('COMMIT');

      state.phase = 'done';
      state.lastResult = summary;
      console.log(`[metafields] Sync complete — ${owners.length} products, ${mfCount} metafields, ${refProducts.length} referenced products`);
      return summary;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    state.phase = 'error';
    state.error = err.message;
    console.error('[metafields] Sync failed:', err.message);
    throw err;
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

function startCron(dbPool) {
  pool = dbPool;
  // Daily at 03:15 UTC (1:15pm Brisbane) — after the overnight analytics syncs
  cron.schedule('15 3 * * *', () => {
    syncMetafields().catch(() => {});
  });
  console.log('[metafields] Daily metafield sync scheduled: 15 3 * * *');

  // First-run: if the mirror is empty, import automatically shortly after boot
  setTimeout(async () => {
    try {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM product_metafields');
      if (rows[0].n === 0) {
        console.log('[metafields] Empty mirror — running initial import');
        await syncMetafields();
      }
    } catch (err) {
      console.error('[metafields] Initial import check failed:', err.message);
    }
  }, 20000);
}

module.exports = { startCron, syncMetafields, getStatus, refIdsFromValue, setPool: (p) => { pool = p; } };
