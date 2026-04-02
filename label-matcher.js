'use strict';

/**
 * label-matcher.js — Phase 4: AI Label Matching Engine
 *
 * Two-stage matching strategy:
 *   Stage 1 (cheap): Claude reads text/SKU from label image
 *   Stage 2 (visual): Claude compares image against reference photos (only if Stage 1 fails)
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const Anthropic = require('@anthropic-ai/sdk');
const { pool }  = require('./db');

let _client = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to Railway environment variables.');
  }
  if (!_client) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/** Strip the data:image/...;base64, prefix to get raw base64 */
function stripDataPrefix(dataUrl) {
  return dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
}

/** Extract MIME type from data URL */
function getMediaType(dataUrl) {
  const m = dataUrl.match(/^data:(image\/[^;]+);/);
  return (m && m[1]) || 'image/jpeg';
}

/** Parse JSON that may be wrapped in markdown code fences */
function parseJsonResponse(raw) {
  const cleaned = raw.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/,     '')
    .replace(/\s*```$/,     '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: find the first {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return null;
  }
}

// ── Stage 1: Text extraction ──────────────────────────────────────

async function stage1Extract(base64, mediaType) {
  const client = getClient();

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `You are reading product labels for an Australian fashion retail warehouse.
Examine this image carefully. Look for any SKU, product code, style code, barcode number, or article number printed on the label or tag.

Respond ONLY with valid JSON — no markdown, no explanation, no code fences:
{"sku":null,"confidence":0.0,"partial":"","reasoning":"one brief sentence"}

Rules:
- sku: the exact product code if clearly readable (3+ characters), otherwise null
- confidence: 0.0–1.0 (0.85+ = crystal clear text; 0.6–0.84 = readable but minor uncertainty; 0.3–0.59 = partial/blurry; <0.3 = guessing)
- partial: any partial text fragment you can see, even if incomplete (helps Stage 2 filtering)
- reasoning: one brief sentence explaining what you found or why you cannot read it`,
        },
      ],
    }],
  });

  const raw = (msg.content[0]?.text || '{}').trim();
  const result = parseJsonResponse(raw);
  if (!result) return { sku: null, confidence: 0, partial: '', reasoning: 'JSON parse failed' };
  return {
    sku:        result.sku        || null,
    confidence: result.confidence || 0,
    partial:    result.partial    || '',
    reasoning:  result.reasoning  || '',
  };
}

// ── Stage 2: Visual matching ──────────────────────────────────────

async function stage2Visual(queryBase64, queryMediaType, candidates, stage1) {
  if (!candidates || candidates.length === 0) return null;
  const client = getClient();

  // Build multi-image content block
  const content = [
    {
      type: 'text',
      text: `You are a visual product matcher for an Australian fashion retail warehouse.
A warehouse worker photographed a product label or garment. Identify which product it is by comparing the query image against the reference photos below.

Stage 1 text extraction result: ${JSON.stringify(stage1)}
Candidates to consider: ${candidates.map(c => c.sku).join(', ')}

Look for: garment style, colour, visible text fragments, label design, shape, and any barcodes.

Respond ONLY with valid JSON — no markdown, no code fences:
{"sku":null,"confidence":0.0,"reasoning":"brief explanation"}

- Set sku to the best matching SKU, or null if none match confidently
- Only set sku if confidence >= 0.6; otherwise set sku to null`,
    },
    {
      type: 'text',
      text: '=== QUERY IMAGE (product to identify) ===',
    },
    {
      type: 'image',
      source: { type: 'base64', media_type: queryMediaType, data: queryBase64 },
    },
  ];

  // Add up to 3 reference images per candidate SKU
  for (const cand of candidates) {
    const { rows: refs } = await pool.query(
      `SELECT image_data AS "imageData", image_label AS "imageLabel"
       FROM sku_reference_images
       WHERE sku = $1
       ORDER BY created_at ASC
       LIMIT 3`,
      [cand.sku]
    );
    if (refs.length === 0) continue;

    content.push({
      type: 'text',
      text: `=== Reference images for SKU: ${cand.sku} (${cand.productTitle || 'unknown'}${cand.variantTitle ? ' – ' + cand.variantTitle : ''}) ===`,
    });
    for (const ref of refs) {
      if (!ref.imageData) continue;
      content.push({
        type: 'image',
        source: {
          type:       'base64',
          media_type: getMediaType(ref.imageData),
          data:       stripDataPrefix(ref.imageData),
        },
      });
    }
  }

  const msg = await client.messages.create({
    model:     'claude-opus-4-6',
    max_tokens: 300,
    messages:  [{ role: 'user', content }],
  });

  const raw    = (msg.content[0]?.text || '{}').trim();
  const result = parseJsonResponse(raw);
  if (!result || !result.sku) return null;

  const match = candidates.find(c => c.sku === result.sku);
  if (!match) return null;

  return {
    sku:          result.sku,
    productTitle: match.productTitle,
    variantTitle: match.variantTitle,
    confidence:   result.confidence || 0.7,
    reasoning:    result.reasoning  || '',
  };
}

// ── Database helpers ──────────────────────────────────────────────

async function lookupSkuInDb(sku) {
  if (!sku) return null;
  const { rows } = await pool.query(
    `SELECT sku, product_title AS "productTitle", variant_title AS "variantTitle"
     FROM sku_reference_images
     WHERE LOWER(TRIM(sku)) = LOWER(TRIM($1))
     LIMIT 1`,
    [sku]
  );
  return rows[0] || null;
}

async function findCandidatesByPartial(partial) {
  if (!partial || partial.trim().length < 3) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT sku, product_title AS "productTitle", variant_title AS "variantTitle"
     FROM sku_reference_images
     WHERE LOWER(sku) LIKE LOWER($1)
     LIMIT 8`,
    [`%${partial.trim()}%`]
  );
  return rows;
}

