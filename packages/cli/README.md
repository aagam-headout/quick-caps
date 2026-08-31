# quick-caps-cli

Distill any rendered web page into a few hundred tokens of numbered
regions and actions — or capture it to disk. Built for agents: `open` a
page, `do` an action by number, `read` a region in full, `find` a query,
`scrape` a schema-driven shape, report the `data` a page contains, `crawl` a
whole site into a dataset on disk, or `capture` the whole thing to a single-file HTML or zip archive. Same functions are also exposed as MCP
tools over stdio (`pc mcp`).

## Requirements

Node 22 or newer. Installing pulls Playwright, which downloads a Chromium
build on first install (a few hundred MB) — that download is what lets
`pc` render pages a plain fetch can't. Commands that never need a browser
(`pc open --static`, `read`, `find`, `next`, `scrape`, and `data` on an
already-open session) work without it.

## Install / run

```bash
npx quick-caps-cli open https://example.com
npx quick-caps-cli --help
```

Note: the npm package is named `quick-caps-cli`, but the command it
installs is `pc` — `npx quick-caps-cli <command>` runs `pc <command>`
directly. A local or global install (`npm install -g quick-caps-cli`)
additionally exposes `pc` on your `PATH`.

Run `pc --help` (or `pc help`, `pc -h`, or `pc` with no arguments) for the
full command reference, including the handle-numbering rules that trip up
first-time users.

## Commands

- `pc open <url> [--static] [--record] [--no-redact]` — distill a page:
  numbered regions + actions. `--record` arms observation for the `network`,
  `stack`, and `vitals` domains of `pc data`.
- `pc do <n> [value]` — follow action `[n]` (click a button, fill an input).
- `pc read <n>` — full text of region `[n]`.
- `pc find <query>` — search the currently open page.
- `pc next` — next slice of a paged render.
- `pc layout` — structural tree: regions, roles, boxes.
- `pc tokens` — colors, type scale, spacing, radii.
- `pc scrape <shape>` — schema-driven field extraction, e.g. `pc scrape '{"title":"h1"}'`.
- `pc data [url] [--structured] [--entities] [--content] [--design] [--links]
[--network] [--stack] [--vitals] [--all] [--json] [--record] [--no-redact]`
  — report the data the page contains, as human-readable text; `--json`
  prints the same report as one line of JSON. With no domain flag, an
  availability summary instead of the data.
- `pc crawl <url> [--limit N] [--depth N] [--name <name>] [--structured] [--entities] [--content] [--design] [--links] [--all] [--rate N] [--concurrency N] [--ignore-robots]`
  — walk a site from a seed and extract from every page into a resumable
  store on disk. `pc crawl --resume <name>` continues an interrupted crawl;
  `pc crawl --report [<name>] [--json]` summarizes one.
- `pc capture [--zip] [--record] [--out <dir>]` — full archive to disk.
- `pc mcp` — the same eleven tools, over an MCP stdio server.
- `pc --help` — full usage, notes, and environment variables.

Every command is stateful across invocations within one directory: a
`.quick-caps/session.json` file holds the current page, its numbered
action map, and the render cursor, so `do`/`read`/`find`/`next` resolve
without re-fetching.

## `pc data`

Reports the facts a page contains rather than what it looks like. With no
URL it reads the session already on disk and makes no network request; given
a URL it opens that page first — saving the session, exactly as `pc open`
would — and then extracts.

With no domain flag it prints an availability line instead of the data, so a
caller can see what a page holds before paying tokens for it:

```
$ pc data
available: structured(3) entities(6) content design links(6)
```

Counts are discrete findings, and the two whole-page domains (`content`,
`design`) have nothing to count, so they appear bare. Naming domains prints
their reports, one block per domain, in the same terse form the other
navigation commands use:

```
$ pc data --structured --entities
structured
  json-ld    Product "Widget Pro"
  preview    "Widget Pro" — http://127.0.0.1:8912/img/widget.png…
  canonical  http://127.0.0.1:8912/

entities
  price      49.99 USD (current)           json-ld         high
             79 USD (original)             semantic-markup medium
  stock      in-stock                      json-ld         high
  published  2026-03-11T00:00:00.000Z      text-heuristic  low  "Published on March 11, 2026"
  rating     4.6/5 (128 reviews)           json-ld         high
  next page  http://127.0.0.1:8912/page/2  semantic-markup medium
```

