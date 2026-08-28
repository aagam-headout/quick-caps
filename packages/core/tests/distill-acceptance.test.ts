import { describe, expect, it } from 'vitest';
import { distill, flattenRegions } from '../src/distill.js';
import { collectFromDocument } from '../src/collect.js';
import { defaultSettings } from '../src/settings.js';
import { fixtureDocument, type FixtureName } from './fake-driver.js';

const collectOptions = {
  settings: defaultSettings,
  pageUrl: 'https://example.com/page',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  documentSize: { width: 1280, height: 2400 },
  devicePixelRatio: 2,
  now: () => new Date('2026-08-27T10:00:00.000Z'),
};

const BUDGET = 500;

describe('distill acceptance corpus', () => {
  const cases: Array<{
    name: FixtureName;
    mustContain: string[];
  }> = [
    // article-heavy: the paragraph text and the "Next page" link must survive.
    {
      name: 'static',
      mustContain: ['First paragraph of body text', 'Next page'],
    },
    // SPA-shell: the client-rendered heading and its action must survive.
    { name: 'spa', mustContain: ['Rendered by client JS', 'Load more'] },
    // nav-heavy: the primary (header) nav's links must survive.
    { name: 'nav-heavy', mustContain: ['Home', 'Pricing'] },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: stays within budget and keeps the useful content`, () => {
      const ir = collectFromDocument(
        fixtureDocument(testCase.name),
        collectOptions,
      );
      const result = distill(ir, { tokenBudget: BUDGET });

      expect(result.tokenCount).toBeLessThanOrEqual(BUDGET);
      for (const phrase of testCase.mustContain) {
        expect(result.text).toContain(phrase);
      }
    });
  }

  it('paging is exhaustive and non-repeating across every fixture', () => {
    for (const testCase of cases) {
      const ir = collectFromDocument(
        fixtureDocument(testCase.name),
        collectOptions,
      );
      const allIds = new Set(
        flattenRegions(ir.regions).map((entry) => entry.region.id),
      );

      const seen: number[] = [];
      let page = 0;
      let hasMore = true;
      while (hasMore) {
        if (page > 50)
          throw new Error(`${testCase.name}: paging did not terminate`);
        // A small budget forces multiple pages even on these small fixtures.
        const result = distill(ir, { tokenBudget: 25, page });
        seen.push(
          ...Object.keys(result.handles)
            .map(Number)
            .filter((id) => allIds.has(id)),
        );
        hasMore = result.hasMore;
        page += 1;
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect(new Set(seen)).toEqual(allIds);
    }
  });
});
