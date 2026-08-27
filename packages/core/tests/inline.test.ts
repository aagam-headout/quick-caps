import { describe, expect, it } from 'vitest';
import {
  inlineDocument,
  resolveImports,
  rewriteCssUrls,
  toDataUri,
} from '../src/inline.js';
import { fixtureDocument } from './fake-driver.js';
import { defaultSettings } from '../src/settings.js';
import type { FetchedAsset } from '../src/assets.js';

const asset = (url: string, bytes: number[], type: string): FetchedAsset => ({
  ref: { url, kind: 'image', referencedBy: 'test' },
  bytes: new Uint8Array(bytes),
  contentType: type,
});

const baseInput = {
  pageUrl: 'https://example.com/page',
  settings: defaultSettings,
  assets: new Map<string, FetchedAsset>(),
  styleTexts: new Map<string, string>(),
  assetPath: undefined,
};

describe('toDataUri', () => {
  it('base64-encodes bytes with the given content type', () => {
    expect(toDataUri(new Uint8Array([104, 105]), 'text/plain')).toBe(
      'data:text/plain;base64,aGk=',
    );
  });

  it('falls back to application/octet-stream when type is null', () => {
    expect(toDataUri(new Uint8Array([1]), null)).toContain(
      'data:application/octet-stream;base64,',
    );
  });

  it('pads correctly for every input length modulo three', () => {
    expect(toDataUri(new Uint8Array([104]), 'x')).toBe('data:x;base64,aA==');
    expect(toDataUri(new Uint8Array([104, 105]), 'x')).toBe(
      'data:x;base64,aGk=',
    );
    expect(toDataUri(new Uint8Array([104, 105, 106]), 'x')).toBe(
      'data:x;base64,aGlq',
    );
  });
});

describe('rewriteCssUrls', () => {
  it('rewrites quoted and unquoted url() references', () => {
    const out = rewriteCssUrls(
      "a{background:url('/a.png')}b{background:url(/b.png)}",
      (u) => `X${u}X`,
    );
    expect(out).toContain('X/a.pngX');
    expect(out).toContain('X/b.pngX');
  });

  it('leaves data: uris untouched', () => {
    const css = 'a{background:url(data:image/png;base64,AAA)}';
    expect(rewriteCssUrls(css, () => 'REPLACED')).toBe(css);
  });
});

