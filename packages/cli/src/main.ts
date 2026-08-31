/**
 * Argv entry point. `cli.ts` deliberately exports `main` without calling
 * it, so tests can drive `dispatch`/`main` in-process; that leaves it inert
 * when run as a script. This module is the one place that actually reads
 * `process.argv`, so `tsx src/main.ts <args>` behaves exactly like the
 * published `bin/pc.mjs` shim does against `dist/`.
 */
import { main } from './cli.js';

await main(process.argv.slice(2));
