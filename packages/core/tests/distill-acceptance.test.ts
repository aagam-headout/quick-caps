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

const DEFAULT_SPEC_BUDGET = 500;

// A budget that actually constrains at least one fixture: at 500 (the spec's
// default), every fixture in this corpus renders in full with `hasMore:
// false` — nothing is ever discarded, so a scoring regression that discards
// the useful content while staying under budget could never fail these
// assertions. 70 was chosen empirically (values 40-200 probed) as the
// smallest budget where `spa` and `nav-heavy` both still have `hasMore:
// true` — real selection pressure — while every fixture's required phrases
// still survive.
const BINDING_BUDGET = 70;

describe('distill acceptance corpus', () => {
  const cases: Array<{
    name: FixtureName;
    mustContain: (string | RegExp)[];
  }> = [
    // article-heavy: the paragraph text and the "Next page" link must survive.
    {
      name: 'static',
      mustContain: ['First paragraph of body text', 'Next page'],
    },
    // SPA-shell: the client-rendered heading and its action must survive.
    { name: 'spa', mustContain: ['Rendered by client JS', 'Load more'] },
    // nav-heavy: the primary (header) nav's *action handles* must survive —
    // checked in handle form (`[<n>]Home`), not just the bare word, since
    // the fixture's individual link regions also carry that text as their
    // own snippet (rendered independently of the nav action), which would
    // satisfy a bare-substring check even if the nav region and its actions
    // were completely dropped from distillation.
    { name: 'nav-heavy', mustContain: [/\[\d+\]Home\b/, /\[\d+\]Pricing\b/] },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: stays within the spec-default budget and keeps the useful content`, () => {
      const ir = collectFromDocument(
        fixtureDocument(testCase.name),
        collectOptions,
      );
      const result = distill(ir, { tokenBudget: DEFAULT_SPEC_BUDGET });

      expect(result.tokenCount).toBeLessThanOrEqual(DEFAULT_SPEC_BUDGET);
      for (const phrase of testCase.mustContain) {
        expect(result.text).toMatch(phrase);
      }
    });

    it(`${testCase.name}: keeps the useful content under a binding budget that forces selection pressure`, () => {
      const ir = collectFromDocument(
        fixtureDocument(testCase.name),
        collectOptions,
      );
      const result = distill(ir, { tokenBudget: BINDING_BUDGET });

      expect(result.tokenCount).toBeLessThanOrEqual(BINDING_BUDGET);
      for (const phrase of testCase.mustContain) {
        expect(result.text).toMatch(phrase);
      }
    });
  }

  it('the binding budget actually constrains at least one fixture (sanity check on the corpus itself)', () => {
    const constrained = cases.some((testCase) => {
      const ir = collectFromDocument(
        fixtureDocument(testCase.name),
        collectOptions,
      );
      return distill(ir, { tokenBudget: BINDING_BUDGET }).hasMore;
    });
    expect(constrained).toBe(true);
  });

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
