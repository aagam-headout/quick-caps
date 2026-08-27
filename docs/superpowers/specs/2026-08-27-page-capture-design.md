# Page Capture — Design Spec

**Date:** 2026-08-27
**Status:** Approved for planning
**Repo:** `~/code/fun-proj/page-capture` (standalone; no dependency on Proto)

---

## 1. Purpose

A Chrome extension that captures the full front-end of any web page — HTML, CSS,
JavaScript, images, fonts — and saves it to the user's disk. Nothing is uploaded
anywhere. The capture is configurable through checkboxes so the user chooses what
a snapshot contains and what shape it takes on disk.

The product bar is Chrome Web Store publishable: minimal install-time
permissions, runtime permission requests with explanation, store listing assets,
a privacy policy, semver releases, and CI-enforced quality gates.

### Success criteria

1. Capturing a static page, a client-rendered SPA, and an image-heavy page all
   produce an archive that renders offline in a fresh browser profile,
   visually indistinguishable from the original at the captured viewport.
2. No capture aborts because of a single failed asset. Failures surface as
   warnings the user can read.
3. A capture of a large page (several hundred assets, >50 MB of raw material)
   completes without the service worker being terminated mid-flight and without
   exceeding configured size caps.
4. Install-time permissions are limited to what the store reviewer would accept
   without justification beyond the listing text.

### Non-goals

- Firefox or Safari support. Chrome and Edge only.
- Server-side rendering, crawling, or multi-page capture.
- Editing captured pages inside the extension.
- Any form of analytics, telemetry, or account system.

---

## 2. Stack

| Concern | Choice | Reason |
| --- | --- | --- |
| Workspace | pnpm workspace from day 1 | §12 needs a portable core; a later migration is avoidable work |
| Manifest | MV3 | Only option for new store submissions |
| Build | Vite + `@crxjs/vite-plugin` | HMR for the popup, correct MV3 asset handling |
| Language | TypeScript, `strict` | Extension message passing is error-prone untyped |
| Popup UI | React 19 | Small, stateful form with async progress |
| Styling | Tailwind CSS v4 | Design tokens live in one place (see §7) |
| Serialization | `single-file-core` | The engine behind the SingleFile extension. Replaced a hand-rolled inliner — see §5.1 |
| Zip | `fflate` | Streaming zip in ~8 kB, runs in both Node and the browser |
| Schemas | `zod` | One schema drives the popup form, CLI flags, and later MCP tool schemas (§12) |
| DOM in Node | `linkedom` (core tests only) | Lets the core be tested without a browser; not shipped in the extension |
| Fonts | Geist woff2 vendored into `public/fonts` | The `geist` npm package exports JS, not CSS, and installs Next (198 MB) for two files. Redistributed under the SIL OFL, whose text ships beside them |
| Unit tests | Vitest + jsdom | The interesting logic is pure and DOM-shaped |
| E2E | Playwright | Loads the unpacked build, drives a real capture |
| Lint/format | ESLint + Prettier | CI gate |

Dependency additions beyond the above require justification in the PR.

**The core targets Node and the browser both.** `packages/core` may not reach for
`document`, `window`, `chrome`, or any Node built-in. This is not future-proofing
for its own sake — §12's CLI runs the same extraction logic under Playwright and
under a static fetch, and a core that only runs inside a Chrome extension would
have to be rewritten rather than reused.

---

## 3. Architecture

A host-agnostic core, plus four extension execution contexts that drive it. Two
rules shape everything: **large payloads never cross a `sendMessage` boundary**,
and **the core never knows which host it is running in.**

```text
┌──────────────┐  settings, capture request, progress   ┌───────────────────┐
│    popup     │◄──────────────────────────────────────►│  service worker   │
│  (React)     │                                        │   (orchestrator)  │
└──────────────┘                                        └─────┬──────┬──────┘
                                                              │      │
                         plan (chunked over Port)             │      │ asset fetch
        ┌─────────────────────────────────────────────────────┘      │ (own network,
        │                                                            │  CORS-free)
┌───────▼────────────────────────┐              ┌────────────────────▼────────┐
│  content: collector (on demand)│              │   offscreen document        │
│  content: recorder (doc_start) │              │  canvas stitch · zip build  │
└────────────────────────────────┘              │  createObjectURL · download │
                                                └─────────────────────────────┘
```

