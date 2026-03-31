const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stocktake_history (
      id            SERIAL PRIMARY KEY,
      product_id    BIGINT NOT NULL,
      product_title TEXT NOT NULL,
      initials      TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_stocktake_product_id
      ON stocktake_history(product_id);

    CREATE INDEX IF NOT EXISTS idx_stocktake_created_at
      ON stocktake_history(created_at DESC);

    CREATE TABLE IF NOT EXISTS stock_alerts (
      id            SERIAL PRIMARY KEY,
      variant_id    BIGINT NOT NULL,
      product_title TEXT NOT NULL,
      variant_title TEXT,
      sku           TEXT,
      stock_at_alert INT NOT NULL,
      alerted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved      BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at   TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_stock_alerts_variant
      ON stock_alerts(variant_id);

    CREATE INDEX IF NOT EXISTS idx_stock_alerts_resolved
      ON stock_alerts(resolved, alerted_at DESC);

    CREATE TABLE IF NOT EXISTS stocktake_discrepancies (
      id             SERIAL PRIMARY KEY,
      product_id     BIGINT NOT NULL,
      product_title  TEXT NOT NULL,
      variant_id     BIGINT NOT NULL,
      variant_title  TEXT,
      sku            TEXT,
      system_qty     INT NOT NULL,
      counted_qty    INT NOT NULL,
      difference     INT NOT NULL,
      initials       TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed       BOOLEAN NOT NULL DEFAULT FALSE,
      reviewed_at    TIMESTAMPTZ,
      reviewed_by    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_discrepancies_product
      ON stocktake_discrepancies(product_id);

    CREATE INDEX IF NOT EXISTS idx_discrepancies_reviewed
      ON stocktake_discrepancies(reviewed, created_at DESC);
  `);
}

module.exports = { pool, initDb };