Every entity value shows its provenance and confidence tier, and a
low-confidence one shows the text the heuristic matched on, so a guess can be
judged where it is read. Long values are truncated rather than wrapped, and a
category with more rows than fit ends in `… N more (--json)` — no category is
dropped in silence. A domain that found nothing reads `(empty)`; one whose
extractor failed reads `(unavailable)`, with the reason in the warnings.

`--json` prints the whole report as one line of JSON instead, for a machine —
one report per invocation, so it pipes straight into `jq`:

```
$ pc data --entities --json | jq '.entities.prices'
```

The five document domains, and what each yields:

- `--structured` — what the page declares outright: JSON-LD (with `@graph`
  flattened), microdata, RDFa, Open Graph and Twitter cards normalized into
  one social preview, and the SEO set (canonical, `hreflang` alternates,
  robots directives, feeds).
- `--entities` — prices, availability, dates, authors, ratings, contacts,
  and pagination targets. Every value carries its provenance and a
  confidence tier — declared sources are `high`, semantic markup `medium`, a
  text heuristic `low`, with the matched text alongside — so a caller can
  filter down to what the page actually declared.
- `--content` — word count, reading time, language, heading outline with
  level violations, media inventory (alt coverage, format mix, lazy-load
  share), and a main-content-versus-boilerplate split.
- `--design` — component inventory grouped by family with variants nested
  under it, fonts declared in stylesheets, and breakpoint and grid inference
  from the page's media queries.
- `--links` — every link classified internal versus external and by page
  zone (nav, content, footer, aside), with anchor text, `rel` tokens, a
  per-domain outbound tally, and the action handle a link already carries so
  it can be `do`ne without re-finding it.

Three further domains report on a page that was _observed_ rather than merely
parsed, and are available only on a session opened with `--record`; without it
they report "not recorded" rather than empty:

- `--network` — the fetch/XHR requests the page made while it loaded, as
  request metadata with credentials redacted.
- `--stack` — the third-party stack inferred from that traffic and from the
  page's cookie inventory.
- `--vitals` — the web vitals that only an observer running before first paint
  can see (CLS, INP, LCP).

`--all` requests all eight.

`pc data` never upgrades a static session to a browser-backed one, precisely
so the handles you are already holding keep their numbers — the re-numbering
`layout`, `tokens`, and `capture` warn about. Fields that would need
computed styles are skipped rather than guessed, and the report says which
domains ran degraded:

```
warning: content, design: skipped every field needing computed styles
```

## `pc crawl`

Walks a site from a seed URL, extracts from every page, and writes the result
as a dataset on disk rather than a session. `pc data` answers a question about
one page; most questions worth asking — every product's price, every article's
author, what a whole site is built from — are about a set of them.

```
$ pc crawl https://example.com --limit 40 --entities
```

Progress goes to stderr, one line per page, because a silent multi-minute
command is indistinguishable from a hung one. The summary goes to stdout, so
the two can be separated:

```
$ pc crawl --report
crawl example.com
  store      /work/site/.quick-caps/crawls/example.com
  seed       http://example.com/
  pages      21
  fetched    19
  errors     1
             1  fetch failed
  skipped    1
             1  robots: disallow-rule (/admin/)
  structured 19
  entities   19
  links      19
  refused    263
             214  already-seen
             37  external-host
             12  depth-cap
  queued     1
  stopped    interrupted
```

A crawl prints exactly what `--report` reprints. `refused` is the frontier's
tally of links it declined and why — the answer to "why did a 200-page site
yield 40 pages" — counted by reason rather than recorded per href, since
`already-seen` fires for every chrome link on every page. Every crawl ends
with a `stopped` reason: the limit, an exhausted frontier, a host-level stop
condition, or an interrupt. A crawl that produced a short dataset for a reason
nobody can see is the failure this is here to prevent.

### Politeness, and how to opt out of it

Defaults, all overridable but only explicitly, because this is a command an
agent may run unattended against somebody else's server:

- **robots.txt is fetched once per host and honoured**, `crawl-delay`
  included. The longest matching rule wins and an equal-length tie goes to
  `Allow`. A disallowed URL is not silently dropped: it is a record whose
  reason names the deciding rule, as in `robots: disallow-rule (/admin/)`.
- **One request per second per host, concurrency 1.** `--rate N` and
  `--concurrency N` raise them. `--rate 0` removes the rate limit entirely,
  which is what a local fixture wants and a real site never does.
- **An identifiable user agent** —
  `quick-caps-crawler/1 (+https://github.com/aagam-headout/quick-caps)` — so
  an operator reading their logs can tell what hit them and act on it.
