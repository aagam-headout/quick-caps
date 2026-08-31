# Contributing

Thanks for looking. This repository holds three shipped things that share
one engine, so where a change belongs matters more than usual — see
[Layout](#layout) before you start.

## Requirements

- **Node 24 or newer** for development (`.nvmrc` pins it; `nvm use` picks
  it up). The published packages themselves only require Node 22 — the
  higher floor is the toolchain's, not the library's.
- **pnpm 11** (`packageManager` in the root `package.json` pins the exact
  version; enable it with `corepack enable`).
- A display and a real Chrome for the extension end-to-end suite. Unit
  tests need neither.

```bash
pnpm install
pnpm build:packages   # required before typecheck, tests, or running `pc`
```

## Layout

| Path             | Package                 | Publishes to                        |
| ---------------- | ----------------------- | ----------------------------------- |
| `packages/core`  | `quick-caps-core`       | npm (public)                        |
| `packages/cli`   | `quick-caps-cli`        | npm (public), provides the `pc` bin |
| `apps/extension` | `@quick-caps/extension` | Chrome Web Store — never npm        |

`packages/core` is **host-agnostic**: no `chrome`, `window`, or `document`
globals. Both a lint rule and `packages/core/tests/boundary.test.ts`
enforce this, because the same engine has to run inside a browser
extension's content script, inside Playwright's page context, and against
a linkedom document in plain Node. Browser APIs and side effects belong in
`*-entry` / `*-inject` files, which are bundled into the host that needs
them.

Anything that reads `process.argv`, touches the filesystem, or launches a
browser belongs in `packages/cli`.

## Workflow

Tests first. Every non-trivial change should have a failing test before it
has an implementation — the existing suites are written that way and are
the fastest review you'll get.

```bash
pnpm test          # unit tests (vitest)
pnpm typecheck     # tsc across the workspace and the extension
pnpm lint          # eslint
pnpm format        # prettier --write
```

Slower, run when relevant:

```bash
pnpm vitest run packages/cli/tests/collector-bundle.test.ts  # esbuild-backed, excluded from `pnpm test`
pnpm build         # apps/extension/dist
pnpm e2e           # Playwright against a real Chrome; needs a display
```

`pnpm test` deliberately excludes `collector-bundle.test.ts` and
`build-artifacts.test.ts` — they invoke a real bundler and are slow enough
to spoil the inner loop.

### Running the CLI while you work

```bash
pnpm --filter quick-caps-cli dev open https://example.com
```

This runs `src/main.ts` through `tsx`, so source edits take effect without
a build. Do **not** insert a `--` before the arguments — pnpm forwards it
verbatim and `pc` would see `--` as the command name.

To exercise the built output the way a user gets it:

```bash
pnpm build:packages
node packages/cli/bin/pc.mjs --help
```

Session state lands in `.quick-caps/session.json` in whatever directory you
run from, and self-gitignores. Run from a scratch directory to avoid
sprinkling sessions through the repo.

### Testing the MCP server

`packages/cli/tests/` drives the server in-process over
`InMemoryTransport`, which is the right layer for most changes. To check
the real stdio transport, register it against a client:

```bash
pnpm build:packages
claude mcp add quick-caps-dev -- node "$PWD/packages/cli/bin/pc.mjs" mcp
```

Remember to `pnpm build:packages` after each change — the MCP server runs
`dist/`, and a stale build fails silently rather than loudly.

## Commits and pull requests

Conventional Commits with a scope, imperative subject, no trailing period:

```
feat(cli): add --help to every command path
fix(core): stop double-counting nested region text
```

Scopes in use, by frequency in `git log`: `cli`, `mcp`, `extension`,
`capture`, `core`, `ci`, `deps`.

Open pull requests as drafts until CI is green. Keep diffs small — a
drive-by refactor in a bugfix PR gets both harder to review.

## Adding a CLI command

A new `pc` command touches five places. Missing any one of them ships a
half-command:

1. `packages/cli/src/commands/<name>.ts` — a `run<Name>(args, cwd)` that
   returns a string and throws `CliError` for user-facing failures. It must
   not call `console` or `process.exit`.
2. `packages/cli/src/cli.ts` — a `case` in `dispatch`, plus the usage string
   in its `CliError`.
3. `packages/cli/src/help.ts` — a line in `HELP_TEXT`. A test asserts every
   dispatchable command appears there, so this is not optional.
4. `packages/cli/src/mcp/schemas.ts` and `mcp/server.ts` — a zod input
   schema and a `registerTool` call, so the command exists for agents too.
5. `packages/cli/src/index.ts` — a re-export, since the package is a library
   as well as a binary.

If the command needs real layout geometry or computed styles, call
`ensurePlaywrightSession(cwd)` rather than reading the session directly:
a static session physically cannot answer those questions, and the
escalation re-numbers every handle.

## Security-sensitive paths

Treat these as review-gated rather than ordinary code:

- **`packages/core/src/url-policy.ts`** — the scheme allowlist and
  private-address block. Every network-initiating path calls
  `assertFetchableUrl`, both before navigation and again on the
  post-redirect URL, because a redirect can land somewhere the first check
  never saw. Adding a fetch path means adding both checks.
- **`packages/cli/src/mcp/artifacts.ts`** — the artifact root, its symlink
  refusal, and the retention sweep. The sweep deletes files; changes here
  want a test proving what it will not delete.

Never log a secret, and don't add a dependency without saying in the PR why
an existing one or the standard library won't do.

## Releasing

See [RELEASING.md](RELEASING.md). Publishing order matters and
`pnpm publish` is required over `npm publish`.
