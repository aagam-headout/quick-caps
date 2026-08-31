import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const binPath = join(here, '../bin/pc.mjs');
const fixtureHtml = readFileSync(
  join(here, 'fixtures/static-article.html'),
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
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-bin-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('pc bin (end-to-end)', () => {
  it('opens a real URL and prints a distillation', async () => {
    const { stdout } = await execFileAsync('node', [binPath, 'open', baseUrl], {
      cwd,
    });
    expect(stdout).toContain('A Real Article');
  }, 30_000);

  it('exits non-zero with a clear message on a bad command', async () => {
    await expect(
      execFileAsync('node', [binPath, 'bogus'], { cwd }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unknown command'),
    });
  }, 30_000);

  it('prints help and exits 0 for --help', async () => {
    const { stdout, stderr } = await execFileAsync(
      'node',
      [binPath, '--help'],
      {
        cwd,
      },
    );
    expect(stdout).toContain('Usage: pc <command>');
    expect(stderr).toBe('');
  }, 30_000);

  it('prints help and exits 0 when invoked with no arguments', async () => {
    const { stdout } = await execFileAsync('node', [binPath], { cwd });
    expect(stdout).toContain('Usage: pc <command>');
  }, 30_000);

  it('runs a full open -> layout -> scrape sequence through the real bin', async () => {
    await execFileAsync('node', [binPath, 'open', baseUrl], { cwd });
    const { stdout: layoutOut } = await execFileAsync(
      'node',
      [binPath, 'layout'],
      { cwd },
    );
    expect(layoutOut).toMatch(/\[\d+\] \w+ \(role=/);

    const { stdout: scrapeOut } = await execFileAsync(
      'node',
      [binPath, 'scrape', '{"title":"h1"}'],
      { cwd },
    );
    expect(JSON.parse(scrapeOut).title).toBe('A Real Article');
  }, 30_000);
});
