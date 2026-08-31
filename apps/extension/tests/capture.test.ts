/**
 * @vitest-environment jsdom
 *
 * runCapture needs a DOMParser for the extract layer's document, exactly as
 * the offscreen document supplies one; the rest of the suite is
 * environment-agnostic.
 */
import { describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { defaultSettings, emptyTally, type PageIR } from 'quick-caps-core';
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
  html: '',
  regions: [],
  styles: [],
  assets: [
    {
      url: 'https://example.com/app.js',
      kind: 'script',
      referencedBy: 'script[src]',
    },
  ],
  styleTally: { ...emptyTally(), color: { '#000000': 5 } },
  warnings: [],
};

const SERIALIZED = '<!doctype html><html><body><h1>Hi</h1></body></html>';

/** Same call the offscreen document makes. */
const parseDocument = (html: string): Document =>
  new DOMParser().parseFromString(html, 'text/html');

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    parseDocument,
    fetchText: vi.fn(async () => 'raw source'),
    stitch: vi.fn(async () => new Uint8Array([137, 80])),
    createObjectUrl: vi.fn(async () => 'blob:fake'),
    onProgress: vi.fn(),
    ...overrides,
  };
}

const input = { ir, html: SERIALIZED, settings: defaultSettings };

/** Enough real structured data for the extract layer to find something. */
const DATA_PAGE = `<!doctype html><html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget","offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD"}}</script>
</head><body><h1>Widget</h1><a href="https://example.com/next">Next</a></body></html>`;

/** The packaged bytes, read back off the createObjectUrl mock. */
const bytesFrom = (d: CaptureDeps): Uint8Array =>
  (d.createObjectUrl as ReturnType<typeof vi.fn>).mock
    .calls[0]![0] as Uint8Array;

describe('runCapture', () => {
  it('produces a filename, size, and object url', async () => {
    const result = await runCapture(input, deps());
    expect(result.filename).toBe('example.com-20260827-100000.html');
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.objectUrl).toBe('blob:fake');
  });

  it('passes the serialized html through untouched', async () => {
    const d = deps();
    await runCapture(input, d);
    const [bytes] = (d.createObjectUrl as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Uint8Array];
    // single-file-core already inlined everything; re-parsing here is what
    // previously produced malformed output.
    expect(new TextDecoder().decode(bytes)).toContain(SERIALIZED);
  });

  it('does no asset fetching of its own', async () => {
    const d = deps();
    await runCapture(input, d);
    expect(d.fetchText).not.toHaveBeenCalled();
  });

  it('reports bundling and done', async () => {
    const d = deps();
    await runCapture(input, d);
    const phases = (d.onProgress as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { phase: string }).phase,
    );
    expect(phases).toEqual(['bundling', 'done']);
  });

  it('produces a zip carrying page.html plus the extras', async () => {
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          output: 'zip',
          include: { ...defaultSettings.include, tokens: true },
        },
      },
      deps(),
    );
    expect(result.filename.endsWith('.zip')).toBe(true);
    expect(result.mimeType).toBe('application/zip');
  });

  it('stitches supplied frames when the screenshot toggle is on', async () => {
    const d = deps();
    await runCapture(
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
    expect(d.stitch).toHaveBeenCalledTimes(1);
  });

  it('warns instead of failing when stitching throws', async () => {
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
        },
        frames: [{ dataUrl: 'data:image/png;base64,A', offsetY: 0 }],
      },
      deps({ stitch: vi.fn().mockRejectedValue(new Error('throttled')) }),
    );
    expect(result.filename).toBeTruthy();
    expect(result.warnings.some((w) => w.phase === 'screenshot')).toBe(true);
  });

  it('drops an oversized screenshot from single-file output with a warning', async () => {
    // Inline base64 costs a third again in size and has to be held as one
    // string; a zip stores the same bytes verbatim.
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
        },
        frames: [{ dataUrl: 'data:image/png;base64,A', offsetY: 0 }],
      },
      deps({
        stitch: vi.fn().mockResolvedValue(new Uint8Array(25 * 1024 * 1024)),
      }),
    );
    expect(
      result.warnings.some(
        (w) => w.phase === 'screenshot' && w.reason.includes('too large'),
      ),
    ).toBe(true);
    expect(result.filename.endsWith('.html')).toBe(true);
  });

  it('keeps an oversized screenshot in zip output, where it costs its own size', async () => {
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          output: 'zip',
          include: { ...defaultSettings.include, screenshot: true },
        },
        frames: [{ dataUrl: 'data:image/png;base64,A', offsetY: 0 }],
      },
      deps({
        stitch: vi.fn().mockResolvedValue(new Uint8Array(25 * 1024 * 1024)),
      }),
    );
    expect(result.warnings.some((w) => w.phase === 'screenshot')).toBe(false);
  });

  it('warns when the screenshot toggle is on but no frames arrived', async () => {
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

  it('skips the screenshot for a selective capture, with a warning', async () => {
    const d = deps();
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          selectionSelector: '#card',
          include: { ...defaultSettings.include, screenshot: true },
        },
        frames: [{ dataUrl: 'data:image/png;base64,A', offsetY: 0 }],
      },
      d,
    );
    expect(d.stitch).not.toHaveBeenCalled();
    expect(
      result.warnings.some(
        (w) => w.phase === 'screenshot' && w.reason.includes('selective'),
      ),
    ).toBe(true);
  });

  it('skips raw sources for a selective capture, with a warning', async () => {
    const d = deps();
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          selectionSelector: '#card',
          include: { ...defaultSettings.include, rawSources: true },
        },
      },
      d,
    );
    expect(d.fetchText).not.toHaveBeenCalled();
    expect(
      result.warnings.some(
        (w) => w.phase === 'assets' && w.reason.includes('selective'),
      ),
    ).toBe(true);
  });

  it('fetches raw sources only when that toggle is on', async () => {
    const d = deps();
    await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, rawSources: true },
        },
      },
      d,
    );
    const requested = (d.fetchText as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as string,
    );
    expect(requested).toContain('https://example.com/p');
    expect(requested).toContain('https://example.com/app.js');
  });

  it('warns rather than failing when a raw source cannot be fetched', async () => {
    const result = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, rawSources: true },
        },
      },
      deps({ fetchText: vi.fn().mockRejectedValue(new Error('403')) }),
    );
    expect(result.filename).toBeTruthy();
    expect(result.warnings.some((w) => w.reason.includes('403'))).toBe(true);
  });

  it('embeds the token report when that toggle is on', async () => {
    const withTokens = await runCapture(
      {
        ...input,
        settings: {
          ...defaultSettings,
          output: 'zip',
          include: { ...defaultSettings.include, tokens: true },
        },
      },
      deps(),
    );
    expect(withTokens.hasTokens).toBe(true);
    expect(await runCapture(input, deps()).then((r) => r.hasTokens)).toBe(
      false,
    );
  });

  it('carries IR warnings into the archive metadata', async () => {
    const d = deps();
    await runCapture(
      {
        ...input,
        ir: {
          ...ir,
          warnings: [{ phase: 'collect', reason: 'unparseable url' }],
        },
        settings: { ...defaultSettings, output: 'zip' },
      },
      d,
    );
    const [bytes] = (d.createObjectUrl as ReturnType<typeof vi.fn>).mock
      .calls[0] as [Uint8Array];
    const metadata = JSON.parse(
      strFromU8(unzipSync(bytes)['metadata.json']!),
    ) as { warnings: { reason: string }[] };
    expect(metadata.warnings.some((w) => w.reason === 'unparseable url')).toBe(
      true,
    );
  });
});

