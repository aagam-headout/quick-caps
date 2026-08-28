import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyTally, type PageIR, type Region } from 'quickcaps-core';
import { flattenRegions } from 'quickcaps-core/distill';
import { looksLikeEmptyShell, openUrl } from '../src/open.js';
import { collectViaStatic } from '../src/collect-via-static.js';

/** Minimal Region — only the fields looksLikeEmptyShell's traversal reads
 * (textLength, children) are given real values; the rest are placeholders. */
function makeRegion(
  id: number,
  textLength: number,
  children: Region[] = [],
): Region {
  return {
    id,
    role: 'generic',
    tag: 'div',
    box: { x: 0, y: 0, w: 10, h: 10 },
    textLength,
    snippet: '',
    textDensity: 0,
    actions: [],
    children,
    domPath: [id],
  };
}

function makeIr(regions: Region[]): PageIR {
  return {
    metadata: {
      url: 'https://example.com/',
      title: 'Test',
      capturedAt: '2026-08-27T10:00:00.000Z',
      viewport: { width: 1280, height: 800 },
      documentSize: { width: 1280, height: 2400 },
      devicePixelRatio: 1,
      userAgent: 'test',
      charset: 'utf-8',
      meta: {},
    },
    html: '<html><head></head><body></body></html>',
    regions,
    styles: [],
    assets: [],
    styleTally: emptyTally(),
    warnings: [],
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const article = readFileSync(
  join(here, 'fixtures/static-article.html'),
  'utf8',
);
const shell = readFileSync(join(here, 'fixtures/spa-shell.html'), 'utf8');

let server: Server;
let articleUrl: string;
let shellUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/shell') {
      res.end(shell);
    } else {
      res.end(article);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  articleUrl = `http://127.0.0.1:${address.port}/`;
  shellUrl = `http://127.0.0.1:${address.port}/shell`;
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('looksLikeEmptyShell', () => {
  it('is false for a real article', async () => {
    const ir = await collectViaStatic(articleUrl);
    expect(looksLikeEmptyShell(ir)).toBe(false);
  });

  it('is true for a near-empty SPA shell', async () => {
    const ir = await collectViaStatic(shellUrl);
    expect(looksLikeEmptyShell(ir)).toBe(true);
  });

  it('sums top-level regions only, not every nesting level (regression: Region.textLength is cumulative)', () => {
    // A single real 70-char run of text, nested 3 levels deep. Because
    // Region.textLength is cumulative (own + all descendants'), the
    // grandchild, child, and root all carry textLength: 70 for this same
    // text. Summing across every flattened entry — the bug — would total
    // 210 (three ancestor levels double/triple-counting the same 70
    // chars), clearing EMPTY_SHELL_TEXT_THRESHOLD and wrongly reporting
    // this as NOT a shell. The true, unique amount of text on the page is
    // 70, well under threshold — this genuinely is shell-shaped.
    const grandchild = makeRegion(3, 70);
    const child = makeRegion(2, 70, [grandchild]);
    const root = makeRegion(1, 70, [child]);
    const ir = makeIr([root]);

    const flat = flattenRegions(ir.regions);
    const buggySumAcrossEveryLevel = flat.reduce(
      (sum, entry) => sum + entry.region.textLength,
      0,
    );
    expect(buggySumAcrossEveryLevel).toBeGreaterThanOrEqual(200);

    expect(looksLikeEmptyShell(ir)).toBe(true);
  });

  it('does not misclassify a deeply nested but genuinely substantial page as an empty shell', () => {
    // Top-level region's own cumulative textLength (250) alone already
    // clears the threshold — real, non-shell content nested a few levels
    // deep must not be flagged.
    const grandchild = makeRegion(3, 100);
    const child = makeRegion(2, 150, [grandchild]);
    const root = makeRegion(1, 250, [child]);
    const ir = makeIr([root]);

    expect(looksLikeEmptyShell(ir)).toBe(false);
  });
});

describe('openUrl', () => {
  it('stays on StaticDriver for a real article — no escalation', async () => {
    const result = await openUrl(articleUrl);
    expect(result.driver).toBe('static');
  }, 30_000);

  it('escalates to PlaywrightDriver for an empty shell', async () => {
    const result = await openUrl(shellUrl);
    expect(result.driver).toBe('playwright');
  }, 30_000);

  it('--static suppresses escalation even for an empty shell', async () => {
    const result = await openUrl(shellUrl, { static: true });
    expect(result.driver).toBe('static');
  }, 30_000);
});
