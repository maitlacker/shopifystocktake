# Influencer Reporting — Build Specification

> Deep-dive design for the Influencer Effectiveness feature, based on
> "Influencer Reporting - Notes for Claude.pdf" (Aug 2026).
> Lives under the **Marketing** nav group.

---

## 1. Feasibility Summary (per scope pillar)

| # | Scope Pillar | Verdict | How |
|---|--------------|---------|-----|
| 1 | Manual campaign info | ✅ Easy | New tables + CRUD pages, same pattern as Incorrect Orders |
| 2 | Organic social performance | ⚠️ Mostly manual, with two big assists | See §3 — API auto-pull only works in specific cases; AI screenshot ingest closes the gap |
| 3 | Meta Ads performance | ✅ Fully automatable | Existing Meta token + new **ad-level** insights sync (current sync is adset-level) |
| 4 | Shopify sales + bought-together | ✅ Fully automatable | Existing Shopify Admin API — compute combos ourselves from order line items (better than ShopifyQL) |
| 5 | Inventory impact | ✅ With one caveat | Shopify has no per-variant inventory *history* — we must snapshot starting inventory ourselves (nightly snapshot job for active campaigns) |
| 6 | ROI + AI insights | ✅ Easy | Server-side math + existing Anthropic SDK pattern (same as Weekly Pulse / velocity insights) |

---

## 2. What We Reuse

- **Shopify Admin REST** (`SHOPIFY_SHOP` / `SHOPIFY_ACCESS_TOKEN`, v2024-01) — orders scan, product/variant lookup, inventory levels, discount code lookup. Pagination + 429 handling already established.
- **Meta Marketing API** (`meta-ads-sync.js`) — OAuth long-lived token in `app_settings`, `handleOAuthCallback` flow, `act_{id}/insights` pattern. We extend to `level=ad` with video fields.
- **Anthropic SDK** — proxy pattern from EDM Builder / Weekly Pulse for insight generation; vision pattern from `label-matcher.js` for screenshot ingest.
- **Live product search** — `/api/stocktake/search-live` pattern for the "Products Featured" picker.
- **Slack** — optional campaign-report notifications later (Block Kit + deep-link button pattern from Incorrect Orders).
- **nav.js / style.css / initDb()** conventions throughout.

---

## 3. Organic Metrics — the honest constraints

What Meta's APIs allow depends on *whose* content it is:

| Content | What we can pull automatically |
|---|---|
| **Our own reposts** (posted from @theselfstyler account) | Everything — reach, views, likes, comments, shares, saves, profile visits — via IG insights on our own media (needs `instagram_basic` + `instagram_manage_insights` on the Meta token) |
| **Creator post with "Paid Partnership" label** (brand tagged as sponsor) | Reach + engagement via branded-content insights / Partnership Ads Hub. Meta expanded these APIs in 2025-26 (aggregated views/likes/comments across placements, saves + shares counts) |
| **Creator post that merely @mentions/tags us** | Public fields only via `/{ig-user-id}/tags` and `mentioned_media`: caption, permalink, like_count, comments_count. **No reach, saves, or views** |
| **Untagged creator post** | Nothing |

**Design response — three input paths, best-available wins:**

1. **Auto-pull** where possible (own reposts always; branded-content posts when the creator uses the Paid Partnership label — worth making this a standard ask in creator agreements).
2. **AI screenshot ingest** — creators routinely send a screenshot of their post insights. Upload it on the campaign page; Claude vision (same pattern as `label-matcher.js`) extracts reach / plays / likes / comments / shares / saves / profile visits into the form for one-click confirm. This is the pragmatic 90% solution.
3. **Manual entry** — plain form fallback.

Metrics are stored as dated **snapshots** (metrics keep growing after post date); the report uses the latest snapshot and can show growth.

---

## 4. Data Model (`db.js → initDb()`)

