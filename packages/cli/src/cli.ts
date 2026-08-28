import { runOpen } from './commands/open.js';
import { runNext } from './commands/next.js';
import { runDo } from './commands/do.js';
import { runRead } from './commands/read.js';
import { runFind } from './commands/find.js';
import { runLayout } from './commands/layout.js';
import { runTokens } from './commands/tokens.js';
import { runScrape } from './commands/scrape.js';
import { runCapture, type CaptureArgs } from './commands/capture.js';
import { startMcpServer } from './mcp/server.js';
import { CliError } from './errors.js';

/**
 * Pure argv-to-output dispatch, no process.exit/console — kept separate
 * from main() below so tests can call it directly against a temp cwd
 * without spawning a real process.
 */
export async function dispatch(
  argv: string[],
  cwd: string = process.cwd(),
): Promise<string> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'open': {
      const staticFlag = rest.includes('--static');
      const url = rest.find((arg) => !arg.startsWith('--'));
      if (!url) throw new Error('Usage: pc open <url> [--static]');
      return runOpen({ url, static: staticFlag }, cwd);
    }
    case 'next':
      return runNext(cwd);
    case 'do': {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) throw new Error('Usage: pc do <n> [value]');
      return runDo(n, cwd, rest[1]);
    }
    case 'read': {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) throw new Error('Usage: pc read <n>');
      return runRead(n, cwd);
    }
    case 'find': {
      const query = rest.join(' ');
      if (!query) throw new Error('Usage: pc find <query>');
      return runFind(query, cwd);
    }
    case 'layout':
      return runLayout(cwd);
    case 'tokens':
      return runTokens(cwd);
    case 'scrape': {
      const shape = rest[0];
      if (!shape) throw new Error('Usage: pc scrape <shape>');
      return runScrape(shape, cwd);
    }
    case 'capture': {
      const args: CaptureArgs = {};
      if (rest.includes('--zip')) args.zip = true;
      const outIndex = rest.indexOf('--out');
      if (outIndex !== -1) {
        const outDir = rest[outIndex + 1];
        if (!outDir) throw new Error('Usage: pc capture [--zip] [--out <dir>]');
        args.outDir = outDir;
      }
      return runCapture(args, cwd);
    }
    case 'mcp':
      await startMcpServer();
      return '';
    default:
      throw new Error(
        `Unknown command: ${command ?? '(none)'}. Expected one of: open, do, read, find, next, layout, tokens, scrape, capture, mcp.`,
      );
  }
}

/* c8 ignore start -- exercised via bin/pc.mjs, not unit-testable without
 * spawning a real process. */
export async function main(argv: string[]): Promise<void> {
  try {
    const output = await dispatch(argv);
    console.log(output);
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
    } else {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    }
    process.exitCode = 1;
  }
}
/* c8 ignore stop */
