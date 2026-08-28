import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
import { unzipSync } from 'fflate';
import { runOpen } from '../../src/commands/open.js';
import { runCapture } from '../../src/commands/capture.js';

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
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-capture-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runCapture', () => {
  it('writes a real, non-empty single-file html archive to cwd by default', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const message = await runCapture({}, cwd);
    expect(message).toContain('Wrote');

    const writtenPath = message.match(/Wrote (\S+)/)?.[1];
    expect(writtenPath).toBeTruthy();
    expect(existsSync(writtenPath!)).toBe(true);
    const bytes = await readFile(writtenPath!);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.toString('utf8')).toContain('A Real Article');
  }, 30_000);

  it('writes a valid zip containing page.html when --zip is set', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const message = await runCapture({ zip: true }, cwd);
    const writtenPath = message.match(/Wrote (\S+)/)![1]!;
    expect(writtenPath.endsWith('.zip')).toBe(true);

    const bytes = await readFile(writtenPath);
    const entries = unzipSync(bytes);
    expect(entries['page.html']).toBeTruthy();
    expect(Buffer.from(entries['page.html']!).toString('utf8')).toContain(
      'A Real Article',
    );
  }, 30_000);

  it('respects --out to redirect the output directory', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const outDir = await mkdtemp(join(tmpdir(), 'quickcaps-capture-out-'));
    try {
      const message = await runCapture({ outDir }, cwd);
      const writtenPath = message.match(/Wrote (\S+)/)![1]!;
      expect(writtenPath.startsWith(outDir)).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});
