# CLAUDE.md — The Self Styler WMS

> Briefing document for any developer (human or AI) taking over this project.
> Updated 2026-05-20 to reflect current codebase state.

---

## 1. Project Overview and Purpose

**The Self Styler WMS** is a private, internal Warehouse Management Studio built for The Self Styler (an Australian e-commerce fashion retailer). It is Railway-hosted so warehouse staff can access it from any device (especially iPads).

The primary users are warehouse pickers, stocktake staff, and management. All pages are behind Google OAuth restricted to `@theselfstyler.com` email addresses only.

Core jobs this application does:
- **Stocktake** — search Shopify products, count physical stock, record discrepancies
- **Order Picking** — load a range of Shopify orders, render a pick list for warehouse staff with double-tap completion tracking
- **Sales Velocity** — flag products that are critically low, dead stock, or imbalanced across variants
- **Discrepancy Reporting** — track and review all stocktake discrepancies over time
- **Draft/Archived Stock** — surface products that are draft/archived but still have stock on hand
- **Restock Planner** — sea/air lead-time planning, purchase orders, low-stock alerts to Slack
- **Total Stock Value** — daily snapshot of inventory value at RRP and cost price (line graph)
- **Shopify Daily Analytics** — revenue, orders, items sold, sessions per day with copy-paste to Google Sheets
- **Google Ads** — campaign performance, ROAS tracking, sheet export, PMAX product coverage monitoring
- **Meta Ads** — Facebook/Instagram campaign performance dashboard
- **Xero Financials** — P&L and balance sheet data synced from Xero
- **BI Dashboard** — high-level business intelligence (restricted to accounts@/bianca@)
- **Weekly Pulse** — AI-generated weekly business narrative (restricted)
- **Scanner** — barcode/label scanning with AI-powered SKU matching and reference image library
- **Production Orders** — purchase order management with supplier records and monthly budgets
- **Marketing / Coupon Export** — import/match/export 360REFUND# Shopify discount codes for Klaviyo
- **Gift Card Export** — import/match/export Shopify gift cards expiring in a given month
- **Margin Tagger** — tag Shopify products with margin tier labels
- **EDM Builder** — AI-powered Klaviyo email campaign builder with Shopify product integration
- **Stock Alerts** — Slack notifications when a variant drops to ≤5 units
- **Picking Performance** — per-staff timing metrics with an admin-only report

---

## 2. Tech Stack and Key Dependencies

**Runtime:** Node.js ≥18, Express 4

**Database:** PostgreSQL (hosted on Railway), accessed via `pg` pool with `connect-pg-simple` for session storage.

**Auth:** `passport` + `passport-google-oauth20`. Domain restricted to `@theselfstyler.com` via the `hd` hint parameter and a server-side email check.

**Scheduling:** `node-cron` — multiple cron jobs running inside the same process (stock alerts, Google Ads sync, Shopify analytics sync, restock sync, stock value sync, weekly pulse, etc.).

**HTTP client:** `node-fetch` v2 (CommonJS). Used for all Shopify API, Google Ads API, Meta Ads API, Xero API, Google OAuth token refresh, Anthropic API proxy, and Slack webhook calls.

**AI:** `@anthropic-ai/sdk` — used server-side for EDM Builder (`claude-sonnet-4-5`), velocity insights, and weekly pulse generation. API key is server-side only; never exposed to the client.

**Frontend:** Vanilla HTML/CSS/JS — no framework, no bundler, no TypeScript. All JS files are plain scripts served statically from `public/`. This is intentional — keep it simple for a small internal tool.

**Deployment:** Railway (auto-deploys from GitHub `master` branch on push). PostgreSQL is a Railway-managed add-on service.

**Key `package.json` dependencies:**
```
express, express-session, connect-pg-simple
passport, passport-google-oauth20
pg
node-cron
node-fetch@^2   ← must stay v2 (CommonJS); v3 is ESM only
@anthropic-ai/sdk
dotenv
```

---

## 3. Architecture and Folder Structure

