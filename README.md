# QuickCaps

A Chrome extension that saves a page's full front-end — HTML, CSS,
JavaScript, images, fonts — to your own disk. It captures the page as
rendered (a live-DOM snapshot, not just what the server sent), and inlines
every asset so the result opens offline with no network request.

**Nothing is uploaded anywhere.** See [PRIVACY.md](PRIVACY.md).

## Install

- **Chrome Web Store:** _listing pending — link goes here once published._
- **Load unpacked (development/manual install):**
  1. `pnpm install && pnpm -w build`
  2. Open `chrome://extensions`, enable Developer mode.
  3. "Load unpacked" → select `apps/extension/dist`.

## Using it

Click the extension icon on any page and hit "Capture page." The first time
a page needs a cross-origin asset (a stylesheet or font served from another
domain), the extension asks for permission to fetch it — page JavaScript
can't read those itself due to CORS, so the extension fetches them on your
behalf. Decline and the capture still completes; those assets are just
skipped with a warning.

The finished file downloads to a `QuickCaps` folder inside your Downloads
folder (on Mac, Windows, and Linux alike), named
`<host>-<YYYYMMDD-HHmmss>.html` or `.zip`. Click any entry under "Recent" in
the popup to open it again.

## Settings

| Toggle                     | What it does                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML / DOM                 | Always captured; this toggle is reserved for a future partial-capture mode and currently has no effect.                                                     |
| Stylesheets                | Inline the page's CSS. Off strips styles from the archive.                                                                                                  |
| Scripts                    | Keep scripts in the archive. Has no effect while **inert snapshot** (below) is on, since that always strips/blocks scripts.                                 |
| Images                     | Inline `<img>` and CSS background images as data URIs.                                                                                                      |
| Fonts                      | Inline `@font-face` sources.                                                                                                                                |
| Full-page screenshot (PNG) | Capture a stitched full-page screenshot, saved as `screenshot.png` (zip) or an inert JSON block (single-file).                                              |
| Design tokens (JSON)       | Extract colours, type scale, and spacing used on the page into `tokens.json`.                                                                               |
| Metadata                   | Save the page URL, capture time, warnings, and the settings used, as `metadata.json`.                                                                       |
| Console + network log      | Include the console and network activity recorded since the page loaded. Needs the page to have been open since load — if you just opened it, reload first. |
| Raw network sources        | Re-fetch the document and every linked script/stylesheet exactly as the server sent them, before any JavaScript ran, saved under `raw/`.                    |

Two more settings apply regardless of what's included:

- **Scroll to load lazy content** — steps down the page before capture so
  lazy-loaded images and infinite-scroll content are materialized, then
  restores your scroll position. On by default.
- **Inert snapshot** — strips and blocks scripts in the archive so a
  reopened capture never re-runs analytics or trackers. On by default; turn
  it off only if you specifically want live scripts preserved.

## Output formats

**Single file** (`.html`) — one self-contained file. Every asset is inlined.
Metadata, tokens, logs, and raw sources (if included) ride along as inert
`<script type="application/json" data-capture="…">` blocks at the end of
`<body>` — present, machine-extractable, never executed.

**Zip** (`.zip`):

```
page.html         the capture, same as the single-file output
metadata.json     if "Metadata" is on
tokens.json       if "Design tokens" is on
logs.json         if "Console + network log" is on
screenshot.png    if "Full-page screenshot" is on
raw/…             if "Raw network sources" is on, one file per source
```

There's no separate `styles/`, `scripts/`, `images/`, or `fonts/` directory —
`page.html` already has everything inlined.

## Development

```bash
pnpm install
pnpm -w test        # unit tests
pnpm -w typecheck
pnpm -w lint
pnpm -w build        # apps/extension/dist
pnpm -w e2e          # Playwright, drives a real Chrome; needs a display
```

`packages/core` is host-agnostic (no `chrome`/`window`/`document` globals),
enforced by lint and a test, so it's reusable outside the extension. Browser
APIs and side effects live only in `*-entry` / `*-inject` files.

## Release

`scripts/release.sh` runs every gate and produces
`release/quickcaps-<version>.zip`, ready for Chrome Web Store upload.

## License

MIT — see [LICENSE](LICENSE).
