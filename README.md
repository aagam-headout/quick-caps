# Quick-Caps

One engine for reading a web page **as rendered** — the live DOM, not the
HTML the server sent — shipped as three things:

| What                                               | For                                                                                                                                    | Install                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **[`quick-caps-cli`](packages/cli#readme)** (`pc`) | Agents and scripts. Distill a page into a few hundred tokens of numbered regions and actions, or archive it. Doubles as an MCP server. | `npx quick-caps-cli --help`                 |
| **[`quick-caps-core`](packages/core#readme)**      | Building your own host. The distillation engine, no browser dependency of its own.                                                     | `npm i quick-caps-core`                     |
| **[Chrome extension](#chrome-extension)**          | People. One click saves a page's whole front-end to your disk.                                                                         | Load unpacked, or the Web Store once listed |

**Nothing is uploaded anywhere,** by any of them. See
[PRIVACY.md](PRIVACY.md).

## For agents: `pc` and MCP

```bash
npx quick-caps-cli open https://example.com
```

```
[1] generic
  [2] heading: "Example Domain"
  [3] generic: "This domain is for use in documentation examples..."
  [4] generic: "Learn more"
```

Those numbers are handles. `pc read 3` prints that region in full, `pc do 4`
follows it, `pc find <query>` re-ranks the page, `pc capture` archives it.
Static fetch first; it escalates to a real browser only when the page looks
like an unrendered shell.

Wire the same nine commands into an MCP client as tools:

```bash
claude mcp add quick-caps -- npx -y quick-caps-cli mcp
```

Full command reference, MCP client config, and known limitations:
**[packages/cli/README.md](packages/cli#readme)**, or `pc --help`.

## Chrome extension

Saves a page's full front-end — HTML, CSS, JavaScript, images, fonts — to
your own disk, as rendered, with every asset inlined so the result opens
offline with no network request.

### Install

- **Chrome Web Store:** _listing pending — link goes here once published._
- **Load unpacked (development/manual install):**
  1. `pnpm install && pnpm -w build`
  2. Open `chrome://extensions`, enable Developer mode.
  3. "Load unpacked" → select `apps/extension/dist`.

### Using it

Click the extension icon on any page and hit "Capture page." The first time
a page needs a cross-origin asset (a stylesheet or font served from another
domain), the extension asks for permission to fetch it — page JavaScript
can't read those itself due to CORS, so the extension fetches them on your
behalf. Decline and the capture still completes; those assets are just
skipped with a warning.

The finished file downloads to a `Quick-Caps` folder inside your Downloads
folder (on Mac, Windows, and Linux alike), named
`<host>-<YYYYMMDD-HHmmss>.html` or `.zip`. Click any entry under "Recent" in
the popup to open it again.

### Settings

| Toggle                     | What it does                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTML / DOM                 | Always captured; this toggle is reserved for a future partial-capture mode and currently has no effect.                                                     |
| Stylesheets                | Inline the page's CSS. Off strips styles from the archive.                                                                                                  |
| Scripts                    | Keep scripts in the archive. Has no effect while **inert snapshot** (below) is on, since that always strips/blocks scripts.                                 |
| Images                     | Inline `<img>` and CSS background images as data URIs.                                                                                                      |
| Fonts                      | Inline `@font-face` sources.                                                                                                                                |
| Full-page screenshot (PNG) | Capture a stitched full-page screenshot, saved as `screenshot.png` (zip) or an inert JSON block (single-file).                                              |
| Design tokens (JSON)       | Extract colours, type scale, and spacing used on the page into `tokens.json`.                                                                               |
| Extracted data (JSON)      | Extract the facts the page contains — structured data, prices, authors, dates, content quality, design system, link graph — into `data.json`.               |
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

### Output formats

**Single file** (`.html`) — one self-contained file. Every asset is inlined.
Metadata, tokens, extracted data, logs, and raw sources (if included) ride
along as inert `<script type="application/json" data-capture="…">` blocks
at the end of `<body>` — present, machine-extractable, never executed.

**Zip** (`.zip`):

```
page.html         the capture, same as the single-file output
metadata.json     if "Metadata" is on
tokens.json       if "Design tokens" is on
data.json         if "Extracted data" is on
logs.json         if "Console + network log" is on
screenshot.png    if "Full-page screenshot" is on
raw/…             if "Raw network sources" is on, one file per source
```

There's no separate `styles/`, `scripts/`, `images/`, or `fonts/` directory —
`page.html` already has everything inlined.

## Development

```bash
pnpm install
pnpm build:packages   # core + cli; needed before typecheck and tests
pnpm test             # unit tests
pnpm typecheck
pnpm lint
pnpm build            # apps/extension/dist
pnpm e2e              # Playwright, drives a real Chrome; needs a display
```

Needs Node 24 and pnpm 11. See **[CONTRIBUTING.md](CONTRIBUTING.md)** for
the repository layout, the host-agnostic boundary `packages/core` has to
respect, how to add a command, and which paths are security-sensitive.

## Release

- **npm** (`quick-caps-core`, `quick-caps-cli`) — see
  [RELEASING.md](RELEASING.md). Order matters, and `pnpm publish` is
  required over `npm publish`.
- **Chrome Web Store** — `scripts/release.sh` runs every gate and produces
  `release/quick-caps-<version>.zip`, ready for upload.

## License

MIT — see [LICENSE](LICENSE).
