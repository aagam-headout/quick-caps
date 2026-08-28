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
import { runLayout } from '../../src/commands/layout.js';
import { runNext } from '../../src/commands/next.js';
import { runFind } from '../../src/commands/find.js';
import { readSession } from '../../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, '../fixtures/static-article.html'),
  'utf8',
);
// Dense enough (17 sibling <section> regions) that renderLayout's default
// 500-token budget pages it, unlike static-article.html — needed to prove
// `next` after `layout` keeps paging with renderLayout (Fix 1), not
// distill().
const pagedHtml = readFileSync(
  join(here, '../fixtures/two-sections.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;
let pagedUrl: string;
let cwd: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/paged') {
      res.end(pagedHtml);
      return;
    }
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
  pagedUrl = `http://127.0.0.1:${address.port}/paged`;
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-layout-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runLayout', () => {
  it('upgrades a static session to playwright and prints a structural tree', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const text = await runLayout(cwd);
    expect(text).toContain('article');
    expect(text).toMatch(/\[\d+\] article \(role=article, \d+x\d+ @ \d+,\d+\)/);

    const session = await readSession(cwd);
    expect(session.driver).toBe('playwright');
    expect(session.page).toBe(0);
  }, 30_000);

  it('writes region-only handles usable by read/next', async () => {
    await runOpen({ url: baseUrl }, cwd);
    await runLayout(cwd);
    const session = await readSession(cwd);
    const handleKinds = new Set(
      Object.values(session.handles).map((h) => h.kind),
    );
    expect(handleKinds).toEqual(new Set(['region']));
  }, 30_000);

  it('clears a stale query field from a prior find command', async () => {
    await runOpen({ url: baseUrl }, cwd);
    await runFind('article', cwd);
    const sessionAfterFind = await readSession(cwd);
    expect(sessionAfterFind.query).toBe('article');

    await runLayout(cwd);
    const sessionAfterLayout = await readSession(cwd);
    expect(sessionAfterLayout.query).toBeUndefined();
  }, 30_000);

  it('next after layout keeps paging with renderLayout, not distill (Fix 1 regression)', async () => {
    await runOpen({ url: pagedUrl }, cwd);
    const layoutText = await runLayout(cwd);
    expect(layoutText).toMatch(/\[\d+\] \w+ \(role=/);

    const sessionAfterLayout = await readSession(cwd);
    expect(sessionAfterLayout.hasMore).toBe(true);
    expect(sessionAfterLayout.renderer).toBe('layout');

    const nextText = await runNext(cwd);
    // Before the fix, `next` unconditionally called distill() here,
    // producing score-ranked snippet content — not layout's structural
    // line format.
    expect(nextText).toMatch(/\[\d+\] \w+ \(role=/);
    expect(nextText).not.toMatch(/^No more content\.$/);

    const sessionAfterNext = await readSession(cwd);
    expect(sessionAfterNext.page).toBe(1);
    expect(sessionAfterNext.renderer).toBe('layout');
    const handleKinds = new Set(
      Object.values(sessionAfterNext.handles).map((h) => h.kind),
    );
    expect(handleKinds).toEqual(new Set(['region']));
  }, 30_000);
});