```sql
CREATE TABLE IF NOT EXISTS influencer_campaigns (
  id SERIAL PRIMARY KEY,
  creator_name TEXT NOT NULL,
  creator_handle TEXT,                    -- @handle for tag/mention auto-pull
  post_datetime TIMESTAMPTZ,              -- Post Date & Time
  cta_used TEXT,
  hook TEXT,                              -- for "winning hook" analysis
  ad_live_start DATE,
  ad_live_end DATE,
  influencer_fee NUMERIC(10,2) DEFAULT 0,
  discount_code TEXT,                     -- influencer code (deterministic attribution)
  reporting_window_days INT NOT NULL DEFAULT 14,
  post_url TEXT,
  content_type TEXT,                      -- reel / story / tiktok / carousel...
  status TEXT NOT NULL DEFAULT 'planned', -- planned | live | completed | archived
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS influencer_campaign_products (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  product_title TEXT NOT NULL,
  UNIQUE(campaign_id, product_id)
);

-- Nightly per-variant inventory snapshots for featured products of active campaigns
CREATE TABLE IF NOT EXISTS influencer_inventory_snapshots (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL,
  variant_id BIGINT NOT NULL,
  variant_title TEXT,
  sku TEXT,
  snapshot_date DATE NOT NULL,
  inventory_quantity INT NOT NULL,
  UNIQUE(campaign_id, variant_id, snapshot_date)
);

-- Organic metric snapshots (manual, screenshot-ingested, or API)
CREATE TABLE IF NOT EXISTS influencer_organic_metrics (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | screenshot | api | repost
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reach INT, views INT, impressions INT,
  likes INT, comments INT, shares INT, saves INT,
  profile_visits INT, link_clicks INT,
  engagement_rate NUMERIC(6,3),          -- computed if null: (likes+comments+shares+saves)/reach
  raw_json JSONB
);

-- Which Meta ads use this creator's content (linked via ad picker UI)
CREATE TABLE IF NOT EXISTS influencer_campaign_ads (
  id SERIAL PRIMARY KEY,
  campaign_id INT NOT NULL REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  adset_id TEXT, adset_name TEXT,        -- adset name ≈ audience
  campaign_meta_id TEXT, campaign_meta_name TEXT,
  creative_id TEXT, creative_thumb_url TEXT,
  UNIQUE(campaign_id, ad_id)
);

-- Ad-level daily insights (richer than meta_ads_daily, only for linked ads)
CREATE TABLE IF NOT EXISTS influencer_ad_insights_daily (
  id SERIAL PRIMARY KEY,
  ad_id TEXT NOT NULL,
  date DATE NOT NULL,
  spend NUMERIC(10,2) DEFAULT 0,
  impressions INT DEFAULT 0,
  clicks INT DEFAULT 0,
  reach INT DEFAULT 0,
  frequency NUMERIC(8,3),
  purchases INT DEFAULT 0,
  purchase_value NUMERIC(12,2) DEFAULT 0,
  video_3s_views INT,                     -- video_play_actions
  thruplays INT,                          -- video_thruplay_watched_actions
  video_p100 INT,
  ctr NUMERIC(8,4), cpc NUMERIC(10,4), cpm NUMERIC(10,4),
  attribution_setting TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ad_id, date)
);

-- Cached sales analysis per campaign (recomputed on demand / nightly)
CREATE TABLE IF NOT EXISTS influencer_sales_cache (
  campaign_id INT PRIMARY KEY REFERENCES influencer_campaigns(id) ON DELETE CASCADE,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  window_start TIMESTAMPTZ, window_end TIMESTAMPTZ,
  summary JSONB,          -- orders, revenue, AOV, new/returning
  product_perf JSONB,     -- per featured product: units, revenue
  combos JSONB,           -- bought-together combinations
  code_attribution JSONB, -- orders/revenue where discount_code used
  baseline JSONB          -- pre-window daily averages for lift calc
);

-- AI insight reports (per campaign + cross-campaign leaderboard)
CREATE TABLE IF NOT EXISTS influencer_insights (
  id SERIAL PRIMARY KEY,
  campaign_id INT REFERENCES influencer_campaigns(id) ON DELETE CASCADE, -- NULL = cross-campaign
  content TEXT NOT NULL,
  model_used TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Derived metrics (thumb-stop rate, hold rate, ROAS, ROII, cost-per-*) are **computed, never stored**:

- Thumb-stop / hook rate = `video_3s_views / impressions`
- Hold rate = `thruplays / video_3s_views`
- ROAS = `purchase_value / spend`; ROII = `combined_revenue / total_investment`
- CPM-equivalent = `fee / views × 1000`; cost per engagement = `fee / (likes+comments+shares+saves)`; etc.

---

## 5. Attribution Model (the important design decision)

Three attribution layers, reported side by side rather than blended:

1. **Deterministic — discount code.** Orders using the influencer's code within the window. Strongest signal; scan window orders' `discount_codes` array.
2. **Meta-attributed — paid.** `purchases` / `purchase_value` from linked ads' insights (Meta's own attribution window, recorded in `attribution_setting`).
3. **Window correlation — organic.** All orders containing ≥1 featured product between `post_datetime` and `post_datetime + reporting_window_days`. This overcounts baseline demand, so also compute a **baseline**: the same products' average daily units/revenue over the equivalent period *before* the post, and report **lift** (window vs baseline). Without this, every campaign for a best-seller looks like a hero.

Overlap caveat shown in the UI: code-attributed and Meta-attributed orders may intersect window orders; combined revenue uses window organic + Meta paid with a footnote, and the AI insight layer comments on overlap.

---

## 6. Sync & Compute Architecture

New module: **`influencer-sync.js`** (same shape as the other sync modules — exports `startCron(pool)`):

- **Nightly (e.g. 03:30):**
  - For campaigns with status `live` (or within ad-live range): sync ad-level insights for linked ads — one Meta call per batch: `act_{id}/insights?level=ad&filtering=[{field:"ad.id",operator:"IN",value:[...]}]&fields=spend,impressions,clicks,reach,frequency,actions,action_values,video_play_actions,video_thruplay_watched_actions,video_p100_watched_actions,ctr,cpc,cpm&time_increment=1`
  - Snapshot inventory for featured products of active campaigns (variants via products API → `influencer_inventory_snapshots`)
  - Recompute `influencer_sales_cache` for live campaigns (orders scan)
  - If handle tagged us: refresh public engagement counts via `mentioned_media` (best-effort)
- **On demand:** "Refresh Data" button on campaign page runs the same for one campaign.

**Shopify orders scan** (the sales engine): paginate `orders.json?status=any&created_at_min=…&created_at_max=…&fields=id,name,created_at,total_price,customer,line_items,discount_codes`. For each order: match featured product IDs in `line_items`, classify new vs returning (`customer.orders_count === 1` at time of order — note: reflects current count; acceptable approximation), detect combos:

- **Featured + featured pairs** (the outfit signal — the priority per the scope)
- **Featured + any other product** pairs, ranked by order count then revenue

Combos aggregate as `{productA, productB, orders, revenue}` — same output as the ShopifyQL report the user built manually, but for every pair at once and cached.

---

## 7. Pages & UX

Nav → **Marketing** group gains:

- **Influencer Campaigns** (`influencers.html` / `influencers.js`)
  - Stats row (active campaigns, total invested, combined revenue, avg ROII)
  - **Creator Leaderboard** — ranked by ROII with cost-efficiency columns (CPM-equiv, cost/engagement, cost/purchase, revenue per $)
  - Campaign table grouped by month: creator, post date, products, investment, revenue, ROII, status
- **Campaign Detail** (`influencer-campaign.html` / `influencer-campaign.js`)
  - **Setup card** — manual fields (creator, handle, post datetime, CTA, hook, ad dates, fee, code, window), featured products picker (live Shopify search, reuse stocktake pattern)
  - **Organic tab** — latest snapshot + history; buttons: *Enter Manually*, *Upload Insights Screenshot* (AI extract → prefilled form → confirm), *Auto-pull* (when handle/repost available)
  - **Paid tab** — ad picker (searchable list of recent Meta ads with names + thumbnails → link to campaign); per-ad table (spend, ROAS, CTR, CPC, CPM, frequency, thumb-stop, hold rate) + combined totals row; winning creative/audience highlighted (best ROAS with spend floor, adset name = audience)
  - **Sales tab** — summary (orders, revenue, AOV, new vs returning), per-product performance, **Bought Together** table (the priority feature), code-attributed orders, baseline lift indicator
  - **Inventory tab** — per variant: starting qty (snapshot at/nearest post date), current/ending, units sold, sell-through %
  - **ROI tab** — investment breakdown, revenue by attribution layer, ROII/ROAS/cost-per-purchase, cost-efficiency metrics
  - **Insights tab** — "Generate Insights" → Claude analysis (per-campaign + comparison vs other campaigns' averages), stored in `influencer_insights`

---

## 8. AI Layer

Two prompts (server-side, existing SDK pattern):

1. **Screenshot ingest** — vision request: image + "extract these metrics as JSON: reach, views, likes, …" → returns JSON → prefill form. (Direct reuse of the `label-matcher.js` approach.)
2. **Campaign insights** — feed the full computed dataset (organic, paid, sales, combos, inventory, ROI, plus cross-campaign averages) → narrative: best creator/product/combo/hook/CTA rankings, new-vs-returning read, inventory impact, comparison vs average and previous campaigns, overall ROI ranking.

---

## 9. Build Phases

| Phase | Scope | Effort |
|---|---|---|
| **1. Foundations** | Tables, campaign CRUD, list + detail pages, product picker, manual organic entry, nav | 1 session |
| **2. Sales engine** | Orders window scan, summary, product perf, bought-together, code attribution, baseline lift, sales cache | 1 session |
| **3. Meta ads** | Ad picker, ad-level daily sync w/ video metrics, paid tab, combined totals | 1 session |
| **4. Inventory** | Nightly snapshots, sell-through tab | small |
| **5. AI + polish** | Screenshot ingest, insights generation, leaderboard, (optional) Slack campaign summaries | 1 session |

Prereqs / checks before Phase 3+:
- Meta token needs `ads_read` at ad level (likely already fine — current sync reads insights).
- For own-repost auto-pull: token needs `instagram_basic` + `instagram_manage_insights` and the IG business account ID.
- Ask creators to use the **Paid Partnership label** going forward — unlocks branded-content insights.

---

## 10. Open Questions

1. Default reporting window — 14 days assumed; confirm.
2. Do current creator agreements include the Paid Partnership label / tagging requirement?
3. Should campaign creation *before* the post go-live be the standard flow? (Needed for a true starting-inventory snapshot; otherwise starting inventory = earliest available snapshot, back-estimated by adding back units sold.)
4. Currency: fee in AUD, Meta spend in ad-account currency — confirm both AUD.
5. Restricted access? Or visible to all staff like other Marketing pages?
