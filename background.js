/**
 * DevReload - background.js (Service Worker)
 * Lightweight orchestrator — polling runs in offscreen.js (long-lived window).
 */

// ─── IndexedDB ────────────────────────────────────────────────────────────────

const DB_NAME = 'DevReloadDB', DB_VERSION = 1, STORE_NAME = 'handles', HANDLE_KEY = 'watchedDirectory';

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}
async function saveHandle(h) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE_NAME,'readwrite'); tx.objectStore(STORE_NAME).put(h, HANDLE_KEY); tx.oncomplete=()=>res(); tx.onerror=e=>rej(e.target.error); });
}
async function loadHandle() {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE_NAME,'readonly'); const r = tx.objectStore(STORE_NAME).get(HANDLE_KEY); r.onsuccess=e=>res(e.target.result||null); r.onerror=e=>rej(e.target.error); });
}
async function clearHandle() {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE_NAME,'readwrite'); tx.objectStore(STORE_NAME).delete(HANDLE_KEY); tx.oncomplete=()=>res(); tx.onerror=e=>rej(e.target.error); });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

let settings = { enabled:false, interval:1000, extensions:'.html .css .js .php .vue .ts', originMode:false };
let dirHandle = null;

/** Origin to reload (e.g. "http://localhost:3000" or "https://sub.domena.cz"). null = active tab fallback. */
let watchedOrigin = null;

async function loadSettings() {
  const s = await chrome.storage.local.get(['enabled','interval','extensions','originMode','watchedOrigin']);
  settings      = { enabled:s.enabled??false, interval:s.interval??1000, extensions:s.extensions??'.html .css .js .php .vue .ts', originMode:s.originMode??false };
  watchedOrigin = s.watchedOrigin ?? null;
}
async function saveSettings() {
  await chrome.storage.local.set({ ...settings, watchedOrigin });
}

// ─── Offscreen document ───────────────────────────────────────────────────────

/** @type {chrome.runtime.Port|null} */
let offscreenPort = null;

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'Runs setInterval polling for file changes in a long-lived window context',
    });
  } catch (err) {
    // "Only a single offscreen document may be created" — already open, that's fine
    if (!err.message?.includes('single offscreen document')) {
      throw err;
    }
  }
}

async function closeOffscreen() {
  offscreenPort = null;
  try { await chrome.offscreen.closeDocument(); } catch (_) {}
}

