import { runOpen } from './commands/open.js';
import { runNext } from './commands/next.js';
import { runDo } from './commands/do.js';
import { runRead } from './commands/read.js';
import { runFind } from './commands/find.js';
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
      if (!Number.isInteger(n)) throw new Error('Usage: pc do <n>');
      return runDo(n, cwd);
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
    default:
      throw new Error(
        `Unknown command: ${command ?? '(none)'}. Expected one of: open, do, read, find, next.`,
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
