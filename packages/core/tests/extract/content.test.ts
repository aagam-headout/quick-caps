import { describe, expect, it } from 'vitest';
import { extractContent } from '../../src/extract/content.js';
import type { ExtractorContext } from '../../src/extract/types.js';
import type { Region } from '../../src/ir.js';
import {
  ARTICLE,
  BARE,
  BOILERPLATE_ONLY,
  EMPTY,
  MEDIA,
  META_LOCALE,
  NAV_HEAVY,
  NO_H1,
  NO_LANDMARK,
  SKIPPED_LEVEL,
  TWO_H1,
  UNDECLARED_JAPANESE,
  UNLAID_TEXT,
  UNDECLARED_SPANISH,
  bodylessHarness,
  harness,
} from './fixtures/content.js';

/** Regions flattened in document order, so a test can name one by its tag or
 * its domPath rather than by an id that shifts whenever a fixture changes. */
function flatRegions(regions: Region[]): Region[] {
  return regions.flatMap((region) => [region, ...flatRegions(region.children)]);
}

function regionByTag(ctx: ExtractorContext, tag: string): number | undefined {
  return flatRegions(ctx.ir.regions).find((region) => region.tag === tag)?.id;
}

function regionByPath(
  ctx: ExtractorContext,
  domPath: number[],
): number | undefined {
  return flatRegions(ctx.ir.regions).find(
    (region) => region.domPath.join(',') === domPath.join(','),
  )?.id;
}

describe('word count, reading time, and language', () => {
  it('counts the words on the page and derives reading time at 200 wpm', () => {
    const { ctx } = harness(ARTICLE);
    const report = extractContent(ctx);

    expect(report.wordCount).toBeGreaterThan(60);
    expect(report.readingTimeMinutes).toBeCloseTo(
      Math.round((report.wordCount / 200) * 10) / 10,
      5,
    );
  });

  it('ignores script and style text, which is not prose', () => {
    const { ctx } = harness(
      '<html lang="en"><body><main><p>Four real words here.</p>' +
        '<script>var ignored = "one two three four five";</script>' +
        '<style>.ignored { color: red; }</style></main></body></html>',
    );

    expect(extractContent(ctx).wordCount).toBe(4);
  });

  it('prefers the declared lang attribute over any guess', () => {
    expect(extractContent(harness(ARTICLE).ctx).language).toBe('en-GB');
  });

  it('falls back to a declared meta locale', () => {
    expect(extractContent(harness(META_LOCALE).ctx).language).toBe('fr-FR');
  });

  it('guesses a Latin-script language from its stopwords when nothing is declared', () => {
    expect(extractContent(harness(UNDECLARED_SPANISH).ctx).language).toBe('es');
  });

  it('guesses a non-Latin language from its script', () => {
    expect(extractContent(harness(UNDECLARED_JAPANESE).ctx).language).toBe(
      'ja',
    );
  });

  it('leaves language absent rather than guessing from nothing', () => {
    expect(extractContent(harness(EMPTY).ctx).language).toBeUndefined();
  });
});

describe('heading outline', () => {
  it('reports every heading in document order with a relocatable domPath', () => {
    const { ctx } = harness(ARTICLE);
    const report = extractContent(ctx);

    expect(report.outline.map((heading) => heading.level)).toEqual([
      1, 2, 3, 2,
    ]);
    expect(report.outline[0]?.text).toBe('The kettle review');
    expect(report.outline[0]?.domPath).toEqual([1, 0, 0]);
    expect(report.outlineViolations).toEqual([]);
  });

  it('flags a skipped level at the heading that skipped it', () => {
    const { ctx } = harness(SKIPPED_LEVEL);
    const report = extractContent(ctx);

    expect(report.outlineViolations).toHaveLength(1);
    expect(report.outlineViolations[0]?.kind).toBe('skipped-level');
    expect(report.outlineViolations[0]?.headingIndex).toBe(1);
    expect(report.outlineViolations[0]?.detail).toContain('h3');
  });

  it('flags each h1 after the first, and nothing else', () => {
    const { ctx } = harness(TWO_H1);
    const report = extractContent(ctx);

    expect(report.outlineViolations.map((v) => v.kind)).toEqual([
      'multiple-h1',
    ]);
    expect(report.outlineViolations[0]?.headingIndex).toBe(2);
  });

  it('flags a missing h1 page-wide, with no index to point at', () => {
    const { ctx } = harness(NO_H1);
    const report = extractContent(ctx);

    expect(report.outlineViolations.map((v) => v.kind)).toEqual(['missing-h1']);
    expect(report.outlineViolations[0]?.headingIndex).toBeUndefined();
  });

  it('reports no violation on a page with no headings to violate', () => {
    const { ctx } = harness(EMPTY);
    const report = extractContent(ctx);

    expect(report.outline).toEqual([]);
    expect(report.outlineViolations).toEqual([]);
  });
});

