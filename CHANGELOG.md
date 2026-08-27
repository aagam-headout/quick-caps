# Changelog

All notable changes to this project are documented in this file.

## 0.1.0

Initial release.

- Capture a page's full front-end — HTML, CSS, JavaScript, images, fonts —
  into a single self-contained archive, with a live-DOM snapshot (not just
  the server response) via `single-file-core`.
- Two output formats: a single inlined `.html` file, or a `.zip` with
  `page.html` plus optional `metadata.json`, `tokens.json`, `logs.json`,
  `screenshot.png`, and raw sources under `raw/`.
- Per-capture toggles for stylesheets, scripts, images, fonts, full-page
  screenshot, design tokens, metadata, console/network log, and raw network
  sources.
- Lazy content materialized with a scroll pass before capture
  (`scrollToLoadLazy`).
- Inert snapshots by default: captured scripts don't re-run analytics or
  trackers when the archive is reopened (`inertSnapshot`).
- Cross-origin asset fetching gated behind an optional, capture-time
  permission grant (`<all_urls>`) — never requested at install.
- System/light/dark theme support in the popup.
- Capture history (last 50) kept locally, never transmitted.
- No analytics, no accounts, no network request other than fetching the
  assets of the page being captured.
