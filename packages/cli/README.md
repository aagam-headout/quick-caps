# quickcaps-cli

Distill any rendered web page into a few hundred tokens of numbered
regions and actions — or capture it to disk. Built for agents: `open` a
page, `do` an action by number, `read` a region in full, `find` a query,
`scrape` a schema-driven shape, or `capture` the whole thing to a
single-file HTML or zip archive. Same functions are also exposed as MCP
tools over stdio (`pc mcp`).

## Install / run

```bash
npx quickcaps-cli open https://example.com
```

Note: the npm package is named `quickcaps-cli`, but the command it
installs is `pc` — `npx quickcaps-cli <command>` runs `pc <command>`
directly. A local or global install (`npm install -g quickcaps-cli`)
additionally exposes `pc` on your `PATH`.

## Commands

- `pc open <url> [--static]` — distill a page: numbered regions + actions.
- `pc do <n> [value]` — follow action `[n]` (click a button, fill an input).
- `pc read <n>` — full text of region `[n]`.
- `pc find <query>` — search the currently open page.
- `pc next` — next slice of a paged render.
- `pc layout` — structural tree: regions, roles, boxes.
- `pc tokens` — colors, type scale, spacing, radii.
- `pc scrape <shape>` — schema-driven field extraction, e.g. `pc scrape '{"title":"h1"}'`.
- `pc capture [--zip] [--out <dir>]` — full archive to disk.
- `pc mcp` — the same nine tools, over an MCP stdio server.

Every command is stateful across invocations within one directory: a
`.quickcaps/session.json` file holds the current page, its numbered
action map, and the render cursor, so `do`/`read`/`find`/`next` resolve
without re-fetching.

## `pc mcp`

Starts an MCP server over stdio, exposing every command above as a typed
tool (`pc_open`, `pc_do`, `pc_read`, `pc_find`, `pc_next`, `pc_layout`,
`pc_tokens`, `pc_scrape`, `pc_capture`). Two environment variables control
`pc_capture`'s default output location:

- `QUICKCAPS_MCP_ARTIFACT_ROOT` — defaults to a per-user directory under
  the OS temp directory (e.g., `<os tmpdir>/quickcaps-mcp-artifacts-<uid>`).
- `QUICKCAPS_MCP_ARTIFACT_RETENTION_MS` — files older than this are swept
  before each `pc_capture` call. Defaults to 24 hours.

## When to use `only-cli` instead

[`only-cli`](https://www.npmjs.com/package/@only-cli/oc) works from a
static fetch with no browser — faster, lighter, no Chromium dependency.
For plain article text where the page doesn't need client-side rendering,
`only-cli` is the better tool. `quickcaps-cli`'s reason to exist is
rendered-DOM fidelity and real design-token extraction: pages that need a
real browser to produce their real content, and cases where you want
actual computed colors/spacing/type scale, not just text.

## Known limitations

- `capture`'s output directory (`--out`, or MCP's `pc_capture` `outDir`
  argument) accepts any path this process can write to, unvalidated. Fine
  for a human running this locally; if you're hosting `pc mcp` for a
  program you don't fully trust, sandbox its filesystem permissions rather
  than relying on this tool to restrict the path itself.
- No CDP attach to a real running browser — every `open`/`capture` starts
  from a clean, unauthenticated browser context or a plain fetch. Real
  cookies/sessions are never available to this tool.
