import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { distill } from '@quickcaps/core/distill';
import { runOpen } from '../../src/commands/open.js';
import { runFind } from '../../src/commands/find.js';
import { readSession } from '../../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, '../fixtures/two-sections.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;
let cwd: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-find-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runFind', () => {
  it('surfaces a rare-word match that a tight default budget would miss', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const session = await readSession(cwd);

    // Same budget find.ts actually uses in production (500) — the only
    // thing that differs between the two calls below is the ranking
    // function, which is the causal claim this test exists to prove.
    const defaultAtSameBudget = distill(session.ir, { tokenBudget: 500 });
    expect(defaultAtSameBudget.text).not.toContain('zephyrquokka987');

    const found = await runFind('zephyrquokka987', cwd);
    expect(found).toContain('zephyrquokka987');
  });
});
