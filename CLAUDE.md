# CLAUDE.md — The Self Styler WMS

> Briefing document for any developer (human or AI) taking over this project.
> Written against the codebase as it stands on 2026-04-01.

---

## 1. Project Overview and Purpose

**The Self Styler WMS** is a private, internal Warehouse Management Studio built for The Self Styler (an Australian e-commerce fashion retailer). It was migrated from a local Node/CMD-only tool to a Railway-hosted web application so that warehouse staff can access it from any device (especially iPads).

The primary users are warehouse pickers, stocktake staff, and management. All pages are behind Google OAuth restricted to `@theselfstyler.com` email addresses only.

Core jobs this application does:
- **Stocktake** — search Shopify products, count physical stock, record discrepancies
- **Order Picking** — load a range of Shopify orders, render a pick list for warehouse staff with double-tap completion tracking
- **Sales Velocity** — flag products that are critically low, dead stock, or imbalanced across variants
- **Discrepancy Reporting** — track and review all stocktake discrepancies over time
- **Draft/Archived Stock** — surface products that are draft/archived but still have stock on hand
- **Shopify Daily Analytics** — revenue, orders, items sold, sessions per day with copy-paste export to Google Sheets
- **Google Ads** — campaign performance, ROAS tracking, sheet export, and PMAX product coverage monitoring
- **Stock Alerts** — Slack notifications when a variant drops to ≤5 units
- **Picking Performance** — per-staff timing metrics with an admin-only report

---

## 2. Tech Stack and Key Dependencies

**Runtime:** Node.js ≥18, Express 4

**Database:** PostgreSQL (hosted on Railway), accessed via `pg` pool with `connect-pg-simple` for session storage.

**Auth:** `passport` + `passport-google-oauth20`. Domain restricted to `@theselfstyler.com` via the `hd` hint parameter and a server-side email check.

**Scheduling:** `node-cron` — three cron jobs running inside the same process (stock alerts, Google Ads sync, Shopify analytics sync).

**HTTP client:** `node-fetch` v2 (CommonJS). Used for all Shopify API, Google Ads API, Google OAuth token refresh, and Slack webhook calls.

**Frontend:** Vanilla HTML/CSS/JS — no framework, no bundler, no TypeScript. All JS files are plain scripts served statically from `public/`. This is intentional — keep it simple for a small internal tool.

**Deployment:** Railway (Docker-based). PostgreSQL is a Railway-managed add-on service. The `Dockerfile` (if present) or Railway's Nixpacks builder handles the container.

**Key `package.json` dependencies:**
```
express, express-session, connect-pg-simple
passport, passport-google-oauth20
pg
node-cron
node-fetch@^2   ← must stay v2 (CommonJS); v3 is ESM only
dotenv
```

---

## 3. Architecture and Folder Structure

```
shopifystocktake/
├── server.js               ← Single Express app, all API routes live here
├── db.js                   ← PostgreSQL pool + initDb() — creates all tables on startup
├── auth.js                 ← Passport config, requireAuth middleware, /auth/google routes
├── alerts.js               ← Stock alert cron job, Slack webhook sender
├── google-ads-sync.js      ← Google Ads REST API client, sync logic, PMAX coverage
├── shopify-analytics.js    ← Shopify orders + ShopifyQL sessions aggregation
├── package.json
├── .env                    ← Local dev secrets (never committed)
├── .env.example            ← Template — use non-URL placeholders for Slack URL
│
└── public/                 ← All static frontend files (served by Express)
    ├── style.css           ← Single shared stylesheet for all pages
    ├── nav.js              ← Shared nav injected into every page's <header>
    │
    ├── index.html / app.js             ← Stocktake page
    ├── picking.html / picking.js       ← Order picking page
    ├── picking-report.html / picking-report.js  ← Admin-only picking metrics
    ├── velocity.html / velocity.js     ← Sales velocity report
    ├── history.html / history.js       ← Stocktake history log
    ├── discrepancies.html / discrepancies.js    ← Discrepancy review workflow
    ├── draft-report.html / draft-report.js      ← Draft/archived products with stock
    ├── syncing.html / syncing.js       ← Sync management hub
    ├── shopify-report.html / shopify-report.js  ← Daily analytics + sheet export
    ├── google-ads.html / google-ads.js ← Google Ads dashboard + PMAX monitor
    └── login.html                      ← Public login page (only unauthenticated page)
```

**Key architectural patterns:**

