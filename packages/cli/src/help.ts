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
  pc open <url> [--static] [--record] [--no-redact]
                                Fetch, distill, and start a session. Escalates
                                to a real browser when the static fetch looks
                                like an unrendered SPA shell; --static opts out.
                                --record arms observation for --network,
                                --stack, and --vitals below. --no-redact keeps
                                recorded credentials, which are replaced with
                                [redacted] by default.
  pc next                       Print the next slice of the current render.
  pc do <n> [value]             Follow handle n: click a link or button, or
                                type value into an input.
  pc read <n>                   Print the full text of region n.
  pc find <query>               Re-rank the open page against query.
  pc layout                     Structural tree: regions, roles, boxes.
  pc tokens                     Colors, type scale, spacing, and radii.
  pc scrape <shape>             Extract fields per a JSON {field: selector}
                                shape; "sel@attr" reads an attribute.
  pc data [url] [--structured] [--entities] [--content] [--design]
          [--links] [--network] [--stack] [--vitals] [--all] [--json]
                                Report the data the page contains: declared
                                structured data, entities, content quality,
                                design system, link graph — plus, on a session
                                opened with --record, the recorded network
                                traffic, the third-party stack, and web vitals.
                                Readable text by default; --json prints the
                                report as one line of JSON. With no domain
                                flag, prints which domains found something and
                                how much. With a url, opens it first.
  pc crawl <url> [--limit N] [--depth N] [--name <name>] [--structured]
           [--entities] [--content] [--design] [--links] [--all] [--rate N]
           [--concurrency N] [--ignore-robots]
  pc crawl --resume <name>
  pc crawl --report [<name>] [--json]
                                Walk a site and extract from every page into a
                                resumable crawl store, one JSON Lines record
                                per page. Same-origin links and pagination,
                                depth-capped; robots.txt honoured and one
                                request per second per host unless --rate,
                                --concurrency, or --ignore-robots says
                                otherwise. --resume continues an interrupted
                                crawl; --report summarizes one.
  pc capture [--zip] [--record] [--out <dir>]
                                Write a self-contained archive of the page.
  pc mcp                        Serve every command above as an MCP tool over
                                stdio (pc_open, pc_do, pc_read, ...).
  pc help, --help, -h           Print this text.

Notes:
  layout, tokens, and capture need real layout geometry and computed styles,
  so they upgrade a static session to a browser-backed one, which re-numbers
  every handle.

  --record does the same, for the same kind of reason: a static fetch
  witnesses nothing, so arming observation forces a real browser session and
  therefore re-numbers every handle. On capture it re-collects the page even
  when the session is already browser-backed, because a recording has to be
  armed before the load it observes.

  network, stack, and vitals report "not recorded" on a session opened
  without --record, rather than reporting empty — nothing happened and nobody
  was watching are different answers.

  A recording redacts Authorization, Cookie, and token-shaped headers, query
  parameters, and body fields as it records them, so .quick-caps/ — gitignored
  but not encrypted, and meant to be read into an agent's context — never
  holds a live credential. --no-redact opts out for the case where reproducing
  an API call needs the real thing; it applies to open only, and capture always
  redacts.

  data never upgrades a static session, precisely so it keeps the handles
  you already have. Fields needing computed styles are skipped instead, and
  the report names them.

  crawl is static by default and has no --record: a browser plus a settle
  window per page across hundreds of pages is a different tool, so the
  network, stack, and vitals domains are not offered here.

  A crawl writes .quick-caps/crawls/<name>/ — records.jsonl plus a state file
  holding the frontier, the seen set, and the counters. JSON Lines because a
  crawl killed at page 180 of 200 must leave 180 valid records; a page that
  failed is a record with its error, and a URL robots disallowed is a record
  with that reason. --report streams that store rather than loading it.

  next replaces the current handles rather than adding to them: act on the
  numbers from the most recent output, not an earlier slice.

  Session state lives in .quick-caps/session.json in the working directory,
  and is self-gitignored. Each directory is an independent session.

Environment (pc mcp only):
  QUICK_CAPS_MCP_ARTIFACT_ROOT         Where pc_capture writes by default.
  QUICK_CAPS_MCP_ARTIFACT_RETENTION_MS Age at which artifacts are swept.
`;
