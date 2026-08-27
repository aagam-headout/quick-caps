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