- **Backoff on 429 and 5xx**, doubling from one second to a one-minute
  ceiling, and only for statuses the host is responsible for: a 404 is a fact
  about one URL and neither slows the crawl nor counts toward stopping it. A
  host's own success resets its ladder.
- **A `Retry-After` is preferred over that ladder**, in either legal form —
  delay-seconds or an HTTP-date — because it is the one pacing instruction a
  server sends deliberately rather than something the crawler has to guess. A
  value that cannot be read falls back to the ladder, and the value that is
  used stays inside the same one-second floor and one-minute ceiling the ladder
  obeys: `Retry-After: 0` does not buy a failing host an instant retry, and
  `Retry-After: 86400` does not park a worker for a day. A wait longer than a
  minute is a crawl to `--resume` later, which is what the store is for.
- **A stop after five consecutive failures on one host**, with that reason in
  the summary. Per host, like everything else here: two unrelated hosts
  failing once each is two hosts with one problem, not one host with two. A
  crawler that keeps hammering a host that is already failing is the behaviour
  that gets tools blocked.
- **A separate stop when every host the crawl has tried is failing at once**,
  once there are at least three of them — counted in hosts, not in errors
  summed across them, and in hosts failing _now_: a host still inside its
  backoff window. A host that failed once an hour ago and was never asked
  again is not a host that is down. A crawl fanned out over several hosts where
  none is answering has a problem of its own, and it ends saying so rather than
  blaming whichever host failed last.
- **A crawl-wide budget of fifty host-level failures**, alongside the per-host
  one and with its own reason naming no host, because none is to blame. Forty
  hosts each sitting one failure short of their own limit, with one host still
  answering, trips neither of the conditions above and would otherwise crawl
  indefinitely. Each failure counts once toward it — it is not the per-host
  ladders summed — and a `--resume` starts a fresh budget.
- **`--ignore-robots` exists and has to be typed.** It waives robots
  _rules_ — for your own staging site, a local fixture, a contractual crawl —
  and not `crawl-delay`, which is still read from the same file.

### The store

`.quick-caps/crawls/<name>/`, beside the session and gitignored by the same
self-written `.quick-caps/.gitignore`. `<name>` is the seed's host unless
`--name` says otherwise.

```
.quick-caps/crawls/example.com/
  records.jsonl   one JSON object per page, appended
  state.json      the frontier, the seen set, the settings, the counters
```

JSON Lines rather than one JSON document, because a crawl is long and
interruptible: a crawl killed at page 180 of 200 has to leave 180 _valid_
records, not one truncated document that parses to nothing. It also lets
`--report` stream the store instead of loading a 200-page dataset into memory.
A half-written final line — what a killed process leaves — is counted on the
summary's `unread` row as an unparseable line and the scan continues past it;
199 good records are not lost to the 200th.

Each record carries the URL, its depth, the timestamp of the fetch attempt,
the outcome, the requested domains' reports, and any extract warnings for that
page. `content` and `design` extract from each page as fetched, with no live
page to compute styles from — the absence of a natural image size or a loaded
font means "not measured" rather than "not there" — and the summary says so on
a `note` row, once for the crawl rather than once per record: it is the same
sentence on every page, and 500 copies of it would bury the handful of real
per-page warnings the `warnings` count exists to surface. A page that 404s,
times out, or fails to parse is a record with its error rather than an absence,
on the principle the rest of the tool follows: a gap a caller can see is a
fact, a gap it cannot see is a lie.

`state.json` is rewritten atomically after every page, so a kill that arrives
without warning leaves a resumable crawl rather than a corrupt one, and a URL
that was in flight goes back onto the queue rather than being lost. A SIGINT
lands even mid-backoff: the wait is abortable, so `^C` ends the crawl at once
instead of being queued behind a minute of politeness.

- `pc crawl --resume <name>` reads that state and continues. `--limit` is a
  budget per run rather than a permanent ceiling: resuming a crawl that spent
  its budget grants it another one, while resuming an interrupted crawl
  finishes the budget it had.
- `pc crawl --report [<name>] [--json]` summarizes a store, including an
  interrupted one — a crawl store is a legitimate end state, not only a
  waypoint. With no name it reports on the most recently updated crawl in the
  directory; with no crawl in the directory at all it says so and exits
  non-zero, rather than printing an empty summary.

### What a crawl extracts

