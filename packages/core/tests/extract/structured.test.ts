import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { emptyTally } from '../../src/collect.js';
import { extractStructured } from '../../src/extract/structured.js';
import type { PageIR, Warning } from '../../src/ir.js';
import type {
  ExtractorContext,
  StructuredReport,
} from '../../src/extract/types.js';
import {
  bareHtml,
  jsonLdOddBlocksHtml,
  misspelledOgHtml,
  richProductHtml,
  twitterOnlyHtml,
} from './fixtures/structured.js';

const PAGE_URL = 'https://shop.example.com/skillet';

/**
 * A hand-built IR rather than a `collectFromDocument` pass: this extractor
 * reads only the recorded page url out of the IR, and going through the
 * collector would tie these assertions to region layout that linkedom cannot
 * produce.
 */
function pageIr(url: string): PageIR {
  return {
    metadata: {
      url,
      title: '',
      capturedAt: '2026-08-31T10:00:00.000Z',
      viewport: { width: 1280, height: 800 },
      documentSize: { width: 1280, height: 2400 },
      devicePixelRatio: 1,
      userAgent: 'test-agent',
      charset: 'utf-8',
      meta: {},
    },
    html: '',
    regions: [],
    styles: [],
    assets: [],
    styleTally: emptyTally(),
    warnings: [],
  };
}

function run(
  html: string,
  url = PAGE_URL,
): { report: StructuredReport; warnings: Omit<Warning, 'phase'>[] } {
  const warnings: Omit<Warning, 'phase'>[] = [];
  const ctx: ExtractorContext = {
    doc: parseHTML(html).document as unknown as Document,
    ir: pageIr(url),
    warn: (warning) => warnings.push(warning),
  };
  return { report: extractStructured(ctx), warnings };
}

describe('extractStructured / json-ld', () => {
  it('reads every block on the page, in document order', () => {
    const { report } = run(richProductHtml);

    expect(report.jsonLd.map((node) => node['@type'])).toEqual([
      'Product',
      'Organization',
      'WebPage',
      'BreadcrumbList',
    ]);
  });

  it('flattens a @graph, including a @graph nested inside one', () => {
    const { report } = run(richProductHtml);

    expect(report.jsonLd).toContainEqual({
      '@type': 'WebPage',
      name: 'Skillet page',
    });
    expect(report.jsonLd.some((node) => node['@graph'] !== undefined)).toBe(
      false,
    );
  });

  it('keeps a @graph wrapper that declared something of its own', () => {
    const { report } = run(jsonLdOddBlocksHtml);

    expect(report.jsonLd).toEqual([
      {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        url: 'https://example.com',
      },
      { '@type': 'SearchAction' },
    ]);
  });

  it('warns on a malformed block without losing the blocks around it', () => {
    const { report, warnings } = run(richProductHtml);

    expect(report.jsonLd).toHaveLength(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toContain('malformed');
    expect(warnings[0]?.detail).toContain('block 3');
  });

  it('warns on a block that parses to something other than a node', () => {
    const { warnings } = run(jsonLdOddBlocksHtml);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).toContain('string');
  });

  it('ignores an empty block and a script of another type', () => {
    const { report, warnings } = run(jsonLdOddBlocksHtml);

    expect(report.jsonLd).toHaveLength(2);
    expect(warnings.map((w) => w.detail).join(' ')).not.toContain('block 2');
  });
});

describe('extractStructured / microdata', () => {
  it('reports the top-level item with its type and id', () => {
    const { report } = run(richProductHtml);

    expect(report.microdata).toHaveLength(1);
    expect(report.microdata[0]?.types).toEqual(['https://schema.org/Product']);
    expect(report.microdata[0]?.id).toBe('#skillet');
  });

  it('nests a scoped itemprop as an item instead of as its text', () => {
    const { report } = run(richProductHtml);
    const offers = report.microdata[0]?.properties.offers?.[0];

    expect(offers).toEqual({
      types: ['https://schema.org/Offer'],
      properties: {
        price: ['39.00'],
        priceCurrency: ['USD'],
        priceValidUntil: ['2026-12-31'],
      },
    });
  });

  it('reads a value from the attribute its element carries it in', () => {
    const { report } = run(richProductHtml);
    const props = report.microdata[0]?.properties;

    expect(props?.name).toEqual(['12-inch Cast-Iron Skillet']);
    expect(props?.sku).toEqual(['SK-12']);
    expect(props?.url).toEqual(['https://shop.example.com/skillet']);
  });

  it('keeps repeated itemprops as several values', () => {
    const { report } = run(richProductHtml);

    expect(report.microdata[0]?.properties.category).toEqual([
      'Cookware',
      'Cast iron',
    ]);
  });
});

