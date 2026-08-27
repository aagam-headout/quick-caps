import { describe, expect, it, vi } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
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

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    fetchText: vi.fn(async () => 'raw source'),
    stitch: vi.fn(async () => new Uint8Array([137, 80])),
    createObjectUrl: vi.fn(async () => 'blob:fake'),
    onProgress: vi.fn(),
    ...overrides,
  };
}

const input = { ir, html: SERIALIZED, settings: defaultSettings };

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
