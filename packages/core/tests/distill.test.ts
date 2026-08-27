import { describe, expect, it } from 'vitest';
import { buildRegions } from '../src/regions.js';
import { flattenRegions, scoreOf } from '../src/distill.js';
import { fixtureDocument } from './fake-driver.js';

const regionOptions = { maxDepth: 12 };

describe('scoreOf', () => {
  it('scores a landmark role higher than a generic one', () => {
    const [nav] = buildRegions(fixtureDocument('spa'), regionOptions);
    const article = flattenRegions(
      buildRegions(fixtureDocument('static'), regionOptions),
    ).find((e) => e.region.tag === 'article')!.region;
    const genericDiv = { ...article, role: 'generic', actions: [] };
    expect(scoreOf(article)).toBeGreaterThan(scoreOf(genericDiv));
    expect(nav).toBeTruthy(); // sanity: fixture actually has content
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
    const flat = flattenRegions(buildRegions(fixtureDocument('static'), regionOptions));
    expect(flat[0]!.depth).toBe(1);
    const article = flat.find((e) => e.region.tag === 'article')!;
    expect(article.depth).toBeGreaterThan(1);
  });

  it('records each entry\'s full ancestor id chain', () => {
    const flat = flattenRegions(buildRegions(fixtureDocument('static'), regionOptions));
    const main = flat.find((e) => e.region.tag === 'main')!;
    const article = flat.find((e) => e.region.tag === 'article')!;
    expect(article.parentIds).toContain(main.region.id);
  });
});