### 3.0 Foundation: core, `PageIR`, `PageDriver`

Three foundation decisions, all pulled forward into v1 because §12 is the known
destination and each is nearly free now and expensive later.

**`packages/core`** exists from the first commit, not after a phase-2 migration.
Pure extraction and transformation logic, no host APIs, unit-tested in Node. The
extension is `apps/extension` and imports it.

**`PageIR` is the one representation everything consumes.** Not `outerHTML` plus
a bag of side data — a single typed intermediate representation:

```ts
type PageIR = {
  metadata: PageMetadata;          // url, title, timestamp, viewport, dpr, meta tags
  html: string;                    // serialized live DOM
  regions: Region[];               // structural tree (see below)
  styles: StyleSource[];           // same-origin text | cross-origin href to fetch
  assets: AssetRef[];              // images, fonts, scripts, media — absolutized
  styleTally: StyleTally;          // normalized computed-value frequencies
  logs?: LogEntry[];               // recorder ring buffer
  warnings: Warning[];
};

type Region = {
  id: number;                      // stable numbered handle
  role: string;                    // ARIA role or inferred landmark
  tag: string;
  box: { x: number; y: number; w: number; h: number };
  textLength: number;
  textDensity: number;             // text bytes per pixel of area
  actions: ActionRef[];            // links, buttons, inputs — numbered
  children: Region[];
};
```

`regions` is the part that would be easy to skip in v1 and painful to add later.
v1 uses it lightly: it is what the popup counts and what `tokens.json` is derived
from. §12's distillation, numbered handles, and token budgeting are then a
function over an IR that already exists, rather than a second traversal of the
page written against a different model. One representation, one place where
"what is on this page" is defined.

**`PageDriver` is an interface from day 1**, with the extension as its first
implementation rather than its only one:

```ts
interface PageDriver {
  evaluate<T>(fn: () => T): Promise<T>;   // run a standalone fn in page context
  fetchAsset(url: string): Promise<AssetBytes>;  // CORS-free fetch
  screenshotFullPage(): Promise<Uint8Array>;
  scrollTo(x: number, y: number): Promise<void>;
  viewport(): Promise<Viewport>;
}
```

The extension implements it over `chrome.scripting`, `chrome.tabs`, and the
offscreen document. §12's CLI implements it over Playwright, raw CDP, or a static
fetch. The capture pipeline is written against the interface and does not change
between them.

Note what this pushes out of the core: full-page screenshot stitching is a
*driver* concern, not core logic. The extension stitches frames on an
`OffscreenCanvas` because that is what Chrome gives it; Playwright takes a
full-page screenshot in one call. The core only asks for pixels.

### 3.1 `content/recorder.ts`

Registered as a `document_start` content script in the MAIN world on
`<all_urls>`, matching only when the user has granted the optional host
permission.

Patches `console.{log,info,warn,error,debug}`, `fetch`, `XMLHttpRequest`,
`window.onerror`, and `unhandledrejection`. Each event appends to a ring buffer
capped at 500 entries (configurable, drop-oldest) held on a non-enumerable
`Symbol`-keyed property of `window` so page code neither sees nor collides
with it.

Wrappers must be transparent: original functions are called with the original
arguments and their return values passed through untouched; a throw inside the
recorder is caught and dropped rather than propagated to page code. `fetch`
recording captures method, URL, status, duration, and response size only —
never bodies.

If the popup is opened on a page loaded before the extension was installed or
enabled, no buffer exists. The popup detects this and shows
"reload the page to include console and network logs" rather than silently
producing an empty log.

### 3.2 `content/collector.ts`