function sendToOffscreen(msg) {
  if (offscreenPort) try { offscreenPort.postMessage(msg); } catch (_) {}
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Action icon & per-tab badge ──────────────────────────────────────────────

/** Switch the toolbar icon between colour (active) and grey (idle). */
function updateExtensionIcon() {
  const active = settings.enabled && !!dirHandle;
  chrome.action.setIcon({
    path: active
      ? { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' }
      : { 16: 'icons/icon-gray-16.png', 32: 'icons/icon-gray-32.png', 48: 'icons/icon-gray-48.png', 128: 'icons/icon-gray-128.png' },
  });
}

/** Update the action badge for a specific tab based on watcher state. */
function updateBadgeForTab(tabId, tabUrl) {
  let show = false;
  if (tabUrl && settings.enabled && watchedOrigin) {
    try { show = new URL(tabUrl).origin === watchedOrigin; } catch (_) {}
  }
  if (show) {
    chrome.action.setBadgeText({ text: '\u25cf', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
    chrome.action.setBadgeTextColor({ color: '#ffffff', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

/** Re-evaluate the badge on every open tab. */
async function updateAllTabBadges() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null) updateBadgeForTab(tab.id, tab.url ?? '');
  }
}

// ─── Change log ───────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 50;
const LOG_MAX_AGE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

async function appendLogEntry(path, changeType, timestamp) {
  const stored  = await chrome.storage.local.get(['logEntries']);
  let entries   = (stored.logEntries || []).filter(e => timestamp - e.timestamp < LOG_MAX_AGE_MS);
  entries.push({ path, changeType, timestamp, origin: watchedOrigin || null });
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ logEntries: entries });
}

// ─── Tab reload ───────────────────────────────────────────────────────────────

async function fullReload() {
  const reloadOpts = { bypassCache: true };
  if (settings.originMode && watchedOrigin) {
    const tabs = await chrome.tabs.query({ url: watchedOrigin + '/*' });
    if (tabs.length > 0) {
      await Promise.all(tabs.map(t => chrome.tabs.reload(t.id, reloadOpts).catch(() => {})));
      return;
    }
  }
  // Fallback: reload whatever tab is currently active
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (tab?.id) await chrome.tabs.reload(tab.id, reloadOpts).catch(() => {});
}

// ─── File scanning (runs in SW — FSA is NOT available in offscreen docs) ──────

function parseExtensions(extString) {
  return new Set(
    extString.split(/[\s,;]+/).map(e => e.trim().toLowerCase()).filter(e => e.startsWith('.') && e.length > 1)
  );
}

async function listAllFiles(handle, prefix = '') {
  const results = [];
  for await (const [name, entry] of handle.entries()) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') results.push({ path: fullPath, fileHandle: entry });
    else if (entry.kind === 'directory') results.push(...await listAllFiles(entry, fullPath));
  }
  return results;
}

async function snapshotFiles(handle, allowedExts) {
  const snapshot = new Map();
  for (const { path, fileHandle } of await listAllFiles(handle)) {
    const ext = '.' + path.split('.').pop().toLowerCase();
    if (allowedExts.has(ext)) {
      const file = await fileHandle.getFile();
      snapshot.set(path, file.lastModified);
    }
  }
  return snapshot;
}

// ─── Polling state ────────────────────────────────────────────────────────────

/** Map<string, number> — file path → lastModified */
let fileSnapshots = new Map();
/** Whether we have a valid baseline snapshot yet */
let snapshotReady = false;
/** Timestamp of last poll tick (ms) */
let lastPollTime = 0;

async function pollOnce() {
  if (!dirHandle || !settings.enabled) return;
  const allowedExts = parseExtensions(settings.extensions);
  let current;
  try {
    current = await snapshotFiles(dirHandle, allowedExts);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      console.warn('[DevReload SW] Permission lost.');
      settings.enabled = false; await saveSettings();
      await stopWatching();
      broadcastToPopup({ type: 'PERMISSION_LOST' });
    } else {
      console.error('[DevReload SW] Scan error:', err.name, err.message);
    }
    return;
  }

  if (!snapshotReady) {
    fileSnapshots = current;
    snapshotReady = true;
    console.log(`[DevReload SW] Baseline: ${current.size} files tracked.`);
    return;
  }

  const changed = [];
  for (const [path, modified] of current) {
    const prev = fileSnapshots.get(path);
    if (prev === undefined) changed.push({ path, changeType: 'added' });
    else if (modified !== prev) changed.push({ path, changeType: 'changed' });
  }
  for (const path of fileSnapshots.keys()) {
    if (!current.has(path)) changed.push({ path, changeType: 'removed' });
  }
  fileSnapshots = current;

  if (changed.length === 0) return;

  const now = Date.now();
  for (const c of changed) {
    await appendLogEntry(c.path, c.changeType, now);
    broadcastToPopup({ type: 'FILE_CHANGED', path: c.path, changeType: c.changeType, timestamp: now, origin: watchedOrigin || null });
  }

  await fullReload();
}

// ─── Offscreen port (heartbeat only) ────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen-polling') return;
  offscreenPort = port;
  console.log('[DevReload SW] Offscreen heartbeat connected.');

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'READY') {
      // Offscreen is alive — take baseline snapshot
      console.log('[DevReload SW] READY. enabled:', settings.enabled, 'hasHandle:', !!dirHandle);
      if (settings.enabled && dirHandle) {
        snapshotReady = false;
        fileSnapshots = new Map();
        lastPollTime = 0;
        await pollOnce(); // take baseline immediately
      }
    } else if (msg.type === 'TICK') {
      // Heartbeat tick (every 500ms) — run poll if interval has elapsed
      if (settings.enabled && dirHandle && snapshotReady) {
        const now = Date.now();
        if (now - lastPollTime >= settings.interval) {
          lastPollTime = now;
          await pollOnce();
        }
      }
    }
  });

  port.onDisconnect.addListener(() => {
    console.log('[DevReload SW] Offscreen disconnected.');
    offscreenPort = null;
  });
});

