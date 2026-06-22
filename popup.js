/**
 * DevReload — popup.js
 *
 * Manages the popup UI:
 * - Syncs state from background service worker
 * - Handles user interactions (pick folder, toggle enable, settings)
 * - Receives FILE_CHANGED / PERMISSION_LOST messages and updates the log
 */

// ─── DOM references ───────────────────────────────────────────────────────────

const emptyState    = document.getElementById('empty-state');
const folderInfo    = document.getElementById('folder-info');
const folderName    = document.getElementById('folder-name');
const permWarning   = document.getElementById('perm-warning');
const btnPick       = document.getElementById('btn-pick');
const btnClear      = document.getElementById('btn-clear');
const btnRegrant    = document.getElementById('btn-regrant');
const chkEnabled    = document.getElementById('chk-enabled');
const selInterval   = document.getElementById('sel-interval');
const inpExtensions = document.getElementById('inp-extensions');
const changeLog     = document.getElementById('change-log');
const btnClearLog   = document.getElementById('btn-clear-log');
const headerBadge    = document.getElementById('header-badge');
const chkOriginMode  = document.getElementById('chk-origin-mode');
const originDot      = document.getElementById('origin-dot');
const originModeLabel = document.getElementById('origin-mode-label');
const originDisplay  = document.getElementById('origin-display');

// ─── In-memory log (persisted in chrome.storage.local) ───────────────────────

const MAX_LOG_ENTRIES = 5;

// ─── IndexedDB helper (popup saves handle directly — avoids sendMessage stripping FSA prototype) ───

const DB_NAME = 'DevReloadDB', DB_VERSION = 1, STORE_NAME = 'handles', HANDLE_KEY = 'watchedDirectory';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function saveHandleToDB(handle) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  });
}

async function clearHandleFromDB() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
    tx.oncomplete = () => res();
    tx.onerror    = e => rej(e.target.error);
  });
}

async function loadHandleFromDB() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = e => rej(e.target.error);
  });
}

/** @type {Array<{path: string, changeType: string, timestamp: number}>} */
let logEntries = [];

/**
 * Cached handle received from background — used for permission calls.
 * queryPermission/requestPermission only work in window context (not SW).
 * @type {FileSystemDirectoryHandle|null}
 */
