import { describe, expect, it } from 'vitest';
import { buildRegions } from '../src/regions.js';
import { fixtureDocument } from './fake-driver.js';
import type { Region } from '../src/ir.js';

const options = { maxDepth: 12 };

function flatten(regions: Region[]): Region[] {
  return regions.flatMap((region) => [region, ...flatten(region.children)]);
}

describe('buildRegions', () => {
  it('assigns stable sequential ids in document order', () => {
    const ids = flatten(buildRegions(fixtureDocument('static'), options)).map(
      (r) => r.id,
    );
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('infers landmark roles from tag names', () => {
    const roles = new Set(
      flatten(buildRegions(fixtureDocument('static'), options)).map(
        (r) => r.role,
      ),
    );
    expect(roles).toContain('banner');
    expect(roles).toContain('main');
    expect(roles).toContain('article');
  });

  it('prefers an explicit role attribute over the inferred one', () => {
    const doc = fixtureDocument('static');
    doc.querySelector('main')!.setAttribute('role', 'search');
    const regions = buildRegions(doc, options);
    expect(regions.find((r) => r.tag === 'main')!.role).toBe('search');
  });

  it('collapses a generic single-child wrapper but keeps a landmark', () => {
    const doc = fixtureDocument('static');
    const article = doc.querySelector('article')!;
    const wrapper = doc.createElement('div');
    article.replaceWith(wrapper);
    wrapper.append(article);

    const tags = flatten(buildRegions(doc, options)).map((r) => r.tag);
    // The generic div wrapping <article> is collapsed away...
    expect(tags.filter((t) => t === 'div')).toHaveLength(0);
    // ...while <header>, a single-child landmark, survives.
    expect(tags).toContain('header');
    expect(tags).toContain('article');
  });

  it('keeps siblings that are not wrappers', () => {
    const tags = flatten(buildRegions(fixtureDocument('spa'), options)).map(
      (r) => r.tag,
    );
    expect(tags).toContain('nav');
    expect(tags).toContain('section');
  });

  it('numbers links and buttons as actions', () => {
    const actions = flatten(
      buildRegions(fixtureDocument('spa'), options),
    ).flatMap((r) => r.actions);
    expect(actions.map((a) => a.type)).toContain('link');
    expect(actions.map((a) => a.type)).toContain('button');
    expect(actions.find((a) => a.type === 'button')!.label).toBe('Load more');
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it('computes text density as text length per 1000 square pixels', () => {
    const withText = flatten(
      buildRegions(fixtureDocument('static'), options),
    ).filter((r) => r.textLength > 0);
    expect(withText.length).toBeGreaterThan(0);
    for (const region of withText)
      expect(region.textDensity).toBeGreaterThan(0);
  });

  it('reports zero density rather than Infinity for a zero-area region', () => {
    const doc = fixtureDocument('static');
    Object.defineProperty(doc.querySelector('h1')!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    });
    const h1 = flatten(buildRegions(doc, options)).find((r) => r.tag === 'h1');
    expect(h1?.textDensity).toBe(0);
  });

  it('stops at maxDepth instead of recursing without bound', () => {
    const doc = fixtureDocument('static');
    let node: Element = doc.body;
    for (let i = 0; i < 50; i++) {
      const div = doc.createElement('div');
      div.textContent = 'x';
      div.append(doc.createElement('span'));
      node.append(div);
      node = div;
    }
    const depth = (regions: Region[]): number =>
      regions.length === 0
        ? 0
        : 1 + Math.max(...regions.map((r) => depth(r.children)));
    expect(depth(buildRegions(doc, { maxDepth: 5 }))).toBeLessThanOrEqual(5);
  });

  it('skips script, style, and head content entirely', () => {
    const tags = flatten(buildRegions(fixtureDocument('static'), options)).map(
      (r) => r.tag,
    );
    expect(tags).not.toContain('script');
    expect(tags).not.toContain('style');
    expect(tags).not.toContain('head');
  });

  it('captures own text as a snippet, not descendant text', () => {
    const regions = flatten(buildRegions(fixtureDocument('static'), options));
    const paragraph = regions.find((r) => r.tag === 'p')!;
    expect(paragraph.snippet).toBe(
      'First paragraph of body text used for density scoring.',
    );
    const article = regions.find((r) => r.tag === 'article')!;
    expect(article.snippet).toBe('');
  });

  it('assigns region and action ids from one shared, collision-free space', () => {
    const regions = flatten(buildRegions(fixtureDocument('static'), options));
    const regionIds = regions.map((r) => r.id);
    const actionIds = regions.flatMap((r) => r.actions.map((a) => a.id));
    const all = [...regionIds, ...actionIds];
    expect(new Set(all).size).toBe(all.length);
  });
});