The frontier follows same-origin links — `content` links before `nav` and
`footer` ones, since a site's chrome links to the same twenty pages from every
page — and `entities.pagination` targets ahead of both, because pagination is
how a catalogue exposes its own contents. It skips external hosts,
non-document schemes (`mailto:`, `tel:`, `javascript:`), and URLs already
seen, where seen means _enqueued_ rather than fetched, which is the property
that makes a cyclic site terminate. Normalization is explicit for the same
reason: the fragment dropped, the host lowercased but never the path, a
trailing `index.html` stripped, query parameters sorted and tracking
parameters (`utm_*`, `gclid`, `fbclid`) dropped — two URLs differing only by a
campaign tag are one page, and treating them as two is the classic way a
crawler runs forever on a finite site.

`--limit` caps pages at 25 by default and `--depth` caps levels from the seed
at 3, so an unqualified `pc crawl` is a sample rather than a commitment.

Domain flags are the same five document domains `pc data` takes —
`--structured`, `--entities`, `--content`, `--design`, `--links` — and `--all`
requests those five and no more. The observation domains (`network`, `stack`,
`vitals`) need a page armed with `--record` before it loads, and `pc crawl`
deliberately has no `--record`: a browser plus a settle window per page across
hundreds of pages is a different tool, and offering the flags without it would
only write "not recorded" two hundred times. With no domain flag a crawl
extracts `structured`, `entities`, and `links` — not the availability summary
`pc data` prints for a single page, since 200 pages' worth of "something was
here" is 200 wasted fetches.

Crawling is **static by default**: each page is fetched and extracted exactly
the way `pc data` does it, escalating to a real browser only where `pc open`
already would — an unrendered SPA shell. No session is written, so a crawl
neither disturbs nor is disturbed by the handles you are holding in that
directory.

## `pc mcp`

Starts an MCP server over stdio, exposing every command above as a typed
tool (`pc_open`, `pc_do`, `pc_read`, `pc_find`, `pc_next`, `pc_layout`,
`pc_tokens`, `pc_scrape`, `pc_data`, `pc_crawl`, `pc_capture`). `pc_data`
takes a `domains` array mirroring the flags — omit it for the availability
summary — and an optional `url` to open first. `pc_crawl` mirrors `pc crawl`'s
flags the same way, including `resume` and `report`, and always answers with
the crawl's summary as JSON plus the store path — never the records: a
200-page dataset is not a tool result, and a follow-up can read exactly the
part of the store it wants. Its per-page progress is suppressed, an MCP client
having no terminal to print it to. Two environment variables control
`pc_capture`'s default output location:

- `QUICK_CAPS_MCP_ARTIFACT_ROOT` — defaults to a per-user directory under
  the OS temp directory (e.g., `<os tmpdir>/quick-caps-mcp-artifacts-<uid>`).
- `QUICK_CAPS_MCP_ARTIFACT_RETENTION_MS` — files older than this are swept
  before each `pc_capture` call. Defaults to 24 hours.

### Adding it to an MCP client

Claude Code:

```bash
claude mcp add quick-caps -- npx -y quick-caps-cli mcp
```

Claude Desktop, Cursor, or any client that reads a JSON config
(`claude_desktop_config.json` and friends):

```json
{
  "mcpServers": {
    "quick-caps": {
      "command": "npx",
      "args": ["-y", "quick-caps-cli", "mcp"]
    }
  }
}
```

The server's session state and `pc_capture`'s default output directory are
resolved from the server process's working directory and
`QUICK_CAPS_MCP_ARTIFACT_ROOT` respectively, so a client that spawns the
server from a project root shares one session with a `pc` invoked in that
same directory from a shell.

## Local development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) in the repository root for
setup, the test suite, and the release process.

## Known limitations

- `capture`'s output directory (`--out`, or MCP's `pc_capture` `outDir`
  argument) accepts any path this process can write to, unvalidated. Fine
  for a human running this locally; if you're hosting `pc mcp` for a
  program you don't fully trust, sandbox its filesystem permissions rather
  than relying on this tool to restrict the path itself.
- `data`'s `content` and `design` domains always run degraded here: they are
  read from the stored session, which has no live page to compute styles
  from, and upgrading it would re-number every handle. Fields that need a
  computed style — an image's natural size, the fonts actually loaded — are
  therefore never reported by this command, on a browser-backed session or a
  static one. The report names what it skipped.
- No CDP attach to a real running browser — every `open`/`capture` starts
  from a clean, unauthenticated browser context or a plain fetch. Real
  cookies/sessions are never available to this tool.