describe('runCapture empty input', () => {
  it('refuses an empty serialized page rather than writing a zero-byte file', async () => {
    await expect(runCapture({ ...input, html: '' }, deps())).rejects.toThrow(
      'nothing was captured',
    );
  });

  it('refuses whitespace-only html', async () => {
    await expect(
      runCapture({ ...input, html: '   \n  ' }, deps()),
    ).rejects.toThrow('nothing was captured');
  });

  it('does not mint an object url for an empty page', async () => {
    const d = deps();
    await runCapture({ ...input, html: '' }, d).catch(() => undefined);
    expect(d.createObjectUrl).not.toHaveBeenCalled();
  });

  it('still captures a page with no assets at all', async () => {
    const result = await runCapture(
      {
        ...input,
        ir: { ...ir, assets: [], styles: [], regions: [] },
        html: '<!doctype html><html><body>bare</body></html>',
      },
      deps(),
    );
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });
  it('writes data.json into the zip only when extracted data is on', async () => {
    const on = deps();
    await runCapture(
      {
        ...input,
        html: DATA_PAGE,
        settings: {
          ...defaultSettings,
          output: 'zip',
          include: { ...defaultSettings.include, data: true },
        },
      },
      on,
    );
    expect(Object.keys(unzipSync(bytesFrom(on)))).toContain('data.json');

    const off = deps();
    await runCapture(
      {
        ...input,
        html: DATA_PAGE,
        settings: { ...defaultSettings, output: 'zip' },
      },
      off,
    );
    expect(Object.keys(unzipSync(bytesFrom(off)))).not.toContain('data.json');
  });

  it('embeds an inert data block in single-file output', async () => {
    const d = deps();
    await runCapture(
      {
        ...input,
        html: DATA_PAGE,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, data: true },
        },
      },
      d,
    );
    const text = new TextDecoder().decode(bytesFrom(d));
    expect(text).toContain(
      '<script type="application/json" data-capture="data">',
    );
    expect(text).toContain('"jsonLd"');
  });

  it('summarizes what extraction found, for the popup', async () => {
    const result = await runCapture(
      {
        ...input,
        html: DATA_PAGE,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, data: true },
        },
      },
      deps(),
    );
    expect(result.dataSummary).toContain('49.99');
    expect(result.dataSummary).toMatch(/link/);
  });

  it('has no summary when extracted data is off', async () => {
    const result = await runCapture({ ...input, html: DATA_PAGE }, deps());
    expect(result.dataSummary).toBeUndefined();
  });

  it('warns rather than failing when extraction throws', async () => {
    const result = await runCapture(
      {
        ...input,
        html: DATA_PAGE,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, data: true },
        },
      },
      deps({
        parseDocument: vi.fn(() => {
          throw new Error('no parser here');
        }),
      }),
    );
    expect(result.filename).toBeTruthy();
    expect(
      result.warnings.some(
        (w) => w.phase === 'extract' && w.reason.includes('no parser here'),
      ),
    ).toBe(true);
  });
});
