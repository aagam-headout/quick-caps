import { describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { defaultSettings, emptyTally, type PageIR } from '@page-capture/core';
import { runCapture, type CaptureDeps } from '../src/lib/capture.js';

const ir: PageIR = {
  metadata: {
    url: 'https://example.com/p',
    title: 'P',
    capturedAt: '2026-08-27T10:00:00.000Z',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1,
    userAgent: 'test',
    charset: 'utf-8',
    meta: {},
  },
  html: '<html><head></head><body><img src="https://example.com/a.png" /></body></html>',
  regions: [],
  styles: [{ kind: 'cross-origin', href: 'https://cdn.example.com/v.css' }],
  assets: [
    {
      url: 'https://example.com/a.png',
      kind: 'image',
      referencedBy: 'img[src]',
    },
  ],
  styleTally: { ...emptyTally(), color: { '#000000': 5 } },
  warnings: [],
};

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    fetchAsset: vi.fn(async (url: string) => ({
      url,
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
    })),
    fetchText: vi.fn(async () => 'a{color:red}'),
    stitch: vi.fn(async () => new Uint8Array([137, 80])),
    parseDocument: (html: string) =>
      parseHTML(html).document as unknown as Document,
    serializeDocument: (doc: Document) => doc.documentElement.outerHTML,
    createObjectUrl: vi.fn(async () => 'blob:fake'),
    onProgress: vi.fn(),
    ...overrides,
  };
}

const input = {
  ir,
  settings: defaultSettings,
  hasHostPermission: true,
};

describe('runCapture', () => {
  it('produces a filename, size, and object url', async () => {
    const result = await runCapture(input, deps());
    expect(result.filename).toBe('example.com-20260827-100000.html');
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.objectUrl).toBe('blob:fake');
  });

  it('reports every phase in order', async () => {
    const d = deps();
    await runCapture(input, d);
    const phases = (d.onProgress as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { phase: string }).phase,
    );
    expect(phases).toEqual([
      'fetching-assets',
      'fetching-assets',
      'bundling',
      'done',
    ]);
  });

  it('fetches cross-origin stylesheets listed in the IR', async () => {
    const d = deps();
    await runCapture(input, d);
    expect(d.fetchText).toHaveBeenCalledWith(
      'https://cdn.example.com/v.css',
      expect.anything(),
    );
  });

  it('skips cross-origin work and warns when the permission was declined', async () => {
    const d = deps();
    const result = await runCapture({ ...input, hasHostPermission: false }, d);
    expect(d.fetchText).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.reason.includes('permission'))).toBe(
      true,
    );
    // Still produces a file: declining degrades the capture, it does not fail it.
    expect(result.filename).toBeTruthy();
  });

  it('warns when a cross-origin stylesheet cannot be fetched', async () => {
    const d = deps({
      fetchText: vi.fn().mockRejectedValue(new Error('403 Forbidden')),
    });
    const result = await runCapture(input, d);
    expect(
      result.warnings.some(
        (w) => w.phase === 'styles' && w.reason.includes('403'),
      ),
    ).toBe(true);
  });

  it('does not stitch a screenshot when the toggle is off', async () => {
    const d = deps();
    await runCapture(input, d);
    expect(d.stitch).not.toHaveBeenCalled();
  });

  it('stitches the supplied frames when the toggle is on', async () => {
    const d = deps();
    await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
          output: 'zip',
        },
        frames: [{ dataUrl: 'data:image/png;base64,A', offsetY: 0 }],
      },
      d,
    );
    expect(d.stitch).toHaveBeenCalledTimes(1);
  });

  it('warns instead of failing when stitching throws', async () => {
    const d = deps({
      stitch: vi.fn().mockRejectedValue(new Error('throttled')),
    });
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
        },
        frames: [{ dataUrl: 'data:image/png;base64,A', offsetY: 0 }],
      },
      d,
    );
    expect(result.filename).toBeTruthy();
    expect(result.warnings.some((w) => w.phase === 'screenshot')).toBe(true);
  });

  it('warns when the screenshot toggle is on but no frames were captured', async () => {
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
        },
      },
      deps(),
    );
    expect(result.warnings.some((w) => w.phase === 'screenshot')).toBe(true);
  });

  it('produces a zip when the output mode is zip', async () => {
    const result = await runCapture(
      { ...input, settings: { ...defaultSettings, output: 'zip' } },
      deps(),
    );
    expect(result.filename.endsWith('.zip')).toBe(true);
    expect(result.mimeType).toBe('application/zip');
  });

  it('aggregates asset warnings into the result', async () => {
    const d = deps({
      fetchAsset: vi.fn().mockRejectedValue(new Error('404 Not Found')),
    });
    const result = await runCapture(input, d);
    expect(result.warnings.some((w) => w.phase === 'assets')).toBe(true);
  });

  it('carries IR warnings through to the result', async () => {
    const result = await runCapture(
      {
        ...input,
        ir: {
          ...ir,
          warnings: [{ phase: 'collect', reason: 'unparseable url' }],
        },
      },
      deps(),
    );
    expect(result.warnings.some((w) => w.reason === 'unparseable url')).toBe(
      true,
    );
  });

  it('includes design tokens only when the toggle is on', async () => {
    const withoutTokens = await runCapture(input, deps());
    expect(withoutTokens.hasTokens).toBe(false);

    const withTokens = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, tokens: true },
        },
      },
      deps(),
    );
    expect(withTokens.hasTokens).toBe(true);
  });

  it('fetches raw sources only when the toggle is on', async () => {
    const off = deps();
    await runCapture(input, off);
    const offCalls = (off.fetchText as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(offCalls).not.toContain('https://example.com/p');

    const on = deps();
    await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, rawSources: true },
        },
      },
      on,
    );
    const onCalls = (on.fetchText as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(onCalls).toContain('https://example.com/p');
  });

  it('rewrites the document rather than passing the original html through', async () => {
    let serialized = '';
    await runCapture(
      input,
      deps({
        serializeDocument: (doc: Document) => {
          serialized = doc.documentElement.outerHTML;
          return serialized;
        },
      }),
    );
    // The image reference must have become a data uri.
    expect(serialized).toContain('data:image/png;base64,');
    expect(serialized).not.toContain('src="https://example.com/a.png"');
  });
});