describe('extractStructured / rdfa', () => {
  it('reports a typeof subject with its vocab and properties', () => {
    const { report } = run(richProductHtml);
    const org = report.rdfa[0];

    expect(org?.vocab).toBe('https://schema.org/');
    expect(org?.types).toEqual(['Organization']);
    expect(org?.properties.name).toEqual(['Pans Co']);
    expect(org?.properties.url).toEqual(['https://shop.example.com/about']);
  });

  it('emits a nested typeof as its own subject, referenced by resource', () => {
    const { report } = run(richProductHtml);

    expect(report.rdfa).toHaveLength(2);
    expect(report.rdfa[0]?.properties.address).toEqual([
      'https://shop.example.com/skillet#hq',
    ]);
    expect(report.rdfa[1]).toEqual({
      vocab: 'https://schema.org/',
      types: ['PostalAddress'],
      properties: { addressLocality: ['Portland'] },
    });
  });

  it('does not turn Open Graph meta into an RDFa subject', () => {
    // og:* lives on `property`, so a pass that collected properties without a
    // typeof would report a phantom subject on nearly every page on the web.
    const { report } = run(richProductHtml);

    expect(report.rdfa.map((item) => item.types)).not.toContainEqual([]);
    expect(run(misspelledOgHtml).report.rdfa).toEqual([]);
  });
});

describe('extractStructured / social preview', () => {
  it('prefers Open Graph over the Twitter card', () => {
    const { report } = run(richProductHtml);

    expect(report.social).toEqual({
      title: 'Cast-Iron Skillet, 12 inch',
      description: 'Pre-seasoned, oven-safe.',
      image: 'https://shop.example.com/img/skillet.jpg',
      type: 'product',
      siteName: 'Pans Co',
    });
  });

  it('leaves a JSON-LD name that disagrees with og:title alone', () => {
    const { report } = run(richProductHtml);

    expect(report.social.title).toBe('Cast-Iron Skillet, 12 inch');
    expect(report.jsonLd[0]?.name).toBe('12-inch Cast-Iron Skillet');
  });

  it('falls back to the Twitter card and resolves against <base>', () => {
    const { report } = run(twitterOnlyHtml);

    expect(report.social).toEqual({
      title: 'A Post',
      description: 'Short one.',
      image: 'https://cdn.example.com/site/thumb.png',
      type: 'summary',
      siteName: '@example',
    });
  });

  it('honours Open Graph published under name=', () => {
    const { report } = run(misspelledOgHtml);

    expect(report.social.title).toBe('Under name=');
    expect(report.social.image).toBe('https://example.com/a.png');
  });
});

describe('extractStructured / seo', () => {
  it('resolves the canonical against the page url', () => {
    const { report } = run(richProductHtml);

    expect(report.seo.canonical).toBe('https://shop.example.com/skillet');
  });

  it('lists hreflang alternates', () => {
    const { report } = run(richProductHtml);

    expect(report.seo.alternates).toEqual([
      { lang: 'de', href: 'https://shop.example.com/de/skillet' },
      { lang: 'x-default', href: 'https://shop.example.com/skillet' },
    ]);
  });

  it('merges robots directives across metas, lowercased and deduplicated', () => {
    const { report } = run(richProductHtml);

    expect(report.seo.robots).toEqual([
      'index',
      'follow',
      'max-snippet:-1',
      'noarchive',
    ]);
  });

  it('takes only RSS and Atom alternates as feeds', () => {
    const { report } = run(richProductHtml);

    expect(report.seo.feeds).toEqual([
      {
        href: 'https://shop.example.com/feed.xml',
        type: 'application/rss+xml',
        title: 'New arrivals',
      },
      {
        href: 'https://shop.example.com/atom.xml',
        type: 'application/atom+xml',
      },
    ]);
  });
});

describe('extractStructured / a page with nothing to find', () => {
  it('returns a well-formed empty report and no warnings', () => {
    const { report, warnings } = run(bareHtml);

    expect(report).toEqual({
      jsonLd: [],
      microdata: [],
      rdfa: [],
      social: {},
      seo: { alternates: [], robots: [], feeds: [] },
    });
    expect(warnings).toEqual([]);
  });

  it('degrades rather than throwing on an unparseable page url', () => {
    const { report } = run(misspelledOgHtml, 'not a url');

    expect(report.social.image).toBe('https://example.com/a.png');
  });
});
