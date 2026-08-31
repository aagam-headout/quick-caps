import { describe, expect, it } from 'vitest';
import { collectFromDocument } from '../src/collect.js';
import { fixtureDocument } from './fake-driver.js';
import { defaultSettings } from '../src/settings.js';

const options = {
  settings: defaultSettings,
  pageUrl: 'https://example.com/page',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  documentSize: { width: 1280, height: 2400 },
  devicePixelRatio: 2,
  now: () => new Date('2026-08-27T10:00:00.000Z'),
};

describe('collectFromDocument', () => {
  it('captures metadata from the document and the host', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.metadata.title).toBe('Static Fixture');
    expect(ir.metadata.url).toBe('https://example.com/page');
    expect(ir.metadata.capturedAt).toBe('2026-08-27T10:00:00.000Z');
    expect(ir.metadata.charset).toBe('utf-8');
    expect(ir.metadata.devicePixelRatio).toBe(2);
  });

  it('carries a passed-in perf report through onto the IR', () => {
    const perf = {
      ttfbMs: 25,
      domContentLoadedMs: 220,
      loadMs: 480,
      firstPaintMs: null,
      firstContentfulPaintMs: null,
      largestContentfulPaintMs: null,
      transferSizeBytes: null,
      resourceCount: 0,
      resourceCountByKind: {},
    };
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      perf,
    });
    expect(ir.perf).toEqual(perf);
  });

  it('omits perf when none was passed in', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.perf).toBeUndefined();
  });

  it('serializes the live DOM into html', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.html).toContain('<h1>Static Fixture</h1>');
    expect(ir.html.startsWith('<html')).toBe(true);
  });

  it('records inline styles as text and cross-origin sheets as href only', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    const inline = ir.styles.filter((s) => s.kind === 'inline');
    expect(inline).toHaveLength(1);
    expect(inline[0]!.kind === 'inline' && inline[0]!.text).toContain(
      '#171717',
    );

    const cross = ir.styles.filter((s) => s.kind === 'cross-origin');
    expect(cross.map((s) => s.kind === 'cross-origin' && s.href)).toEqual([
      'https://cdn.example.com/vendor.css',
    ]);
  });

  it('classifies a same-origin stylesheet link as an asset to fetch', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    const sheets = ir.assets.filter((a) => a.kind === 'stylesheet');
    expect(sheets.map((a) => a.url)).toEqual([
      'https://example.com/styles/site.css',
    ]);
  });

  it('absolutizes asset urls against the page url', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(
      ir.assets.filter((a) => a.kind === 'image').map((a) => a.url),
    ).toEqual(['https://example.com/img/hero.png']);
    expect(
      ir.assets.filter((a) => a.kind === 'script').map((a) => a.url),
    ).toEqual(['https://example.com/js/app.js']);
  });

  it('collects every srcset candidate and picture source', () => {
    const ir = collectFromDocument(fixtureDocument('gallery'), options);
    const urls = ir.assets.filter((a) => a.kind === 'image').map((a) => a.url);
    expect(urls).toContain('https://example.com/img/1@2x.jpg');
    expect(urls).toContain('https://example.com/img/3.avif');
    expect(urls).toContain('https://example.com/img/3.jpg');
  });

  it('deduplicates repeated asset references', () => {
    const ir = collectFromDocument(fixtureDocument('gallery'), options);
    const urls = ir.assets.map((a) => a.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('omits asset kinds the settings exclude', () => {
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      settings: {
        ...defaultSettings,
        include: { ...defaultSettings.include, images: false, scripts: false },
      },
    });
    expect(ir.assets.some((a) => a.kind === 'image')).toBe(false);
    expect(ir.assets.some((a) => a.kind === 'script')).toBe(false);
    expect(ir.assets.some((a) => a.kind === 'stylesheet')).toBe(true);
  });

  it('warns rather than throwing on a malformed url', () => {
    const doc = fixtureDocument('static');
    const img = doc.createElement('img');
    img.setAttribute('src', 'http://[bad');
    doc.body.append(img);
    const ir = collectFromDocument(doc, options);
    expect(ir.warnings.some((w) => w.phase === 'collect')).toBe(true);
    expect(ir.assets.some((a) => a.url.includes('[bad'))).toBe(false);
  });

  it('returns an empty tally when no computedStyle reader is supplied', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.styleTally.color).toEqual({});
  });
});