```
shopifystocktake/
├── server.js               ← Single Express app — ALL API routes live here
├── db.js                   ← PostgreSQL pool + initDb() — creates all tables on startup
├── auth.js                 ← Passport config, requireAuth middleware, /auth/google routes
├── alerts.js               ← Low-stock alert cron (≤5 units → Slack), 30-min schedule
├── google-ads-sync.js      ← Google Ads REST API client, sync logic, PMAX coverage
├── meta-ads-sync.js        ← Meta (Facebook) Ads API client and sync
├── shopify-analytics.js    ← Shopify orders + ShopifyQL sessions aggregation
├── stock-value-sync.js     ← Daily inventory value snapshot (RRP + cost), cron at 03:00
├── restock-sync.js         ← Restock planner: velocity calc, sea/air alerts, Slack
├── xero-sync.js            ← Xero P&L + balance sheet sync via Xero API
├── weekly-pulse.js         ← AI-generated weekly business narrative (Claude)
├── ideas-cron.js           ← AI velocity insights/ideas cron
├── label-matcher.js        ← AI-powered barcode/label → SKU matching (Claude vision)
├── ops-sync.js             ← Operational sync helpers
├── package.json
├── .env                    ← Local dev secrets (never committed)
│
└── public/                 ← All static frontend files (served by Express)
    ├── style.css           ← Single shared stylesheet for all pages
    ├── nav.js              ← Shared nav injected into every page's <header>
    │
    ├── index.html / stocktake.html / app.js   ← Stocktake page
    ├── picking.html / picking.js              ← Order picking page
    ├── picking-report.html / picking-report.js ← Admin-only picking metrics
    ├── velocity.html / velocity.js            ← Sales velocity report
    ├── history.html / history.js              ← Stocktake history log
    ├── discrepancies.html / discrepancies.js  ← Discrepancy review workflow
    ├── draft-report.html / draft-report.js    ← Draft/archived products with stock
    ├── restock.html / restock.js              ← Restock planner
    ├── total-stock.html / total-stock.js      ← Daily inventory value chart
    ├── syncing.html / syncing.js              ← Sync management hub
    ├── shopify-report.html / shopify-report.js ← Daily analytics + sheet export
    ├── google-ads.html / google-ads.js        ← Google Ads dashboard + PMAX monitor
    ├── bi-dashboard.html / bi-dashboard.js    ← BI Dashboard (restricted)
    ├── weekly-pulse.html / weekly-pulse.js    ← Weekly pulse report (restricted)
    ├── label-scanner.html / label-scanner.js  ← Barcode/label scanner
    ├── label-reference.html / label-reference.js ← SKU reference image library
    ├── scan-history.html / scan-history.js    ← Scanner history log
    ├── coupon-export.html / coupon-export.js  ← 360REFUND# coupon export for Klaviyo
    ├── gift-card-export.html / gift-card-export.js ← Gift card export for Klaviyo
    ├── margin-tagger.html / margin-tagger.js  ← Margin tier tagger
    ├── edm-builder.html / edm-builder.js      ← AI email campaign builder
    ├── suppliers.html / suppliers.js          ← Supplier CRM
    ├── production-orders.html / production-orders.js ← PO list
    ├── production-order.html / production-order.js   ← PO detail/edit
    ├── production-budget.html / production-budget.js ← Monthly production budgets
    └── login.html                             ← Public login page (only unauthenticated page)
```

**Key architectural patterns:**

- **All API routes in `server.js`** — no Express Router abstraction. Routes are grouped by domain with comment banners (e.g. `// ── Coupon Export ──`).
- **Modules for background work** — each module (`alerts.js`, `google-ads-sync.js`, etc.) exports `startCron()` called once in `initDb().then()` at startup.
- **`nav.js` pattern** — every HTML page has `<header></header>` + `<script src="nav.js"></script>` at the bottom. `nav.js` injects the full nav HTML, fetches `/api/me`, and redirects to `/login` on 401.
- **In-memory products cache** — `productsCache` / `lastFetched` in `server.js`. Resets on restart. Auto-fetches on first request if empty.
- **New DB tables reach production via `initDb()`** — add the `CREATE TABLE IF NOT EXISTS` SQL to `db.js`, commit and push, Railway restarts and creates it. No separate migration tool.

