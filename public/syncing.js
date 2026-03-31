function formatDate(d) {
  if (!d) return 'Never';
  return new Date(d).toLocaleString();
}

const btnSync       = document.getElementById('btn-inventory-sync');
const statusText    = document.getElementById('inventory-status-text');
const statusDot     = document.querySelector('#card-inventory .sync-status-dot');
const logEl         = document.getElementById('inventory-log');

function setStatus(state, text) {
  statusDot.className = `sync-status-dot sync-status-dot--${state}`;
  statusText.textContent = text;
}

function appendLog(msg, type = 'info') {
  logEl.style.display = 'block';
  const line = document.createElement('div');
  line.className = `sync-log-line sync-log-line--${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// Check current cache status on load
(async () => {
  try {
    const res  = await fetch('/api/products/status');
    const data = await res.json();
    if (data.count > 0) {
      setStatus('ok', `${data.count} products loaded — last synced ${formatDate(data.lastFetched)}`);
    } else {
      setStatus('idle', 'Not synced yet — click Sync Inventory to load');
    }
  } catch {
    setStatus('error', 'Could not reach server');
  }
})();

btnSync.addEventListener('click', async () => {
  btnSync.disabled = true;
  setStatus('syncing', 'Syncing…');
  appendLog('Starting Shopify inventory sync…');

  try {
    const res  = await fetch('/api/products/refresh');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    setStatus('ok', `${data.count} products loaded — synced ${formatDate(data.lastFetched)}`);
    appendLog(`Done — ${data.count} active products loaded.`, 'success');
  } catch (err) {
    setStatus('error', 'Sync failed');
    appendLog(`Error: ${err.message}`, 'error');
  } finally {
    btnSync.disabled = false;
  }
});
