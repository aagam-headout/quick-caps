#!/usr/bin/env node
// One command that puts the workspace in a shippable state: it fixes what it
// can (lint autofixes, formatting), then proves the rest (types, tests, both
// package builds, the extension build) and prints a single report.
//
// Order matters. `lint --fix` rewrites code, so formatting runs after it, not
// before. Both package builds run before `typecheck` because quick-caps-core's
// exports.types points at ./dist/index.d.ts — on a clean checkout the workspace
// cannot typecheck until that file exists. The two artifact tests are excluded
// from `pnpm test` and read apps/extension/dist, so they run last.

import { spawnSync } from 'node:child_process';

const steps = [
  { name: 'lint --fix', cmd: 'pnpm', args: ['-w', 'lint:fix'] },
  { name: 'format --write', cmd: 'pnpm', args: ['-w', 'format'] },
  { name: 'build packages', cmd: 'pnpm', args: ['-w', 'build:packages'] },
  { name: 'typecheck', cmd: 'pnpm', args: ['-w', 'typecheck'] },
  { name: 'test', cmd: 'pnpm', args: ['-w', 'test'] },
  { name: 'build extension', cmd: 'pnpm', args: ['-w', 'build'] },
  {
    name: 'artifact tests',
    cmd: 'pnpm',
    args: [
      'exec',
      'vitest',
      'run',
      'apps/extension/tests/collector-bundle.test.ts',
      'apps/extension/tests/build-artifacts.test.ts',
    ],
  },
];

const results = [];
let failed = null;

for (const step of steps) {
  process.stdout.write(`\n[1m→ ${step.name}[0m\n`);
  const startedAt = Date.now();
  const run = spawnSync(step.cmd, step.args, { stdio: 'inherit' });
  const ms = Date.now() - startedAt;
  const ok = run.status === 0;

  results.push({ name: step.name, ok, ms });

  if (!ok) {
    failed = step.name;
    break;
  }
}

const skipped = steps.slice(results.length).map((step) => step.name);
const pad = Math.max(
  ...steps.map((step) => step.name.length),
  ...skipped.map((name) => name.length),
);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

process.stdout.write(`\n[1mship report[0m\n`);
for (const result of results) {
  const mark = result.ok ? '[32mpass[0m' : '[31mFAIL[0m';
  process.stdout.write(
    `  ${result.name.padEnd(pad)}  ${mark}  ${seconds(result.ms)}\n`,
  );
}
for (const name of skipped) {
  process.stdout.write(`  ${name.padEnd(pad)}  [90mskipped[0m\n`);
}

const total = results.reduce((sum, result) => sum + result.ms, 0);

if (failed) {
  process.stdout.write(
    `\n[31m${failed} failed[0m — its output is above. ` +
      `${skipped.length} step(s) never ran.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `\n[32mall ${results.length} steps passed[0m in ${seconds(total)}. ` +
    `Working tree may have lint/format fixes to review before committing.\n`,
);
