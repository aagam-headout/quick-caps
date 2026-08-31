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
import { runData } from '../../src/commands/data.js';
import { readSession, SessionNotFoundError } from '../../src/session.js';

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
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-data-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runData', () => {
  it('refuses without a session and without a url', async () => {
    await expect(runData({ domains: [] }, cwd)).rejects.toThrow(
      SessionNotFoundError,
    );
  });

  it('opens the url itself, then extracts from the session it saved', async () => {
    const output = await runData({ url: baseUrl, domains: ['links'] }, cwd);

    expect(JSON.parse(output).links).toBeDefined();
    const session = await readSession(cwd);
    expect(session.url).toBe(baseUrl);
  });

  it('prints an availability summary when no domain is named', async () => {
    await runOpen({ url: baseUrl, static: true }, cwd);
    const output = await runData({ domains: [] }, cwd);

    expect(output).toMatch(/^available: /m);
    expect(output).toContain('structured(');
    expect(output).toContain('links(');
  });

  it('prints requested domains as pretty JSON, and as one line with --json', async () => {
    await runOpen({ url: baseUrl, static: true }, cwd);

    const pretty = await runData({ domains: ['structured'] }, cwd);
    expect(pretty).toContain('\n  ');
    expect(Object.keys(JSON.parse(pretty))).toContain('structured');

    const compact = await runData({ domains: ['structured'], json: true }, cwd);
    expect(compact.trim().split('\n')).toHaveLength(1);
    expect(Object.keys(JSON.parse(compact))).toContain('structured');
  });

  it('never upgrades a static session to a browser-backed one', async () => {
    await runOpen({ url: baseUrl, static: true }, cwd);
    const before = await readSession(cwd);

    // The fixture server is closed for the rest of this test's lifetime only
    // in spirit — what matters is the session file: an upgrade would rewrite
    // it with driver 'playwright' and a fresh, renumbered handle map, which
    // is exactly what `pc data` must not do to a caller mid-conversation.
    await runData({ domains: ['content', 'design'] }, cwd);
    const after = await readSession(cwd);

    expect(after.driver).toBe('static');
    expect(after.driver).toBe(before.driver);
    expect(after.handles).toEqual(before.handles);
  });

  it('warns by name about the domains a session without computed styles degrades', async () => {
    await runOpen({ url: baseUrl, static: true }, cwd);
    const report = JSON.parse(await runData({ domains: ['design'] }, cwd));

    const reasons = (report.warnings ?? []).map(
      (warning: { reason: string }) => warning.reason,
    );
    expect(reasons.join(' ')).toContain('design');
    expect(reasons.join(' ')).toContain('computed styles');
  });

  it('keeps warnings out of the availability summary line', async () => {
    await runOpen({ url: baseUrl, static: true }, cwd);
    const output = await runData({ domains: [] }, cwd);

    expect(output.split('\n')[0]).not.toContain('warnings');
  });
});
