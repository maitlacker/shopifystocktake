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

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS google_ads_daily (
      id               SERIAL PRIMARY KEY,
      campaign_id      TEXT NOT NULL,
      campaign_name    TEXT NOT NULL,
      campaign_status  TEXT,
      date             DATE NOT NULL,
      impressions      BIGINT NOT NULL DEFAULT 0,
      clicks           BIGINT NOT NULL DEFAULT 0,
      cost             DECIMAL(12,2) NOT NULL DEFAULT 0,
      conversions      DECIMAL(10,2) NOT NULL DEFAULT 0,
      conversion_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_google_ads_daily_date
      ON google_ads_daily(date DESC);

    CREATE INDEX IF NOT EXISTS idx_google_ads_daily_campaign
      ON google_ads_daily(campaign_id, date DESC);

    CREATE TABLE IF NOT EXISTS shopify_daily (
      id         SERIAL PRIMARY KEY,
      date       DATE NOT NULL UNIQUE,
      revenue    DECIMAL(12,2) NOT NULL DEFAULT 0,
      orders     INT NOT NULL DEFAULT 0,
      items_sold INT NOT NULL DEFAULT 0,
      sessions   INT,
      synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_shopify_daily_date
      ON shopify_daily(date DESC);

    CREATE TABLE IF NOT EXISTS pmax_product_coverage (
      id               SERIAL PRIMARY KEY,
      snapshot_date    DATE NOT NULL,
      campaign_id      TEXT NOT NULL,
      campaign_name    TEXT NOT NULL,
      products_serving INT NOT NULL DEFAULT 0,
      shopify_active   INT,
      synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(snapshot_date, campaign_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pmax_coverage_date
      ON pmax_product_coverage(snapshot_date DESC);

    CREATE INDEX IF NOT EXISTS idx_pmax_coverage_campaign
      ON pmax_product_coverage(campaign_id, snapshot_date DESC);

    CREATE TABLE IF NOT EXISTS picking_sessions (
      id                SERIAL PRIMARY KEY,
      user_email        TEXT NOT NULL,
      user_name         TEXT NOT NULL,
      initials          TEXT,
      order_start       INT NOT NULL,
      order_end         INT NOT NULL,
      order_count       INT NOT NULL DEFAULT 0,
      item_count        INT NOT NULL DEFAULT 0,
      picks_completed   INT NOT NULL DEFAULT 0,
      avg_pick_seconds  DECIMAL(8,2),
      active_seconds    INT,
      excluded_gaps     INT NOT NULL DEFAULT 0,
      first_pick_at     TIMESTAMPTZ,
      last_pick_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_picking_sessions_user
      ON picking_sessions(user_email, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_picking_sessions_date
      ON picking_sessions(created_at DESC);
  `);
}

module.exports = { pool, initDb };