---

## 4. Nav Groups (as at 2026-05-20)

| Group | Pages |
|-------|-------|
| **Stocktake** | Stocktake, Order Picking, Discrepancy Report, Draft & Archived Stock, History |
| **Reports** | BI Dashboard *(restricted)*, Weekly Pulse *(restricted)*, Sales Velocity, Total Stock Value, Restock Planner, Shopify Daily Report, Google Ads, Picking Performance |
| **Scanner** | Scan Label, Reference Images, Scan History |
| **Syncing** | Manage Syncs |
| **Production** | Production Orders, Monthly Budgets, Suppliers |
| **Marketing** | Coupon Export, Gift Card Export, Margin Tagger, EDM Builder |

Restricted items: `BI Dashboard` and `Weekly Pulse` are hidden from nav until `/api/me` confirms the user is `accounts@theselfstyler.com` or `bianca@theselfstyler.com`.

---

## 5. Data Models (all tables in `db.js → initDb()`)

### Core stocktake
- **`stocktake_history`** — one row per stocktake submission (product_id, product_title, initials, created_at)
- **`stocktake_discrepancies`** — one row per variant where counted ≠ system qty; has `reviewed` workflow
- **`stock_alerts`** — tracks sent Slack alerts per variant to prevent duplicates; `resolved` flag

### Analytics & reporting
- **`shopify_daily`** — one row per day: revenue, orders, items_sold, sessions (nullable)
- **`google_ads_daily`** — one row per campaign per day: impressions, clicks, cost, conversions, conversion_value; `UNIQUE(campaign_id, date)`
- **`pmax_product_coverage`** — per-campaign product count snapshot: `UNIQUE(snapshot_date, campaign_id)`
- **`meta_ads_daily`** — one row per campaign per day for Meta Ads: spend, impressions, clicks, reach, purchases, purchase_value; `UNIQUE(campaign_id, date)`
- **`stock_value_history`** — daily RRP + cost snapshot: total_rrp, total_cost, variant_count; `UNIQUE(date)`
- **`xero_financials`** — P&L summary per period: revenue, cogs, gross_profit, expenses, net_profit, raw_json; `UNIQUE(period_start, period_end, report_type)`
- **`xero_pl_lines`** — individual P&L line items per period and account
- **`xero_balance_sheet`** — balance sheet line items per report_date
- **`xero_tenants`** — Xero OAuth tenants: access_token, refresh_token, token_expiry
- **`velocity_insights`** — AI-generated velocity analysis JSON blobs per period_days
- **`velocity_ideas`** — AI-generated markdown ideas per period_days
- **`weekly_pulse_reports`** — AI-generated weekly narrative content + model_used

### Warehouse operations
- **`picking_sessions`** — per-picker timing per session: item_count, avg_pick_seconds, active_seconds, excluded_gaps; saved on completion
- **`sku_reference_images`** — base64 reference images keyed by SKU for the scanner
- **`scan_log`** — every scanner lookup: sku, confidence, method, reasoning, confirmed

### Restock / production
- **`restock_settings`** — global defaults singleton (id=1): sea_lead_days, air_lead_days, cover_weeks, velocity_days
- **`product_restock_config`** — per-product overrides + restock_enabled flag; `PRIMARY KEY(product_id)`
- **`restock_orders`** — purchase orders for restock: freight_mode, ordered_at, expected_delivery, qty_by_variant (JSONB)
- **`restock_alerts_log`** — one row per product per alert_type; `UNIQUE(product_id, alert_type)`; cleared when order received
- **`suppliers`** — supplier CRM: company_name, location, currency, contact details
- **`production_orders`** — production purchase orders: po_number, supplier, dates, currency, exchange_rate, shipping_cost, status
- **`production_order_lines`** — line items per PO: product_code, quantities (JSONB), unit_price
- **`production_budgets`** — monthly budget targets: `UNIQUE(year, month)`
- **`picked_orders`** — record of completed pick orders: `UNIQUE(order_name)`