describe('runCapture second asset pass', () => {
  const withFontCss = {
    ...input,
    ir: {
      ...ir,
      styles: [
        {
          kind: 'same-origin' as const,
          href: 'https://example.com/s/site.css',
          text: "@font-face{src:url('/f/geist.woff2')}body{background:url(/img/bg.png)}",
        },
      ],
    },
  };

  it('fetches fonts and background images referenced only from css', async () => {
    const d = deps();
    await runCapture(withFontCss, d);
    const requested = (d.fetchAsset as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(requested).toContain('https://example.com/f/geist.woff2');
    expect(requested).toContain('https://example.com/img/bg.png');
  });

  it('skips css-referenced fonts when fonts are excluded', async () => {
    const d = deps();
    await runCapture(
      {
        ...withFontCss,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, fonts: false },
        },
      },
      d,
    );
    const requested = (d.fetchAsset as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(requested).not.toContain('https://example.com/f/geist.woff2');
  });

  it('does not re-fetch something the first pass already got', async () => {
    const d = deps();
    await runCapture(
      {
        ...withFontCss,
        ir: {
          ...withFontCss.ir,
          styles: [
            {
              kind: 'same-origin' as const,
              href: 'https://example.com/s/site.css',
              text: 'body{background:url(/a.png)}',
            },
          ],
          assets: [
            {
              url: 'https://example.com/a.png',
              kind: 'image' as const,
              referencedBy: 'img[src]',
            },
          ],
        },
      },
      d,
    );
    const requested = (d.fetchAsset as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(requested.filter((url) => url.endsWith('/a.png'))).toHaveLength(1);
  });

  it('skips cross-origin css references without the host grant', async () => {
    const d = deps();
    await runCapture(
      {
        ...withFontCss,
        hasHostPermission: false,
        ir: {
          ...withFontCss.ir,
          styles: [
            {
              kind: 'same-origin' as const,
              href: 'https://example.com/s/site.css',
              text: "@font-face{src:url('https://cdn.other.test/f.woff2')}",
            },
          ],
        },
      },
      d,
    );
    const requested = (d.fetchAsset as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(requested).not.toContain('https://cdn.other.test/f.woff2');
  });
});
