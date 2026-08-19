/* Style Forecast — event stock planning for one style */
(function () {
  let targetProduct  = null;   // { id, title, image }
  let compareProduct = null;
  let lastAnalysis   = null;

  const F = (id) => document.getElementById(id);

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtNum(n) { return Number(n || 0).toLocaleString('en-AU'); }
  function fmtMoney(n) {
    return '$' + Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 });
  }
  function debounce(fn, ms) {
    let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function sizeSort(a, b) {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    const order = ['XXS','XS','S','M','L','XL','XXL','XXXL'];
    const ia = order.indexOf(String(a).toUpperCase()), ib = order.indexOf(String(b).toUpperCase());
    if (ia !== -1 && ib !== -1) return ia - ib;
    return String(a).localeCompare(String(b));
  }

  /* ── Product pickers ──────────────────────────────────────────── */
  function setupPicker(searchId, ddId, chipId, onSelect, getCurrent) {
    const input = F(searchId), dd = F(ddId);
    const doSearch = debounce(async (q) => {
      if (q.length < 2) { dd.classList.remove('open'); return; }
      dd.innerHTML = '<div class="sf-dd-msg">Searching…</div>';
      dd.classList.add('open');
      try {
        const res  = await fetch(`/api/stocktake/search-live?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!data.length) { dd.innerHTML = '<div class="sf-dd-msg">No styles found</div>'; return; }
        dd.innerHTML = data.map(p => `
          <div class="sf-dd-opt" data-id="${p.id}" data-title="${escHtml(p.title)}" data-image="${escHtml(p.image || '')}">
            ${p.image ? `<img src="${escHtml(p.image)}" alt="" />` : '<span style="width:34px;height:34px;border-radius:6px;background:#f1f5f9;display:inline-block"></span>'}
            <span>${escHtml(p.title)}</span>
          </div>`).join('');
        dd.querySelectorAll('.sf-dd-opt').forEach(opt => {
          opt.addEventListener('click', () => {
            onSelect({ id: Number(opt.dataset.id), title: opt.dataset.title, image: opt.dataset.image || null });
            input.value = '';
            dd.classList.remove('open');
            renderChip(chipId, getCurrent(), onSelect);
          });
        });
      } catch (err) {
        dd.innerHTML = `<div class="sf-dd-msg">${escHtml(err.message)}</div>`;
      }
    }, 300);
    input.addEventListener('input', (e) => doSearch(e.target.value.trim()));
  }

  function renderChip(chipId, product, onSelect) {
    const el = F(chipId);
    if (!product) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <span class="sf-chip">
        ${product.image ? `<img src="${escHtml(product.image)}" alt="" />` : ''}
        ${escHtml(product.title)}
        <button title="Clear">✕</button>
      </span>`;
    el.querySelector('button').addEventListener('click', () => {
      onSelect(null);
      renderChip(chipId, null, onSelect);
    });
  }

  setupPicker('sf-target-search', 'sf-target-dd', 'sf-target-chip',
    (p) => { targetProduct = p; }, () => targetProduct);
  setupPicker('sf-compare-search', 'sf-compare-dd', 'sf-compare-chip',
    (p) => { compareProduct = p; }, () => compareProduct);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sf-picker')) {
      document.querySelectorAll('.sf-dd.open').forEach(d => d.classList.remove('open'));
    }
  });

  /* ── Run forecast ─────────────────────────────────────────────── */
  F('sf-run').addEventListener('click', runForecast);

  async function runForecast() {
    if (!targetProduct) { alert('Pick a style to forecast first.'); return; }
    const params = new URLSearchParams({
      product_id: targetProduct.id,
      start: F('sf-start').value,
      end: F('sf-end').value,
      growth: F('sf-growth').value || '0',
      event_start: F('sf-event-start').value,
    });
    if (F('sf-event-days').value) params.set('event_days', F('sf-event-days').value);
    if (compareProduct) params.set('compare_product_id', compareProduct.id);

    F('sf-results').style.display = 'none';
    F('sf-loading').style.display = '';
    F('sf-run').disabled = true;
    try {
      const res = await fetch(`/api/style-forecast?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Forecast failed');
      lastAnalysis = data;
      renderResults(data);
      F('sf-results').style.display = '';
    } catch (err) {
      alert(`Forecast failed: ${err.message}`);
    } finally {
      F('sf-loading').style.display = 'none';
      F('sf-run').disabled = false;
    }
  }

  /* ── Render ───────────────────────────────────────────────────── */
  function renderResults(d) {
    const m = d.model;

    /* Warnings */
    let warn = '';
    if (m.insufficient_history && !d.compare) {
      warn += `<div class="sf-note">⚠ <strong>${escHtml(d.target.title)}</strong> sold only ${d.ref_period.units} units in the reference window —
        not enough history for a reliable forecast. Pick a <strong>comparison style</strong> above (the closest similar style that WAS selling last year) and re-run.</div>`;
    }
    if (d.compare) {
      warn += `<div class="sf-note">Reference history comes from <strong>${escHtml(d.compare.title)}</strong> — the forecast scales it by how "${escHtml(d.target.title)}" is selling right now.</div>`;
    }
    F('sf-warnings').innerHTML = warn;

    /* Reference period */
    F('sf-ref-badge').innerHTML = d.compare ? '<span class="sf-badge proxy">comparison style</span>' : '';
    F('sf-ref-sub').textContent =
      `${new Date(d.window.start).toLocaleDateString('en-AU')} → ${new Date(d.window.end).toLocaleDateString('en-AU')} (${d.window.period_days} days)`;
    F('sf-ref-tiles').innerHTML = `
      <div class="sf-tile"><div class="sf-tile-num">${fmtNum(d.ref_period.units)}</div><div class="sf-tile-label">Units Sold</div></div>
      <div class="sf-tile"><div class="sf-tile-num">${fmtMoney(d.ref_period.revenue)}</div><div class="sf-tile-label">Revenue</div></div>
      <div class="sf-tile"><div class="sf-tile-num">${m.ref_period_vel}</div><div class="sf-tile-label">Units / Day</div></div>
      <div class="sf-tile"><div class="sf-tile-num">${m.ref_pre_vel}</div><div class="sf-tile-label">Pre-Event Units / Day</div></div>`;

    const refSizes = Object.keys(d.ref_period.bySize).sort(sizeSort);
    F('sf-ref-table').innerHTML = refSizes.length ? `
      <thead><tr><th>Size</th>${refSizes.map(s => `<th>${escHtml(s)}</th>`).join('')}</tr></thead>
      <tbody><tr><td>Units</td>${refSizes.map(s => `<td>${fmtNum(d.ref_period.bySize[s].units)}</td>`).join('')}</tr></tbody>`
      : '<tbody><tr><td>No sales in the reference window.</td></tr></tbody>';

    /* Momentum */
    const momCls = m.momentum === null ? '' : (m.momentum >= 1.05 ? 'up' : m.momentum <= 0.95 ? 'down' : '');
    const momArrow = m.momentum === null ? '—' : (m.momentum >= 1.4 ? '↑↑' : m.momentum >= 1.05 ? '↑' : m.momentum >= 0.95 ? '→' : m.momentum >= 0.6 ? '↓' : '↓↓');
    F('sf-momentum-tiles').innerHTML = `
      <div class="sf-tile"><div class="sf-tile-num">${m.current_vel}</div><div class="sf-tile-label">Current Units / Day (42d)</div></div>
      <div class="sf-tile"><div class="sf-tile-num ${momCls}">${m.momentum !== null ? m.momentum + 'x ' + momArrow : '—'}</div><div class="sf-tile-label">Momentum vs Last Year's Lead-Up</div></div>
      <div class="sf-tile"><div class="sf-tile-num">${m.amplification !== null ? m.amplification + 'x' : '—'}</div><div class="sf-tile-label">Event Demand Amplification</div></div>
      <div class="sf-tile"><div class="sf-tile-num">${m.growth_pct}%</div><div class="sf-tile-label">Growth Assumption</div></div>
      <div class="sf-tile"><div class="sf-tile-num">${m.predicted_units !== null ? fmtNum(m.predicted_units) : '—'}</div><div class="sf-tile-label">Predicted Event Units (${m.event_days}d)</div></div>`;
    F('sf-formula').innerHTML =
      `Model: predicted units = current velocity (${m.current_vel}/day) × amplification (${m.amplification ?? '—'}x — how much the reference style lifted during last year's event) × growth (${(1 + m.growth_pct / 100).toFixed(2)}) × ${m.event_days} days.` +
      ` Momentum is shown for context — it's already baked in because the model starts from today's velocity, not last year's.` +
      ` Size mix from ${m.mix_from === 'reference_period' ? 'the reference period' : 'current sales (reference too thin)'}.` +
      (m.days_to_event ? ` Pre-event depletion assumes current velocity holds for the ${m.days_to_event} days until the event.` : '');

    /* Suggested order */
    const totals = { ref_units: 0, current_42d: 0, stock: 0, incoming: 0, depletion: 0, conservative: 0, expected: 0, aggressive: 0 };
    const rows = d.sizes.map(s => {
      ['ref_units','current_42d','stock','incoming','depletion','conservative','expected','aggressive'].forEach(k => {
        totals[k] += s[k] || 0;
      });
      return `<tr>
        <td>${escHtml(s.size)}</td>
        <td>${fmtNum(s.ref_units)}</td>
        <td>${fmtNum(s.current_42d)}</td>
        <td>${s.mix_pct}%</td>
        <td>${fmtNum(s.stock)}</td>
        <td>${s.incoming ? '+' + fmtNum(s.incoming) : '—'}</td>
        <td>${s.depletion ? '−' + fmtNum(s.depletion) : '—'}</td>
        <td class="sf-order-cell conservative">${s.conservative !== null ? fmtNum(s.conservative) : '—'}</td>
        <td class="sf-order-cell expected">${s.expected !== null ? fmtNum(s.expected) : '—'}</td>
        <td class="sf-order-cell aggressive">${s.aggressive !== null ? fmtNum(s.aggressive) : '—'}</td>
      </tr>`;
    }).join('');

    F('sf-order-table').innerHTML = `
      <thead><tr>
        <th>Size</th><th>Ref Units</th><th>Sold 42d</th><th>Mix</th><th>Stock</th><th>Incoming</th><th>Pre-Event Sales</th>
        <th>🟢 Conservative</th><th>🔵 Expected</th><th>🟣 Aggressive</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td>Total</td>
        <td>${fmtNum(totals.ref_units)}</td>
        <td>${fmtNum(totals.current_42d)}</td>
        <td></td>
        <td>${fmtNum(totals.stock)}</td>
        <td>${totals.incoming ? '+' + fmtNum(totals.incoming) : '—'}</td>
        <td>${totals.depletion ? '−' + fmtNum(totals.depletion) : '—'}</td>
        <td class="sf-order-cell conservative">${fmtNum(totals.conservative)}</td>
        <td class="sf-order-cell expected">${fmtNum(totals.expected)}</td>
        <td class="sf-order-cell aggressive">${fmtNum(totals.aggressive)}</td>
      </tr></tfoot>`;

    /* Reset insight */
    F('sf-insight-body').innerHTML =
      '<div class="sf-card-sub">Runs the numbers past Claude for a momentum read, size-risk callouts, and a scenario recommendation weighted to your "don\'t over-order" priority.</div>';
  }

  /* ── AI insight ───────────────────────────────────────────────── */
  F('sf-insight-btn').addEventListener('click', async () => {
    if (!lastAnalysis) { alert('Run a forecast first.'); return; }
    const btn = F('sf-insight-btn');
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    F('sf-insight-body').innerHTML = '<div class="sf-loading">Analysing the numbers…</div>';
    try {
      const res = await fetch('/api/style-forecast/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ analysis: lastAnalysis }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Insight failed');
      F('sf-insight-body').innerHTML = `<div class="sf-insight">${escHtml(data.insight)}</div>`;
    } catch (err) {
      F('sf-insight-body').innerHTML = `<div class="sf-card-sub" style="color:#b91c1c">Failed: ${escHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Insight';
    }
  });
})();