Injected on demand by the service worker via `chrome.scripting.executeScript`,
ISOLATED world. Runs once and returns a `PageIR` without asset bytes — a
**capture plan**:

**Hard constraint: the collector is a single standalone function with zero
imports**, bundled to one self-contained expression. It is the only code that
must run inside the page, and both `chrome.scripting.executeScript` and
Playwright's `page.evaluate` can only inject something serializable. Writing it
as an importing module would work in the extension and silently block §12. It is
built as its own Vite entry with inlining enforced, and a unit test asserts the
built artifact references no external binding.

It produces:

- `html`: `document.documentElement.outerHTML` after any lazy-load scroll pass
- `sameOriginStyles`: text of every readable `document.styleSheets` entry
- `crossOriginStyleHrefs`: `href` of every sheet whose `cssRules` access threw
  `SecurityError` — the service worker fetches these instead
- `assetUrls`: absolutized URLs for images (`img[src]`, `srcset`, CSS
  `url()`, inline `style`, `<picture>`), fonts, scripts, and media
- `computedTally`: the raw material for design tokens (§5.4)
- `metadata`: URL, title, timestamp, viewport, device pixel ratio, user agent,
  document character set, `<meta>` tags
- `logs`: the recorder ring buffer, if present

`html` can be several megabytes. Plans whose serialized `html` exceeds 1 MB are
streamed to the service worker in 512 kB chunks over a `chrome.runtime.connect`
port; smaller plans go in a single message. The chunking path is used for every
capture in tests regardless of size, so it is never the untested branch.

**Lazy-load pass** (when the "scroll to load lazy content" toggle is on): before
reading `outerHTML`, scroll stepwise to the bottom in viewport-height
increments, awaiting a frame plus a short settle delay at each step, then
restore the original `scrollX`/`scrollY`. This materializes `loading="lazy"`
images and IntersectionObserver-driven content.

### 3.3 `background/` service worker

The orchestrator. It owns:

- Restricted-page detection before anything else: `chrome://*`, `edge://*`,
  `chrome-extension://*`, the Chrome Web Store, `view-source:`, and the built-in
  PDF viewer cannot be scripted. The popup gets a specific message naming the
  reason, not a generic failure.
- Optional host permission check and request (§4).
- Collector injection and plan assembly.
- Asset fetching: 6 concurrent requests, 10 s timeout each, one retry on
  network error or 5xx, per-asset cap 5 MB, total cap 50 MB. All four numbers
  live in settings. An asset that fails, times out, or exceeds a cap is skipped
  and recorded as a warning; the capture continues.
- Full-page screenshot: scroll the tab stepwise, `chrome.tabs.captureVisibleTab`
  at each step throttled to Chrome's 2 calls/second limit, hand the frames to
  the offscreen document for stitching, restore scroll position.
- Progress reporting to the popup over the same port: phase, items done, items
  total, warnings so far.
- Handing the finished bundle to `chrome.downloads.download`.

The offscreen document's existence keeps the worker alive for the duration of a
capture; the port between popup and worker is a second liveness anchor. Neither
is treated as a guarantee — capture state is written to `chrome.storage.session`
at each phase transition so a terminated worker resumes rather than losing the
capture silently.

### 3.4 `offscreen/`

A `chrome.offscreen` document created with reasons `BLOBS` and `DOM_PARSER`,
torn down when the capture completes. It exists because a service worker has no
`OffscreenCanvas` image decoding path for stitching, no `URL.createObjectURL`,
and no DOM. It performs:

1. **Screenshot stitching** — decode captured frames, draw into an
   `OffscreenCanvas` of full document height, encode PNG.
2. **Zip assembly** — `fflate` streaming zip, so peak memory stays near the
   largest single asset rather than the whole archive.
3. **Single-file assembly** — DOM-parse the captured HTML, apply the inlining
   transforms (§5.1), serialize.
4. **Object URL creation** — the blob URL passed to `chrome.downloads.download`,
   revoked on the download's completion event.

---

## 4. Permissions

