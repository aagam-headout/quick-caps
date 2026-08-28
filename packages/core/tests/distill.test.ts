import { describe, expect, it } from 'vitest';
import { buildRegions } from '../src/regions.js';
import {
  flattenRegions,
  scoreOf,
  renderRegions,
  distill,
} from '../src/distill.js';
import { fixtureDocument } from './fake-driver.js';
import { collectFromDocument } from '../src/collect.js';
import { defaultSettings } from '../src/settings.js';

const regionOptions = { maxDepth: 12 };

describe('scoreOf', () => {
  it('scores a landmark role higher than a generic one', () => {
    const article = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    ).find((e) => e.region.tag === 'article')!.region;
    const genericRole = { ...article, role: 'generic' };
    expect(scoreOf(article)).toBeGreaterThan(scoreOf(genericRole));
  });

  it('scores a region with actions higher than an identical one without', () => {
    const regions = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    const article = regions.find((e) => e.region.tag === 'article')!.region;
    const noActions = { ...article, actions: [] };
    expect(scoreOf(article)).toBeGreaterThan(scoreOf(noActions));
  });
});

describe('flattenRegions', () => {
  it('walks in document order and records depth', () => {
    const flat = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    expect(flat[0]!.depth).toBe(1);
    const article = flat.find((e) => e.region.tag === 'article')!;
    expect(article.depth).toBeGreaterThan(1);
  });

  it("records each entry's full ancestor id chain", () => {
    const flat = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    const main = flat.find((e) => e.region.tag === 'main')!;
    const article = flat.find((e) => e.region.tag === 'article')!;
    expect(article.parentIds).toContain(main.region.id);
  });
});

describe('renderRegions', () => {
  it('renders a selected region with its snippet and indented by depth', () => {
    const flat = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    const article = flat.find((e) => e.region.tag === 'article')!;
    const text = renderRegions(flat, new Set([article.region.id]));
    expect(text).toContain(`[${article.region.id}] ${article.region.role}`);
  });

  it("renders an action inline on its owning region's line", () => {
    const flat = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    const article = flat.find((e) => e.region.tag === 'article')!;
    const link = article.region.actions.find((a) => a.type === 'link')!;
    const text = renderRegions(flat, new Set([article.region.id]));
    expect(text).toContain(`[${link.id}]${link.label}`);
  });

  it('omits the quoted snippet clause for a region with no own text', () => {
    const flat = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    const main = flat.find((e) => e.region.tag === 'main')!;
    const text = renderRegions(flat, new Set([main.region.id]));
    expect(text).not.toContain('"');
  });

  it('only renders ids present in the given set', () => {
    const flat = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    );
    const text = renderRegions(flat, new Set());
    expect(text).toBe('');
  });
});

const collectOptions = {
  settings: defaultSettings,
  pageUrl: 'https://example.com/page',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  documentSize: { width: 1280, height: 2400 },
  devicePixelRatio: 2,
  now: () => new Date('2026-08-27T10:00:00.000Z'),
};

describe('distill', () => {
  it('stays within the token budget', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = distill(ir, { tokenBudget: 500 });
    expect(result.tokenCount).toBeLessThanOrEqual(500);
  });

  it('a tiny budget still selects the single highest-scored region', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = distill(ir, { tokenBudget: 8 });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.tokenCount).toBeLessThanOrEqual(8);
  });

  it("pulls in a selected region's ancestors for free", () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = distill(ir, { tokenBudget: 500 });
    const mainId = ir.regions.find((r) => r.tag === 'main')!.id;
    expect(result.handles[mainId]).toBeTruthy();
  });

  it('handles map covers every id present in the rendered text', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = distill(ir, { tokenBudget: 500 });
    const idsInText = [...result.text.matchAll(/\[(\d+)\]/g)].map((m) =>
      Number(m[1]),
    );
    for (const id of idsInText) expect(result.handles[id]).toBeTruthy();
  });

  it('paginates deterministically with no id repeated across pages', () => {
    const ir = collectFromDocument(
      fixtureDocument('nav-heavy'),
      collectOptions,
    );
    const budget = 30;
    const seenPerPage: number[][] = [];
    let page = 0;
    let hasMore = true;
    while (hasMore && page < 20) {
      const result = distill(ir, { tokenBudget: budget, page });
      seenPerPage.push(Object.keys(result.handles).map(Number));
      hasMore = result.hasMore;
      page += 1;
    }
    const all = seenPerPage.flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('defaults to a 500 token budget and page 0', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const withDefaults = distill(ir, {});
    const explicit = distill(ir, { tokenBudget: 500, page: 0 });
    expect(withDefaults.text).toBe(explicit.text);
  });
});
