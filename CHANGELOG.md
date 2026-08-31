# Changelog

All notable changes to this project are documented in this file.

## 0.1.1 (unreleased)

Page data extraction: what a page _contains_, alongside what it looks like.

- New `pc data [url]` command and `pc_data` MCP tool. With no domain flag it
  prints an availability summary rather than the data, so a caller can see
  what a page holds before paying tokens for it. With no URL it reads the
  open session and touches the network not at all. Output is readable text
  by default — entity values shown with their provenance, their confidence,
  and, for a guess, the text it was guessed from — with `--json` for one
  line of JSON. The MCP tool always answers in JSON, since the readable
  form elides long categories behind a flag a tool caller cannot pass.
- Five extraction domains, opt-in per call:
  - `structured` — JSON-LD (including `@graph` flattening), microdata, RDFa,
    a normalized Open Graph/Twitter preview, and the SEO set (canonical,
    hreflang, robots, feeds).
  - `entities` — prices, availability, dates, authors, ratings, contacts, and
    pagination targets. Every value carries its provenance and a confidence
    tier, so a caller can filter to what the page actually declared instead
    of trusting a text heuristic it cannot see. A declared source wins each
    semantic role rather than the whole field, which is what lets a
    struck-through original price survive beside a declared sale price.
  - `content` — word count, reading time, language, heading outline with
    level violations, media inventory, and a main-versus-boilerplate split.
  - `design` — component inventory grouped by family with variants nested,
    fonts declared in stylesheets, and breakpoint and grid inference.
  - `links` — every link classified internal/external and by page zone, with
    `rel` values and a per-domain outbound tally.
- New `quick-caps-core` subpath export, `quick-caps-core/extract`. The layer
  is deliberately absent from the root barrel: it reaches the distiller for
  region flattening, which transitively pulls a tokenizer's BPE table, and
  anything in the root barrel lands in the extension's injected bundle.
- Extension: an "Extracted data (JSON)" capture toggle, off by default,
  writing `data.json` into the zip or an inert `data-capture="data"` block
  into single-file output. The popup names what was found after a capture.
  Extraction runs over the serialized archive, so `data.json` describes
  exactly the `page.html` shipped beside it.
- Fixed: a relative `<base href>` — `<base href="/shop/">` and the like —
  was used as a base URL without being resolved against the page URL first,
  so every asset reference on such a page failed to resolve and the archive's
  asset list came back empty.
- Fixed: media reported a displayed size of 0×0 on a collection with no
  layout engine, presenting an unmeasured value as a measurement. The field
  is omitted instead, with one warning for the page.

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
