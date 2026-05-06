// weekly-pulse.js — AI-powered weekly business pulse report to Slack
'use strict';

const fetch = require('node-fetch');
const cron  = require('node-cron');

let _pool      = null;
let _anthropic = null;
let isRunning  = false;
let lastRun    = null;
let lastResult = null;

// ── Gather all data sources ────────────────────────────────────────
async function gatherData() {
  const now    = new Date();
  const endStr = now.toISOString().slice(0, 10);

  const prev7Start = new Date(now); prev7Start.setDate(prev7Start.getDate() - 13);
  const prev7End   = new Date(now); prev7End.setDate(prev7End.getDate() - 7);
  const cur7Start  = new Date(now); cur7Start.setDate(cur7Start.getDate() - 6);

  const cur7s  = cur7Start.toISOString().slice(0, 10);
  const prev7s = prev7Start.toISOString().slice(0, 10);
  const prev7e = prev7End.toISOString().slice(0, 10);

  // ── Shopify last 7 days + prior 7 days ───────────────────────────
  const [{ rows: sh }, { rows: shPrev }] = await Promise.all([
    _pool.query(`
      SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(orders),0) AS orders,
             COALESCE(SUM(items_sold),0) AS items_sold, SUM(sessions) AS sessions
      FROM shopify_daily WHERE date >= $1 AND date <= $2`, [cur7s, endStr]),
    _pool.query(`
      SELECT COALESCE(SUM(revenue),0) AS revenue, COALESCE(SUM(orders),0) AS orders
      FROM shopify_daily WHERE date >= $1 AND date <= $2`, [prev7s, prev7e]),
  ]);

  // ── Google Ads last 7 days ────────────────────────────────────────
  const { rows: ga } = await _pool.query(`
    SELECT COALESCE(SUM(cost),0) AS spend, COALESCE(SUM(impressions),0) AS impressions,
           COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(conversions),0) AS conversions,
           COALESCE(SUM(conversion_value),0) AS conv_value
    FROM google_ads_daily WHERE date >= $1 AND date <= $2`, [cur7s, endStr]);

  // ── Meta Ads last 7 days ─────────────────────────────────────────
  const { rows: ma } = await _pool.query(`
    SELECT COALESCE(SUM(spend),0) AS spend, COALESCE(SUM(impressions),0) AS impressions,
           COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(purchases),0) AS purchases,
           COALESCE(SUM(purchase_value),0) AS purchase_value
    FROM meta_ads_daily WHERE date >= $1 AND date <= $2`, [cur7s, endStr]);

  // ── Xero P&L summaries — last 3 months ───────────────────────────
  const { rows: plSummary } = await _pool.query(`
    SELECT to_char(period_start,'YYYY-MM') AS month,
           revenue, cogs, gross_profit, expenses, net_profit
    FROM xero_financials WHERE report_type = 'ProfitAndLoss'
    ORDER BY period_start DESC LIMIT 3`);

  // ── Xero P&L line items — most recent month ───────────────────────
  const { rows: plLines } = await _pool.query(`
    SELECT section, account_name, value
    FROM xero_pl_lines
    WHERE period_start = (SELECT MAX(period_start) FROM xero_pl_lines)
    ORDER BY section, value DESC`);

  // ── Xero Balance Sheet — most recent snapshot ─────────────────────
  const { rows: bs } = await _pool.query(`
    SELECT section, subsection, account_name, value
    FROM xero_balance_sheet
    WHERE report_date = (SELECT MAX(report_date) FROM xero_balance_sheet)
    ORDER BY section, subsection NULLS LAST, value DESC`);

  return {
    period:   { start: cur7s, end: endStr },
    shopify:  sh[0],
    shPrev:   shPrev[0],
    google:   ga[0],
    meta:     ma[0],
    plSummary,
    plLines,
    balanceSheet: bs,
  };
}