let cachedHandle = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a timestamp to HH:MM:SS */
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Send a message to the background service worker. */
function sendMsg(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ─── UI state helpers ─────────────────────────────────────────────────────────

/**
 * Update the folder section UI.
 * @param {string|null} name
 * @param {boolean} permGranted
 */
function setFolderUI(name, permGranted) {
  if (!name) {
    emptyState.classList.remove('hidden');
    folderInfo.classList.add('hidden');
    permWarning.classList.add('hidden');
    btnClear.classList.add('hidden');
    chkEnabled.disabled = true;
  } else {
    emptyState.classList.add('hidden');
    folderInfo.classList.remove('hidden');
    btnClear.classList.remove('hidden');
    folderName.textContent = name;
    folderName.title = name;
    chkEnabled.disabled = false;

    if (!permGranted) {
      permWarning.classList.remove('hidden');
      chkEnabled.disabled = true;
    } else {
      permWarning.classList.add('hidden');
    }
  }
}

/**
 * Update the watching status indicator.
 * @param {boolean} enabled
 * @param {boolean} permGranted
 */
function setStatusUI(enabled, permGranted) {
  chkEnabled.checked = enabled && permGranted;

  if (!permGranted) {
    headerBadge.textContent = 'Paused';
    headerBadge.className = 'badge badge-paused';
  } else if (enabled) {
    headerBadge.textContent = 'Running';
    headerBadge.className = 'badge badge-live';
  } else {
    headerBadge.textContent = 'Paused';
    headerBadge.className = 'badge badge-paused';
  }
}

/**
 * Update the origin mode toggle UI.
 * @param {string|null} origin  e.g. "http://localhost:3000"
 * @param {boolean} originMode
 */
function setOriginUI(origin, originMode) {
  chkOriginMode.disabled = !origin;
  chkOriginMode.checked  = originMode && !!origin;
  if (origin && originMode) {
    originDot.className              = 'dot dot-on';
    originModeLabel.textContent      = 'Reload: ' + origin;
    originDisplay.textContent        = 'Only tabs on this origin will reload';
  } else if (origin) {
    originDot.className              = 'dot dot-off';
    originModeLabel.textContent      = 'Reload: active tab';
    originDisplay.textContent        = 'Detected origin: ' + origin;
  } else {
    originDot.className              = 'dot dot-off';
    originModeLabel.textContent      = 'Reload: active tab';
    originDisplay.textContent        = 'Pick a folder to detect origin';
  }
}

// ─── Change log UI ────────────────────────────────────────────────────────────

/** Render the log list from `logEntries`. */
function renderLog() {
  if (logEntries.length === 0) {
    changeLog.innerHTML = '<li class="log-empty">No changes detected yet.</li>';
    return;
  }

  changeLog.innerHTML = '';
  for (const entry of [...logEntries].reverse()) {
    const li = document.createElement('li');
    li.className = 'log-item';

    const badgeClass = {
      changed: 'log-badge-changed',
      added:   'log-badge-added',
      removed: 'log-badge-removed',
    }[entry.changeType] || 'log-badge-changed';

    // Show only the file name portion for brevity; show full path on title
    const parts = entry.path.split('/');
    const displayName = parts.slice(-2).join('/'); // parent/file.ext
    const originLabel = entry.origin ? entry.origin.replace(/^https?:\/\//, '') : null;

    li.innerHTML = `
      <span class="log-path" title="${escHtml(entry.path)}">${escHtml(displayName)}</span>
      ${originLabel ? `<span class="log-origin">${escHtml(originLabel)}</span>` : ''}
      <span class="log-badge ${badgeClass}">${escHtml(entry.changeType)}</span>
      <span class="log-time">${formatTime(entry.timestamp)}</span>
    `;
    changeLog.appendChild(li);
  }
}

/** Escape HTML entities to safely insert into innerHTML. */
function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Add an entry to the log (capped at MAX_LOG_ENTRIES) and persist + re-render.
 * @param {string} path
 * @param {string} changeType
 * @param {number} timestamp
 */
function addLogEntry(path, changeType, timestamp, origin = null) {
  logEntries.push({ path, changeType, timestamp, origin });
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.splice(0, logEntries.length - MAX_LOG_ENTRIES);
  }
  // Storage zápis přeskočíme — background.js ukládá přímo do storage
  renderLog();
}

// ─── Init — load state from background ───────────────────────────────────────

async function init() {
  // Restore log from storage — drop entries older than 7 days
  const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const stored = await chrome.storage.local.get(['logEntries']);
  const now = Date.now();
  logEntries = (stored.logEntries || []).filter(e => now - e.timestamp < LOG_MAX_AGE_MS);
  renderLog();

  // Fetch live state from background
  let status;
  try {
    status = await sendMsg({ type: 'GET_STATUS' });
  } catch {
    // Background not ready yet — show default UI
    setFolderUI(null, false);
    setStatusUI(false, false);
    return;
  }

  const { name, settings } = status;

  // Load handle directly from IndexedDB — sending it via sendMessage strips FSA prototype
  cachedHandle = await loadHandleFromDB();

  // Check permission in this window context (queryPermission not available in SW)
  let permissionGranted = false;
  if (cachedHandle) {
    try {
      const perm = await cachedHandle.queryPermission({ mode: 'read' });
      permissionGranted = perm === 'granted';
    } catch (err) {
      console.warn('[DevReload] queryPermission failed:', err);
      permissionGranted = false;
    }
  }

  // Restore settings UI
  selInterval.value   = String(settings.interval ?? 1000);
  inpExtensions.value = settings.extensions ?? '.html .css .js .php .vue .ts';

  setOriginUI(status.watchedOrigin || null, status.settings.originMode ?? false);
  setFolderUI(name, permissionGranted);
  setStatusUI(settings.enabled, permissionGranted || !name);
}

// ─── Event listeners ──────────────────────────────────────────────────────────

/** Pick folder button */
btnPick.addEventListener('click', async () => {
  // showDirectoryPicker must be called from a user gesture inside the popup page
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[DevReload] showDirectoryPicker failed:', err);
    }
    return;
  }

  // Request read permission explicitly (usually auto-granted from picker)
  try {
    await handle.requestPermission({ mode: 'read' });
  } catch (err) {
    console.warn('[DevReload] requestPermission failed:', err);
  }

  // Save handle directly to IndexedDB from the popup context.
  // Do NOT send it via sendMessage — structured clone strips FSA prototype methods,
  // making handle.entries() unavailable in the SW.
  try {
    await saveHandleToDB(handle);
  } catch (err) {
    console.error('[DevReload] Failed to save handle to IndexedDB:', err);
    return;
  }

  // Tell SW to reload the handle from IndexedDB and register the folder name
  try {
    await sendMsg({ type: 'SET_DIRECTORY', name: handle.name });
  } catch (err) {
    console.error('[DevReload] SET_DIRECTORY failed:', err);
    return;
  }

  setFolderUI(handle.name, true);
  permWarning.classList.add('hidden');
  chkEnabled.disabled = false;

  // Auto-start watching after folder pick
  const enableResult = await sendMsg({ type: 'SET_ENABLED', enabled: true });
  if (enableResult?.ok) {
    chkEnabled.checked = true;
    setStatusUI(true, true);
  } else {
    setStatusUI(chkEnabled.checked, true);
  }

  // Auto-detect origin from the currently active tab
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url) {
    try {
      const origin = new URL(activeTab.url).origin;
      if (origin && origin !== 'null') {
        await sendMsg({ type: 'SET_ORIGIN', origin });
        await sendMsg({ type: 'SET_ORIGIN_MODE', enabled: true });
        setOriginUI(origin, true);
      }
    } catch (_) {}
  }
});