### Marketing / exports
- **`coupon_imports`** — 360REFUND# codes with expiry, discount, matched order/customer; `UNIQUE(code, expiry_month)`
- **`gift_card_imports`** — Shopify gift cards with expiry, matched order/customer; `UNIQUE(gift_card_id)`
- **`margin_tags`** — per-variant margin tier classification: cost_price, sell_price, markup, margin_tier; `UNIQUE(variant_id)`

### Settings
- **`app_settings`** — key/value store: currently stores `google_ads_refresh_token` and Xero tokens

---

## 6. External Service Connections

### Shopify Admin REST API
- **Version:** `2024-01` (hardcoded as `API_VERSION`)
- **Auth:** `X-Shopify-Access-Token` header
- **Endpoints used:** products, variants, inventory_items, orders, price_rules, discount_codes, gift_cards, discount_code lookups
- **Rate limiting:** 429 + `retry-after` header handled throughout
- **Required scopes:** `read_products`, `read_orders`, `read_inventory`, `read_analytics`, `read_price_rules`, `read_gift_cards`
- **Key filter:** variants with `inventory_management !== 'shopify'` are excluded from stock value calculations (untracked variants have arbitrary qty values)

### Shopify ShopifyQL (GraphQL)
- Used only for **sessions data** in `shopify-analytics.js`
- Requires `read_analytics` scope — fails gracefully if missing

### Google OAuth 2.0
- **Two separate purposes:**
  1. **User login** — passport-google-oauth20, restricted to `@theselfstyler.com`
  2. **Google Ads API** — separate OAuth at `/auth/google-ads/connect`; stores refresh token in `app_settings` DB

### Google Ads REST API
- **Version:** `v23` (default, `GOOGLE_ADS_API_VERSION` env var overrides)
- **Resources:** campaign stats, shopping_performance_view for PMAX product coverage

### Meta Ads API
- Facebook Marketing API for campaign/adset performance data

### Xero API
- P&L and balance sheet sync via Xero OAuth

### Anthropic API (`@anthropic-ai/sdk`)
- **Model:** `claude-sonnet-4-5` (or as configured per feature)
- **Used for:** EDM Builder email generation, Sales Velocity AI insights, Weekly Pulse narrative, Label scanner SKU matching
- **Pattern:** server-side only proxy — client POSTs to e.g. `/api/edm/generate`; server calls Anthropic and returns result

### Slack
- Simple webhook POST to `SLACK_WEBHOOK_URL`
- Used for: low-stock alerts (≤5 units). Restock sea/air alerts are logged to DB only (Slack notifications paused for those).

---

## 7. Cron Jobs

| Module | Schedule | Purpose |
|--------|----------|---------|
| `alerts.js` | Every 30 min (`STOCK_ALERT_CRON` env override) | Low-stock Slack alerts |
| `shopify-analytics.js` | Daily 01:00 | Shopify revenue/orders/sessions |
| `google-ads-sync.js` | Daily (configurable) | Google Ads performance data |
| `meta-ads-sync.js` | Daily | Meta Ads performance data |
| `stock-value-sync.js` | Daily 03:00 | Total inventory value snapshot |
| `restock-sync.js` | Scheduled | Restock velocity + alert calculations |
| `weekly-pulse.js` | Weekly | AI-generated business narrative |
| `ideas-cron.js` | Scheduled | AI velocity insights generation |

---

