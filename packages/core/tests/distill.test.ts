import { describe, expect, it } from 'vitest';
import { buildRegions } from '../src/regions.js';
import { flattenRegions, scoreOf, renderRegions } from '../src/distill.js';
import { fixtureDocument } from './fake-driver.js';

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

describe('renderRegions', () => {
  it('renders a selected region with its snippet and indented by depth', () => {
    const flat = flattenRegions(buildRegions(fixtureDocument('static'), regionOptions));
    const article = flat.find((e) => e.region.tag === 'article')!;
    const text = renderRegions(flat, new Set([article.region.id]));
    expect(text).toContain(`[${article.region.id}] ${article.region.role}`);
  });

  it('renders an action inline on its owning region\'s line', () => {
    const flat = flattenRegions(buildRegions(fixtureDocument('static'), regionOptions));
    const article = flat.find((e) => e.region.tag === 'article')!;
    const link = article.region.actions.find((a) => a.type === 'link')!;
    const text = renderRegions(flat, new Set([article.region.id]));
    expect(text).toContain(`[${link.id}]${link.label}`);
  });

  it('omits the quoted snippet clause for a region with no own text', () => {
    const flat = flattenRegions(buildRegions(fixtureDocument('static'), regionOptions));
    const main = flat.find((e) => e.region.tag === 'main')!;
    const text = renderRegions(flat, new Set([main.region.id]));
    expect(text).not.toContain('"');
  });

  it('only renders ids present in the given set', () => {
    const flat = flattenRegions(buildRegions(fixtureDocument('static'), regionOptions));
    const text = renderRegions(flat, new Set());
    expect(text).toBe('');
  });
});