### Install-time

```json
"permissions": ["activeTab", "scripting", "storage", "downloads", "offscreen"]
```

### Optional

```json
"optional_host_permissions": ["<all_urls>"]
```

Requested via `chrome.permissions.request` from the popup's Capture click — a
user gesture, which the API requires. The popup explains before requesting:
cross-origin stylesheets and fonts cannot be read by page JavaScript, so the
extension must fetch them itself.

**Declining is a supported path.** The capture runs with same-origin material
only; every cross-origin asset becomes a warning listing what was skipped. The
user is never blocked, and the request is not re-nagged within a session.

`activeTab` covers the common single-page case without any host grant when the
page has no cross-origin assets.

---

## 5. Capture pipeline

### 5.1 Serialization: `single-file-core`

**This section replaced a hand-rolled inliner.** The original design had core
rewriting the document itself: absolutizing urls, inlining stylesheets and
assets, resolving `@import`, neutralizing scripts. It was written, tested to 24
cases, and shipped — and then a capture of one real site produced three separate
defects at once. It serialized through `XMLSerializer`, so the output was XHTML
rather than HTML. The document's head came out empty with every `meta` and
`link` relocated into the body, because another installed extension injects a
custom element into the live page's head and re-parsing `outerHTML` makes the
HTML parser close head at that point. And webfonts were absent from every
capture ever made, because fonts are referenced only from inside stylesheets and
nothing in the DOM points at them.

Whole-page capture has a long tail — shadow DOM, canvas, `srcset`, `@import`
chains, deferred images, duplicate images, cross-frame content — and
`single-file-core` has absorbed years of it. Reinventing that one bug at a time
was the wrong trade, so the inliner was deleted.

**Where it runs.** In the page, because it needs the live DOM. That has one
consequence worth stating plainly: its own fetches are subject to the page's
CORS policy and would fail for most cross-origin assets, so every resource
request is proxied through the service worker, which fetches under the
extension's host permissions instead. Bytes cross that boundary base64-encoded,
because a Chrome message is JSON. The proxy serves only the tab currently being
captured, and honours the configured timeout and size caps.

**Options that matter**, all mirrored from Proto's working configuration:

- `loadDeferredImages: false` — pages built on IntersectionObserver frequently
  never trigger inside SingleFile's timing window and the serialization hangs.
  This is what made a real capture time out. The worker performs its own scroll
  pass before injecting, so lazy content is already materialized.
- `groupDuplicateImages: true` — a capture of a busy page came to 42 MB without
  it.
- `removeScripts` / `blockScripts` follow the inert-snapshot setting: an
  archived page should not re-run analytics when reopened.
- `removeFrames: true` — cross-frame walking needs SingleFile's hooks-frames
  bootstrap, which the npm build does not carry.

**Progress.** SingleFile emits `RESOURCES_INITIALIZED` with a resource count and
`RESOURCE_LOADED` per asset. Both are relayed from the page through the worker
to the popup, so a heavy page reports real counts instead of appearing frozen,
and a timeout can say how far it got rather than only that it gave up.

### 5.2 `core/bundle.ts`

Two output modes, chosen per capture by a radio in the popup.

**Zip** — `<host>-<YYYYMMDD-HHmmss>.zip`:

```text
page.html          self-contained; assets already inlined by §5.1
raw/               original network sources (§5.3)
screenshot.png
tokens.json
metadata.json      includes the full warnings list
logs.json
```

There are no asset directories. An earlier design split assets into `styles/`,
`scripts/`, `images/`, and `fonts/`, which is what a zip is for — but with
serialization delegated to `single-file-core`, splitting them back out of a
finished document would mean re-implementing the rewriting that was just removed
for being unreliable. Zip now means "the page, plus the artifacts a single file
cannot carry naturally".

**Single file** — `<host>-<YYYYMMDD-HHmmss>.html`: everything inlined. Tokens,
metadata, logs, and raw sources ride along as inert
`<script type="application/json" data-capture="tokens|metadata|logs|raw">`
blocks at the end of `<body>` — still one file, still machine-extractable, never
executed.