describe('media inventory', () => {
  it('inventories every image and video with its format and lazy state', () => {
    const { ctx } = harness(MEDIA);
    const { media } = extractContent(ctx);

    expect(media.items).toHaveLength(9);
    expect(media.formats).toEqual({
      webp: 1,
      png: 2,
      jpg: 2,
      avif: 1,
      gif: 1,
      mp4: 1,
    });
    expect(media.items.map((item) => item.lazy).filter(Boolean)).toHaveLength(
      3,
    );
    expect(media.lazyShare).toBeCloseTo(3 / 9, 4);
  });

  it('scores alt coverage over items that carry non-empty alt text', () => {
    const { media } = extractContent(harness(MEDIA).ctx);

    expect(media.altCoverage).toBeCloseTo(6 / 9, 4);
    expect(media.items[1]?.alt).toBe('');
    expect(media.items[2]?.alt).toBeUndefined();
  });

  it('absolutizes src against the page and keeps the srcset candidate it used', () => {
    const { media } = extractContent(harness(MEDIA).ctx);

    expect(media.items[0]?.src).toBe('https://example.com/img/hero.webp');
    expect(media.items[5]?.src).toBe('https://example.com/img/small.jpg');
  });

  it('reports displayed size from the region box, not from an attribute', () => {
    const { media } = extractContent(harness(MEDIA).ctx);

    expect(media.items[0]?.displayed).toEqual({ w: 1200, h: 600 });
  });

  it('warns naming displayed size when an image has no region box', () => {
    const { ctx, warnings } = harness(MEDIA, { maxRegionDepth: 1 });
    const { media } = extractContent(ctx);

    expect(media.items[0]?.displayed).toBeUndefined();
    expect(warnings.map((w) => w.reason).join(' ')).toContain('displayed size');
  });

  it('returns a zero-filled inventory, not NaN, for a page with no media', () => {
    const { media } = extractContent(harness(EMPTY).ctx);

    expect(media).toEqual({
      items: [],
      altCoverage: 0,
      formats: {},
      lazyShare: 0,
    });
  });
});

