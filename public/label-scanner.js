'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let stream       = null;   // MediaStream from getUserMedia
let lastResult   = null;   // most recent match result from API
let capturedData = null;   // base64 data URL of captured frame

// ── DOM refs ─────────────────────────────────────────────────────────────────
const video          = document.getElementById('cameraFeed');
const canvas         = document.getElementById('captureCanvas');
const snapBtn        = document.getElementById('snapBtn');
const resultCard     = document.getElementById('resultCard');
const resultHeader   = document.getElementById('resultHeader');
const resultTitle    = document.getElementById('resultTitle');
const resultIcon     = document.getElementById('resultIcon');
const resultBody     = document.getElementById('resultBody');
const confirmBtn     = document.getElementById('confirmBtn');
const retryBtn       = document.getElementById('retryBtn');
const scanningOverlay= document.getElementById('scanningOverlay');
const crosshair      = document.getElementById('crosshair');
const noCameraMsg    = document.getElementById('noCameraMsg');
const toast          = document.getElementById('toast');

// ── Camera initialisation ─────────────────────────────────────────────────────
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode:  { ideal: 'environment' },  // rear camera on phones/iPads
        width:       { ideal: 1280 },
        height:      { ideal: 960 },
      },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();

    snapBtn.disabled = false;
    crosshair.style.display = '';
  } catch (err) {
    console.error('Camera error:', err);
    noCameraMsg.classList.add('active');
    crosshair.style.display = 'none';
  }
}

// ── Capture a frame from the live feed ───────────────────────────────────────
function captureFrame() {
  const vw = video.videoWidth  || 640;
  const vh = video.videoHeight || 480;

  canvas.width  = vw;
  canvas.height = vh;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, vw, vh);

  // Compress to JPEG ≤450 KB using 800px long-edge resize
  const MAX_EDGE = 800;
  const scale    = Math.min(1, MAX_EDGE / Math.max(vw, vh));
  const tw = Math.round(vw * scale);
  const th = Math.round(vh * scale);

  const thumb   = document.createElement('canvas');
  thumb.width   = tw;
  thumb.height  = th;
  thumb.getContext('2d').drawImage(canvas, 0, 0, tw, th);

  return thumb.toDataURL('image/jpeg', 0.82);
}

// ── Show captured image in viewfinder ────────────────────────────────────────
function showPreview(dataUrl) {
  canvas.style.display = 'block';
  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    canvas.width  = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
  };
  img.src = dataUrl;
  video.style.display = 'none';
  crosshair.style.display = 'none';
}

// ── Restore live camera feed ─────────────────────────────────────────────────
function showLiveFeed() {
  canvas.style.display    = 'none';
  video.style.display     = '';
  crosshair.style.display = '';
  resultCard.classList.remove('active');
  lastResult   = null;
  capturedData = null;
  snapBtn.disabled = false;
}

// ── Confidence bar colour ────────────────────────────────────────────────────
function confColor(pct) {
  if (pct >= 80) return '#22c55e';
  if (pct >= 60) return '#f59e0b';
  return '#ef4444';
}

