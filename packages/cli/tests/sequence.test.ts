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
import { distillWithScoring } from '@quickcaps/core/distill';
import { runOpen } from '../src/commands/open.js';
import { runDo } from '../src/commands/do.js';
import { runRead } from '../src/commands/read.js';
import { runNext } from '../src/commands/next.js';
import { runFind, findScore } from '../src/commands/find.js';
import { readSession } from '../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const articleHtml = readFileSync(
  join(here, 'fixtures/static-article.html'),
  'utf8',
);
// Reused verbatim from find.test.ts's fixture: 16 generic filler sections
// plus one final section carrying a rare marker word that a tight default
// budget doesn't surface on page 0 — exactly the content shape `find`
// exists to fix, and (with enough sections) enough content to page past 0.
const pagedHtml = readFileSync(
  join(here, 'fixtures/two-sections.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;
let cwd: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/about') {
      res.end(pagedHtml);
      return;
    }
    res.end(articleHtml);
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
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-sequence-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('open -> do -> read -> next -> find sequence', () => {
  it('carries accurate session state through the full command chain', async () => {
    // 1. open
    const openedText = await runOpen({ url: baseUrl }, cwd);
    expect(openedText).toContain('A Real Article');

    let session = await readSession(cwd);
    expect(session.url).toBe(baseUrl);
    expect(session.page).toBe(0);
    expect(session.query).toBeUndefined();

    const aboutLink = Object.values(session.handles).find(
      (h) => h.kind === 'link' && h.href === '/about',
    );
    expect(aboutLink).toBeDefined();

    // 2. do — follows the link, distills the new page fresh at page 0
    const doText = await runDo(aboutLink!.id, cwd);
    expect(typeof doText).toBe('string');

    session = await readSession(cwd);
    expect(session.url).toBe(`${baseUrl}about`);
    expect(session.page).toBe(0);
    // A fresh page from `do` must not inherit a stale query from `open`.
    expect(session.query).toBeUndefined();

    const regionHandle = Object.values(session.handles).find(
      (h) => h.kind === 'region',
    );
    expect(regionHandle).toBeDefined();

    // 3. read — full text of a region, not just its distilled snippet
    const readText = await runRead(regionHandle!.id, cwd);
    expect(readText.length).toBeGreaterThan(0);

    // 4. next (no query yet) — plain paging advances the page and leaves
    // query untouched (still absent).
    const firstNextText = await runNext(cwd);
    session = await readSession(cwd);
    expect(session.page).toBe(1);
    expect(session.query).toBeUndefined();
    expect(typeof firstNextText).toBe('string');

    // 5. find — resets to page 0 under query-scoring and records the query
    // on the session so a later `next` knows to keep scoring by it.
    const findText = await runFind('zephyrquokka987', cwd);
    expect(findText).toContain('zephyrquokka987');

    session = await readSession(cwd);
    expect(session.page).toBe(0);
    expect(session.query).toBe('zephyrquokka987');

    // 6. next after find — this is the regression `find` -> `next` bug
    // (Fix 1) would have broken: before the fix, `next` always called
    // plain distill() ignoring session.query, silently paging through a
    // *different* (default-ranked) distillation than the one `find` just
    // produced. Assert the actual page-1 text matches exactly what
    // re-running distillWithScoring with the same query scorer produces —
    // not what plain distill() at page 1 would produce (which the
    // computation below also checks is different, so this fixture
    // actually would have caught the bug).
    const secondNextText = await runNext(cwd);

    const expectedQueryScoredPage1 = distillWithScoring(
      session.ir,
      (region, baseScore) => findScore(region, baseScore, 'zephyrquokka987'),
      { tokenBudget: 500, page: 1 },
    );
    expect(secondNextText).toBe(expectedQueryScoredPage1.text);

    const buggyDefaultPage1 = distillWithScoring(
      session.ir,
      (_region, baseScore) => baseScore,
      { tokenBudget: 500, page: 1 },
    );
    // The two rankings must actually diverge on this fixture, or this
    // assertion set wouldn't have caught the regression in the first
    // place.
    expect(buggyDefaultPage1.text).not.toBe(expectedQueryScoredPage1.text);

    const finalSession = await readSession(cwd);
    expect(finalSession.page).toBe(1);
    expect(finalSession.query).toBe('zephyrquokka987');
  });
});