// ── Build Claude prompt ────────────────────────────────────────────
function buildPrompt(d) {
  const { shopify: sh, shPrev, google: ga, meta: ma,
          plSummary, plLines, balanceSheet, period } = d;

  const revenue    = parseFloat(sh?.revenue    || 0);
  const prevRev    = parseFloat(shPrev?.revenue || 0);
  const orders     = parseInt(sh?.orders        || 0);
  const items      = parseInt(sh?.items_sold    || 0);
  const sessions   = sh?.sessions != null ? parseInt(sh.sessions) : null;
  const gSpend     = parseFloat(ga?.spend       || 0);
  const gConvVal   = parseFloat(ga?.conv_value  || 0);
  const mSpend     = parseFloat(ma?.spend       || 0);
  const mPurchVal  = parseFloat(ma?.purchase_value || 0);
  const totalSpend = gSpend + mSpend;

  const revChg  = prevRev > 0 ? (((revenue - prevRev) / prevRev) * 100).toFixed(1) : null;
  const aov     = orders  > 0 ? (revenue / orders).toFixed(2) : null;
  const cr      = sessions && sessions > 0 ? ((orders / sessions) * 100).toFixed(2) : null;
  const gRoas   = gSpend  > 0 ? (gConvVal  / gSpend).toFixed(2) : null;
  const mRoas   = mSpend  > 0 ? (mPurchVal / mSpend).toFixed(2) : null;
  const mer     = totalSpend > 0 ? (revenue / totalSpend).toFixed(2) : null;

  let prompt = `You are a senior commercial analyst for The Self Styler, an Australian online fashion retailer (women's clothing). You have access to their complete business data across Shopify, Google Ads, Meta Ads, and Xero.

Today: ${new Date().toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
Report period: ${period.start} → ${period.end} (last 7 days)

=== SHOPIFY — LAST 7 DAYS ===
Revenue: $${revenue.toLocaleString('en-AU', {maximumFractionDigits:0})} AUD${revChg !== null ? ` (${revChg > 0 ? '+' : ''}${revChg}% vs prior 7 days)` : ''}
Orders: ${orders}${aov ? ` | AOV: $${aov}` : ''}
Items Sold: ${items}
Sessions: ${sessions !== null ? sessions.toLocaleString() : 'not available'}${cr ? ` | Conversion rate: ${cr}%` : ''}

=== ADVERTISING — LAST 7 DAYS ===
Google Ads: $${gSpend.toFixed(2)} spend | ROAS ${gRoas !== null ? gRoas + 'x' : 'N/A'} | ${parseInt(ga?.conversions||0)} conversions | $${gConvVal.toFixed(0)} conv. value | ${parseInt(ga?.clicks||0)} clicks
Meta Ads:   $${mSpend.toFixed(2)} spend | ROAS ${mRoas !== null ? mRoas + 'x' : 'N/A'} | ${parseInt(ma?.purchases||0)} purchases | $${mPurchVal.toFixed(0)} purchase value | ${parseInt(ma?.clicks||0)} clicks
Combined:   $${totalSpend.toFixed(2)} total spend | MER ${mer !== null ? mer + 'x' : 'N/A'} (Shopify revenue ÷ total ad spend)

`;

  if (plSummary?.length > 0) {
    prompt += `=== XERO P&L — MONTHLY SUMMARY ===\n`;
    for (const m of plSummary) {
      const rev = parseFloat(m.revenue);
      const gp  = parseFloat(m.gross_profit);
      const np  = parseFloat(m.net_profit);
      const gpPct = rev > 0 ? ((gp / rev) * 100).toFixed(1) : '?';
      const npPct = rev > 0 ? ((np / rev) * 100).toFixed(1) : '?';
      prompt += `${m.month}: Revenue $${rev.toFixed(0)} | COGS $${parseFloat(m.cogs).toFixed(0)} | Gross Profit $${gp.toFixed(0)} (${gpPct}%) | Expenses $${parseFloat(m.expenses).toFixed(0)} | Net Profit $${np.toFixed(0)} (${npPct}%)\n`;
    }
    prompt += '\n';
  }

  if (plLines?.length > 0) {
    prompt += `=== XERO P&L — LINE ITEMS (MOST RECENT MONTH) ===\n`;
    let curSection = '';
    for (const line of plLines) {
      if (line.section !== curSection) {
        prompt += `\n[${line.section}]\n`;
        curSection = line.section;
      }
      prompt += `  ${line.account_name}: $${parseFloat(line.value).toFixed(2)}\n`;
    }
    prompt += '\n';
  }

  if (balanceSheet?.length > 0) {
    prompt += `=== XERO BALANCE SHEET (MOST RECENT SNAPSHOT) ===\n`;
    let curSection = ''; let curSub = '';
    for (const item of balanceSheet) {
      if (item.section !== curSection) {
        prompt += `\n[${item.section}]\n`;
        curSection = item.section; curSub = '';
      }
      if (item.subsection && item.subsection !== curSub) {
        prompt += `  ${item.subsection}:\n`;
        curSub = item.subsection;
      }
      const indent = item.subsection ? '    ' : '  ';
      prompt += `${indent}${item.account_name}: $${parseFloat(item.value).toFixed(2)}\n`;
    }
    prompt += '\n';
  }

  prompt += `=== INDUSTRY BENCHMARKS (Australian online fashion retail) ===
- Gross margin: 55–65% is healthy; below 50% is a concern
- Net profit margin: 10–20% is healthy for a growing DTC brand
- MER (Marketing Efficiency Ratio): 4–8x is typical; below 3x needs attention
- Google Ads ROAS: 3–5x for fashion; below 2x is unprofitable at typical margins
- Meta Ads ROAS: 2–4x for fashion; below 1.5x is unprofitable
- AOV for Australian women's fashion online: $100–$180 is typical
- Conversion rate: 2–4% is healthy for fashion e-commerce
- Wages as % of revenue: 15–25% for small DTC brands
- Marketing spend as % of revenue: 10–20% is typical growth-stage spend

=== YOUR TASK ===
Write a weekly business pulse report. Structure it EXACTLY as follows (use these exact section headers):

*📈 WEEK IN REVIEW*
2–3 sentences. What happened this week at a high level? Revenue context, any notable shifts vs prior week.

*📣 AD PERFORMANCE*
4–5 bullet points. Is each channel delivering? Is the MER healthy? Flag anything that needs urgent attention. Compare ROAS/MER against benchmarks. Be specific with numbers.

*💰 FINANCIAL HEALTH*
4–5 bullet points. Based on the P&L line items: are margins healthy? Any expense line that's out of proportion or trending wrong? What does the balance sheet tell us about cash, stock, liabilities? Flag anything concerning vs industry benchmarks.

*✅ TOP 3 ACTIONS THIS WEEK*
Numbered 1–3. Specific, actionable tasks — not generic advice. Name the channel, the metric, the specific change to make and why. E.g. "Meta ROAS is 1.6x, below the 2x breakeven — pause the top-of-funnel awareness campaigns and shift that budget to retargeting which is historically stronger."

Tone: Direct, commercially sharp, like a trusted CFO/CMO hybrid. Use AUD. Keep each section tight — this is a Slack message, not a report. Total length target: ~400–500 words.`;

  return prompt;
}

