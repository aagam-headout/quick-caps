# quick-caps-cli

Distill any rendered web page into a few hundred tokens of numbered
regions and actions — or capture it to disk. Built for agents: `open` a
page, `do` an action by number, `read` a region in full, `find` a query,
`scrape` a schema-driven shape, report the `data` a page contains, or
`capture` the whole thing to a single-file HTML or zip archive. Same functions are also exposed as MCP
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

- `pc open <url> [--static]` — distill a page: numbered regions + actions.
- `pc do <n> [value]` — follow action `[n]` (click a button, fill an input).
- `pc read <n>` — full text of region `[n]`.
- `pc find <query>` — search the currently open page.
- `pc next` — next slice of a paged render.
- `pc layout` — structural tree: regions, roles, boxes.
- `pc tokens` — colors, type scale, spacing, radii.
- `pc scrape <shape>` — schema-driven field extraction, e.g. `pc scrape '{"title":"h1"}'`.
- `pc data [url] [--structured] [--entities] [--content] [--design] [--links] [--all] [--json]`
  — report the data the page contains, as human-readable text; `--json`
  prints the same report as one line of JSON. With no domain flag, an
  availability summary instead of the data.
- `pc capture [--zip] [--out <dir>]` — full archive to disk.
- `pc mcp` — the same ten tools, over an MCP stdio server.
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

The five domains, and what each yields:

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

`--all` requests all five.

`pc data` never upgrades a static session to a browser-backed one, precisely
so the handles you are already holding keep their numbers — the re-numbering
`layout`, `tokens`, and `capture` warn about. Fields that would need
computed styles are skipped rather than guessed, and the report says which
domains ran degraded:

```
warning: content, design: skipped every field needing computed styles
```

## `pc mcp`

Starts an MCP server over stdio, exposing every command above as a typed
tool (`pc_open`, `pc_do`, `pc_read`, `pc_find`, `pc_next`, `pc_layout`,
`pc_tokens`, `pc_scrape`, `pc_data`, `pc_capture`). `pc_data` takes a
`domains` array mirroring the flags — omit it for the availability summary —
and an optional `url` to open first. Two environment variables control
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