Filenames are sanitized for every platform (no `:`, no path traversal, length
capped) by the core, which returns bytes plus a filename and never writes them.
The extension hands that to `chrome.downloads.download` as a relative path under
the user's Downloads directory; §12's CLI writes it to its artifact root. Where
output lands is a host concern.

### 5.3 Raw network sources

An independent toggle from live-DOM capture. When on, the service worker
re-fetches the document URL and each `<link>`/`<script>` source, storing the
bytes as the server sent them under `raw/`. This is the true source, before any
JavaScript ran — useful for diffing what shipped against what rendered.

The two capture modes are orthogonal and can both be on: `page.html` is the
live DOM, `raw/` is what the server sent.

### 5.4 `core/tokens.ts`

Reads `PageIR.styleTally` — not the DOM — and emits `tokens.json`: colors,
font families, font sizes, line heights, spacing values, border radii, and
shadows, each with a usage count, sorted by frequency. Values are normalized
before tallying (colors to lowercase hex or `rgb()` with alpha; lengths to px
where unambiguous) so `#FFF`, `#ffffff`, and `rgb(255,255,255)` count as one
token rather than three.

---

## 6. Popup

Single screen, three regions:

1. **What to capture** — checkboxes: HTML/DOM, stylesheets, scripts, images,
   fonts, full-page screenshot PNG, design tokens JSON, metadata,
   console + network log, raw network sources, scroll to load lazy content,
   inert snapshot.
2. **Output** — radio: single self-contained HTML, or ZIP folder.
3. **Action** — Capture button, then a progress region (phase, counts,
   determinate bar), then a result region: file name, size, warning count with
   an expandable list.

Settings persist in `chrome.storage.sync` so they follow the user's profile.
Capture history — last 50 entries, metadata only, never blobs — lives in
`chrome.storage.local` and is reachable from a "Recent" disclosure.

Accessibility is a gate, not a nicety: every control has a real `<label>`, the
form is fully keyboard-operable in DOM order, focus is visible against both
themes, progress uses `aria-live="polite"`, and errors are associated with their
control via `aria-describedby`.

---

## 7. Design system — Vercel Geist, light and dark

The UI follows Vercel's Geist design system: near-monochrome grays carrying the
structure, a single blue for the primary action, semantic colors used only for
state.

**Typography** — Geist Sans for UI, Geist Mono for URLs, file names, sizes, and
log output. Both self-hosted as woff2 and bundled; the extension CSP forbids
remote font loading, and a store reviewer will check.

The two variable woff2 files are vendored into `apps/extension/public/fonts`
rather than pulled from the `geist` npm package. That package is a Next.js font
wrapper: it exports JS modules rather than stylesheets, so there is no
`geist/font/sans.css` to import, and installing it pulls in the whole of Next —
198 MB — to deliver two font files. Geist is licensed under the SIL Open Font
License, so redistribution is permitted with the license text, which ships
alongside the fonts as `public/fonts/OFL-Geist.txt`.

**Shape** — 6 px radius on controls, 8 px on cards. 1 px borders in the
appropriate gray-alpha. Elevation is a border plus a low-opacity shadow, never a
heavy drop shadow.

**Theming** — CSS custom properties defined on `:root` for light, overridden
under both `@media (prefers-color-scheme: dark)` and a `[data-theme="dark"]`
attribute, so the popup follows the OS by default and an explicit user override
still wins in either direction. Every color used in the UI resolves through a
token; no raw hex in component code. A three-state control (System / Light /
Dark) lives in the popup footer and persists to `chrome.storage.sync`.

Token set, mirroring Geist's published scales:

| Token | Light | Dark |
| --- | --- | --- |
| `--background-100` | `#ffffff` | `#0a0a0a` |
| `--background-200` | `#fafafa` | `#000000` |
| `--gray-100` | `#f2f2f2` | `#1a1a1a` |
| `--gray-200` | `#ebebeb` | `#1f1f1f` |
| `--gray-300` | `#e5e5e5` | `#292929` |
| `--gray-400` | `#d4d4d4` | `#2e2e2e` |
| `--gray-500` | `#a3a3a3` | `#454545` |
| `--gray-600` | `#8f8f8f` | `#878787` |
| `--gray-700` | `#737373` | `#8f8f8f` |
| `--gray-800` | `#525252` | `#a1a1a1` |
| `--gray-900` | `#404040` | `#c9c9c9` |
| `--gray-1000` | `#171717` | `#ededed` |
| `--blue-600` (primary) | `#0072f5` | `#0072f5` |
| `--blue-700` (hover) | `#0761d1` | `#3291ff` |
| `--red-600` (error) | `#cd2b31` | `#ff6166` |
| `--amber-600` (warning) | `#ab5600` | `#f5b849` |
| `--green-600` (success) | `#357a45` | `#62c073` |

The light-theme state colors step darker than their dark-theme counterparts
because the brighter values fail the AA gate on white: `#e5484d` measures
3.91:1 against a 4.5:1 body-text floor, and `#f5a623` measures 1.98:1.

Semantic aliases sit on top — `--surface`, `--surface-raised`, `--border`,
`--text-primary`, `--text-secondary`, `--accent`, `--accent-hover`, and one per
state — and components consume only those. Swapping the palette then means
editing one file.

These hexes **approximate** the Geist scales rather than reproducing them. The
Geist documentation does not publish machine-readable hex values and the `geist`
npm package ships fonts only, so no authoritative source was available to check
against — this was verified, not assumed. Treat the exact numbers as
replaceable; the contrast gate below is the real guarantee, and it will
immediately report whether a substituted palette holds.

**Contrast is a gate.** Every text/background pair in both themes must meet WCAG
AA (4.5:1 body, 3:1 large text and UI boundaries). Verified by a unit test over
the token table, not by eye — a palette regression should fail CI.

---

## 8. Error handling

The governing rule: a capture degrades, it does not collapse.

| Failure | Behavior |
| --- | --- |
| Single asset fetch fails, times out, or exceeds cap | Skip, warn, continue |
| Total size cap reached | Stop fetching, warn with the count of skipped assets, bundle what exists |
| Cross-origin sheet unreadable and permission declined | Warn naming the origin |
| Restricted page | Refuse before injecting, with the specific reason |
| Recorder buffer absent | Prompt to reload; other toggles unaffected |
| Screenshot capture throttled or fails | Warn, omit the PNG, keep the rest |
| Service worker terminated mid-capture | Resume from the last phase in `chrome.storage.session`, or report the failure — never a silent stall |
| Download blocked by the user or by Chrome | Surface the `chrome.downloads` error text verbatim |

Warnings are structured (`{ phase, url, reason, detail }`), shown in the popup,
and written into `metadata.json`. Nothing is swallowed, and nothing is logged to
a remote.

---

## 9. Testing

**Vitest, Node + `linkedom`** — `packages/core`, which is where the real logic
is, tested with no browser and no Chrome API stubs at all. A core test that needs
a `chrome.*` mock is a design failure, not a test-setup problem. Golden-file tests
pin `PageIR` for each fixture page, so a change to the representation is visible
in a diff rather than discovered downstream. Covered:
`inline` (URL absolutization, `@import` recursion and cycle capping, `srcset`
rewriting, inert-mode transforms), `bundle` (both modes, filename sanitization,
path traversal rejection), `tokens` (value normalization, tallying), asset
fetching (concurrency, timeout, retry, cap enforcement — against a fake
`PageDriver`), plan chunking and reassembly, region-tree construction and text
density, the collector bundle's zero-import property, and the §7 contrast check.

A second fake `PageDriver` implementation lives in the test suite. It is the
cheap, continuous proof that the driver seam is real — if the pipeline can run
against a fake, it can run against Playwright later.

