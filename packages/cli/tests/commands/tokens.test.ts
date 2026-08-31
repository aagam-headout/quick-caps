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
import { runTokens } from '../../src/commands/tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, '../fixtures/styled.html'), 'utf8');

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
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-tokens-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runTokens', () => {
  it('reports repeated color and size values as JSON', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const output = await runTokens(cwd);
    const report = JSON.parse(output);

    expect(report.color).toBeTruthy();
    expect(Object.keys(report.color)).toContain('#1a1a1a');
    expect(report.fontSize).toBeTruthy();
    expect(Object.keys(report.fontSize)).toContain('14px');
  }, 30_000);
});
