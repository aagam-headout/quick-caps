import { describe, expect, it } from 'vitest';
import { buildRegions } from '../src/regions.js';
import {
  flattenRegions,
  scoreOf,
  renderRegions,
  distill,
  distillWithScoring,
  type FlatRegion,
} from '../src/distill.js';
import type { Region } from '../src/ir.js';
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

  it('truncates a long snippet to 120 chars, ellipsized', () => {
    const longSnippet = 'a'.repeat(150);
    const region: Region = {
      id: 999,
      role: 'generic',
      tag: 'div',
      box: { x: 0, y: 0, w: 100, h: 100 },
      textLength: longSnippet.length,
      snippet: longSnippet,
      textDensity: 0,
      actions: [],
      children: [],
      domPath: [],
    };
    const flat: FlatRegion[] = [
      { region, depth: 1, parentIds: [], score: scoreOf(region) },
    ];
    const text = renderRegions(flat, new Set([region.id]));
    expect(text).toContain(`"${'a'.repeat(119)}…"`);
    expect(text).not.toContain(longSnippet);
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

  it("carries the ActionRef's label on an action handle", () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = distill(ir, { tokenBudget: 500 });
    const flat = flattenRegions(ir.regions);
    const link = flat
      .flatMap((entry) => entry.region.actions)
      .find((action) => action.type === 'link')!;
    expect(result.handles[link.id]).toMatchObject({
      kind: 'link',
      label: link.label,
      href: link.href,
    });
  });

  it('leaves label undefined for a region handle', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const result = distill(ir, { tokenBudget: 500 });
    const mainId = ir.regions.find((r) => r.tag === 'main')!.id;
    expect(result.handles[mainId]!.label).toBeUndefined();
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

  it('marks overBudget when the starvation fallback force-selects an over-budget candidate', () => {
    // nav-heavy, page 1: page 0 (budget=1) consumes the highest-scored
    // region (`main`); by page 1 the next-highest remaining candidate is
    // the header's `nav`, whose own line plus its six action-links and its
    // `header` ancestor is unavoidably over a budget of 1 token. With
    // nothing else fitting, fillPage's fallback force-selects exactly that
    // set rather than leaving the page empty.
    const ir = collectFromDocument(
      fixtureDocument('nav-heavy'),
      collectOptions,
    );
    const result = distill(ir, { tokenBudget: 1, page: 1 });

    expect(result.overBudget).toBe(true);
    expect(result.tokenCount).toBeGreaterThan(1);

    const header = ir.regions.find((r) => r.tag === 'header')!;
    const nav = header.children.find((r) => r.tag === 'nav')!;
    const expectedIds = new Set([
      header.id,
      nav.id,
      ...nav.actions.map((a) => a.id),
    ]);
    const selectedIds = new Set(Object.keys(result.handles).map(Number));
    expect(selectedIds).toEqual(expectedIds);
  });

  it('defaults to a 500 token budget and page 0', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const withDefaults = distill(ir, {});
    const explicit = distill(ir, { tokenBudget: 500, page: 0 });
    expect(withDefaults.text).toBe(explicit.text);
  });
});

describe('distillWithScoring', () => {
  it('lets a custom score function override the default ranking', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const article = ir.regions
      .flatMap(function walk(r): typeof ir.regions {
        return [r, ...r.children.flatMap(walk)];
      })
      .find((r) => r.tag === 'article')!;

    // A score function that only ever returns 0 for every region except
    // one it recognizes by id must select nothing but that region (plus
    // its mandatory ancestors) even though the default ranking would have
    // picked something else at this budget.
    const result = distillWithScoring(
      ir,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      (region, base) => (region.id === article.id ? 1_000_000 : 0),
      { tokenBudget: 500 },
    );
    expect(result.handles[article.id]).toBeTruthy();
  });

  it('distill() is equivalent to distillWithScoring with an identity score fn', () => {
    const ir = collectFromDocument(fixtureDocument('static'), collectOptions);
    const a = distill(ir, { tokenBudget: 500 });
    const b = distillWithScoring(ir, (_region, base) => base, {
      tokenBudget: 500,
    });
    expect(a.text).toBe(b.text);
    expect(a.handles).toEqual(b.handles);
  });
});