**Playwright** — loads the unpacked build in a real Chrome and captures three
fixture pages served locally: a static document, a client-rendered SPA, and an
image-heavy page with lazy loading. Asserts the archive downloads, then reopens
it in a fresh context and checks it renders offline with no network requests
attempted.

**Manual pre-release pass** — real pages across the same three categories, both
output modes, permission granted and declined, light and dark themes.

**CI (GitHub Actions)** on every push and PR: `tsc --noEmit`, ESLint, Prettier
check, Vitest with coverage, Playwright, and a production build that must
produce a loadable unpacked extension.

---

## 10. Store readiness

Icons at 16/32/48/128. Store listing copy, screenshots, and a 1280×800 promo
tile. A privacy policy stating what is true: captures stay on the user's
machine, the extension makes no network request except to fetch the assets of
the page being captured, and no data is collected or transmitted. Semver with a
`CHANGELOG.md`, MIT license, a `README.md` covering install (store and
unpacked), each toggle's meaning, and the output formats. A release script
producing the store-upload zip from a clean build.

---

## 11. Repository layout

```text
page-capture/
├── packages/
│   └── core/                  @page-capture/core — no host APIs, Node-testable
│       ├── src/
│       │   ├── ir.ts          PageIR, Region, Warning types
│       │   ├── driver.ts      PageDriver interface
│       │   ├── collect.ts     the standalone injectable collector fn
│       │   ├── regions.ts     region tree, roles, text density
│       │   ├── bundle.ts      single-file and zip assembly
│       │   ├── tokens.ts      styleTally → tokens.json
│       │   ├── assets.ts      concurrency, timeout, retry, caps
│       │   └── settings.ts    zod schemas, defaults
│       └── tests/             Vitest + linkedom, fake driver, IR goldens
├── apps/
│   └── extension/
│       ├── src/
│       │   ├── popup/         React UI, Geist-themed
│       │   ├── background/    ChromeDriver, orchestration, resource proxy
│       │   ├── content/       recorder, collector, single-file serializer
│       │   ├── offscreen/     stitch, bundle, blob URL
│       │   ├── lib/           messages, capture pipeline, http
│       │   └── styles/        tokens.css, tailwind entry
│       ├── e2e/               Playwright specs + fixture pages
│       ├── public/icons/
│       └── manifest.config.ts
├── docs/superpowers/specs/
├── pnpm-workspace.yaml
└── package.json               workspace scripts, shared config
```

The boundary is enforced, not just documented: an ESLint rule bans
`chrome`, `window`, `document`, and Node built-ins inside `packages/core`, and CI
fails on violation. Extension contexts talk to each other only through the typed
port contracts in `apps/extension/src/lib/messages.ts`.

---


## 12. Future scope — agent-facing CLI + MCP server

**Status: not in v1.** But v1's foundation is built for it — see §3.0. Four v1
decisions exist to serve this section: a pnpm workspace with a host-agnostic
`packages/core`, `PageIR` as the single page representation, `PageDriver` as an
interface with the extension as one implementation, and a collector that is a
zero-import standalone function. None of those cost meaningful v1 time; all four
are expensive to retrofit.

### 12.1 The problem

Agents that browse today either fetch raw HTML — an empty shell on any modern
SPA — or drive a browser and dump `outerHTML` into context, burning tens of
thousands of tokens on markup they do not need. `only-cli` (`npx @only-cli/oc`)
frames this well and is the model for the command surface here: distill a page
into a few hundred tokens of actionable text with numbered regions and links,
hard-cap the output budget, keep dependencies tiny, no daemon.

Where we differ, and the only reason to build this at all: `only-cli` works from
static fetches with no browser, which is what makes it fast and dependency-light,
and also what makes it thin on client-rendered pages. The v1 pipeline already
renders the real DOM, resolves cross-origin CSS, and extracts real design tokens.
So the pitch is `only-cli`'s ergonomics and token discipline over rendered-DOM
fidelity, with layout and design-token extraction that a static fetcher cannot
do. The cost is honest: a browser dependency and slower cold start. Worth it only
for the rendered-page and design-extraction cases — for plain article text,
`only-cli` is the better tool and this should say so in its README.

