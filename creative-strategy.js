// creative-strategy.js — Creative Strategy analysis engine
// Ports the "creative-strategy-analysis" skill: parse ad names against the
// house naming convention, derive customer segment from adset/campaign names,
// rank personas on CPA, and break winning styles/angles down per segment.
'use strict';

// House naming convention — fixed field order in the ad name
const FIELD_ORDER = [
  'uid', 'product_category', 'product', 'persona', 'angle', 'creative_style',
  'media_type', 'creative_source', 'creator_name', 'primary_text',
  'headline_version', 'url', 'date_tag',
];

// Segment synonyms, checked against adset name first, then campaign name
const SEGMENT_RULES = [
  { segment: 'new',      re: /prospect|cold|acquisi|top of funnel|\btof\b|new cust|broad/i },
  { segment: 'engaged',  re: /retarget|\bmof\b|warm|engag|mid funnel|remarket|social engag|video view|visitors?/i },
  { segment: 'existing', re: /retention|\bbau\b|existing|\bbof\b|\bltv\b|customer list|past purch|repeat|loyal/i },
];

const CANDIDATE_DELIMS = ['|', '_', '~', ';', '//'];

// ── Name parsing ───────────────────────────────────────────────────

function detectDelimiter(name) {
  let best = null, bestCount = 0;
  for (const d of CANDIDATE_DELIMS) {
    const count = name.split(d).length - 1;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  // Need enough separators to plausibly carry the keyed convention
  return bestCount >= 5 ? best : null;
}

function cleanVal(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}

// Parse one ad name against the fixed field order. Returns null when the name
// does not carry the convention (goes to the unattributed bucket).
function parseAdName(name) {
  if (!name) return null;
  const delim = detectDelimiter(name);
  if (!delim) return null;
  const parts = name.split(delim).map(cleanVal);
  const attrs = {};
  for (let i = 0; i < FIELD_ORDER.length; i++) attrs[FIELD_ORDER[i]] = parts[i] || '';
  // The analysis lives or dies on persona, angle, creative style
  if (!attrs.persona || !attrs.angle || !attrs.creative_style) return null;
  return attrs;
}

function segmentOf(adsetName, campaignName) {
  for (const src of [adsetName, campaignName]) {
    if (!src) continue;
    for (const rule of SEGMENT_RULES) {
      if (rule.re.test(src)) return rule.segment;
    }
  }
  return 'unclassified';
}

// Media type → Static / Video / GIF buckets
function formatBucket(mediaType) {
  const m = String(mediaType || '').toLowerCase();
  if (!m) return '';
  const isVideo = /video|vid\b|reel|ugc vid/.test(m);
  const isGif = /gif/.test(m);
  const isStatic = /static|image|img|photo|still|carousel/.test(m);
  const hits = [isVideo, isGif, isStatic].filter(Boolean).length;
  if (hits > 1) return 'Mixed';
  if (isVideo) return 'Video';
  if (isGif) return 'GIF';
  if (isStatic) return 'Static';
  return cleanVal(mediaType);
}

// Normalisation: group on a case-folded key, display the most common original
function normKey(v) { return String(v || '').toLowerCase().trim().replace(/\s+/g, ' '); }

// ── Aggregation ────────────────────────────────────────────────────

function newAgg() {
  return { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, reach: 0,
           purchases: 0, purchase_value: 0, ads: new Set() };
}

function addTo(agg, ad) {
  agg.spend          += ad.spend;
  agg.impressions    += ad.impressions;
  agg.clicks         += ad.clicks;
  agg.link_clicks    += ad.link_clicks;
  agg.reach          += ad.reach;          // approximation: reach is not additive
  agg.purchases      += ad.purchases;
  agg.purchase_value += ad.purchase_value;
  agg.ads.add(ad.ad_id);
}

function metricsOf(agg) {
  const clicksForCtr = agg.link_clicks > 0 ? agg.link_clicks : agg.clicks;
  return {
    spend:          round2(agg.spend),
    ad_count:       agg.ads.size,
    purchases:      round2(agg.purchases),
    purchase_value: round2(agg.purchase_value),
    cpa:   agg.purchases > 0 ? round2(agg.spend / agg.purchases) : null,
    roas:  agg.spend > 0 ? round2(agg.purchase_value / agg.spend) : null,
    ctr:   agg.impressions > 0 ? round4(clicksForCtr / agg.impressions) : null,
    frequency: agg.reach > 0 ? round2(agg.impressions / agg.reach) : null,
    reach: agg.reach,
    cost_per_k_reach: agg.reach > 0 ? round2(agg.spend / agg.reach * 1000) : null,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

// Group a list of ads by a label function → sorted metric rows
function groupBy(ads, labelFn) {
  const groups = new Map(); // normKey → { label, agg, labelCounts }
  for (const ad of ads) {
    const raw = labelFn(ad);
    if (!raw) continue;
    const key = normKey(raw);
    if (!groups.has(key)) groups.set(key, { agg: newAgg(), labelCounts: new Map() });
    const g = groups.get(key);
    addTo(g.agg, ad);
    g.labelCounts.set(raw, (g.labelCounts.get(raw) || 0) + 1);
  }
  const rows = [];
  for (const g of groups.values()) {
    let label = '', best = 0;
    for (const [l, c] of g.labelCounts) if (c > best) { label = l; best = c; }
    rows.push({ label, ...metricsOf(g.agg) });
  }
  rows.sort((a, b) => b.spend - a.spend); // default view: spend descending
  return rows;
}

// Style/angle/etc. broken down by segment: { new: rows, engaged: rows, existing: rows }
function bySegment(ads, labelFn) {
  const out = {};
  for (const seg of ['new', 'engaged', 'existing', 'unclassified']) {
    const segAds = ads.filter(a => a.segment === seg);
    if (!segAds.length) { out[seg] = []; continue; }
    out[seg] = groupBy(segAds, labelFn);
  }
  return out;
}

// Best style + angle pairings per segment (spend ≥ threshold, ≥1 purchase)
function pairings(ads, minSpend) {
  const out = {};
  for (const seg of ['new', 'engaged', 'existing']) {
    const segAds = ads.filter(a => a.segment === seg);
    const rows = groupBy(segAds, a => `${a.attrs.creative_style} × ${a.attrs.angle}`)
      .filter(r => r.spend >= minSpend && r.purchases >= 1)
      .sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity))
      .slice(0, 8);
    out[seg] = rows;
  }
  return out;
}

// ── Main entry ─────────────────────────────────────────────────────

async function analyze(pool, since, until, opts = {}) {
  const minSpend     = Number(opts.minSpend) || 100;   // persona materiality
  const minPurchases = Number(opts.minPurchases) || 3;
  const tableSpend   = Number(opts.tableSpend) || 100; // deep-dive table threshold

  const { rows } = await pool.query(
    `SELECT ad_id,
            (ARRAY_AGG(ad_name ORDER BY date DESC))[1]       AS ad_name,
            (ARRAY_AGG(adset_name ORDER BY date DESC))[1]    AS adset_name,
            (ARRAY_AGG(campaign_name ORDER BY date DESC))[1] AS campaign_name,
            SUM(spend)::float AS spend, SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks, SUM(link_clicks)::bigint AS link_clicks,
            SUM(reach)::bigint AS reach, SUM(purchases)::float AS purchases,
            SUM(purchase_value)::float AS purchase_value
     FROM meta_ad_perf_daily
     WHERE date >= $1::date AND date <= $2::date
     GROUP BY ad_id`,
    [since, until]);

  const ads = [];           // attributed ads
  const unattributed = [];  // could not parse persona/angle/style
  let totalSpend = 0, attributedSpend = 0;
  const unmappedSegmentNames = new Map(); // name → spend

  for (const r of rows) {
    const ad = {
      ad_id: r.ad_id, ad_name: r.ad_name,
      spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0, link_clicks: Number(r.link_clicks) || 0,
      reach: Number(r.reach) || 0, purchases: Number(r.purchases) || 0,
      purchase_value: Number(r.purchase_value) || 0,
    };
    totalSpend += ad.spend;
    const attrs = parseAdName(r.ad_name);
    if (!attrs) {
      unattributed.push({ ad_name: r.ad_name, spend: round2(ad.spend), purchases: round2(ad.purchases) });
      continue;
    }
    ad.attrs = attrs;
    ad.segment = segmentOf(r.adset_name, r.campaign_name);
    if (ad.segment === 'unclassified') {
      const key = r.adset_name || r.campaign_name || '(no adset/campaign name)';
      unmappedSegmentNames.set(key, (unmappedSegmentNames.get(key) || 0) + ad.spend);
    }
    attributedSpend += ad.spend;
    ads.push(ad);
  }
  unattributed.sort((a, b) => b.spend - a.spend);

  // ── Coverage ──
  const coverage = {
    total_ads: rows.length,
    attributed_ads: ads.length,
    unattributed_ads: unattributed.length,
    total_spend: round2(totalSpend),
    attributed_spend: round2(attributedSpend),
    attributed_pct: totalSpend > 0 ? round2(attributedSpend / totalSpend * 100) : 0,
    unattributed_spend: round2(totalSpend - attributedSpend),
  };

  // ── Persona ranking (CPA asc, ROAS desc, volume desc; material only) ──
  const personaRows = groupBy(ads, a => a.attrs.persona);
  const material = personaRows.filter(p => p.spend >= minSpend && p.purchases >= minPurchases);
  const insufficient = personaRows.filter(p => !(p.spend >= minSpend && p.purchases >= minPurchases));
  material.sort((a, b) =>
    ((a.cpa ?? Infinity) - (b.cpa ?? Infinity)) ||
    ((b.roas ?? 0) - (a.roas ?? 0)) ||
    (b.purchases - a.purchases));

  // ── Account-level dimension tables (no segment split) ──
  const account = {
    style:   groupBy(ads, a => a.attrs.creative_style),
    angle:   groupBy(ads, a => a.attrs.angle),
    url:     groupBy(ads, a => a.attrs.url),
    source:  groupBy(ads, a => a.attrs.creative_source),
    format:  groupBy(ads, a => formatBucket(a.attrs.media_type)),
    category: groupBy(ads, a => a.attrs.product_category),
    product: groupBy(ads, a => a.attrs.product),
  };

  // ── Per-persona deep dives (every persona with spend, biggest first) ──
  const personas = personaRows.map(p => {
    const pAds = ads.filter(a => normKey(a.attrs.persona) === normKey(p.label));
    return {
      persona: p.label,
      summary: p,
      material: p.spend >= minSpend && p.purchases >= minPurchases,
      style_by_segment:    bySegment(pAds, a => a.attrs.creative_style),
      angle_by_segment:    bySegment(pAds, a => a.attrs.angle),
      best_pairings:       pairings(pAds, tableSpend),
      source_by_segment:   bySegment(pAds, a => a.attrs.creative_source),
      url_by_segment:      bySegment(pAds, a => a.attrs.url),
      format_by_segment:   bySegment(pAds, a => formatBucket(a.attrs.media_type)),
      category_by_segment: bySegment(pAds, a => a.attrs.product_category),
      product_by_segment:  bySegment(pAds, a => a.attrs.product),
    };
  });

  // Segment totals (for context chips only — never ranked against each other)
  const segmentTotals = {};
  for (const seg of ['new', 'engaged', 'existing', 'unclassified']) {
    const segAds = ads.filter(a => a.segment === seg);
    const agg = newAgg();
    for (const a of segAds) addTo(agg, a);
    segmentTotals[seg] = metricsOf(agg);
  }

  return {
    since, until,
    thresholds: { persona_min_spend: minSpend, persona_min_purchases: minPurchases, table_min_spend: tableSpend },
    coverage,
    ranking: material,
    insufficient_volume: insufficient,
    personas,
    account,
    segment_totals: segmentTotals,
    unattributed: unattributed.slice(0, 100),
    unmapped_segment_names: [...unmappedSegmentNames.entries()]
      .map(([name, spend]) => ({ name, spend: round2(spend) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 50),
    notes: [
      'Reach and frequency above ad level are approximations — reach is not additive across ads.',
      'CTR uses link clicks when present, otherwise all clicks.',
      'Ranked on CPA (lowest first); ROAS and volume break ties.',
      'Segments are read on their own terms — new is expected to run leaner than engaged/existing by design.',
    ],
  };
}

module.exports = { analyze, parseAdName, segmentOf, formatBucket };