// ── Render result card ───────────────────────────────────────────────────────
function renderResult(result) {
  const pct = Math.round((result.confidence || 0) * 100);

  let headerClass, icon, title;
  if (result.method === 'no_match') {
    headerClass = 'no-match';
    icon  = '✕';
    title = 'No match found';
  } else if (pct >= 80) {
    headerClass = 'match';
    icon  = '✓';
    title = 'Match found';
  } else {
    headerClass = 'partial';
    icon  = '~';
    title = 'Possible match';
  }

  resultHeader.className = 'result-header ' + headerClass;
  resultIcon.textContent  = icon;
  resultTitle.textContent = title;

  let methodLabel = result.method || '';
  let methodClass = 'method-no';
  if (result.method === 'text')          { methodLabel = 'Text'; methodClass = 'method-text'; }
  if (result.method === 'text_unmatched'){ methodLabel = 'Text (unregistered)'; methodClass = 'method-text'; }
  if (result.method === 'visual')        { methodLabel = 'Visual'; methodClass = 'method-visual'; }

  const rows = [];

  if (result.sku) {
    rows.push(`
      <div class="result-row">
        <span class="result-label">SKU</span>
        <span class="result-value result-sku">${escHtml(result.sku)}</span>
      </div>`);
  }

  if (result.productTitle) {
    rows.push(`
      <div class="result-row">
        <span class="result-label">Product</span>
        <span class="result-value">${escHtml(result.productTitle)}</span>
      </div>`);
  }

  if (result.variantTitle) {
    rows.push(`
      <div class="result-row">
        <span class="result-label">Variant</span>
        <span class="result-value">${escHtml(result.variantTitle)}</span>
      </div>`);
  }

  rows.push(`
    <div class="result-row">
      <span class="result-label">Confidence</span>
      <div class="conf-bar-wrap">
        <div class="conf-bar">
          <div class="conf-bar-fill" style="width:${pct}%; background:${confColor(pct)};"></div>
        </div>
        <span class="conf-pct">${pct}%</span>
      </div>
    </div>`);

  rows.push(`
    <div class="result-row">
      <span class="result-label">Method</span>
      <span class="result-value">
        <span class="method-badge ${methodClass}">${escHtml(methodLabel)}</span>
      </span>
    </div>`);

  if (result.reasoning) {
    rows.push(`
      <div class="result-row">
        <span class="result-label">Note</span>
        <span class="result-value" style="font-weight:400; font-size:0.85rem; color:#475569;">${escHtml(result.reasoning)}</span>
      </div>`);
  }

  resultBody.innerHTML = rows.join('');

  // Show confirm button only if we have a result to confirm
  confirmBtn.style.display = result.sku ? '' : 'none';
  confirmBtn.textContent   = result.sku ? '✓ Confirm' : '✓ Dismiss';
  confirmBtn.style.display = ''; // always show it (dismiss or confirm)

  resultCard.classList.add('active');
}

// ── Scan (capture + send to API) ─────────────────────────────────────────────
async function scan() {
  snapBtn.disabled = true;

  capturedData = captureFrame();
  showPreview(capturedData);
  scanningOverlay.classList.add('active');

  try {
    const r = await fetch('/api/label/match', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ imageData: capturedData }),
    });
    const data = await r.json();

    if (!r.ok) throw new Error(data.error || 'Server error');

    lastResult = data;
    scanningOverlay.classList.remove('active');
    renderResult(data);

    // Auto-log to scan history
    logScan(data, false).catch(() => {});
  } catch (err) {
    scanningOverlay.classList.remove('active');
    showToast('Error: ' + err.message, 4000);
    snapBtn.disabled = false;
  }
}

// ── Log scan to history table ─────────────────────────────────────────────────
async function logScan(result, confirmed, confirmedSku) {
  await fetch('/api/scan/log', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sku:          result.sku,
      productTitle: result.productTitle,
      variantTitle: result.variantTitle,
      confidence:   result.confidence,
      method:       result.method,
      reasoning:    result.reasoning,
      confirmed:    confirmed || false,
      confirmedSku: confirmedSku || null,
    }),
  });
}

// ── Toast notification ────────────────────────────────────────────────────────
function showToast(msg, ms = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), ms);
}

// ── Button handlers ───────────────────────────────────────────────────────────
snapBtn.addEventListener('click', scan);

retryBtn.addEventListener('click', () => {
  showLiveFeed();
  snapBtn.disabled = false;
});

confirmBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  try {
    await logScan(lastResult, true, lastResult.sku);
    showToast('✓ Confirmed and logged');
    setTimeout(showLiveFeed, 1200);
  } catch (err) {
    showToast('Could not save: ' + err.message, 3000);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
startCamera();