- **All API routes in `server.js`** — there is no Express Router abstraction. Routes are grouped by domain with comment banners. This is fine for the current size.
- **Modules for background work** — `alerts.js`, `google-ads-sync.js`, `shopify-analytics.js` each export a `startCron()` that is called once in `initDb().then()` at startup.
- **`nav.js` pattern** — every HTML page has `<header></header>` + `<script src="nav.js"></script>` at the bottom. `nav.js` injects the full nav HTML, fetches `/api/me`, and redirects to `/login` on 401. This means the nav is maintained in exactly one file.
- **In-memory products cache** — `productsCache` and `lastFetched` are module-level variables in `server.js`. They reset on every server restart. The picking page and velocity page auto-fetch from Shopify if the cache is empty. The Syncing page has a manual "Refresh Inventory" button.

---

## 4. Key Features Already Built

### Stocktake (`/`, `app.js`)
- Search products by title or SKU
- Enter counted quantities per variant
- Submit records entry in `stocktake_history`, saves discrepancies to `stocktake_discrepancies`
- Shows last check date per product

### Order Picking (`/picking.html`)
- Staff enter initials (persisted in `localStorage`), start order #, end order #
- `+50` / `+100` shortcut buttons for end order
- Fetches Shopify orders newest-first, stops paginating once below start order number
- Items shown per line (not aggregated), sorted by order number ascending
- Each row: thumbnail image, SKU, product title, variant (bold), order number + qty on the right
- Double-tap (click-based timer, 400ms window) to mark picked — fades item, shows green tick
- First tap gives purple flash so staff know it registered
- Sticky progress bar, green complete message when all picked
- Picking session timing tracked silently: timestamps on every pick/unpick, gaps >2min excluded, saved to DB on completion or page hide via `sendBeacon`

### Picking Performance Report (`/picking-report.html`)
- **Restricted to `accounts@theselfstyler.com` only** — all other authenticated users get a 403
- Per-picker summary cards: sessions, items picked, avg seconds/item (colour coded), best session
- Full session history table with order range, active time, excluded gaps
- Colour coding: green ≤15s/item, amber ≤30s, red >30s

### Sales Velocity (`/velocity.html`)
- Configurable lookback period, low stock / critical / dead stock thresholds
- Fetches all active Shopify products + orders, calculates daily velocity per variant
- Status badges: red (critical), amber (low stock), yellow (imbalanced), blue (dead stock), grey (no activity)
- Shows cost, price, margin%, markup on hand per variant (costs from Shopify inventory_items API)

### Discrepancy Report (`/discrepancies.html`)
- Filter by All / Needs Review / Reviewed, search by product/SKU
- Summary stats: needs review, total, short, over, last 7 days
- Mark Reviewed per row or bulk "Mark All Visible"
- Reviewed by name stored (Google login display name)

### Draft & Archived Stock (`/draft-report.html`)
- Shows draft and archived Shopify products that still have positive inventory
- Sorted by total stock descending

### Shopify Daily Report (`/shopify-report.html`)
- Date range pickers (default last 30 days)
- 5 copy cards: Dates (DD/MM), Revenue, Orders, Items Sold, Sessions
- Sessions card dims if `read_analytics` scope is missing
- Each row is tab-separated for direct paste into Google Sheets

### Google Ads (`/google-ads.html`)
Three tabs:
1. **Overview** — summary cards (spend, ROAS, conv value, conversions, clicks, impressions), campaign table with ROAS colour coding, daily breakdown
2. **Sheet Export** — date range picker, metric selector, Copy Dates Row + Copy Values Row → TSV clipboard
3. **PMAX Monitor** — per-campaign cards showing products serving (from `shopping_performance_view`), coverage % vs Shopify active products, historical trend table, 14/30/90 day periods

### Syncing (`/syncing.html`)
- Shopify Inventory: manual refresh, shows cache status
- Shopify Daily Analytics: status, last run, manual sync trigger
- Google Ads: Connect button (OAuth flow), Full Sync (90d) + Last 7 Days, PMAX status shown in sync result
- Stock Level Monitoring: status, last run, recent alerts table, manual trigger

### Stock Alerts
- Cron every 30 min (or `STOCK_ALERT_CRON` env var)
- Threshold: ≤5 units
- Deduplicates: won't re-alert until stock recovers above threshold
- Sends to Slack webhook

---

## 5. External Service Connections

### Shopify Admin REST API
- **Version:** `2024-01` (hardcoded in `server.js` as `API_VERSION`)
- **Auth:** `X-Shopify-Access-Token` header
- **Endpoints used:**
  - `GET /products.json` — product + variant + image data (paginated, 250/page)
  - `GET /products/count.json` — active product count (used in PMAX coverage)
  - `GET /orders.json` — orders with line items (picking + velocity)
  - `GET /inventory_items.json` — cost prices per variant (velocity)