/** Clear folder button */
btnClear.addEventListener('click', async () => {
  chkEnabled.checked = false;
  await sendMsg({ type: 'SET_ENABLED', enabled: false });
  await clearHandleFromDB();          // clear from popup context (full FSA object)
  await sendMsg({ type: 'CLEAR_DIRECTORY' });
  setFolderUI(null, false);
  setStatusUI(false, false);
  setOriginUI(null, false);
});

/** Re-grant permission button */
btnRegrant.addEventListener('click', async () => {
  // requestPermission must be called from a user gesture in a window context
  if (!cachedHandle) {
    alert('No folder stored. Please pick the folder again.');
    return;
  }
  try {
    const perm = await cachedHandle.requestPermission({ mode: 'read' });
    if (perm === 'granted') {
      permWarning.classList.add('hidden');
      chkEnabled.disabled = false;

      // Re-persist the handle and force the SW to reload it from IndexedDB.
      // This is critical: requestPermission() was called in the popup (window)
      // context, but the SW's in-memory dirHandle may not yet reflect the
      // updated permission state. Re-saving + SET_DIRECTORY gives the SW a
      // freshly-loaded handle reference that passes the Chrome permission check
      // on the very first poll, preventing a PERMISSION_LOST loop.
      try {
        await saveHandleToDB(cachedHandle);
        await sendMsg({ type: 'SET_DIRECTORY', name: cachedHandle.name });
      } catch (e) {
        console.warn('[DevReload] Failed to refresh handle after re-grant:', e);
      }

      // Auto-start watching after permission re-granted
      const enableResult = await sendMsg({ type: 'SET_ENABLED', enabled: true });
      if (enableResult?.ok) {
        chkEnabled.checked = true;
        setStatusUI(true, true);
      } else {
        setStatusUI(chkEnabled.checked, true);
      }
    } else {
      alert('Permission was not granted. Please try picking the folder again.');
    }
  } catch (err) {
    console.error('[DevReload] requestPermission failed:', err);
    alert('Permission was not granted. Please try picking the folder again.');
  }
});

/** Origin mode toggle */
chkOriginMode.addEventListener('change', async () => {
  const enabled = chkOriginMode.checked;
  await sendMsg({ type: 'SET_ORIGIN_MODE', enabled });
  const status = await sendMsg({ type: 'GET_STATUS' });
  setOriginUI(status.watchedOrigin || null, enabled);
});

/** Enable / disable toggle */
chkEnabled.addEventListener('change', async () => {
  const enabled = chkEnabled.checked;
  const result = await sendMsg({ type: 'SET_ENABLED', enabled });
  if (!result?.ok && enabled) {
    // Couldn't enable (e.g. no directory)
    chkEnabled.checked = false;
    return;
  }
  setStatusUI(enabled, true);
});

/** Polling interval selector */
selInterval.addEventListener('change', () => {
  sendMsg({ type: 'SET_INTERVAL', interval: Number(selInterval.value) });
});

/** Extension filter input — debounce 600 ms */
let extDebounce;
inpExtensions.addEventListener('input', () => {
  clearTimeout(extDebounce);
  extDebounce = setTimeout(() => {
    sendMsg({ type: 'SET_EXTENSIONS', extensions: inpExtensions.value.trim() });
  }, 600);
});

/** Clear log button */
btnClearLog.addEventListener('click', () => {
  logEntries = [];
  chrome.storage.local.set({ logEntries: [] });
  renderLog();
});

// ─── Runtime messages from background ────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FILE_CHANGED') {
    addLogEntry(msg.path, msg.changeType, msg.timestamp, msg.origin || null);
  } else if (msg.type === 'PERMISSION_LOST') {
    permWarning.classList.remove('hidden');
    chkEnabled.checked = false;
    chkEnabled.disabled = true;
    setStatusUI(false, false);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