describe('resolveImports', () => {
  it('inlines a nested @import', () => {
    const sheets = new Map([
      ['/a.css', "@import url('/b.css'); a{color:red}"],
      ['/b.css', 'b{color:blue}'],
    ]);
    const out = resolveImports(
      sheets.get('/a.css')!,
      (u) => sheets.get(u) ?? null,
      5,
    );
    expect(out).toContain('b{color:blue}');
    expect(out).toContain('a{color:red}');
    expect(out).not.toContain('@import');
  });

  it('stops at the depth cap instead of looping on a cycle', () => {
    const sheets = new Map([
      ['/a.css', "@import url('/b.css');"],
      ['/b.css', "@import url('/a.css');"],
    ]);
    const out = resolveImports(
      sheets.get('/a.css')!,
      (u) => sheets.get(u) ?? null,
      3,
    );
    expect(out).toBeTypeOf('string');
    expect((out.match(/@import/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('leaves an unresolvable import in place', () => {
    expect(
      resolveImports("@import url('/missing.css');", () => null, 5),
    ).toContain('@import');
  });
});

describe('inlineDocument', () => {
  it('strips the base element after absolutizing', () => {
    const doc = fixtureDocument('static');
    const base = doc.createElement('base');
    base.setAttribute('href', 'https://example.com/');
    doc.head.prepend(base);
    inlineDocument(doc, baseInput);
    expect(doc.querySelector('base')).toBeNull();
  });

  it('absolutizes a relative anchor href', () => {
    const doc = fixtureDocument('static');
    inlineDocument(doc, baseInput);
    expect(doc.querySelector('a')!.getAttribute('href')).toBe(
      'https://example.com/next',
    );
  });

  it('replaces an image src with a data uri in single-file mode', () => {
    const doc = fixtureDocument('static');
    const url = 'https://example.com/img/hero.png';
    inlineDocument(doc, {
      ...baseInput,
      assets: new Map([[url, asset(url, [104, 105], 'image/png')]]),
    });
    expect(doc.querySelector('img')!.getAttribute('src')).toBe(
      'data:image/png;base64,aGk=',
    );
  });

  it('rewrites an image src to a relative path in zip mode', () => {
    const doc = fixtureDocument('static');
    const url = 'https://example.com/img/hero.png';
    inlineDocument(doc, {
      ...baseInput,
      assets: new Map([[url, asset(url, [104, 105], 'image/png')]]),
      assetPath: () => 'images/hero.png',
    });
    expect(doc.querySelector('img')!.getAttribute('src')).toBe(
      'images/hero.png',
    );
  });

  it('rewrites every srcset candidate', () => {
    const doc = fixtureDocument('gallery');
    const one = 'https://example.com/img/1.jpg';
    const two = 'https://example.com/img/1@2x.jpg';
    inlineDocument(doc, {
      ...baseInput,
      assets: new Map([
        [one, asset(one, [1], 'image/jpeg')],
        [two, asset(two, [2], 'image/jpeg')],
      ]),
    });
    const srcset = doc.querySelector('img[srcset]')!.getAttribute('srcset')!;
    expect(srcset).toContain('data:image/jpeg;base64,');
    expect(srcset).toContain('1x');
    expect(srcset).toContain('2x');
  });

  it('warns for a referenced asset that was never fetched', () => {
    const result = inlineDocument(fixtureDocument('static'), baseInput);
    expect(
      result.warnings.some(
        (w) => w.phase === 'assets' && w.reason === 'asset not available',
      ),
    ).toBe(true);
  });

  it('inlines a fetched stylesheet as a style element recording its origin', () => {
    const doc = fixtureDocument('static');
    inlineDocument(doc, {
      ...baseInput,
      styleTexts: new Map([
        ['https://example.com/styles/site.css', 'h1{color:#000}'],
      ]),
    });
    const injected = [...doc.querySelectorAll('style')].find((s) =>
      (s.textContent ?? '').includes('h1{color:#000}'),
    );
    expect(injected).toBeDefined();
    expect(injected!.getAttribute('data-capture-src')).toBe(
      'https://example.com/styles/site.css',
    );
    expect(doc.querySelector('link[rel~="stylesheet"]')).toBeNull();
  });

  it('warns and removes a stylesheet link whose text was never fetched', () => {
    const doc = fixtureDocument('static');
    const result = inlineDocument(doc, baseInput);
    expect(result.warnings.some((w) => w.phase === 'styles')).toBe(true);
    expect(doc.querySelectorAll('link[rel~="stylesheet"]')).toHaveLength(0);
  });

  it('neutralizes scripts in inert mode while preserving the original type', () => {
    const doc = fixtureDocument('spa');
    inlineDocument(doc, baseInput);
    const script = doc.querySelector('script')!;
    expect(script.getAttribute('type')).toBe('text/plain');
    expect(script.getAttribute('data-capture-type')).toBe('module');
  });

  it('moves inline event handlers to data attributes in inert mode', () => {
    const doc = fixtureDocument('static');
    doc.querySelector('h1')!.setAttribute('onclick', 'alert(1)');
    inlineDocument(doc, baseInput);
    const h1 = doc.querySelector('h1')!;
    expect(h1.hasAttribute('onclick')).toBe(false);
    expect(h1.getAttribute('data-capture-onclick')).toBe('alert(1)');
  });

  it('leaves scripts executable when inert mode is off', () => {
    const doc = fixtureDocument('spa');
    inlineDocument(doc, {
      ...baseInput,
      settings: { ...defaultSettings, inertSnapshot: false },
    });
    expect(doc.querySelector('script')!.getAttribute('type')).toBe('module');
  });

  it('removes script elements entirely when scripts are excluded', () => {
    const doc = fixtureDocument('spa');
    inlineDocument(doc, {
      ...baseInput,
      settings: {
        ...defaultSettings,
        include: { ...defaultSettings.include, scripts: false },
      },
    });
    expect(doc.querySelectorAll('script')).toHaveLength(0);
  });
});