### 12.2 Shape

```text
npx @page-capture/pc open <url>     # distill: numbered regions + actions
npx @page-capture/pc do <n>         # follow action [n]
npx @page-capture/pc read <n>       # full text of region [n]
npx @page-capture/pc find <query>   # search current page
npx @page-capture/pc next           # next slice of a paged render
npx @page-capture/pc layout         # structural tree: regions, roles, boxes
npx @page-capture/pc tokens         # colors, type scale, spacing, radii
npx @page-capture/pc scrape <shape> # schema-driven field extraction
npx @page-capture/pc capture        # full archive to disk (v1 formats)
npx @page-capture/pc mcp            # same tools over stdio MCP
```

Stateful across invocations: a session file under the project or a temp root
holds the current page, its numbered action map, and the render cursor, so `do`
and `read` resolve without re-fetching. Session state is plain JSON a human can
read.

`pc mcp` is a thin adapter, not a second implementation — the same tool
functions, wrapped in MCP schemas over stdio. CLI first because a CLI is
trivially testable, scriptable, and usable by any agent that can run a shell;
MCP for the agents that prefer typed tools.

**Output discipline, borrowed and enforced:** every command has a hard token
budget (default 500 for `open`, configurable), returns numbered handles rather
than content, and paginates. No command returns unbounded markup — that is the
entire point, and it is a test, not an aspiration.

**Browser driver:** Playwright's bundled Chromium by default. A `--static` flag
skips the browser for pages that don't need it, which keeps the fast path fast.
Optional CDP attach to the user's running Chrome so authenticated pages work
without re-login.

### 12.3 How we get there

Because §3.0 landed in v1, the old phases 1–3 — extract a core, convert to a
workspace, define a driver seam — are already done when v1 ships. What remains is
genuinely new work rather than restructuring.

**Phase A — the Playwright driver.** Implement `PageDriver` over Playwright's
bundled Chromium, plus a `StaticDriver` that fetches and parses without a
browser. The capture pipeline runs unchanged against both, and v1's core tests
already pass against a fake driver, so this phase's acceptance test is: the same
`PageIR` goldens, produced through a different driver. Small phase, high
confidence — the seam was proven continuously in v1's CI rather than discovered
here.

**Phase B — distillation.** The hard part and the actual product: turning a
`PageIR` into a few hundred useful tokens. Collapse wrapper regions, rank by text
density and role, assign stable numbered handles to regions and actions, page the
output against a hard budget. `PageIR.regions` already carries the raw material
(§3.0), so this is a scoring and selection problem, not a second DOM traversal.
Acceptance criterion is measured token counts on real pages against real agent
tasks — a number in CI, not a judgement call.

**Phase C — the CLI.** The `open`/`do`/`read`/`find`/`next` surface, the session
file, the `--static` escalation logic, and the `layout`/`tokens`/`scrape`/
`capture` commands. Thin over Phases A and B.

**Phase D — MCP adapter.** Tool schemas over the Phase C functions, stdio
transport, artifact directory with configurable root and retention. The `zod`
schemas from v1 (§2) generate the JSON Schema, so this is adapter code only.

Phases B and C each get their own spec and plan. A and D do not need one.

### 12.4 Open questions to settle before starting

- Default driver: bundled Chromium versus static-fetch-first with browser
  escalation on detecting a client-rendered shell. The latter is better
  behavior and more work.
- Whether the CLI ever talks to the installed extension as a driver, for real
  cookies and real-browser fidelity. A local listener inside an extension is
  meaningful attack surface and a store-review risk — needs a security review
  before it is entertained.
- Session state location and artifact retention defaults, given agents may
  capture in loops.
- Whether this ships as its own package or stays a workspace-internal tool. Its
  overlap with `only-cli` on static pages argues for a narrow, honest scope:
  rendered pages, layout, and design tokens.