describe('collectFromDocument regions', () => {
  it('populates regions from the document', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.regions.length).toBeGreaterThan(0);
    expect(ir.regions.some((r) => r.role === 'banner')).toBe(true);
  });

  it('honours a custom region depth cap', () => {
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      maxRegionDepth: 1,
    });
    expect(ir.regions.every((r) => r.children.length === 0)).toBe(true);
  });
});

describe('collectFromDocument style tally', () => {
  it('tallies computed styles when a reader is supplied', () => {
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      computedStyle: () => ({
        color: 'rgb(23, 23, 23)',
        'font-size': '16px',
      }),
    });
    expect(ir.styleTally.color['#171717']).toBeGreaterThan(0);
    expect(ir.styleTally.fontSize['16px']).toBeGreaterThan(0);
  });
});

describe('collectFromDocument defensive paths', () => {
  it('warns rather than throwing when the page url will not parse', () => {
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      pageUrl: 'not a url',
    });
    expect(
      ir.warnings.some((w) => w.reason === 'page url could not be parsed'),
    ).toBe(true);
    // Nothing can be judged same-origin, so no stylesheet is queued for fetch.
    expect(ir.assets.some((a) => a.kind === 'stylesheet')).toBe(false);
  });

  it('still returns metadata when the page url will not parse', () => {
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      pageUrl: 'not a url',
    });
    expect(ir.metadata.title).toBe('Static Fixture');
  });

  it('warns rather than throwing on a document with no root element', () => {
    const doc = fixtureDocument('static');
    Object.defineProperty(doc, 'documentElement', {
      configurable: true,
      value: null,
    });
    const ir = collectFromDocument(doc, options);
    expect(ir.html).toBe('');
    expect(ir.assets).toEqual([]);
    expect(ir.regions).toEqual([]);
    expect(
      ir.warnings.some((w) => w.reason === 'the document has no root element'),
    ).toBe(true);
  });
});

describe('collectFromDocument base href', () => {
  // A relative asset is the only thing that distinguishes one base from
  // another: the static fixture's own urls are root-relative and so resolve
  // the same way whatever the base's path is.
  const withBase = (baseHref: string | null): Document => {
    const doc = fixtureDocument('static');
    if (baseHref !== null) {
      const base = doc.createElement('base');
      base.setAttribute('href', baseHref);
      doc.head.append(base);
    }
    const img = doc.createElement('img');
    img.setAttribute('src', 'photos/x.png');
    doc.body.append(img);
    return doc;
  };

  const nested = { ...options, pageUrl: 'https://example.com/a/b' };
  const relativeAsset = (ir: ReturnType<typeof collectFromDocument>) =>
    ir.assets.find((a) => a.url.endsWith('photos/x.png'))?.url;

  it('resolves assets against an absolute base href', () => {
    const ir = collectFromDocument(withBase('https://cdn.example/x/'), nested);
    expect(relativeAsset(ir)).toBe('https://cdn.example/x/photos/x.png');
  });

  it('resolves a root-relative base href against the page url', () => {
    const ir = collectFromDocument(withBase('/shop/'), nested);
    expect(relativeAsset(ir)).toBe('https://example.com/shop/photos/x.png');
    expect(ir.warnings).toEqual([]);
  });

  it("resolves a path-relative base href against the page's directory", () => {
    const ir = collectFromDocument(withBase('sub/'), nested);
    expect(relativeAsset(ir)).toBe('https://example.com/a/sub/photos/x.png');
    expect(ir.warnings).toEqual([]);
  });

  it('resolves against the page url when no base is declared', () => {
    const ir = collectFromDocument(withBase(null), nested);
    expect(relativeAsset(ir)).toBe('https://example.com/a/photos/x.png');
    expect(ir.warnings).toEqual([]);
  });

  it('falls back to the page url and warns once on an unparseable base', () => {
    const ir = collectFromDocument(withBase('http://[bad'), nested);
    expect(relativeAsset(ir)).toBe('https://example.com/a/photos/x.png');
    expect(
      ir.warnings.filter((w) => w.reason === 'base href could not be parsed'),
    ).toHaveLength(1);
  });

  it('does not throw when both the page url and the base are unusable', () => {
    const ir = collectFromDocument(withBase('/shop/'), {
      ...options,
      pageUrl: 'not a url',
    });
    expect(ir.metadata.title).toBe('Static Fixture');
    expect(relativeAsset(ir)).toBeUndefined();
  });
});
