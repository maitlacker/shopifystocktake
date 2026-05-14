'use strict';

/* ── State ─────────────────────────────────────────────────────── */
let lastResult      = null;   // { html, subjectA, subjectB, previewText, sendTime, instructions }
let loadedTemplate  = null;   // { name, html } — set when user loads a template file
let currentTab      = 'preview';
let imgCounter      = 0;

/* ── Image rows ─────────────────────────────────────────────────── */
function addImage() {
  const id  = ++imgCounter;
  const wrap = document.createElement('div');
  wrap.className = 'img-row-wrap';
  wrap.id = `img-row-${id}`;
  wrap.innerHTML = `
    <div class="img-row">
      <input class="edm-input" id="img-url-${id}" type="url" placeholder="https://cdn.shopify.com/…image.jpg" />
      <select class="img-role-sel" id="img-role-${id}">
        <option value="hero">Hero banner</option>
        <option value="product">Product shot</option>
        <option value="lifestyle">Lifestyle</option>
        <option value="logo">Logo</option>
        <option value="footer">Footer image</option>
      </select>
      <button class="img-remove-btn" onclick="removeImage(${id})" title="Remove">×</button>
    </div>
    <div class="img-link-row">
      <span class="img-link-icon">🔗</span>
      <input class="edm-input" id="img-link-${id}" type="url"
             placeholder="Optional: click-through link for this image" />
    </div>
  `;
  document.getElementById('img-rows').appendChild(wrap);
}

function removeImage(id) {
  const el = document.getElementById(`img-row-${id}`);
  if (el) el.remove();
}

function getImages() {
  const wraps = document.querySelectorAll('#img-rows .img-row-wrap');
  return Array.from(wraps).map(wrap => {
    const id      = wrap.id.replace('img-row-', '');
    const url     = (document.getElementById(`img-url-${id}`)?.value  || '').trim();
    const role    = document.getElementById(`img-role-${id}`)?.value  || 'product';
    const linkUrl = (document.getElementById(`img-link-${id}`)?.value || '').trim();
    return { url, role, linkUrl };
  }).filter(img => img.url);
}

/* ── Tone pills ─────────────────────────────────────────────────── */
function selectTone(btn) {
  document.querySelectorAll('.tone-pill').forEach(p => p.classList.remove('selected'));
  btn.classList.add('selected');
}

function getSelectedTone() {
  const selected = document.querySelector('.tone-pill.selected');
  return selected ? selected.dataset.tone : 'friendly';
}

/* ── Brand colour sync ──────────────────────────────────────────── */
function syncColour(val) {
  document.getElementById('f-brand-colour').value = val;
}

function syncColourPicker(val) {
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    document.getElementById('f-colour-picker').value = val;
  }
}

/* ── Generate ───────────────────────────────────────────────────── */
async function generateEDM() {
  const goal = document.getElementById('f-goal').value.trim();
  if (!goal) {
    showFormError('Please enter a campaign goal.');
    document.getElementById('f-goal').focus();
    return;
  }
  clearFormError();
  clearOutputError();

  const payload = {
    campaignName:    document.getElementById('f-name').value.trim(),
    goal,
    details:         document.getElementById('f-details').value.trim(),
    ctaText:         document.getElementById('f-cta-text').value.trim() || 'Shop Now',
    ctaUrl:          document.getElementById('f-cta-url').value.trim(),
    images:          getImages(),
    tone:            getSelectedTone(),
    brandName:       document.getElementById('f-brand-name').value.trim() || 'The Self Styler',
    brandColour:     document.getElementById('f-brand-colour').value.trim() || '#6366f1',
    logoUrl:         document.getElementById('f-logo-url').value.trim(),
    footerImageUrl:  document.getElementById('f-footer-img-url').value.trim(),
    footerImageLink: document.getElementById('f-footer-img-link').value.trim(),
    existingHtml:    loadedTemplate ? loadedTemplate.html : '',
  };

  setLoading(true);

  try {
    const res = await fetch('/api/edm/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Server error ${res.status}`);
    }

    lastResult = data;
    renderOutput(data);

  } catch (err) {
    showOutputError('Generation failed: ' + err.message);
  } finally {
    setLoading(false);
  }
}