- **Rate limiting:** 429 handling with `retry-after` header on inventory cost fetches
- **Required scopes:** `read_products`, `read_orders`, `read_inventory`, `read_analytics`

### Shopify ShopifyQL (GraphQL)
- Used only for **sessions data** in `shopify-analytics.js`
- Endpoint: `POST /admin/api/2024-01/graphql.json`
- Query: `FROM sessions SHOW sessions SINCE {date} UNTIL {date} GROUP BY day ORDER BY day`
- Requires `read_analytics` scope — fails gracefully with a `sessionsNote` if scope is missing

### Google OAuth 2.0
- Used for **two separate purposes:**
  1. **User login** — `passport-google-oauth20`, restricted to `@theselfstyler.com` domain
  2. **Google Ads API** — separate OAuth flow at `/auth/google-ads/connect` → `/auth/google-ads/callback`, stores refresh token in `app_settings` DB table (not env var)
- Both flows use the same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

### Google Ads REST API
- **Version:** `v23` (default, overridable via `GOOGLE_ADS_API_VERSION` env var). Supported versions as of 2026: v21–v23.
- **Auth:** Bearer token from OAuth refresh + `developer-token` header
- **Login customer ID:** Optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for MCC accounts
- **Key resources queried:**
  - `campaign` — daily stats (impressions, clicks, cost_micros, conversions, conversions_value)
  - `shopping_performance_view` — PMAX product coverage (distinct `segments.product_item_id` per campaign)
  - `asset_group_listing_group_filter` — fallback if shopping_performance_view returns no product IDs
- **Pagination:** handled via `nextPageToken` in `queryAds()`
- **Error handling:** reads `res.text()` first, tries `JSON.parse`, logs first 200 chars on failure

### Slack
- Simple webhook POST to `SLACK_WEBHOOK_URL`
- URL is validated (must start with `https://`) and trimmed before use
- Used only for stock level alerts

---

## 6. Data Models and Storage

All tables are created idempotently in `db.js → initDb()` using `CREATE TABLE IF NOT EXISTS`. **initDb() runs on every server startup** — this is how new tables reach production (Railway restarts the container on every deploy).

### `stocktake_history`
Records every stocktake submission.
```
id, product_id (BIGINT), product_title, initials, created_at
```

### `stocktake_discrepancies`
One row per variant where counted ≠ system qty.
```
id, product_id, product_title, variant_id, variant_title, sku,
system_qty, counted_qty, difference, initials, created_at,
reviewed (BOOL), reviewed_at, reviewed_by
```

### `stock_alerts`
Tracks sent Slack alerts to prevent duplicates.
```
id, variant_id, product_title, variant_title, sku,
stock_at_alert, alerted_at, resolved (BOOL), resolved_at
```
Alert only fires if no `resolved=false` row exists for that variant_id. When stock recovers above threshold, the alert is marked `resolved=true`.

### `app_settings`
Key-value store for runtime config.
```
key (TEXT PK), value, updated_at
```
Currently stores: `google_ads_refresh_token`

### `google_ads_daily`
One row per campaign per day.
```
id, campaign_id, campaign_name, campaign_status, date,
impressions, clicks, cost (DECIMAL), conversions, conversion_value,
synced_at
UNIQUE(campaign_id, date)
```

### `shopify_daily`
One row per day.
```
id, date (UNIQUE), revenue, orders, items_sold, sessions (nullable), synced_at
```
Sessions is nullable — it stays null if `read_analytics` scope is missing.

### `pmax_product_coverage`
One row per campaign per snapshot date.
```
id, snapshot_date, campaign_id, campaign_name,
products_serving (INT), shopify_active (INT nullable), synced_at
UNIQUE(snapshot_date, campaign_id)
```
Captured as part of every Google Ads sync. Counts distinct `productItemId` from `shopping_performance_view` over a rolling 7-day window.

### `picking_sessions`
One row per picking session (saved on completion or page hide).
```
id, user_email, user_name, initials,
order_start, order_end, order_count, item_count,
picks_completed, avg_pick_seconds (DECIMAL), active_seconds,
excluded_gaps (INT), first_pick_at, last_pick_at, created_at
```
Only saved if `picks_completed >= 2`. Gaps >120s between picks are excluded from timing stats.

### `user_sessions` (auto-created by connect-pg-simple)
Standard Passport session store table. Not manually defined in `db.js`.

