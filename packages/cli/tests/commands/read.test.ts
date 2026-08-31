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
import { CliError, runRead } from '../../src/commands/read.js';
import { readSession } from '../../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, '../fixtures/long-paragraph.html'),
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
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-read-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runRead', () => {
  it('errors clearly on an unknown handle', async () => {
    await runOpen({ url: baseUrl }, cwd);
    await expect(runRead(99_999, cwd)).rejects.toThrow(CliError);
  });

  it('returns the full text of a region, longer than its distilled snippet', async () => {
    const distilled = await runOpen({ url: baseUrl }, cwd);
    const session = await readSession(cwd);
    const paragraphRegion = Object.values(session.handles).find(
      (h) => h.kind === 'region',
    )!;

    const full = await runRead(paragraphRegion.id, cwd);
    expect(full).toContain('cut off mid sentence');
    expect(full.length).toBeGreaterThan(200);
    // The distillation's own snippet is truncated with an ellipsis;
    // read's full text should not be.
    expect(distilled).toContain('…');
    expect(full).not.toContain('…');
  });
});
