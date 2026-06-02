# DevReload — Chrome Web Store Listing

---

## Title

**DevReload — Local File Watcher & Auto Reload**

---

## Short Description (132 chars)

Watch local project files for changes and auto-reload your tab instantly. No server, no npm — just the File System Access API.

---

## Full Description

**DevReload** is a zero-dependency live-reload tool built for web developers who want instant browser feedback while editing local files — without spinning up a dev server.

### How it works

Pick a local project folder once. DevReload silently polls your files in the background and reloads the active tab the moment it detects a change.

### Key features

🗂 **Folder watching via File System Access API**
Grant read access to any local folder — no uploads, no servers, no extensions accessing remote services.

⚡ **Configurable polling interval**
Choose 300 ms, 500 ms, 1 s or 2 s depending on how quickly you need feedback.

🎨 **CSS-only reload**
Changed only a stylesheet? DevReload injects the new CSS directly into the page without a full reload — no page flash, scroll position preserved.

🔍 **File extension filter**
Watch only the file types you care about: `.html .css .js .php .vue .ts` by default, fully customisable.

📋 **Change log**
See the last 5 detected changes (filename, type, timestamp) right in the popup.

🔒 **Completely private & offline**
Zero network requests. All data stays on your machine. No analytics, no tracking, no external dependencies.

### Perfect for

- Static site development
- WordPress / PHP theme editing
- Vanilla HTML/CSS/JS prototyping
- Vue / React source editing (without HMR)
- Any scenario where you can't or don't want to run a local server

### How to use

1. Click the DevReload toolbar icon.
2. Click **Pick Folder** and choose your project directory.
3. Toggle **Enable Watching** to on.
4. Edit your files — the active tab reloads automatically!

---

## Category

**Developer Tools**

---

## Tags / Keywords

```
live reload, auto reload, file watcher, local development, developer tools,
CSS injection, hot reload, File System Access API, no server, static site,
web development, productivity, devtools
```

---

## Screenshots (suggested)

1. Popup with a folder selected and watching enabled (green dot).
2. Popup showing 5 recent file changes in the log.
3. Settings section (interval selector + extension filter + CSS-only toggle).

---

## Additional Notes

- **Manifest V3** compliant — ready for Chrome Web Store submission.
- Requires Chrome 86+ (File System Access API support).
- Open source — contributions welcome.