---

## 7. Coding Conventions and Patterns

**General:**
- CommonJS (`require`/`module.exports`) throughout — no ESM
- `node-fetch` v2 for all HTTP — do not upgrade to v3 (ESM only)
- All async routes use `async/await` with try/catch, returning `res.status(500).json({ error: err.message })`
- Route parameters from query string are always parsed with `parseInt()` and validated before use
- PostgreSQL date arithmetic always uses explicit cast: `CURRENT_DATE - ($1::int)` — without the cast, Postgres throws "operator does not exist: date >= integer"

**Upsert pattern:**
All sync tables use `ON CONFLICT (...) DO UPDATE SET ... = EXCLUDED....` — never plain INSERT.

**Shopify pagination:**
All Shopify paginated fetches follow the same pattern: parse `Link` header for `rel="next"`, loop until no next link. Break early when order numbers drop below the requested start.

**In-memory cache:**
`productsCache` / `lastFetched` in `server.js`. Auto-fetches if empty when needed. This means the first request after a deploy may be slow while it fetches from Shopify.

**Frontend conventions:**
- Every page: `<header></header>` at top, `<script src="nav.js"></script>` at the very bottom (after the page's own script)
- No page-specific CSS files — all styles in `style.css`. Page-specific styles go in a `<style>` block in the HTML head
- `escHtml()` helper defined in each JS file that renders user/API data into HTML strings
- `fmtCurrency()`, `fmt()`, `fmtDate()` helpers repeated per page (no shared utils file)
- `localStorage` used for persisting user preferences (e.g., picking initials)

**Background modules pattern:**
```javascript
// Each module exports:
module.exports = { runSync, getStatus, startCron, ... }
// startCron() called once in server.js initDb().then()
// isRunning flag prevents concurrent runs
```

---

## 8. Environment Variables

All set in Railway → Service → Variables. Local dev uses `.env` in project root.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string (Railway provides this automatically when Postgres service is linked) |
| `SESSION_SECRET` | ✅ | Express session signing secret. Use a long random string. |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID — used for both user login AND Google Ads OAuth |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `APP_URL` | ✅ | Full HTTPS URL of the app e.g. `https://yourapp.up.railway.app` — must be `https://` for secure cookies and OAuth redirect URIs |
| `SHOPIFY_SHOP` | ✅ | Shopify store domain e.g. `theselfstyler.myshopify.com` (no https://) |
| `SHOPIFY_ACCESS_TOKEN` | ✅ | Shopify Admin API access token |
| `SLACK_WEBHOOK_URL` | ✅ | Slack incoming webhook URL for stock alerts |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ✅ for Ads | Google Ads developer token |
| `GOOGLE_ADS_CUSTOMER_ID` | ✅ for Ads | Google Ads customer/account ID (hyphens stripped automatically) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional | MCC/manager account ID if accessing via a manager account |
| `GOOGLE_ADS_API_VERSION` | Optional | Default: `v23`. Supported: v21–v23 as of 2026 |
| `STOCK_ALERT_CRON` | Optional | Override alert cron schedule. Default: `*/30 * * * *` |
| `NODE_ENV` | Optional | Set to `production` on Railway — enables secure cookies |
| `PORT` | Optional | Railway sets this automatically. Default: `3000` |

**Important:** `GOOGLE_ADS_REFRESH_TOKEN` does **not** need to be set as an env var. The OAuth connect flow at `/auth/google-ads/connect` stores the token in the `app_settings` DB table automatically.

---

## 9. How to Run and Build

**Local development:**
```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in env vars
cp .env.example .env
# Edit .env with real values

# 3. Start with nodemon (auto-restart on changes)
npm run dev

# 4. Or plain node
npm start
```

The app runs on `http://localhost:3000`. Google OAuth won't work locally unless you add `http://localhost:3000/auth/google/callback` to the Google Cloud Console authorised redirect URIs.

**Production (Railway):**
- Push to `master` branch on GitHub → Railway auto-deploys
- Railway runs `npm start` (i.e. `node server.js`)
- On startup, `initDb()` runs and creates any new tables — this is the migration mechanism
- No build step required — no Webpack, no TypeScript compilation
- The PostgreSQL service must be linked in the Railway project so `DATABASE_URL` is injected

**Common Railway gotchas:**
- `app.set('trust proxy', 1)` is required before session middleware — without it, secure cookies fail behind Railway's reverse proxy
- `APP_URL` must be `https://` — if it's `http://` you'll get Google OAuth redirect_uri_mismatch errors
- New DB tables only get created after the next Railway deploy triggers a server restart

---

## 10. Known Limitations and Work in Progress

**In-memory product cache:**
The `productsCache` is lost on every server restart/redeploy. This means images can be missing on the picking page immediately after a deploy. Auto-fetching is in place as a fallback but adds latency to the first request.

**PMAX coverage data source:**
`shopping_performance_view` only returns products with impressions in the last 7 days. If a product is in a PMAX campaign but hasn't had impressions recently, it won't appear. The fallback (`asset_group_listing_group_filter`) was tried but returns 0 product IDs for this account because the asset groups use broad "all products" rules rather than individual product listings.

**Google Ads API version:**
Currently pinned to `v23`. Google deprecates old versions regularly — check https://developers.google.com/google-ads/api/docs/sunset-dates and update `GOOGLE_ADS_API_VERSION` when needed.

**Shopify ShopifyQL sessions:**
Requires the `read_analytics` scope on the Shopify token. If missing, sessions data will be null across the board. The UI handles this gracefully (sessions card dims to 45% opacity).

**No job queue:**
All syncs are fire-and-forget within the Node process. If a sync takes too long or the process crashes mid-sync, there's no retry mechanism. For the current data volumes this is fine.

**Single process:**
All crons, API routes, and background syncs run in one Node process. If this ever needs to scale, the crons should be moved to a separate worker.

**Picking report timing accuracy:**
Session timing relies on the page being active. If the picker locks their iPad mid-session and resumes, the gap will be >2 minutes and excluded. This is by design but means very short sessions (few picks) may have unreliable stats.

**No test suite:**
There are no automated tests. Manual testing only.

---

## 11. Context for Future AI / Developer

**This is a living internal tool** — it will keep growing. The pattern is: product owner requests a new feature, it gets built and pushed to Railway. Keep it simple; don't over-engineer.

**Before adding any feature, check:**
1. Does it need a new DB table? → Add to `initDb()` in `db.js`, commit, deploy (the next server start creates it)
2. Does it need a new page? → Create `pagename.html` + `pagename.js` in `public/`, add to `NAV_ITEMS` in `nav.js`, add any API routes to `server.js`
3. Does it need a cron job? → Create a new module like `alerts.js`, export `startCron()`, call it in `server.js` `initDb().then()`

**The `node-fetch` v2 constraint is critical.** Every `fetch()` call in the backend uses `node-fetch` v2 (CommonJS). Do not upgrade to v3 — it's ESM only and will break the entire app.

**The PostgreSQL date cast is critical.** When subtracting a query parameter from a `DATE` column, always write `CURRENT_DATE - ($1::int)` not `CURRENT_DATE - $1`. Postgres will throw "operator does not exist: date >= integer" without the explicit cast. This has bitten us multiple times.

**Don't change `app.set('trust proxy', 1)`** — it must come before the session middleware. Without it, `req.secure` is false on Railway, the secure cookie flag is dropped, and users get redirect-looped after login.

**The Google Ads refresh token is stored in the DB** (`app_settings` table, key: `google_ads_refresh_token`), not in env vars. The `getRefreshToken()` function in `google-ads-sync.js` checks the DB first, then falls back to `GOOGLE_ADS_REFRESH_TOKEN` env var. If re-connecting Google Ads, use the `/auth/google-ads/connect` flow — it replaces the stored token automatically.

**iPad/Safari frontend notes:**
- Always add `touch-action: manipulation` on interactive elements to prevent double-tap zoom
- Use `click` event for double-tap detection (not `touchend`) — more reliable cross-platform
- Input fields need `inputmode="numeric"` or `inputmode="text"` for correct iPad keyboard
- `font-size: 16px` minimum on inputs to prevent Safari auto-zoom
- `navigator.sendBeacon` works on iOS for fire-and-forget requests on page hide

**Restricted pages:**
- `/picking-report.html` — checks `req.user.email === 'accounts@theselfstyler.com'` server-side on the `/api/picking/report` route. The page is visible in the nav to everyone but returns a 403 for all other users.
- All other pages are restricted to `@theselfstyler.com` domain via `requireAuth` middleware in `auth.js`.

**Deployment checklist for new features:**
1. Add DB table to `db.js` if needed (and commit it — forgetting this has happened before and causes "relation does not exist" in production)
2. Add API routes to `server.js`
3. Add HTML/JS files to `public/`
4. Update `nav.js` if a new page needs linking
5. `git add [files] && git commit && git push origin master`
6. Railway auto-deploys from master — watch the build logs