// ─── Start / stop ─────────────────────────────────────────────────────────────

async function startWatching() {
  snapshotReady = false;
  fileSnapshots = new Map();
  updateExtensionIcon();
  await updateAllTabBadges();
  await ensureOffscreen();
  // Offscreen READY handler will trigger the first pollOnce.
  // If offscreen was already running, poll immediately.
  if (offscreenPort) {
    await pollOnce();
  }
}

async function stopWatching() {
  snapshotReady = false;
  fileSnapshots = new Map();
  lastPollTime = 0;
  updateExtensionIcon();
  await updateAllTabBadges();
  await closeOffscreen();
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  try { dirHandle = await loadHandle(); } catch (e) { dirHandle = null; }
  if (!dirHandle) { settings.enabled = false; await saveSettings(); updateExtensionIcon(); await updateAllTabBadges(); return; }
  if (settings.enabled) await startWatching();
  else { updateExtensionIcon(); await updateAllTabBadges(); }
}
init();

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'SET_DIRECTORY':
        // Popup saved the handle directly to IndexedDB (sendMessage strips FSA prototype).
        // Reload it here so we get a fully functional FileSystemDirectoryHandle.
        try {
          dirHandle = await loadHandle();
        } catch (e) {
          sendResponse({ ok: false, error: e.message }); break;
        }
        sendResponse({ ok: true, name: msg.name });
        break;
      case 'GET_STATUS':
        sendResponse({ ok:true, name:dirHandle?.name||null, enabled:settings.enabled, settings, watchedOrigin });
        break;
      case 'SET_ORIGIN':
        watchedOrigin = msg.origin ?? null;
        await saveSettings();
        await updateAllTabBadges();
        sendResponse({ ok:true });
        break;
      case 'SET_ORIGIN_MODE':
        settings.originMode = msg.enabled ?? false;
        await saveSettings();
        sendResponse({ ok:true });
        break;
      case 'SET_ENABLED':
        settings.enabled = msg.enabled; await saveSettings();
        if (msg.enabled) {
          if (!dirHandle) { sendResponse({ ok:false, error:'No directory' }); break; }
          await startWatching();
        } else {
          await stopWatching();
        }
        sendResponse({ ok:true });
        break;
      case 'SET_INTERVAL':
        settings.interval = msg.interval; await saveSettings();
        sendResponse({ ok:true });
        break;
      case 'SET_EXTENSIONS':
        settings.extensions = msg.extensions; await saveSettings();
        sendResponse({ ok:true });
        break;
      case 'CLEAR_DIRECTORY':
        settings.enabled = false;
        settings.originMode = false;
        watchedOrigin  = null;
        dirHandle      = null;
        await saveSettings();
        await stopWatching();
        await clearHandle();
        await chrome.storage.local.set({ logEntries: [] });
        sendResponse({ ok:true });
        break;
      default:
        sendResponse({ ok:false, error:'Unknown message' });
    }
  })();
  return true;
});

// ─── Tab event listeners (per-tab badge) ──────────────────────────────────────

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadgeForTab(tabId, tab.url ?? '');
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status === 'complete') {
    updateBadgeForTab(tabId, tab.url ?? '');
  }
});