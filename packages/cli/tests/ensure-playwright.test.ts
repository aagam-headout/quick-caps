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
import { distill, flattenRegions } from '@quickcaps/core/distill';
import { runOpen } from '../src/commands/open.js';
import { runNext } from '../src/commands/next.js';
import { ensurePlaywrightSession } from '../src/ensure-playwright.js';
import { readSession } from '../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
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
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-ensure-playwright-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('ensurePlaywrightSession', () => {
  it('upgrades a static session to playwright, overwriting the session', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const before = await readSession(cwd);
    expect(before.driver).toBe('static');

    const upgraded = await ensurePlaywrightSession(cwd);
    expect(upgraded.driver).toBe('playwright');

    const persisted = await readSession(cwd);
    expect(persisted.driver).toBe('playwright');
  }, 30_000);

  it('is a no-op when the session is already playwright-backed', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const first = await ensurePlaywrightSession(cwd);
    const second = await ensurePlaywrightSession(cwd);
    expect(second.ir.metadata.capturedAt).toBe(first.ir.metadata.capturedAt);
  }, 30_000);

  it('re-derives handles/page/hasMore from the freshly-collected ir, dropping stale paging state (Fix 2 regression)', async () => {
    await runOpen({ url: baseUrl }, cwd);
    // Advance paging state on the static session, so escalation has
    // something stale to (incorrectly) carry forward if the bug regresses.
    await runNext(cwd);
    const staleSession = await readSession(cwd);
    expect(staleSession.page).toBe(1);

    const escalated = await ensurePlaywrightSession(cwd);

    // Region/action ids come from a per-collection counter in buildRegions
    // — a re-collected page has entirely different numbering, so the
    // escalated session must not inherit the old page/handles wholesale.
    // It should look exactly like a fresh distill() of the new ir at page 0.
    expect(escalated.page).toBe(0);
    const freshDistillation = distill(escalated.ir, {
      tokenBudget: 500,
      page: 0,
    });
    expect(escalated.hasMore).toBe(freshDistillation.hasMore);
    expect(escalated.handles).toEqual(freshDistillation.handles);
    expect(escalated.query).toBeUndefined();
    expect(escalated.renderer).toBeUndefined();

    // Every persisted handle must resolve to a real region/action in the
    // NEW ir — not a stale reference into the old (discarded) tree.
    const flat = flattenRegions(escalated.ir.regions);
    for (const [idStr, handle] of Object.entries(escalated.handles)) {
      const id = Number(idStr);
      const resolvesToRegion = flat.some((entry) => entry.region.id === id);
      const resolvesToAction = flat.some((entry) =>
        entry.region.actions.some((a) => a.id === id),
      );
      expect(
        resolvesToRegion || resolvesToAction,
        `handle ${id} (kind=${handle.kind}) should resolve against the new ir`,
      ).toBe(true);
    }

    const persisted = await readSession(cwd);
    expect(persisted.page).toBe(0);
    expect(persisted.handles).toEqual(freshDistillation.handles);
  }, 30_000);
});
