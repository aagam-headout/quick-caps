import { runOpen, type OpenCommandArgs } from './commands/open.js';
import { runNext } from './commands/next.js';
import { runDo } from './commands/do.js';
import { runRead } from './commands/read.js';
import { runFind } from './commands/find.js';
import { runLayout } from './commands/layout.js';
import { runTokens } from './commands/tokens.js';
import { runScrape } from './commands/scrape.js';
import { runData } from './commands/data.js';
import { runCapture, type CaptureArgs } from './commands/capture.js';
import { startMcpServer } from './mcp/server.js';
import { EXTRACT_DOMAINS } from 'quick-caps-core/extract';
import { HELP_TEXT } from './help.js';
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

  // Checked before the switch so the flags win from any position: `pc
  // --help` and `pc open --help` both print usage rather than the second
  // dispatching a real fetch against a URL the user never supplied. The
  // bare word `help` is only honored as the command itself — `pc find help`
  // is a search for the word, not a request for this text.
  if (
    command === undefined ||
    command === 'help' ||
    rest.some((arg) => arg === '--help' || arg === '-h') ||
    command === '--help' ||
    command === '-h'
  ) {
    return HELP_TEXT;
  }

  switch (command) {
    case 'open': {
      const staticFlag = rest.includes('--static');
      const record = rest.includes('--record');
      const url = rest.find((arg) => !arg.startsWith('--'));
      if (!url)
        throw new CliError(
          'Usage: pc open <url> [--static] [--record] [--no-redact]',
        );
      const args: OpenCommandArgs = { url, static: staticFlag, record };
      // Set only when passed, so the common path's args keep their shape.
      if (rest.includes('--no-redact')) args.noRedact = true;
      return runOpen(args, cwd);
    }
    case 'next':
      return runNext(cwd);
    case 'do': {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) throw new CliError('Usage: pc do <n> [value]');
      return runDo(n, cwd, rest[1]);
    }
    case 'read': {
      const n = Number(rest[0]);
      if (!Number.isInteger(n)) throw new CliError('Usage: pc read <n>');
      return runRead(n, cwd);
    }
    case 'find': {
      const query = rest.join(' ');
      if (!query) throw new CliError('Usage: pc find <query>');
      return runFind(query, cwd);
    }
    case 'layout':
      return runLayout(cwd);
    case 'tokens':
      return runTokens(cwd);
    case 'scrape': {
      const shape = rest[0];
      if (!shape) throw new CliError('Usage: pc scrape <shape>');
      return runScrape(shape, cwd);
    }
    case 'data': {
      // No domain flag is a request for the availability summary, not for
      // everything — runData reads an empty list that way.
      const all = rest.includes('--all');
      const domains = EXTRACT_DOMAINS.filter(
        (domain) => all || rest.includes(`--${domain}`),
      );
      const url = rest.find((arg) => !arg.startsWith('--'));
      // --record/--no-redact are forwarded because `pc data <url>` opens that
      // url for the caller; dropping them here would arm nothing and then
      // report the recording as missing.
      return runData(
        {
          ...(url !== undefined && { url }),
          domains: [...domains],
          json: rest.includes('--json'),
          ...(rest.includes('--record') && { record: true }),
          ...(rest.includes('--no-redact') && { noRedact: true }),
        },
        cwd,
      );
    }
    case 'capture': {
      const args: CaptureArgs = {};
      if (rest.includes('--zip')) args.zip = true;
      if (rest.includes('--record')) args.record = true;
      const outIndex = rest.indexOf('--out');
      if (outIndex !== -1) {
        const outDir = rest[outIndex + 1];
        if (!outDir)
          throw new CliError(
            'Usage: pc capture [--zip] [--record] [--out <dir>]',
          );
        args.outDir = outDir;
      }
      return runCapture(args, cwd);
    }
    case 'mcp':
      await startMcpServer();
      return '';
    default:
      throw new CliError(
        `Unknown command: ${command}. Expected one of: open, do, read, find, next, layout, tokens, scrape, data, capture, mcp — run 'pc --help' for usage.`,
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
