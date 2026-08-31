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

Observation: what only a witness can answer.

- New `--record` on `pc open` and `pc capture` arms observation before the
  page loads, because a load cannot be watched retroactively. It requires a
  real browser, since a static fetch witnesses nothing, and refuses
  `--static` rather than silently resolving two flags that ask for opposite
  drivers. Three further `pc data` domains read what it recorded:
  - `network` — every request in observation order with its metadata and,
    where policy kept one, its response body; a per-host summary that ranks
    hosts the page actually talks to ahead of asset and pixel hosts; and skip
    accounting that balances against the request count, so a body cannot
    quietly vanish from it.
  - `stack` — framework, analytics, tag manager, ad network, CDN, A/B tool,
    chat widget and payment provider, from script URLs, markup, globals,
    response headers and cookies; a third-party host inventory classified
    from those same detections; a cookie inventory; and consent-banner
    presence.
  - `vitals` — LCP, CLS, INP, TTFB and FCP with a rating each, over the
    navigation and resource summary already collected. An unobserved metric
    is reported absent rather than as zero: a CLS of 0 is a perfect score and
    an absent CLS is no data, and conflating them would make the domain
    untrustworthy. INP is absent on an automated load, which performs no
    interaction to measure.
- Response bodies are kept only for text-ish types, under a per-body and a
  per-session cap with oldest-first eviction, and every skipped body records
  why. A gap a caller can see is a fact; a gap it cannot see is a lie.
- Credentials are redacted at record time rather than on the way out, so
  nothing unredacted ever reaches the session file on the default path —
  `Authorization`, `Cookie`, `Set-Cookie`, token headers, URL userinfo, and
  token-bearing query parameters, the last being the case most often missed.
  `--no-redact` makes full fidelity an explicit choice. Cookie redaction
  replaces the value and keeps the attributes, because an inventory wants the
  name, domain, expiry and flags, none of which is the secret.
- The extension observes vitals and reports `stack` into `data.json`, and its
  recorder now sees `XMLHttpRequest` as well as `fetch` — which also fixes
  the existing console and network log, previously blind to XHR. It captures
  no response bodies and asks for no new permission; its cookie inventory is
  reported partial, because `HttpOnly` cookies are invisible to a host
  limited to `document.cookie`.
- Fixed: the extension shipped a tokenizer's 2.4 MB rank table, because the
  extraction layer reached the distiller for region flattening and pulled it
  along transitively. The offscreen bundle went from 2,080 kB to 45 kB.

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