/* ── Render output ──────────────────────────────────────────────── */
function renderOutput(data) {
  // -- Preview tab
  document.getElementById('preview-empty').style.display = 'none';
  const iframe = document.getElementById('preview-iframe');
  iframe.style.display = 'block';
  // srcdoc is the safest way to load HTML into an iframe without navigation
  iframe.srcdoc = data.html;

  // -- HTML tab
  document.getElementById('html-pre').textContent = data.html;
  document.getElementById('copy-html-btn').style.display = '';
  document.getElementById('clear-btn').style.display = '';

  // -- Subjects tab
  document.getElementById('subjects-empty').style.display = 'none';
  const content = document.getElementById('subjects-content');
  content.style.display = 'flex';
  content.innerHTML = `
    <div class="subj-card">
      <div class="subj-card-label">Subject Line A</div>
      <div class="subj-card-value">${escHtml(data.subjectA)}</div>
      <div class="subj-char-count">${data.subjectA.length} characters</div>
      <button class="subj-copy-btn" onclick="copyText(${JSON.stringify(data.subjectA)}, this)">Copy</button>
    </div>
    <div class="subj-card">
      <div class="subj-card-label">Subject Line B</div>
      <div class="subj-card-value">${escHtml(data.subjectB)}</div>
      <div class="subj-char-count">${data.subjectB.length} characters</div>
      <button class="subj-copy-btn" onclick="copyText(${JSON.stringify(data.subjectB)}, this)">Copy</button>
    </div>
    <div class="subj-card" style="border-color:#e0f2fe">
      <div class="subj-card-label" style="color:#0284c7">Preview Text</div>
      <div class="subj-card-value" style="font-size:0.88rem;color:#0369a1">${escHtml(data.previewText)}</div>
      <div class="subj-char-count">${data.previewText.length} characters</div>
      <button class="subj-copy-btn" onclick="copyText(${JSON.stringify(data.previewText)}, this)">Copy</button>
    </div>
    <div class="send-time-card">
      <div class="subj-card-label">Recommended Send Time</div>
      <div class="subj-card-value">${escHtml(data.sendTime)}</div>
    </div>
    <div class="instructions-card">
      <div class="subj-card-label">Klaviyo Setup Notes</div>
      <div class="instr-list">${escHtml(data.instructions)}</div>
    </div>
  `;

  // Switch to preview tab
  switchTab('preview');
}

/* ── Tabs ───────────────────────────────────────────────────────── */
function switchTab(tab) {
  currentTab = tab;

  document.querySelectorAll('.edm-tab').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');

  // Hide all panes then show the right one
  document.querySelectorAll('.edm-pane').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });

  const pane = document.getElementById(`pane-${tab}`);
  if (pane) {
    pane.style.display = 'flex';
    pane.classList.add('active');
  }

  document.getElementById('copy-html-btn').style.display =
    (tab === 'html' && lastResult) ? '' : 'none';
}

/* ── Copy helpers ───────────────────────────────────────────────── */
function copyHtml() {
  if (!lastResult) return;
  copyText(lastResult.html, document.getElementById('copy-html-btn'));
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 1800);
    }
  }).catch(() => {
    // Fallback for older browsers / restricted contexts
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity  = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1800);
      }
    } catch (_) {}
  });
}

/* ── Template upload ────────────────────────────────────────────── */
function triggerTemplateUpload() {
  document.getElementById('template-file-input').click();
}

function handleTemplateUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const html = e.target.result;

    // Store for generate-with-template mode
    loadedTemplate = { name: file.name, html };
    showTemplateIndicator(file.name);

    // Also preview it immediately
    if (!lastResult) lastResult = {};
    lastResult.html = html;

    document.getElementById('preview-empty').style.display = 'none';
    const iframe = document.getElementById('preview-iframe');
    iframe.style.display = 'block';
    iframe.srcdoc = html;

    document.getElementById('html-pre').textContent = html;
    document.getElementById('copy-html-btn').style.display = '';
    document.getElementById('clear-btn').style.display = '';

    switchTab('preview');
    clearOutputError();
  };
  reader.onerror = function () {
    showOutputError('Could not read the file. Make sure it is a valid HTML file.');
  };
  reader.readAsText(file);

  // Reset so the same file can be re-loaded if needed
  input.value = '';
}

function removeTemplate() {
  loadedTemplate = null;
  document.getElementById('tpl-indicator').style.display = 'none';
  // Don't clear the output — user may still want to see/copy it.
  // Next generate will now build from scratch.
}

function showTemplateIndicator(name) {
  document.getElementById('tpl-name').textContent = name;
  document.getElementById('tpl-indicator').style.display = 'flex';
}

function clearOutput() {
  lastResult  = null;

  // Reset preview pane
  document.getElementById('preview-empty').style.display = '';
  const iframe = document.getElementById('preview-iframe');
  iframe.style.display = 'none';
  iframe.srcdoc = '';

  // Reset HTML code pane
  document.getElementById('html-pre').textContent = '';

  // Reset subjects pane
  document.getElementById('subjects-empty').style.display = '';
  const content = document.getElementById('subjects-content');
  content.style.display = 'none';
  content.innerHTML = '';

  // Hide action buttons
  document.getElementById('copy-html-btn').style.display = 'none';
  document.getElementById('clear-btn').style.display = 'none';

  clearOutputError();
  switchTab('preview');
}

/* ── Loading state ──────────────────────────────────────────────── */
function setLoading(on) {
  const btn     = document.getElementById('gen-btn');
  const overlay = document.getElementById('loading-overlay');
  btn.disabled  = on;
  btn.classList.toggle('loading', on);
  overlay.classList.toggle('show', on);
}

/* ── Error helpers ──────────────────────────────────────────────── */
function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearFormError() {
  document.getElementById('form-error').style.display = 'none';
}
function showOutputError(msg) {
  const el = document.getElementById('output-error');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearOutputError() {
  document.getElementById('output-error').style.display = 'none';
}

/* ── Utility ────────────────────────────────────────────────────── */
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Init ───────────────────────────────────────────────────────── */
(function init() {
  // The subjects pane starts hidden because the CSS class approach and display flex interact.
  // Ensure consistent initial state:
  document.querySelectorAll('.edm-pane').forEach(p => {
    p.classList.remove('active');
    p.style.display = 'none';
  });
  const previewPane = document.getElementById('pane-preview');
  previewPane.style.display = 'flex';
  previewPane.classList.add('active');
})();
