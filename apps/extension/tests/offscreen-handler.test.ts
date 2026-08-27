import { describe, expect, it, vi } from 'vitest';
import {
  handleOffscreenRequest,
  isOffscreenRequest,
  type HandlerDeps,
} from '../src/offscreen/handler.js';
import { defaultSettings, emptyTally, type PageIR } from '@quickcaps/core';

const ir: PageIR = {
  metadata: {
    url: 'https://example.com/p',
    title: 'P',
    capturedAt: '2026-08-27T10:00:00.000Z',
    viewport: { width: 1, height: 1 },
    documentSize: { width: 1, height: 1 },
    devicePixelRatio: 1,
    userAgent: 'test',
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

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    capture: vi.fn(async () => ({
      filename: 'x.html',
      mimeType: 'text/html',
      byteLength: 10,
      objectUrl: 'blob:x',
      warnings: [],
      hasTokens: false,
    })),
    stitch: vi.fn(async () => new Uint8Array([1, 2])),
    createObjectUrl: vi.fn(() => 'blob:new'),
    revokeObjectUrl: vi.fn(),
    ...overrides,
  };
}

describe('isOffscreenRequest', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'offscreen:stitch'],
    ['a number', 7],
    ['an object with no type', {}],
    ['a non-string type', { type: 7 }],
    ['another namespace', { type: 'capture:start' }],
  ])('rejects %s without throwing', (_name, message) => {
    expect(isOffscreenRequest(message)).toBe(false);
  });

  it('accepts an offscreen message', () => {
    expect(isOffscreenRequest({ type: 'offscreen:revoke' })).toBe(true);
  });
});

describe('handleOffscreenRequest', () => {
  it('runs a capture and returns its result', async () => {
    const response = await handleOffscreenRequest(
      {
        type: 'offscreen:capture',
        ir,
        html: '<html></html>',
        settings: defaultSettings,
      },
      deps(),
    );
    expect(response).toMatchObject({
      ok: true,
      type: 'capture',
      result: { filename: 'x.html', objectUrl: 'blob:x' },
    });
  });

  it('returns ok:false rather than rejecting when a capture fails', async () => {
    const response = await handleOffscreenRequest(
      {
        type: 'offscreen:capture',
        ir,
        html: '',
        settings: defaultSettings,
      },
      deps({
        capture: vi.fn().mockRejectedValue(new Error('nothing was captured')),
      }),
    );
    // The caller's only alternative to an error response is to hang.
    expect(response).toEqual({ ok: false, error: 'nothing was captured' });
  });

  it('returns stitched bytes as a plain array', async () => {
    const response = await handleOffscreenRequest(
      {
        type: 'offscreen:stitch',
        request: {
          frames: [{ dataUrl: 'a', offsetY: 0 }],
          width: 1,
          height: 1,
          devicePixelRatio: 1,
        },
      },
      deps(),
    );
    expect(response).toEqual({ ok: true, type: 'stitch', bytes: [1, 2] });
  });

  it('reports a stitch failure as an error response', async () => {
    const response = await handleOffscreenRequest(
      {
        type: 'offscreen:stitch',
        request: {
          frames: [],
          width: 1,
          height: 1,
          devicePixelRatio: 1,
        },
      },
      deps({ stitch: vi.fn().mockRejectedValue(new Error('no frames')) }),
    );
    expect(response).toEqual({ ok: false, error: 'no frames' });
  });

  it('mints and revokes object urls', async () => {
    const d = deps();
    await expect(
      handleOffscreenRequest(
        { type: 'offscreen:object-url', bytes: [1], mimeType: 'text/html' },
        d,
      ),
    ).resolves.toEqual({ ok: true, type: 'object-url', url: 'blob:new' });

    await expect(
      handleOffscreenRequest({ type: 'offscreen:revoke', url: 'blob:new' }, d),
    ).resolves.toEqual({ ok: true, type: 'revoked' });
    expect(d.revokeObjectUrl).toHaveBeenCalledWith('blob:new');
  });

  it('answers an unknown offscreen type instead of resolving undefined', async () => {
    const response = await handleOffscreenRequest(
      { type: 'offscreen:teleport' } as never,
      deps(),
    );
    // Resolving undefined here is what the client used to dereference.
    expect(response).toMatchObject({ ok: false });
    expect((response as { error: string }).error).toContain(
      'unknown offscreen request',
    );
  });

  it('stringifies a non-Error rejection', async () => {
    const response = await handleOffscreenRequest(
      { type: 'offscreen:revoke', url: 'blob:x' },
      deps({
        revokeObjectUrl: vi.fn(() => {
          throw 'plain string throw';
        }),
      }),
    );
    expect(response).toEqual({ ok: false, error: 'plain string throw' });
  });
});