## 8. Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Railway auto-injects) |
| `SESSION_SECRET` | ✅ | Express session signing |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth — login + Ads |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth |
| `APP_URL` | ✅ | Full HTTPS URL e.g. `https://tss-wms.up.railway.app` |
| `SHOPIFY_SHOP` | ✅ | e.g. `theselfstyler.myshopify.com` (no https://) |
| `SHOPIFY_ACCESS_TOKEN` | ✅ | Shopify Admin API token |
| `SLACK_WEBHOOK_URL` | ✅ | Slack incoming webhook for stock alerts |
| `ANTHROPIC_API_KEY` | ✅ | Anthropic API key for AI features |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ✅ Ads | Google Ads developer token |
| `GOOGLE_ADS_CUSTOMER_ID` | ✅ Ads | Google Ads account ID |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional | MCC/manager account ID |
| `GOOGLE_ADS_API_VERSION` | Optional | Default `v23` |
| `META_ADS_ACCESS_TOKEN` | Meta | Meta API access token |
| `META_ADS_ACCOUNT_ID` | Meta | Meta ad account ID |
| `STOCK_ALERT_CRON` | Optional | Override alert cron. Default `*/30 * * * *` |
| `NODE_ENV` | Optional | Set `production` on Railway for secure cookies |
| `PORT` | Optional | Railway sets automatically. Default 3000 |

**Note:** `GOOGLE_ADS_REFRESH_TOKEN` is stored in the `app_settings` DB table (not env var). Use `/auth/google-ads/connect` to set it. Same pattern for Xero tokens.

---

## 9. Critical Coding Rules

1. **`node-fetch` MUST stay v2.** v3 is ESM-only and will break everything.

2. **PostgreSQL date arithmetic needs explicit cast:**
   ```sql
   -- CORRECT
   WHERE date >= CURRENT_DATE - ($1::int)
   -- WRONG — throws "operator does not exist: date >= integer"
   WHERE date >= CURRENT_DATE - $1
   ```

3. **`app.set('trust proxy', 1)`** must come before session middleware. Required for Railway's reverse proxy — without it secure cookies break and users get redirect-looped.

4. **All upserts use `ON CONFLICT ... DO UPDATE`** — never plain INSERT on sync tables.

5. **Shopify pagination** — always parse `Link` header for `rel="next"`. Loop until no next link.

6. **Frontend conventions:**
   - Every page: `<header></header>` at top, `<script src="nav.js"></script>` at the very bottom
   - All styles in `style.css` (shared) + `<style>` block in the HTML head (page-specific)
   - `escHtml()` in every JS file that renders API/user data into HTML strings
   - `localStorage` for persisting user preferences (e.g. picking initials)

7. **Stock value calculations** exclude:
   - Products with titles containing `x-redo` (internal adjustment products)
   - Variants where `inventory_management !== 'shopify'` (untracked variants)

8. **Restock Slack alerts are paused** — only low-stock (≤5 unit) alerts hit the Slack channel. Sea/air restock alerts are logged to DB only.

9. **Restricted pages:**
   - `/picking-report.html` API (`/api/picking/report`) — checks `req.user.email === 'accounts@theselfstyler.com'`
   - `/bi-dashboard.html` and `/weekly-pulse.html` — nav hidden via `restrict` array in `nav.js`

---

## 10. Deployment

- Push to `master` branch on GitHub → Railway auto-deploys
- Railway runs `npm start` (`node server.js`)
- On startup, `initDb()` runs — this creates any new DB tables (the migration mechanism)
- No build step — no Webpack, no TypeScript

**Checklist for new features:**
1. Add DB table to `db.js` → commit → deploy (next restart creates it)
2. Add API routes to `server.js`
3. Add HTML/JS to `public/`
4. Update `nav.js` if a new page needs linking
5. `git add ... && git commit && git push origin master`

---

## 11. Known Limitations

- **In-memory products cache** resets on every deploy — first request after deploy may be slow
- **PMAX coverage** only shows products with impressions in last 7 days
- **Google Ads API** — check sunset dates and update `GOOGLE_ADS_API_VERSION` when needed
- **No test suite** — manual testing only
- **Single process** — all crons + API routes in one Node process; if it crashes, everything stops
- **Picking report timing** — gaps >2min between picks are excluded; very short sessions may have unreliable stats
