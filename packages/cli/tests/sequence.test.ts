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
import { stat } from 'node:fs/promises';
import { distillWithScoring, distill } from 'quickcaps-core/distill';
import { runOpen } from '../src/commands/open.js';
import { runDo } from '../src/commands/do.js';
import { runRead } from '../src/commands/read.js';
import { runNext } from '../src/commands/next.js';
import { runFind, findScore } from '../src/commands/find.js';
import { runTokens } from '../src/commands/tokens.js';
import { runCapture } from '../src/commands/capture.js';
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

const toggleHtml = readFileSync(
  join(here, 'fixtures/toggle-button.html'),
  'utf8',
);

describe('open (static) -> tokens (escalation) -> do -> capture sequence', () => {
  let toggleServer: Server;
  let toggleUrl: string;

  beforeAll(async () => {
    toggleServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(toggleHtml);
    });
    await new Promise<void>((resolve) => toggleServer.listen(0, resolve));
    const address = toggleServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    toggleUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => toggleServer.close(resolve));
  });

  it('carries valid handles across the static->playwright escalation, into do and capture (Fix 2 + Fix 1/2 integration)', async () => {
    // 1. open --static — forces StaticDriver even though a real browser
    // would also be able to render this page.
    const openedText = await runOpen({ url: toggleUrl, static: true }, cwd);
    expect(typeof openedText).toBe('string');

    let session = await readSession(cwd);
    expect(session.driver).toBe('static');
    const staticButtonHandle = Object.values(session.handles).find(
      (h) => h.kind === 'button',
    );
    expect(staticButtonHandle).toBeDefined();

    // Stamp stale paging state onto the static session — a discriminator
    // that Fix 2's pre-fix `{ ...session, url, driver, ir }` spread would
    // carry forward wholesale (since the button/region ids happen to line
    // up identically between the static and playwright collections of
    // this simple fixture, a plain id-based assertion alone wouldn't have
    // caught the regression).
    await runFind('show', cwd);
    session = await readSession(cwd);
    expect(session.query).toBe('show');

    // 2. tokens — triggers ensurePlaywrightSession's unconditional
    // escalation. Before Fix 2, this would silently carry the static
    // session's stale `query`/handles/page forward even though
    // buildRegions handed out entirely new ids for the re-collected
    // (playwright) tree.
    const tokensText = await runTokens(cwd);
    expect(() => JSON.parse(tokensText)).not.toThrow();

    session = await readSession(cwd);
    expect(session.driver).toBe('playwright');
    expect(session.page).toBe(0);
    expect(session.query).toBeUndefined();
    expect(session.renderer).toBeUndefined();

    // The post-escalation handles must match a fresh distill() of the new
    // ir exactly — proof the escalation didn't inherit stale state.
    const freshDistillation = distill(session.ir, {
      tokenBudget: 500,
      page: 0,
    });
    expect(session.handles).toEqual(freshDistillation.handles);

    const postEscalationButtonHandle = Object.values(session.handles).find(
      (h) => h.kind === 'button',
    );
    expect(postEscalationButtonHandle).toBeDefined();

    // 3. do — click the button using the POST-escalation session's real
    // handle id. Before Fix 2, this handle id could point at a
    // nonexistent or wrong action in the re-collected tree.
    const doText = await runDo(postEscalationButtonHandle!.id, cwd);
    expect(doText).toContain('Revealed by clicking the button.');

    session = await readSession(cwd);
    expect(session.page).toBe(0);
    expect(session.query).toBeUndefined();

    // 4. capture — archives the post-click page to disk.
    const captureText = await runCapture({}, cwd);
    expect(captureText).toMatch(/^Wrote .+ \(\d+ bytes\)$/);

    const writtenPath = captureText.slice(
      'Wrote '.length,
      captureText.lastIndexOf(' ('),
    );
    const stats = await stat(writtenPath);
    expect(stats.size).toBeGreaterThan(0);
  }, 30_000);
});
