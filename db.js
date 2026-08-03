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

    CREATE TABLE IF NOT EXISTS sku_reference_images (
      id             SERIAL PRIMARY KEY,
      sku            TEXT NOT NULL,
      product_id     TEXT,
      product_title  TEXT,
      variant_title  TEXT,
      image_data     TEXT NOT NULL,
      image_label    TEXT,
      uploaded_by    TEXT NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_ref_images_sku
      ON sku_reference_images(sku);

    CREATE TABLE IF NOT EXISTS scan_log (
      id             SERIAL PRIMARY KEY,
      user_email     TEXT NOT NULL,
      user_name      TEXT NOT NULL,
      sku            TEXT,
      product_title  TEXT,
      variant_title  TEXT,
      confidence     DECIMAL(4,2),
      method         TEXT,
      reasoning      TEXT,
      confirmed      BOOLEAN NOT NULL DEFAULT FALSE,
      confirmed_sku  TEXT,
      scanned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_scan_log_user
      ON scan_log(user_email, scanned_at DESC);

    CREATE INDEX IF NOT EXISTS idx_scan_log_date
      ON scan_log(scanned_at DESC);

    CREATE TABLE IF NOT EXISTS coupon_imports (
      id              SERIAL PRIMARY KEY,
      code            TEXT NOT NULL,
      price_rule_id   BIGINT,
      usage_count     INT DEFAULT 0,
      discount_type   TEXT,
      discount_value  DECIMAL(10,2),
      expires_at      TIMESTAMPTZ,
      expiry_month    TEXT NOT NULL,
      order_id        BIGINT,
      order_name      TEXT,
      customer_name   TEXT,
      customer_email  TEXT,
      imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(code, expiry_month)
    );

    CREATE INDEX IF NOT EXISTS idx_coupon_imports_month
      ON coupon_imports(expiry_month, imported_at DESC);

    CREATE INDEX IF NOT EXISTS idx_coupon_imports_order
      ON coupon_imports(order_id);

    CREATE TABLE IF NOT EXISTS margin_tags (
      id            SERIAL PRIMARY KEY,
      product_id    BIGINT NOT NULL,
      variant_id    BIGINT NOT NULL,
      product_title TEXT NOT NULL,
      variant_title TEXT,
      sku           TEXT,
      cost_price    DECIMAL(10,2),
      sell_price    DECIMAL(10,2),
      markup        DECIMAL(10,2),
      margin_tier   TEXT NOT NULL DEFAULT 'UNKNOWN',
      synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(variant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_margin_tags_product
      ON margin_tags(product_id);

    CREATE INDEX IF NOT EXISTS idx_margin_tags_tier
      ON margin_tags(margin_tier);

    CREATE TABLE IF NOT EXISTS gift_card_imports (
      id              SERIAL PRIMARY KEY,
      gift_card_id    BIGINT NOT NULL UNIQUE,
      last_characters TEXT,
      initial_value   DECIMAL(10,2),
      balance         DECIMAL(10,2),
      currency        TEXT DEFAULT 'AUD',
      expires_on      DATE,
      expiry_month    TEXT NOT NULL,
      order_id        BIGINT,
      order_name      TEXT,
      customer_id     BIGINT,
      customer_name   TEXT,
      customer_email  TEXT,
      imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_gift_card_imports_month
      ON gift_card_imports(expiry_month, imported_at DESC);

    CREATE INDEX IF NOT EXISTS idx_gift_card_imports_order
      ON gift_card_imports(order_id);

    CREATE TABLE IF NOT EXISTS velocity_insights (
      id                SERIAL PRIMARY KEY,
      period_days       INT NOT NULL,
      products_analysed INT NOT NULL DEFAULT 0,
      hot_json          JSONB NOT NULL DEFAULT '{}',
      not_hot_json      JSONB NOT NULL DEFAULT '{}',
      model_used        TEXT,
      generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_velocity_insights_period
      ON velocity_insights(period_days, generated_at DESC);

    CREATE TABLE IF NOT EXISTS velocity_ideas (
      id                SERIAL PRIMARY KEY,
      period_days       INT NOT NULL,
      products_analysed INT NOT NULL DEFAULT 0,
      headline          TEXT,
      ideas_json        JSONB NOT NULL DEFAULT '[]',
      model_used        TEXT,
      generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_velocity_ideas_period
      ON velocity_ideas(period_days, generated_at DESC);

    CREATE TABLE IF NOT EXISTS meta_ads_daily (
      id               SERIAL PRIMARY KEY,
      campaign_id      TEXT NOT NULL,
      campaign_name    TEXT NOT NULL,
      adset_id         TEXT,
      adset_name       TEXT,
      date             DATE NOT NULL,
      spend            DECIMAL(12,2) NOT NULL DEFAULT 0,
      impressions      BIGINT NOT NULL DEFAULT 0,
      clicks           BIGINT NOT NULL DEFAULT 0,
      reach            BIGINT NOT NULL DEFAULT 0,
      purchases        DECIMAL(10,2) NOT NULL DEFAULT 0,
      purchase_value   DECIMAL(12,2) NOT NULL DEFAULT 0,
      synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, date)
    );

    CREATE INDEX IF NOT EXISTS idx_meta_ads_daily_date
      ON meta_ads_daily(date DESC);

    CREATE INDEX IF NOT EXISTS idx_meta_ads_daily_campaign
      ON meta_ads_daily(campaign_id, date DESC);

    CREATE TABLE IF NOT EXISTS xero_financials (
      id           SERIAL PRIMARY KEY,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      report_type  TEXT NOT NULL DEFAULT 'ProfitAndLoss',
      revenue      DECIMAL(14,2) NOT NULL DEFAULT 0,
      cogs         DECIMAL(14,2) NOT NULL DEFAULT 0,
      gross_profit DECIMAL(14,2) NOT NULL DEFAULT 0,
      expenses     DECIMAL(14,2) NOT NULL DEFAULT 0,
      net_profit   DECIMAL(14,2) NOT NULL DEFAULT 0,
      raw_json     JSONB NOT NULL DEFAULT '{}',
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(period_start, period_end, report_type)
    );

    CREATE INDEX IF NOT EXISTS idx_xero_financials_period
      ON xero_financials(period_start DESC);

    CREATE TABLE IF NOT EXISTS xero_tenants (
      tenant_id       TEXT PRIMARY KEY,
      tenant_name     TEXT NOT NULL,
      access_token    TEXT,
      refresh_token   TEXT,
      token_expiry    TIMESTAMPTZ,
      connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS xero_pl_lines (
      id           SERIAL PRIMARY KEY,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      section      TEXT NOT NULL,
      account_name TEXT NOT NULL,
      value        DECIMAL(14,2) NOT NULL DEFAULT 0,
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(period_start, section, account_name)
    );

    CREATE INDEX IF NOT EXISTS idx_xero_pl_lines_period
      ON xero_pl_lines(period_start DESC);

    CREATE TABLE IF NOT EXISTS xero_balance_sheet (
      id           SERIAL PRIMARY KEY,
      report_date  DATE NOT NULL,
      section      TEXT NOT NULL,
      subsection   TEXT,
      account_name TEXT NOT NULL,
      value        DECIMAL(14,2) NOT NULL DEFAULT 0,
      synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(report_date, section, account_name)
    );

    CREATE INDEX IF NOT EXISTS idx_xero_balance_sheet_date
      ON xero_balance_sheet(report_date DESC);

    CREATE TABLE IF NOT EXISTS weekly_pulse_reports (
      id           SERIAL PRIMARY KEY,
      period_start DATE NOT NULL,
      period_end   DATE NOT NULL,
      content      TEXT NOT NULL,
      model_used   TEXT,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_weekly_pulse_generated
      ON weekly_pulse_reports(generated_at DESC);

    CREATE TABLE IF NOT EXISTS picked_orders (
      id               SERIAL PRIMARY KEY,
      order_name       TEXT NOT NULL UNIQUE,
      picker_initials  TEXT,
      picked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_picked_orders_picked_at
      ON picked_orders(picked_at DESC);

    -- Shared picking batches: multiple devices picking the same range share one job
    CREATE TABLE IF NOT EXISTS picking_jobs (
      id           SERIAL PRIMARY KEY,
      order_start  INT NOT NULL,
      order_end    INT NOT NULL,
      created_by   TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_picking_jobs_range
      ON picking_jobs(order_start, order_end, created_at DESC);

    -- Per-item pick state within a job
    CREATE TABLE IF NOT EXISTS picking_item_states (
      id           SERIAL PRIMARY KEY,
      job_id       INT NOT NULL REFERENCES picking_jobs(id) ON DELETE CASCADE,
      order_number INT NOT NULL,
      variant_id   BIGINT NOT NULL,
      picked       BOOLEAN NOT NULL DEFAULT false,
      picked_by    TEXT,
      picked_at    TIMESTAMPTZ,
      UNIQUE(job_id, order_number, variant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_picking_item_states_job
      ON picking_item_states(job_id);

    -- ── Packing Audit ────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS packing_audit (
      id               SERIAL PRIMARY KEY,
      order_number     INT NOT NULL,
      order_name       TEXT NOT NULL,
      initials         TEXT,
      customer_name    TEXT,
      total_items      INT,
      range_start      INT,
      range_end        INT,
      started_at       TIMESTAMPTZ NOT NULL,
      packed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pack_taps        INT NOT NULL DEFAULT 0,
      nav_events       INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_packing_audit_packed_at
      ON packing_audit(packed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_packing_audit_initials
      ON packing_audit(initials, packed_at DESC);

    -- ── Restock Planner ──────────────────────────────────────────────

    -- Global defaults (singleton row, id=1 always)
    CREATE TABLE IF NOT EXISTS restock_settings (
      id              INT PRIMARY KEY DEFAULT 1,
      sea_lead_days   INT NOT NULL DEFAULT 49,
      air_lead_days   INT NOT NULL DEFAULT 28,
      cover_weeks     INT NOT NULL DEFAULT 8,
      velocity_days   INT NOT NULL DEFAULT 42,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO restock_settings (id, sea_lead_days, air_lead_days, cover_weeks, velocity_days)
      VALUES (1, 49, 28, 8, 42) ON CONFLICT DO NOTHING;
    -- Migration: update default lead days if still at old shipped defaults
    UPDATE restock_settings SET sea_lead_days=49, air_lead_days=28, updated_at=NOW()
      WHERE id=1 AND sea_lead_days=60 AND air_lead_days=14;

    -- Per-style lead-time overrides and restock toggle
    CREATE TABLE IF NOT EXISTS product_restock_config (
      product_id      BIGINT PRIMARY KEY,
      product_title   TEXT NOT NULL DEFAULT '',
      sea_lead_days   INT,
      air_lead_days   INT,
      cover_weeks     INT,
      restock_enabled BOOL NOT NULL DEFAULT true,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Active purchase orders (qty_by_variant keyed by variant title)
    CREATE TABLE IF NOT EXISTS restock_orders (
      id                SERIAL PRIMARY KEY,
      product_id        BIGINT NOT NULL,
      product_title     TEXT NOT NULL,
      freight_mode      TEXT NOT NULL CHECK (freight_mode IN ('sea','air')),
      ordered_at        DATE NOT NULL,
      expected_delivery DATE NOT NULL,
      qty_by_variant    JSONB NOT NULL DEFAULT '{}',
      total_qty         INT NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','received','cancelled')),
      notes             TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_restock_orders_product
      ON restock_orders(product_id, status);
    CREATE INDEX IF NOT EXISTS idx_restock_orders_delivery
      ON restock_orders(expected_delivery) WHERE status = 'pending';

    -- One row per product per alert type; cleared when order is received
    CREATE TABLE IF NOT EXISTS restock_alerts_log (
      id             SERIAL PRIMARY KEY,
      product_id     BIGINT NOT NULL,
      product_title  TEXT NOT NULL DEFAULT '',
      alert_type     TEXT NOT NULL,
      rating         TEXT,
      days_remaining INT,
      alerted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, alert_type)
    );
    CREATE INDEX IF NOT EXISTS idx_restock_alerts_log_product
      ON restock_alerts_log(product_id);

    -- ── Production / Purchase Orders ─────────────────────────────────

    CREATE TABLE IF NOT EXISTS suppliers (
      id            SERIAL PRIMARY KEY,
      company_name  TEXT NOT NULL,
      location      TEXT,
      currency      TEXT NOT NULL DEFAULT 'AUD',
      contact_name  TEXT,
      email         TEXT,
      phone         TEXT,
      notes         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_suppliers_name
      ON suppliers(company_name);

    CREATE TABLE IF NOT EXISTS production_orders (
      id              SERIAL PRIMARY KEY,
      po_number       TEXT NOT NULL,
      supplier_id     INT,
      supplier_name   TEXT NOT NULL DEFAULT '',
      order_date      DATE NOT NULL DEFAULT CURRENT_DATE,
      delivery_date   DATE,
      freight_mode    TEXT NOT NULL DEFAULT 'sea'
                      CHECK (freight_mode IN ('sea','air')),
      currency        TEXT NOT NULL DEFAULT 'AUD',
      exchange_rate   DECIMAL(10,4) NOT NULL DEFAULT 1.0,
      shipping_cost   DECIMAL(12,2) NOT NULL DEFAULT 0,
      include_gst     BOOLEAN NOT NULL DEFAULT FALSE,
      status          TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','confirmed','received','cancelled')),
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_production_orders_supplier
      ON production_orders(supplier_id);
    CREATE INDEX IF NOT EXISTS idx_production_orders_date
      ON production_orders(order_date DESC);

    CREATE TABLE IF NOT EXISTS production_order_lines (
      id               SERIAL PRIMARY KEY,
      order_id         INT NOT NULL,
      line_number      INT NOT NULL DEFAULT 1,
      line_type        TEXT NOT NULL DEFAULT 'restock'
                       CHECK (line_type IN ('restock','new')),
      product_id       BIGINT,
      product_code     TEXT,
      product_name     TEXT NOT NULL DEFAULT '',
      size_set         TEXT NOT NULL DEFAULT 'numeric',
      quantities       JSONB NOT NULL DEFAULT '{}',
      total_qty        INT NOT NULL DEFAULT 0,
      unit_price       DECIMAL(12,2) NOT NULL DEFAULT 0,
      freight_override TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_po_lines_order
      ON production_order_lines(order_id, line_number);

    CREATE TABLE IF NOT EXISTS production_budgets (
      id         SERIAL PRIMARY KEY,
      year       INT NOT NULL,
      month      INT NOT NULL CHECK (month BETWEEN 1 AND 12),
      budget_aud DECIMAL(14,2) NOT NULL DEFAULT 0,
      notes      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(year, month)
    );
    CREATE INDEX IF NOT EXISTS idx_production_budgets_year
      ON production_budgets(year, month);

    CREATE TABLE IF NOT EXISTS stock_value_history (
      id            SERIAL PRIMARY KEY,
      date          DATE NOT NULL,
      total_rrp     DECIMAL(14,2) NOT NULL DEFAULT 0,
      total_cost    DECIMAL(14,2) NOT NULL DEFAULT 0,
      variant_count INT NOT NULL DEFAULT 0,
      synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(date)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_value_date
      ON stock_value_history(date DESC);

    CREATE TABLE IF NOT EXISTS google_ads_assets (
      id                SERIAL PRIMARY KEY,
      shopify_image_id  TEXT NOT NULL UNIQUE,
      product_id        TEXT,
      product_title     TEXT,
      image_url         TEXT,
      asset_name        TEXT,
      resource_name     TEXT,
      image_role        TEXT,
      synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Migration guard: add image_role if table already exists without it
    ALTER TABLE google_ads_assets ADD COLUMN IF NOT EXISTS image_role TEXT;
    CREATE INDEX IF NOT EXISTS idx_google_ads_assets_product
      ON google_ads_assets(product_id);
    CREATE INDEX IF NOT EXISTS idx_google_ads_assets_synced
      ON google_ads_assets(synced_at DESC);

    CREATE TABLE IF NOT EXISTS warehouse_layout (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      layout_json JSONB   NOT NULL DEFAULT '{}',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_locations (
      id           SERIAL PRIMARY KEY,
      product_id   VARCHAR NOT NULL,
      variant_id   VARCHAR NOT NULL DEFAULT '',
      aisle        INTEGER,
      bay          INTEGER,
      excess_loc   TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(product_id, variant_id)
    );

    CREATE TABLE IF NOT EXISTS creative_products (
      id                  SERIAL PRIMARY KEY,
      shopify_product_id  TEXT NOT NULL UNIQUE,
      title               TEXT,
      vendor              TEXT,
      product_type        TEXT,
      tags                TEXT,
      description         TEXT,
      price               NUMERIC(10,2),
      compare_at_price    NUMERIC(10,2),
      images              JSONB NOT NULL DEFAULT '[]',
      collections         JSONB NOT NULL DEFAULT '[]',
      inventory_count     INT DEFAULT 0,
      is_available        BOOLEAN DEFAULT TRUE,
      synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_creative_products_shopify
      ON creative_products(shopify_product_id);
    CREATE INDEX IF NOT EXISTS idx_creative_products_synced
      ON creative_products(synced_at DESC);

    CREATE TABLE IF NOT EXISTS creative_jobs (
      id                   SERIAL PRIMARY KEY,
      job_type             TEXT NOT NULL DEFAULT 'single',
      shopify_product_ids  TEXT[] NOT NULL DEFAULT '{}',
      template_type        TEXT,
      arcads_job_id        TEXT,
      status               TEXT NOT NULL DEFAULT 'queued',
      brief                JSONB NOT NULL DEFAULT '{}',
      result_urls          JSONB NOT NULL DEFAULT '[]',
      error_message        TEXT,
      created_by           TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_creative_jobs_status
      ON creative_jobs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_creative_jobs_arcads
      ON creative_jobs(arcads_job_id);

    CREATE TABLE IF NOT EXISTS leave_employees (
      id                SERIAL PRIMARY KEY,
      xero_employee_id  TEXT NOT NULL UNIQUE,
      first_name        TEXT,
      last_name         TEXT,
      xero_email        TEXT,
      wms_email         TEXT,
      is_active         BOOLEAN DEFAULT TRUE,
      synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE leave_employees ADD COLUMN IF NOT EXISTS is_casual BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_leave_employees_wms
      ON leave_employees(wms_email);

    CREATE TABLE IF NOT EXISTS leave_requests (
      id               SERIAL PRIMARY KEY,
      employee_id      INTEGER REFERENCES leave_employees(id),
      wms_email        TEXT NOT NULL,
      start_date       DATE NOT NULL,
      end_date         DATE NOT NULL,
      days_count       NUMERIC(4,1),
      notes            TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      approved_by      TEXT,
      approved_at      TIMESTAMPTZ,
      reject_reason    TEXT,
      xero_leave_id    TEXT,
      xero_status      TEXT,
      xero_error       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_leave_requests_email
      ON leave_requests(wms_email);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_dates
      ON leave_requests(start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_leave_requests_status
      ON leave_requests(status);

    CREATE TABLE IF NOT EXISTS leave_blackouts (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      start_date  DATE NOT NULL,
      end_date    DATE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_leave_blackouts_dates
      ON leave_blackouts(start_date, end_date);

    CREATE TABLE IF NOT EXISTS leave_public_holidays (
      id        SERIAL PRIMARY KEY,
      date      DATE NOT NULL,
      name      TEXT NOT NULL,
      year      INT NOT NULL,
      state     TEXT NOT NULL DEFAULT 'QLD',
      UNIQUE(date, state)
    );
    CREATE INDEX IF NOT EXISTS idx_leave_public_holidays_date
      ON leave_public_holidays(date);

    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_sea INT;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS lead_time_air INT;

    ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS po_type TEXT NOT NULL DEFAULT 'restock';
    ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS is_collection BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS collection_name TEXT;
    ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS launch_type TEXT NOT NULL DEFAULT '';

    -- ── Forecast & Budget ─────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS forecast_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS forecast_monthly_budgets (
      id             SERIAL PRIMARY KEY,
      year           INT  NOT NULL,
      month          INT  NOT NULL,
      meta_planned        DECIMAL(12,2),
      google_planned      DECIMAL(12,2),
      opex_planned        DECIMAL(12,2),
      purchasing_planned  DECIMAL(12,2),
      notes          TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(year, month)
    );
    ALTER TABLE forecast_monthly_budgets ADD COLUMN IF NOT EXISTS purchasing_planned DECIMAL(12,2);

    CREATE TABLE IF NOT EXISTS asana_po_mapping (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      config     JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sellthrough_alerts_log (
      product_id        TEXT NOT NULL PRIMARY KEY,
      product_title     TEXT NOT NULL DEFAULT '',
      tier              TEXT NOT NULL,
      sell_through_pct  NUMERIC(5,2),
      alerted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── Stock Receipt Forms (SRF) ─────────────────────────────────────

    CREATE TABLE IF NOT EXISTS srf_size_groups (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      sizes      JSONB NOT NULL DEFAULT '[]',
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS srf_form_types (
      id                 SERIAL PRIMARY KEY,
      name               TEXT NOT NULL UNIQUE,
      measurement_fields JSONB NOT NULL DEFAULT '[]',
      sort_order         INT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO srf_size_groups (name, sizes, is_default, sort_order) VALUES
      ('Clothing Numeric 6-20', '["6","8","10","12","14","16","18","20"]', true, 1),
      ('Clothing Letter XS-XXXL', '["XS","S","M","L","XL","XXL","XXXL"]', false, 2),
      ('Jeans 6-18', '["6","7","8","9","10","11","12","14","16","18"]', false, 3),
      ('Shoes 35-42', '["35","36","37","38","39","40","41","42"]', false, 4),
      ('Accessories ONE SIZE', '["ONE SIZE"]', false, 5)
    ON CONFLICT (name) DO NOTHING;

    -- Migrate old Jeans 24-34 row only if Jeans 6-18 was not just inserted
    UPDATE srf_size_groups
    SET name='Jeans 6-18', sizes='["6","7","8","9","10","11","12","14","16","18"]'
    WHERE name='Jeans 24-34'
      AND NOT EXISTS (SELECT 1 FROM srf_size_groups WHERE name='Jeans 6-18');

    INSERT INTO srf_form_types (name, measurement_fields, sort_order) VALUES
      ('Tops/Dresses', '["Bust/Chest","Body Length","Hem Width","Sleeve Length","Shoulder Width"]', 1),
      ('Bottoms', '["Waist","Hip","Thigh","Inseam","Rise"]', 2),
      ('Jeans', '["Waist","Hip","Thigh","Inseam","Rise"]', 3),
      ('Accessories', '["Width","Height","Depth"]', 4),
      ('Shoes', '["Insole Length"]', 5)
    ON CONFLICT (name) DO NOTHING;

    CREATE TABLE IF NOT EXISTS stock_receipts (
      id                     SERIAL PRIMARY KEY,
      form_type_id           INT REFERENCES srf_form_types(id),
      form_type_name         TEXT,
      size_group_id          INT REFERENCES srf_size_groups(id),
      size_group_name        TEXT,
      receipt_type           TEXT NOT NULL DEFAULT 'restock',
      style_name             TEXT,
      supplier               TEXT,
      invoice_number         TEXT,
      po_number              TEXT,
      po_id                  INT,
      product_code           TEXT,
      shopify_product_id     BIGINT,
      shopify_product_title  TEXT,
      receipt_date           DATE,
      processed_by           TEXT,
      stock_matches_invoice  BOOLEAN,
      on_rack_for_photoshoot BOOLEAN,
      cost_price             NUMERIC(10,2),
      discount_percent       NUMERIC(5,2),
      freight_price          NUMERIC(10,2),
      final_price            NUMERIC(10,2),
      fabric                 TEXT,
      stretch_allowance      TEXT,
      product_features       JSONB NOT NULL DEFAULT '[]',
      notes                  TEXT,
      status                 TEXT NOT NULL DEFAULT 'draft',
      completed_at           TIMESTAMPTZ,
      completed_by           TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by             TEXT,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_stock_receipts_status
      ON stock_receipts(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_receipts_form_type
      ON stock_receipts(form_type_id);

    -- Remove the leftover Jeans 24-34 group on DBs where Jeans 6-18 already
    -- existed (the rename above is skipped there, leaving both rows).
    -- Repoint any receipts referencing it first to satisfy the FK.
    UPDATE stock_receipts
      SET size_group_id = (SELECT id FROM srf_size_groups WHERE name='Jeans 6-18')
      WHERE size_group_id IN (SELECT id FROM srf_size_groups WHERE name='Jeans 24-34');
    DELETE FROM srf_size_groups WHERE name='Jeans 24-34';

    CREATE TABLE IF NOT EXISTS stock_receipt_sizes (
      id           SERIAL PRIMARY KEY,
      receipt_id   INT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
      size_label   TEXT NOT NULL,
      sort_order   INT NOT NULL DEFAULT 0,
      qty          INT,
      measurements JSONB NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_srf_sizes_receipt
      ON stock_receipt_sizes(receipt_id, sort_order);

    CREATE TABLE IF NOT EXISTS stock_receipt_photos (
      id           SERIAL PRIMARY KEY,
      receipt_id   INT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
      filename     TEXT,
      data         TEXT NOT NULL,
      uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      uploaded_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_srf_photos_receipt
      ON stock_receipt_photos(receipt_id);

    CREATE TABLE IF NOT EXISTS stock_receipt_audit (
      id          SERIAL PRIMARY KEY,
      receipt_id  INT NOT NULL REFERENCES stock_receipts(id) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      field_name  TEXT,
      old_value   TEXT,
      new_value   TEXT,
      changed_by  TEXT NOT NULL DEFAULT 'system',
      changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_srf_audit_receipt
      ON stock_receipt_audit(receipt_id, changed_at DESC);

    ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMPTZ;
    ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS deleted_by  TEXT;
    ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS archived_by TEXT;

    -- ── Incorrect Orders (Customer Service) ──────────────────────────

    CREATE TABLE IF NOT EXISTS incorrect_orders (
      id                     SERIAL PRIMARY KEY,
      order_number           TEXT NOT NULL,
      shopify_order_id       BIGINT,
      shopify_order_note     TEXT,
      customer_name          TEXT,
      reported_date          DATE NOT NULL DEFAULT CURRENT_DATE,
      correct_item           TEXT,
      correct_product_id     BIGINT,
      correct_stock_counted  BOOLEAN NOT NULL DEFAULT FALSE,
      received_item          TEXT,
      received_product_id    BIGINT,
      received_stock_counted BOOLEAN NOT NULL DEFAULT FALSE,
      pick_pack_notes        TEXT,
      notes                  TEXT,
      status                 TEXT NOT NULL DEFAULT 'open',
      resolution             TEXT,
      replacement_order      TEXT,
      slack_notified_at      TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by             TEXT,
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by             TEXT,
      deleted_at             TIMESTAMPTZ,
      deleted_by             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_incorrect_orders_status
      ON incorrect_orders(status, reported_date DESC);
    CREATE INDEX IF NOT EXISTS idx_incorrect_orders_order_number
      ON incorrect_orders(order_number);

    CREATE TABLE IF NOT EXISTS incorrect_order_notes (
      id         SERIAL PRIMARY KEY,
      order_id   INT NOT NULL REFERENCES incorrect_orders(id) ON DELETE CASCADE,
      note       TEXT NOT NULL,
      added_by   TEXT NOT NULL,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_incorrect_order_notes_order
      ON incorrect_order_notes(order_id, added_at DESC);

    CREATE TABLE IF NOT EXISTS influencer_campaigns (
      id                    SERIAL PRIMARY KEY,
      creator_name          TEXT NOT NULL,
      creator_handle        TEXT,
      post_datetime         TIMESTAMPTZ,
      cta_used              TEXT,
      hook                  TEXT,
      ad_live_start         DATE,
      ad_live_end           DATE,
      influencer_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,
      discount_code         TEXT,
      reporting_window_days INT NOT NULL DEFAULT 14,
      post_url              TEXT,
      content_type          TEXT,
      status                TEXT NOT NULL DEFAULT 'planned',
      notes                 TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by            TEXT,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by            TEXT,
      deleted_at            TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_influencer_campaigns_status
      ON influencer_campaigns(status, post_datetime DESC);

    CREATE TABLE IF NOT EXISTS influencer_campaign_products (
      id            SERIAL PRIMARY KEY,
      campaign_id   INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      product_id    BIGINT NOT NULL,
      product_title TEXT NOT NULL,
      image_url     TEXT,
      UNIQUE(campaign_id, product_id)
    );

    CREATE TABLE IF NOT EXISTS influencer_inventory_snapshots (
      id                 SERIAL PRIMARY KEY,
      campaign_id        INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      product_id         BIGINT NOT NULL,
      variant_id         BIGINT NOT NULL,
      variant_title      TEXT,
      sku                TEXT,
      snapshot_date      DATE NOT NULL,
      inventory_quantity INT NOT NULL,
      UNIQUE(campaign_id, variant_id, snapshot_date)
    );

    CREATE TABLE IF NOT EXISTS influencer_organic_metrics (
      id              SERIAL PRIMARY KEY,
      campaign_id     INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      source          TEXT NOT NULL DEFAULT 'manual',
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      captured_by     TEXT,
      reach           INT,
      views           INT,
      impressions     INT,
      likes           INT,
      comments        INT,
      shares          INT,
      saves           INT,
      profile_visits  INT,
      link_clicks     INT,
      engagement_rate NUMERIC(6,3),
      raw_json        JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_influencer_organic_campaign
      ON influencer_organic_metrics(campaign_id, captured_at DESC);

    CREATE TABLE IF NOT EXISTS influencer_campaign_ads (
      id                 SERIAL PRIMARY KEY,
      campaign_id        INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      ad_id              TEXT NOT NULL,
      ad_name            TEXT,
      adset_id           TEXT,
      adset_name         TEXT,
      campaign_meta_id   TEXT,
      campaign_meta_name TEXT,
      creative_id        TEXT,
      creative_thumb_url TEXT,
      UNIQUE(campaign_id, ad_id)
    );

    CREATE TABLE IF NOT EXISTS influencer_ad_insights_daily (
      id                  SERIAL PRIMARY KEY,
      ad_id               TEXT NOT NULL,
      date                DATE NOT NULL,
      spend               NUMERIC(10,2) DEFAULT 0,
      impressions         INT DEFAULT 0,
      clicks              INT DEFAULT 0,
      reach               INT DEFAULT 0,
      frequency           NUMERIC(8,3),
      purchases           INT DEFAULT 0,
      purchase_value      NUMERIC(12,2) DEFAULT 0,
      video_3s_views      INT,
      thruplays           INT,
      video_p100          INT,
      ctr                 NUMERIC(8,4),
      cpc                 NUMERIC(10,4),
      cpm                 NUMERIC(10,4),
      attribution_setting TEXT,
      synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(ad_id, date)
    );

    CREATE TABLE IF NOT EXISTS influencer_sales_cache (
      campaign_id      INT PRIMARY KEY REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      computed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      window_start     TIMESTAMPTZ,
      window_end       TIMESTAMPTZ,
      summary          JSONB,
      product_perf     JSONB,
      combos           JSONB,
      code_attribution JSONB,
      baseline         JSONB
    );

    CREATE TABLE IF NOT EXISTS influencer_insights (
      id          SERIAL PRIMARY KEY,
      campaign_id INT REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
      content     TEXT NOT NULL,
      model_used  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

module.exports = { pool, initDb };
