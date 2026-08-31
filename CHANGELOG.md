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

Crawling: the same questions, a site at a time.

- New `pc crawl <url>` command and `pc_crawl` MCP tool. It walks same-origin
  links and pagination from a seed, extracts the requested domains from every
  page, and writes a dataset — not a session — into
  `.quick-caps/crawls/<name>/`, gitignored beside the session it never
  touches. `--limit` (25) and `--depth` (3) keep an unqualified crawl a sample
  rather than a commitment, and every crawl ends with a named stop reason: a
  short dataset nobody can explain is the failure the summary exists to
  prevent. The MCP tool returns the summary and the store path, never the
  records — a 200-page dataset is not a tool result.
- Records are JSON Lines, one page per line, because a crawl is long and
  interruptible: killed at page 180 of 200 it leaves 180 valid records rather
  than one truncated document that parses to nothing, and `--report` streams
  them instead of loading them. The half-written last line a kill leaves is
  reported as an unreadable line and the scan continues past it. A page that
  404s or times out is a record with its error, and a URL robots disallowed is
  a record naming the rule that decided it. State is flushed atomically after
  every page, so `pc crawl --resume <name>` continues a crawl rather than
  discovering it is corrupt, and a URL that was in flight goes back on the
  queue rather than being lost.
- A URL is marked seen when it is _enqueued_, not when it is fetched, which is
  what makes a cyclic site terminate; normalization is explicit for the same
  reason, since two URLs differing only by a `utm_` tag are one page and
  treating them as two is how a crawler runs forever on a finite site. Links
  the frontier refused are tallied by reason rather than recorded per href,
  which is what answers "why did a 200-page site yield 40 pages" without
  burying the dataset under its own bookkeeping.
- Politeness is the default and every way out of it has to be typed:
  robots.txt honoured including `crawl-delay`, one request per second per
  host, concurrency 1, backoff on 429 and 5xx but not on a 404 that is a fact
  about one URL, a stop after five consecutive host-level failures, and an
  identifiable user agent so an operator reading their logs can act on it.
  `--rate`, `--concurrency`, and `--ignore-robots` raise or waive those;
  `--ignore-robots` waives the rules and not the crawl-delay. The reason is
  unattended use: an agent looping on an impolite default is how a tool earns
  a place on a block list.
- Static by default, escalating to a browser only where `pc open` already
  would, and with no `--record`: the `network`, `stack`, and `vitals` domains
  are deliberately not offered, since a browser plus a settle window per page
  across hundreds of pages is a different tool.

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