// ── Main entrypoint ───────────────────────────────────────────────

/**
 * Match a label image against known products.
 *
 * @param {string} imageDataUrl  base64 data URL (data:image/jpeg;base64,...)
 * @returns {object} { sku, productTitle, variantTitle, confidence, method, reasoning, stage1 }
 *
 * method values:
 *   'text'          — SKU clearly read from label AND found in reference set
 *   'text_unmatched'— SKU clearly read but NOT in our reference images
 *   'visual'        — Matched via visual comparison (Stage 2)
 *   'no_match'      — Could not identify
 */
async function matchLabel(imageDataUrl) {
  const base64    = stripDataPrefix(imageDataUrl);
  const mediaType = getMediaType(imageDataUrl);

  // ── Stage 1 ──────────────────────────────────────────────────────
  const stage1 = await stage1Extract(base64, mediaType);

  if (stage1.sku && stage1.confidence >= 0.7) {
    const dbMatch = await lookupSkuInDb(stage1.sku);
    if (dbMatch) {
      return {
        sku:          stage1.sku,
        productTitle: dbMatch.productTitle,
        variantTitle: dbMatch.variantTitle,
        confidence:   stage1.confidence,
        method:       'text',
        reasoning:    stage1.reasoning,
        stage1,
      };
    }
    // SKU was read clearly but we have no reference images for it
    return {
      sku:          stage1.sku,
      productTitle: null,
      variantTitle: null,
      confidence:   stage1.confidence,
      method:       'text_unmatched',
      reasoning:    stage1.reasoning + ' (SKU not in reference images yet)',
      stage1,
    };
  }

  // ── Stage 2 ──────────────────────────────────────────────────────
  const searchText = stage1.sku || stage1.partial || '';
  const candidates = await findCandidatesByPartial(searchText);

  if (candidates.length > 0) {
    const visual = await stage2Visual(base64, mediaType, candidates, stage1);
    if (visual && visual.confidence >= 0.6) {
      return { ...visual, method: 'visual', stage1 };
    }
  }

  // No match at either stage
  return {
    sku:          null,
    productTitle: null,
    variantTitle: null,
    confidence:   0,
    method:       'no_match',
    reasoning:    'Could not identify product from this image',
    stage1,
  };
}

module.exports = { matchLabel };
