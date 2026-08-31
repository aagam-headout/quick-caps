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
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-open-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runOpen', () => {
  it('prints a distillation and writes a session', async () => {
    const text = await runOpen({ url: baseUrl }, cwd);
    expect(text).toContain('A Real Article');

    const session = await readSession(cwd);
    expect(session.url).toBe(baseUrl);
    expect(session.driver).toBe('static');
    expect(session.page).toBe(0);
  });

  /**
   * The fixture is a real article, so the escalation heuristic would leave it
   * on StaticDriver — which is what makes it the right page to prove --record
   * forces a browser regardless of what the heuristic thinks.
   */
  it('--record forces a browser session on a page that would have stayed static', async () => {
    const withoutRecord = await mkdtemp(join(tmpdir(), 'quick-caps-open-'));
    try {
      await runOpen({ url: baseUrl }, withoutRecord);
      expect((await readSession(withoutRecord)).driver).toBe('static');
    } finally {
      await rm(withoutRecord, { recursive: true, force: true });
    }

    await runOpen({ url: baseUrl, record: true }, cwd);
    expect((await readSession(cwd)).driver).toBe('playwright');
  }, 30_000);

  it('refuses --record together with --static rather than picking a driver', async () => {
    await expect(
      runOpen({ url: baseUrl, record: true, static: true }, cwd),
    ).rejects.toThrow(/--record needs a real browser/);
  });
});
