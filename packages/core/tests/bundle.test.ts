import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  assetPathFor,
  buildSingleFile,
  buildZip,
  captureFilename,
} from '../src/bundle.js';
import { defaultSettings } from '../src/settings.js';
import { emptyTally } from '../src/collect.js';
import type { PageIR } from '../src/ir.js';
import type { FetchedAsset } from '../src/assets.js';

const ir: PageIR = {
  metadata: {
    url: 'https://example.com/a/page?q=1',
    title: 'Example',
    capturedAt: '2026-08-27T10:00:00.000Z',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 2,
    userAgent: 'test',
    charset: 'utf-8',
    meta: {},
  },
  html: '<html><head></head><body><h1>Hi</h1></body></html>',
  regions: [],
  styles: [],
  assets: [],
  styleTally: emptyTally(),
  warnings: [{ phase: 'assets', url: '/x.png', reason: 'boom' }],
};

const input = {
  ir,
  settings: defaultSettings,
  html: '<html><head></head><body><h1>Hi</h1></body></html>',
  assets: new Map<string, FetchedAsset>(),
  styleTexts: new Map<string, string>(),
  tokens: { color: { '#000000': 3 } },
  screenshot: undefined,
  rawSources: new Map([['https://example.com/a/page?q=1', 'raw html']]),
};

describe('captureFilename', () => {
  it('uses hostname and a sortable timestamp', () => {
    expect(
      captureFilename(
        'https://example.com/a/page',
        '2026-08-27T10:00:00.000Z',
        'html',
      ),
    ).toBe('example.com-20260827-100000.html');
  });

  it('strips characters that are illegal on any platform', () => {
    const name = captureFilename(
      'https://ex:am*ple.com/p',
      '2026-08-27T10:00:00.000Z',
      'zip',
    );
    expect(name).not.toMatch(/[:*?"<>|]/);
  });

  it('caps the length', () => {
    const long = `https://${'a'.repeat(300)}.com/p`;
    expect(
      captureFilename(long, '2026-08-27T10:00:00.000Z', 'html').length,
    ).toBeLessThanOrEqual(120);
  });

  it('falls back to a fixed name for an unparseable url', () => {
    expect(
      captureFilename('not a url', '2026-08-27T10:00:00.000Z', 'html'),
    ).toBe('capture-20260827-100000.html');
  });
});

describe('assetPathFor', () => {
  it('groups by kind and keeps the basename', () => {
    expect(assetPathFor('https://example.com/img/hero.png', 'image')).toMatch(
      /^images\/hero-[0-9a-f]{8}\.png$/,
    );
  });

  it('rejects path traversal from the url', () => {
    const path = assetPathFor('https://example.com/../../etc/passwd', 'image');
    expect(path).not.toContain('..');
    expect(path.startsWith('images/')).toBe(true);
  });

  it('gives distinct paths to same-named files from different urls', () => {
    expect(assetPathFor('https://example.com/one/logo.svg', 'image')).not.toBe(
      assetPathFor('https://example.com/two/logo.svg', 'image'),
    );
  });

  it('is stable for the same url', () => {
    const url = 'https://example.com/one/logo.svg';
    expect(assetPathFor(url, 'image')).toBe(assetPathFor(url, 'image'));
  });
});

describe('buildSingleFile', () => {
  it('produces one html file with the right name and mime type', () => {
    const out = buildSingleFile(input);
    expect(out.filename).toBe('example.com-20260827-100000.html');
    expect(out.mimeType).toBe('text/html');
  });

  it('embeds metadata, tokens, and warnings as inert json blocks', () => {
    const text = new TextDecoder().decode(buildSingleFile(input).bytes);
    expect(text).toContain(
      '<script type="application/json" data-capture="metadata">',
    );
    expect(text).toContain(
      '<script type="application/json" data-capture="tokens">',
    );
    expect(text).toContain('"reason":"boom"');
  });

  it('escapes a closing script tag inside embedded json', () => {
    const text = new TextDecoder().decode(
      buildSingleFile({
        ...input,
        ir: {
          ...ir,
          warnings: [{ phase: 'assets', reason: '</script><script>bad()' }],
        },
      }).bytes,
    );
    expect(text).not.toContain('</script><script>bad()');
    expect(text).toContain('<\\/script>');
  });

  it('embeds raw sources when the setting is on', () => {
    const text = new TextDecoder().decode(
      buildSingleFile({
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, rawSources: true },
        },
      }).bytes,
    );
    expect(text).toContain('data-capture="raw"');
    expect(text).toContain('raw html');
  });

  it('omits the tokens block when tokens are excluded', () => {
    const text = new TextDecoder().decode(
      buildSingleFile({ ...input, tokens: undefined }).bytes,
    );
    expect(text).not.toContain('data-capture="tokens"');
  });
});

describe('buildZip', () => {
  it('produces a zip containing page.html and metadata.json', () => {
    const out = buildZip(input);
    expect(out.filename).toBe('example.com-20260827-100000.zip');
    expect(out.mimeType).toBe('application/zip');
    const files = unzipSync(out.bytes);
    expect(Object.keys(files)).toContain('page.html');
    expect(Object.keys(files)).toContain('metadata.json');
    expect(strFromU8(files['page.html']!)).toContain('<h1>Hi</h1>');
  });

  it('writes warnings into metadata.json', () => {
    const files = unzipSync(buildZip(input).bytes);
    const metadata = JSON.parse(strFromU8(files['metadata.json']!)) as {
      warnings: { reason: string }[];
    };
    expect(metadata.warnings).toHaveLength(1);
    expect(metadata.warnings[0]!.reason).toBe('boom');
  });

  it('writes each stylesheet under styles/', () => {
    const files = unzipSync(
      buildZip({
        ...input,
        styleTexts: new Map([
          ['https://example.com/s/site.css', 'a{color:red}'],
        ]),
      }).bytes,
    );
    const styleFiles = Object.keys(files).filter((f) =>
      f.startsWith('styles/'),
    );
    expect(styleFiles).toHaveLength(1);
    expect(strFromU8(files[styleFiles[0]!]!)).toBe('a{color:red}');
  });

  it('includes screenshot.png only when a screenshot was captured', () => {
    expect(Object.keys(unzipSync(buildZip(input).bytes))).not.toContain(
      'screenshot.png',
    );
    expect(
      Object.keys(
        unzipSync(
          buildZip({ ...input, screenshot: new Uint8Array([137, 80]) }).bytes,
        ),
      ),
    ).toContain('screenshot.png');
  });

  it('never writes an entry outside the archive root', () => {
    const files = unzipSync(
      buildZip({
        ...input,
        styleTexts: new Map([['https://example.com/../../evil.css', 'a{}']]),
      }).bytes,
    );
    for (const name of Object.keys(files)) {
      expect(name).not.toContain('..');
      expect(name.startsWith('/')).toBe(false);
    }
  });
});
