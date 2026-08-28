import { describe, expect, it } from 'vitest';
import { collectFromDocument } from '../src/collect.js';
import { defaultSettings } from '../src/settings.js';
import { renderLayout } from '../src/layout.js';
import { flattenRegions } from '../src/distill.js';
import { fixtureDocument } from './fake-driver.js';

const collectOptions = {
  settings: defaultSettings,
  pageUrl: 'https://example.com/page',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  documentSize: { width: 1280, height: 2400 },
  devicePixelRatio: 2,
  now: () => new Date('2026-08-27T10:00:00.000Z'),
};

describe('renderLayout', () => {
  it('renders every region, in document order, with role/tag/box', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = renderLayout(ir, { tokenBudget: 500, page: 0 });
    const flat = flattenRegions(ir.regions);
    const article = flat.find((e) => e.region.tag === 'article')!.region;
    expect(result.text).toContain(
      `[${article.id}] article (role=${article.role}, ${article.box.w}x${article.box.h} @ ${article.box.x},${article.box.y})`,
    );
  });

  it('never reorders regions by score — output order matches flattenRegions order', () => {
    const ir = collectFromDocument(
      fixtureDocument('nav-heavy'),
      collectOptions,
    );
    const result = renderLayout(ir, { tokenBudget: 500, page: 0 });
    const idsInText = [...result.text.matchAll(/\[(\d+)\]/g)].map((m) =>
      Number(m[1]),
    );
    const docOrderIds = flattenRegions(ir.regions).map((e) => e.region.id);
    const expectedPrefix = docOrderIds.slice(0, idsInText.length);
    expect(idsInText).toEqual(expectedPrefix);
  });

  it('pages exhaustively with no id repeated across pages', () => {
    const ir = collectFromDocument(
      fixtureDocument('nav-heavy'),
      collectOptions,
    );
    const allIds = flattenRegions(ir.regions).map((e) => e.region.id);
    const seen: number[] = [];
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      if (page > 50) throw new Error('paging did not terminate');
      const result = renderLayout(ir, { tokenBudget: 30, page });
      seen.push(...result.regionIds);
      hasMore = result.hasMore;
      page += 1;
    }
    expect(seen).toEqual(allIds);
  });

  it('defaults to a 500 token budget and page 0', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const withDefaults = renderLayout(ir, {});
    const explicit = renderLayout(ir, { tokenBudget: 500, page: 0 });
    expect(withDefaults.text).toBe(explicit.text);
  });
});
