/**
 * DevReload — offscreen.js
 *
 * Offscreen documents (Chrome 109+) are long-lived hidden pages that keep
 * the service worker alive by sending periodic messages.
 *
 * NOTE: The File System Access API is NOT available in offscreen documents
 * (Chrome blocks it in hidden contexts). All file scanning runs in background.js.
 * This file's only job is to send a TICK every 500 ms so the SW never sleeps.
 */

const port = chrome.runtime.connect({ name: 'offscreen-polling' });

// Notify SW we are alive
port.postMessage({ type: 'READY' });

// Send a heartbeat tick every 500 ms — this resets the SW idle timer
const tickInterval = setInterval(() => {
  try {
    port.postMessage({ type: 'TICK' });
  } catch (_) {
    clearInterval(tickInterval);
  }
}, 500);

port.onDisconnect.addListener(() => {
  clearInterval(tickInterval);
});

console.log('[DevReload Offscreen] Heartbeat started.');

port.onMessage.addListener(async (msg) => {
  console.log('[DevReload Offscreen] Received message:', msg.type);
  switch (msg.type) {
    case 'START_WATCHING':
      await handleStart(msg.settings);
      break;
    case 'STOP_WATCHING':
      stopPolling();
      break;
    case 'UPDATE_SETTINGS':
      Object.assign(currentSettings, msg.settings);
      if (pollTimer !== null) {
        stopPolling();
        startPolling();
      }
      break;
    case 'SET_HANDLE':
      // Handle changed — reload from IndexedDB and restart polling if active
      if (pollTimer !== null) {
        stopPolling();
        await handleStart(currentSettings);
      }
      break;
  }
});

port.onDisconnect.addListener(() => {
  // Service worker disconnected — stop to avoid errors
  stopPolling();
});

// ─── IndexedDB helpers (mirrored from background.js) ─────────────────────────

const DB_NAME    = 'DevReloadDB';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'watchedDirectory';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME);
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

async function loadHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {FileSystemDirectoryHandle|null} */
let dirHandle = null;

/** Map<string, number> — relative path → lastModified */
let fileSnapshots = new Map();

/** @type {number|null} */
let pollTimer = null;

let currentSettings = {
  interval:   1000,
  extensions: '.html .css .js .php .vue .ts',
  cssOnly:    false,
};

// ─── File scanning ────────────────────────────────────────────────────────────

function parseExtensions(extString) {
  return new Set(
    extString
      .split(/[\s,;]+/)
      .map(e => e.trim().toLowerCase())
      .filter(e => e.startsWith('.') && e.length > 1)
  );
}

async function listAllFiles(handle, prefix = '') {
  const results = [];
  for await (const [name, entry] of handle.entries()) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'file') {
      results.push({ path: fullPath, fileHandle: entry });
    } else if (entry.kind === 'directory') {
      results.push(...await listAllFiles(entry, fullPath));
    }
  }
  return results;
}

async function snapshotFiles(handle, allowedExts) {
  const snapshot = new Map();
  const allFiles = await listAllFiles(handle);
  for (const { path, fileHandle } of allFiles) {
    const ext = '.' + path.split('.').pop().toLowerCase();
    if (allowedExts.has(ext)) {
      const file = await fileHandle.getFile();
      snapshot.set(path, file.lastModified);
    }
  }
  return snapshot;
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function pollOnce() {
  if (!dirHandle) return;

  const allowedExts = parseExtensions(currentSettings.extensions);
  let currentSnapshot;
  try {
    currentSnapshot = await snapshotFiles(dirHandle, allowedExts);
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      console.warn('[DevReload Offscreen] Permission lost during poll.');
      stopPolling();
      port.postMessage({ type: 'PERMISSION_LOST' });
    } else {
      console.error('[DevReload Offscreen] Scan error:', err);
      port.postMessage({ type: 'ERROR', name: err.name, message: err.message });
    }
    return;
  }

  const changedFiles = [];

  for (const [path, modified] of currentSnapshot) {
    const prev = fileSnapshots.get(path);
    if (prev === undefined) {
      changedFiles.push({ path, changeType: 'added' });
    } else if (modified !== prev) {
      changedFiles.push({ path, changeType: 'changed' });
    }
  }

  for (const path of fileSnapshots.keys()) {
    if (!currentSnapshot.has(path)) {
      changedFiles.push({ path, changeType: 'removed' });
    }
  }

  fileSnapshots = currentSnapshot;

  if (changedFiles.length === 0) return;

  // Send each change to the service worker for popup log + tab reload
  for (const change of changedFiles) {
    port.postMessage({
      type:       'FILE_CHANGED',
      path:       change.path,
      changeType: change.changeType,
      timestamp:  Date.now(),
      cssOnly:    currentSettings.cssOnly,
    });
  }
}

async function startPolling() {
  if (pollTimer !== null) clearInterval(pollTimer);

  // Take initial snapshot FIRST — interval only starts after we have a baseline.
  // This prevents false positives and ensures the first diff is meaningful.
  const allowedExts = parseExtensions(currentSettings.extensions);
  try {
    fileSnapshots = await snapshotFiles(dirHandle, allowedExts);
    console.log(`[DevReload Offscreen] Baseline snapshot: ${fileSnapshots.size} files. Starting poll every ${currentSettings.interval} ms.`);
  } catch (err) {
    console.error('[DevReload Offscreen] Initial snapshot failed:', err);
    // Send full error details back so SW console shows what actually went wrong
    port.postMessage({ type: 'ERROR', name: err.name, message: err.message });
    return;
  }

  pollTimer = setInterval(pollOnce, currentSettings.interval);
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  fileSnapshots = new Map();
  console.log('[DevReload Offscreen] Stopped.');
}

// ─── Start handler ────────────────────────────────────────────────────────────

async function handleStart(settings) {
  Object.assign(currentSettings, settings);
  console.log('[DevReload Offscreen] handleStart — loading handle from IndexedDB...');

  // FileSystemDirectoryHandle cannot be transferred via postMessage between
  // a service worker and an offscreen document — it loses its prototype methods.
  // Always load the handle fresh from IndexedDB (same origin, same IndexedDB).
  try {
    dirHandle = await loadHandle();
  } catch (err) {
    console.error('[DevReload Offscreen] Could not load handle from IndexedDB:', err);
    port.postMessage({ type: 'NO_HANDLE' });
    return;
  }

  if (!dirHandle) {
    console.warn('[DevReload Offscreen] No handle in IndexedDB.');
    port.postMessage({ type: 'NO_HANDLE' });
    return;
  }

  console.log('[DevReload Offscreen] Handle loaded:', dirHandle.name, '— starting polling...');
  await startPolling();
}