// ── Split long text into Slack-safe chunks (<3000 chars each) ──────
function chunkForSlack(text, maxLen = 2900) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  const paragraphs = text.split('\n\n');
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length > maxLen && current) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ── Run the pulse ──────────────────────────────────────────────────
async function runWeeklyPulse() {
  if (isRunning) {
    console.log('[weekly-pulse] Already running, skipping');
    return { skipped: true };
  }
  if (!_anthropic) throw new Error('Anthropic client not initialised');

  const webhook = process.env.SLACK_IDEAS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!webhook || !webhook.startsWith('https://')) {
    throw new Error('No valid Slack webhook configured (set SLACK_IDEAS_WEBHOOK_URL)');
  }

  isRunning = true;
  console.log('[weekly-pulse] Starting…');

  try {
    const data   = await gatherData();
    const prompt = buildPrompt(data);

    console.log('[weekly-pulse] Calling Claude Sonnet…');
    const response = await _anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 1200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const analysis = response.content[0]?.text || 'No analysis generated.';
    console.log(`[weekly-pulse] Claude responded — ${analysis.length} chars`);

    // Build Slack blocks
    const dateStr = new Date().toLocaleDateString('en-AU', { day:'numeric', month:'long', year:'numeric' });
    const textChunks = chunkForSlack(analysis);

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `📊 Weekly Business Pulse — ${dateStr}`, emoji: true },
      },
      ...textChunks.map((chunk) => ({
        type: 'section',
        text: { type: 'mrkdwn', text: chunk },
      })),
      {
        type: 'divider',
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Data sources: Shopify · Google Ads · Meta Ads · Xero P&L + Balance Sheet | Analysis by Claude Sonnet`,
        }],
      },
    ];

    const slackRes = await fetch(webhook, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks }),
    });

    if (!slackRes.ok) {
      const errText = await slackRes.text();
      throw new Error(`Slack post failed ${slackRes.status}: ${errText.slice(0, 100)}`);
    }

    lastResult = { ok: true, chars: analysis.length, date: new Date().toISOString() };
    console.log('[weekly-pulse] Posted to Slack ✓');
    return lastResult;

  } finally {
    isRunning = false;
    lastRun   = new Date();
  }
}

// ── Cron ───────────────────────────────────────────────────────────
function startCron(pool, anthropicClient) {
  _pool      = pool;
  _anthropic = anthropicClient;

  // Monday 8am AEST = Sunday 10pm UTC
  const schedule = process.env.WEEKLY_PULSE_CRON || '0 22 * * 0';
  cron.schedule(schedule, async () => {
    console.log('[weekly-pulse] Cron fired');
    try {
      await runWeeklyPulse();
    } catch (err) {
      console.error('[weekly-pulse] Cron error:', err.message);
      lastResult = { error: err.message };
      lastRun    = new Date();
    }
  });
  console.log(`[weekly-pulse] Cron scheduled: ${schedule} (Mon 8am AEST)`);
}

function getStatus() {
  return {
    isRunning,
    lastRun:    lastRun?.toISOString() || null,
    lastResult,
    schedule:   process.env.WEEKLY_PULSE_CRON || '0 22 * * 0',
    slackConfigured: !!(process.env.SLACK_IDEAS_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL),
  };
}

module.exports = { startCron, runWeeklyPulse, getStatus };
