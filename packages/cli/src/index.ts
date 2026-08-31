/**
 * @module quick-caps-cli
 *
 * ### `pc mcp`
 *
 * Starts an MCP server over stdio, exposing every command below as a typed
 * tool (`pc_open`, `pc_do`, `pc_read`, `pc_find`, `pc_next`, `pc_layout`,
 * `pc_tokens`, `pc_scrape`, `pc_data`, `pc_capture`). Same session file, same
 * `.quick-caps/session.json` in the process's working directory — a `pc open`
 * in a shell and a `pc_open` tool call in the same directory share state.
 *
 * `pc_capture` defaults its output directory to an MCP-specific artifact
 * root instead of the working directory, since MCP clients don't have a
 * notion of "current shell directory" the way a terminal user does:
 *
 * - `QUICK_CAPS_MCP_ARTIFACT_ROOT` — where capture files land by default.
 *   Defaults to a per-user directory under the OS temp directory (e.g., `<os tmpdir>/quick-caps-mcp-artifacts-<uid>`).
 * - `QUICK_CAPS_MCP_ARTIFACT_RETENTION_MS` — files older than this are swept
 *   before each `pc_capture` call, so an agent capturing in a loop doesn't
 *   fill the disk. Defaults to 24 hours.
 *
 * Not supported: attaching to a real running browser via CDP for
 * authenticated/cookie-bearing sessions — flagged in the design spec as
 * needing a security review first, out of scope here.
 */

export { PlaywrightDriver } from './drivers/playwright-driver.js';
export { StaticDriver } from './drivers/static-driver.js';
export { dispatch, main } from './cli.js';
export { HELP_TEXT } from './help.js';
export { runOpen, type OpenCommandArgs } from './commands/open.js';
export { runNext } from './commands/next.js';
export { runDo, CliError } from './commands/do.js';
export { runRead } from './commands/read.js';
export { runFind } from './commands/find.js';
export { openUrl, looksLikeEmptyShell, type OpenResult } from './open.js';
export {
  readSession,
  writeSession,
  SessionNotFoundError,
  type Session,
} from './session.js';
export { runLayout } from './commands/layout.js';
export { runTokens } from './commands/tokens.js';
export { runScrape, splitSelectorAttr } from './commands/scrape.js';
export { runData, type DataArgs } from './commands/data.js';
export { runCapture, type CaptureArgs } from './commands/capture.js';
export { interact, type InteractAction } from './interact.js';
export { ensurePlaywrightSession } from './ensure-playwright.js';
export { collectViaPlaywrightFor } from './open.js';
export { buildMcpServer, startMcpServer } from './mcp/server.js';
export {
  resolveArtifactRoot,
  resolveRetentionMs,
  sweepArtifactRoot,
} from './mcp/artifacts.js';
