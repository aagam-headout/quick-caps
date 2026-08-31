/**
 * The one place `pc`'s surface is described in prose. Kept as a module
 * constant rather than assembled per-command so there is a single text to
 * keep in step with dispatch() — a per-command usage string already lives
 * next to each CliError throw, and duplicating those here would just give
 * the two copies room to drift.
 */
export const HELP_TEXT = `Usage: pc <command> [args]

Distill a rendered web page into a few hundred tokens of numbered regions
and actions, or capture it to disk. Region and action numbers printed by one
command are the handles the next command takes.

Commands:
  pc open <url> [--static]      Fetch, distill, and start a session. Escalates
                                to a real browser when the static fetch looks
                                like an unrendered SPA shell; --static opts out.
  pc next                       Print the next slice of the current render.
  pc do <n> [value]             Follow handle n: click a link or button, or
                                type value into an input.
  pc read <n>                   Print the full text of region n.
  pc find <query>               Re-rank the open page against query.
  pc layout                     Structural tree: regions, roles, boxes.
  pc tokens                     Colors, type scale, spacing, and radii.
  pc scrape <shape>             Extract fields per a JSON {field: selector}
                                shape; "sel@attr" reads an attribute.
  pc capture [--zip] [--out <dir>]
                                Write a self-contained archive of the page.
  pc mcp                        Serve every command above as an MCP tool over
                                stdio (pc_open, pc_do, pc_read, ...).
  pc help, --help, -h           Print this text.

Notes:
  layout, tokens, and capture need real layout geometry and computed styles,
  so they upgrade a static session to a browser-backed one, which re-numbers
  every handle.

  next replaces the current handles rather than adding to them: act on the
  numbers from the most recent output, not an earlier slice.

  Session state lives in .quick-caps/session.json in the working directory,
  and is self-gitignored. Each directory is an independent session.

Environment (pc mcp only):
  QUICK_CAPS_MCP_ARTIFACT_ROOT         Where pc_capture writes by default.
  QUICK_CAPS_MCP_ARTIFACT_RETENTION_MS Age at which artifacts are swept.
`;
