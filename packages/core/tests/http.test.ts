import { describe, expect, it, vi } from 'vitest';
import { fetchAssetBytes, fetchAssetText } from '../src/http.js';

function fakeFetch(
  init: Partial<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: Uint8Array;
  }>,
): typeof fetch {
  const body = init.body ?? new Uint8Array([1, 2, 3]);
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      get: (name: string) => (init.headers ?? {})[name.toLowerCase()] ?? null,
    },
    arrayBuffer: async () => body.buffer.slice(0, body.byteLength),
  })) as unknown as typeof fetch;
}

describe('fetchAssetBytes', () => {
  it('returns bytes and content type on success', async () => {
    const impl = fakeFetch({ headers: { 'content-type': 'image/png' } });
    const result = await fetchAssetBytes(
      'https://x.test/a.png',
      { timeoutMs: 100, maxBytes: 1000 },
      impl,
    );
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.contentType).toBe('image/png');
  });

  it('rejects a non-ok response', async () => {
    const impl = fakeFetch({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 100, maxBytes: 1000 }, impl),
    ).rejects.toThrow('404 Not Found');
  });

  it('rejects on a declared content-length over the cap, before downloading', async () => {
    const impl = fakeFetch({ headers: { 'content-length': '99999' } });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 100, maxBytes: 10 }, impl),
    ).rejects.toThrow('exceeds per-asset cap');
  });

  it('rejects when the actual body exceeds the cap despite no declared length', async () => {
    const impl = fakeFetch({ body: new Uint8Array(20) });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 100, maxBytes: 10 }, impl),
    ).rejects.toThrow('exceeds per-asset cap');
  });

  it('aborts after the timeout', async () => {
    const hanging: typeof fetch = (url, init) =>
      new Promise((resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }
      });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 20, maxBytes: 1000 }, hanging),
    ).rejects.toThrow();
  });
});

describe('fetchAssetText', () => {
  it('decodes the fetched bytes as UTF-8', async () => {
    const impl = fakeFetch({ body: new TextEncoder().encode('hello') });
    const text = await fetchAssetText(
      'https://x.test/a.css',
      { timeoutMs: 100, maxBytes: 1000 },
      impl,
    );
    expect(text).toBe('hello');
  });
});
