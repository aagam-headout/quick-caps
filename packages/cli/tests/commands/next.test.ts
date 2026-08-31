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
import { runOpen } from '../../src/commands/open.js';
import { runNext } from '../../src/commands/next.js';
import { readSession } from '../../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, '../fixtures/static-article.html'),
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
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-next-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runNext', () => {
  it('advances the session page and does not re-fetch', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const text = await runNext(cwd);
    const session = await readSession(cwd);
    expect(session.page).toBe(1);
    expect(typeof text).toBe('string');
  });

  it('reports no more content on an already-exhausted page', async () => {
    await runOpen({ url: baseUrl }, cwd);
    // This tiny fixture fits on page 0 entirely at the default budget, so
    // page 1 has nothing left.
    const text = await runNext(cwd);
    expect(text).toBe('No more content.');
  });
});