describe('main versus boilerplate split', () => {
  it('takes the declared landmarks and counts only main words', () => {
    const { ctx } = harness(ARTICLE);
    const report = extractContent(ctx);

    expect(report.split.mainRegionIds).toEqual([regionByTag(ctx, 'main')]);
    expect(report.split.boilerplateRegionIds).toEqual([
      regionByTag(ctx, 'header'),
      regionByTag(ctx, 'footer'),
    ]);
    expect(report.split.mainWordCount).toBeGreaterThan(0);
    expect(report.split.mainWordCount).toBeLessThan(report.wordCount);
    expect(report.split.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('trusts a declared main even when boilerplate outweighs it', () => {
    const { ctx } = harness(NAV_HEAVY);
    const report = extractContent(ctx);

    expect(report.split.mainRegionIds).toEqual([regionByTag(ctx, 'main')]);
    expect(report.split.boilerplateRegionIds).toHaveLength(2);
    expect(report.split.confidence).toBeGreaterThanOrEqual(0.75);
    expect(report.split.confidence).toBeLessThan(0.95);
  });

  it('infers main from density and geometry when no landmark declares it, at lower confidence', () => {
    const { ctx } = harness(NO_LANDMARK);
    const report = extractContent(ctx);

    // body.children[1] is the shell, and its first child is the content
    // block the inference has to drill down to.
    expect(report.split.mainRegionIds).toEqual([regionByPath(ctx, [1, 0])]);
    expect(report.split.boilerplateRegionIds).toEqual([
      regionByTag(ctx, 'nav'),
    ]);
    expect(report.split.confidence).toBeGreaterThan(0);
    expect(report.split.confidence).toBeLessThanOrEqual(0.6);
    expect(report.split.mainWordCount).toBeGreaterThan(20);
  });

  it('infers main from text alone on a static session, where every box is zero', () => {
    // The regression that matters: a static collection has no layout engine,
    // so geometry cannot be a precondition for inferring anything.
    const { ctx, warnings } = harness(BARE, { geometry: 'none' });
    expect(
      ctx.ir.regions.every(
        (region) => region.box.w === 0 && region.textDensity === 0,
      ),
    ).toBe(true);

    const report = extractContent(ctx);

    expect(report.split.mainRegionIds).toEqual([regionByPath(ctx, [0])]);
    expect(report.split.mainWordCount).toBe(4);
    expect(report.split.confidence).toBeCloseTo(0.6, 5);
    expect(warnings).toEqual([]);
  });

  it('picks the same inferred main with or without geometry', () => {
    const measured = harness(NO_LANDMARK).ctx;
    const unmeasured = harness(NO_LANDMARK, { geometry: 'none' }).ctx;

    expect(extractContent(unmeasured).split.mainRegionIds).toEqual(
      extractContent(measured).split.mainRegionIds,
    );
  });

  it('still refuses a region geometry says is not laid out', () => {
    const { ctx, warnings } = harness(UNLAID_TEXT);
    const report = extractContent(ctx);

    expect(report.split.mainRegionIds).toEqual([]);
    expect(report.split.confidence).toBeCloseTo(0.1, 5);
    expect(warnings.map((w) => w.detail).join(' ')).toContain('not laid out');
    expect(warnings.map((w) => w.detail).join(' ')).not.toContain(
      'boilerplate landmark',
    );
  });

  it('warns rather than inventing a main region when the page is all boilerplate', () => {
    const { ctx, warnings } = harness(BOILERPLATE_ONLY);
    const report = extractContent(ctx);

    expect(report.split.mainRegionIds).toEqual([]);
    expect(report.split.boilerplateRegionIds).toHaveLength(2);
    expect(report.split.mainWordCount).toBe(0);
    expect(report.split.confidence).toBeLessThanOrEqual(0.1);
    expect(warnings.map((w) => w.reason).join(' ')).toContain('main');
    // The two dead ends read differently, because they are different pages:
    // this one has landmarks and they are all boilerplate.
    expect(warnings.map((w) => w.detail).join(' ')).toContain(
      'boilerplate landmark',
    );
  });

  it('reports zero confidence, and no warning, on a page with no text at all', () => {
    const { ctx, warnings } = harness(EMPTY);
    const report = extractContent(ctx);

    expect(report.split).toEqual({
      mainRegionIds: [],
      boilerplateRegionIds: [],
      mainWordCount: 0,
      confidence: 0,
    });
    expect(warnings).toEqual([]);
  });
});

describe('degradation', () => {
  it('needs no computed styles, and says nothing about them', () => {
    const { ctx, warnings } = harness(ARTICLE);
    expect(ctx.computedStyle).toBeUndefined();

    extractContent(ctx);

    expect(warnings.map((w) => w.reason).join(' ')).not.toContain('style');
  });

  it('degrades to an empty report with a warning when the document has no body', () => {
    const { ctx, warnings } = bodylessHarness();
    const report = extractContent(ctx);

    expect(report.wordCount).toBe(0);
    expect(report.outline).toEqual([]);
    expect(report.split.mainRegionIds).toEqual([]);
    expect(warnings.map((w) => w.reason).join(' ')).toContain('body');
  });
});
