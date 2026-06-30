require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fetch = require('node-fetch');
const cron  = require('node-cron');

const ARCADS_CLIENT_ID     = process.env.ARCADS_CLIENT_ID     || '';
const ARCADS_CLIENT_SECRET = process.env.ARCADS_CLIENT_SECRET || '';
const ARCADS_BASE_URL      = process.env.ARCADS_BASE_URL      || 'https://api.arcads.ai';

function arcadsAuth() {
  const encoded = Buffer.from(`${ARCADS_CLIENT_ID}:${ARCADS_CLIENT_SECRET}`).toString('base64');
  return `Basic ${encoded}`;
}

function arcadsEnabled() {
  return Boolean(ARCADS_CLIENT_ID && ARCADS_CLIENT_SECRET);
}

async function arcadsRequest(method, path, body) {
  const url = `${ARCADS_BASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      Authorization: arcadsAuth(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Arcads ${method} ${path} → ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Submit a generation job to Arcads
// brief: { product, templateType, jobType, extra }
async function submitJob(brief) {
  return arcadsRequest('POST', '/v1/videos', {
    template: brief.templateType,
    product: {
      name:           brief.product.title,
      description:    brief.product.description,
      price:          brief.product.price,
      compare_at_price: brief.product.compareAtPrice,
      images:         brief.product.images,
      tags:           brief.product.tags,
    },
    brand: brief.brand || {},
    metadata: { wms_job_type: brief.jobType },
  });
}

// Submit a collage job (multiple products)
async function submitCollageJob(brief) {
  return arcadsRequest('POST', '/v1/videos', {
    template: brief.templateType,
    products: brief.products.map(p => ({
      name:        p.title,
      description: p.description,
      price:       p.price,
      images:      p.images,
    })),
    brand: brief.brand || {},
    metadata: { wms_job_type: 'collage' },
  });
}

// Get status of a job from Arcads
async function getJobStatus(arcadsJobId) {
  return arcadsRequest('GET', `/v1/videos/${arcadsJobId}`);
}

// Poll all 'generating' jobs and update their status in the DB
async function pollJobs(pool) {
  const { rows } = await pool.query(
    `SELECT id, arcads_job_id FROM creative_jobs WHERE status = 'generating' AND arcads_job_id IS NOT NULL`
  );
  if (!rows.length) return;

  console.log(`[arcads] Polling ${rows.length} in-progress job(s)…`);

  for (const job of rows) {
    try {
      const data = await getJobStatus(job.arcads_job_id);
      // Arcads returns status in data.status — map to our statuses
      const arcadsStatus = (data.status || '').toLowerCase();
      let newStatus = 'generating';
      let resultUrls = [];
      let errorMsg = null;

      if (arcadsStatus === 'completed' || arcadsStatus === 'done' || arcadsStatus === 'ready') {
        newStatus = 'ready';
        // Arcads may return output_url, video_url, or assets array
        if (data.output_url) resultUrls = [data.output_url];
        else if (data.video_url) resultUrls = [data.video_url];
        else if (Array.isArray(data.assets)) resultUrls = data.assets.map(a => a.url || a).filter(Boolean);
        else if (Array.isArray(data.outputs)) resultUrls = data.outputs.map(a => a.url || a).filter(Boolean);
      } else if (arcadsStatus === 'failed' || arcadsStatus === 'error') {
        newStatus = 'queued'; // reset to queued for retry, or 'error' if you prefer
        errorMsg = data.error || data.message || 'Arcads job failed';
        newStatus = 'error';
      }

      if (newStatus !== 'generating') {
        await pool.query(
          `UPDATE creative_jobs SET status=$1, result_urls=$2, error_message=$3, updated_at=NOW() WHERE id=$4`,
          [newStatus, JSON.stringify(resultUrls), errorMsg, job.id]
        );
        console.log(`[arcads] Job ${job.id} (arcads: ${job.arcads_job_id}) → ${newStatus}`);
      }
    } catch (err) {
      console.error(`[arcads] Poll error for job ${job.id}:`, err.message);
    }
  }
}

function startCron(pool) {
  if (!arcadsEnabled()) {
    console.warn('[arcads] ARCADS_CLIENT_ID / ARCADS_CLIENT_SECRET not set — polling disabled');
    return;
  }
  // Poll every 5 minutes
  cron.schedule('*/5 * * * *', () => pollJobs(pool).catch(err => {
    console.error('[arcads] Cron poll error:', err.message);
  }));
  console.log('[arcads] Polling cron started (every 5 min)');
}

module.exports = { startCron, pollJobs, submitJob, submitCollageJob, getJobStatus, arcadsEnabled };
