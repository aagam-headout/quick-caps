#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// tsx's own loader refuses node:module's register() API on this Node
// version ("must be loaded with --import instead of --loader"), and a
// bare `--import tsx/esm` CLI flag resolves relative to the caller's cwd,
// not this script's location — unacceptable since pc must run from any
// directory. import.meta.resolve('tsx/esm') resolves relative to *this
// script's own location* (inside packages/cli, where tsx is a real
// dependency), giving a cwd-independent absolute path. This process then
// relaunches itself once, as a child process with tsx's loader properly
// registered via --import, guarded by an env marker so it doesn't loop.
if (!process.env.__PC_TSX_LOADED__) {
  const tsxLoader = fileURLToPath(import.meta.resolve('tsx/esm'));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      tsxLoader,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit', env: { ...process.env, __PC_TSX_LOADED__: '1' } },
  );
  process.exit(result.status ?? 1);
}

const { main } = await import('../src/cli.js');
await main(process.argv.slice(2));
