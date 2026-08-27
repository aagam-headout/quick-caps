import { describe, expect, it, vi } from 'vitest';
import { fetchAssets } from '../src/assets.js';
import { FakeDriver } from './fake-driver.js';
import type { AssetRef } from '../src/ir.js';

const ref = (url: string): AssetRef => ({
  url,
  kind: 'image',
  referencedBy: 'img[src]',
});

const limits = {
  concurrency: 2,
  assetTimeoutMs: 50,
  retries: 1,
  maxAssetBytes: 10,
  maxTotalBytes: 25,
  logRingSize: 500,
};

describe('fetchAssets', () => {
  it('returns bytes keyed by url', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/a.png': new Uint8Array([1]), '/b.png': new Uint8Array([2]) },
    });
    const result = await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/a.png'), ref('/b.png')],
      {
        limits,
      },
    );
    expect([...result.assets.keys()].sort()).toEqual(['/a.png', '/b.png']);
    expect(result.warnings).toEqual([]);
    expect(result.totalBytes).toBe(2);
  });

  it('warns and continues when one asset fails', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/ok.png': new Uint8Array([1]) },
      failures: { '/bad.png': 'network error' },
    });
    const result = await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/ok.png'), ref('/bad.png')],
      { limits },
    );
    expect(result.assets.has('/ok.png')).toBe(true);
    expect(result.assets.has('/bad.png')).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      phase: 'assets',
      url: '/bad.png',
    });
  });

  it('retries a failing asset exactly `retries` times', async () => {
    let calls = 0;
    const result = await fetchAssets(
      async (url) => {
        calls++;
        throw new Error(`boom ${url}`);
      },
      [ref('/x.png')],
      { limits },
    );

    // One initial attempt plus one retry.
    expect(calls).toBe(2);
    expect(result.warnings[0]!.reason).toContain('boom');
  });

  it('times out a hanging asset and warns', async () => {
    const driver = new FakeDriver({ fixture: 'static', hangs: ['/slow.png'] });
    const result = await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/slow.png')],
      { limits },
    );
    expect(result.assets.size).toBe(0);
    expect(result.warnings[0]!.reason).toContain('timed out');
  });

  it('skips an asset over the per-asset cap', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/big.png': new Uint8Array(20) },
    });
    const result = await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/big.png')],
      { limits },
    );
    expect(result.assets.size).toBe(0);
    expect(result.warnings[0]!.reason).toMatch(/too large|exceeds/);
  });

  it('stops fetching once the total cap is reached and warns with a count', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: {
        '/1.png': new Uint8Array(10),
        '/2.png': new Uint8Array(10),
        '/3.png': new Uint8Array(10),
        '/4.png': new Uint8Array(10),
      },
    });
    const result = await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/1.png'), ref('/2.png'), ref('/3.png'), ref('/4.png')],
      { limits: { ...limits, concurrency: 1 } },
    );
    expect(result.totalBytes).toBeLessThanOrEqual(limits.maxTotalBytes);
    const capWarning = result.warnings.find((w) =>
      w.reason.includes('total size cap'),
    );
    expect(capWarning).toBeDefined();
    expect(capWarning!.detail).toMatch(/\d+ asset/);
  });

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await fetchAssets(
      async (url) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { url, bytes: new Uint8Array([1]), contentType: null };
      },
      Array.from({ length: 10 }, (_, i) => ref(`/${i}.png`)),
      { limits: { ...limits, concurrency: 3 } },
    );

    expect(peak).toBeLessThanOrEqual(3);
    // Without this the assertion above passes when nothing ran at all.
    expect(peak).toBeGreaterThan(0);
    expect(result.assets.size).toBe(10);
  });

  it('reports progress as assets settle', async () => {
    const onProgress = vi.fn();
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/a.png': new Uint8Array([1]), '/b.png': new Uint8Array([2]) },
    });
    await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/a.png'), ref('/b.png')],
      {
        limits,
        onProgress,
      },
    );
    expect(onProgress).toHaveBeenCalledWith({ done: 2, total: 2 });
  });

  it('does not reject even when every asset fails', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      failures: { '/a.png': 'down', '/b.png': 'down' },
    });
    const result = await fetchAssets(
      (url, opts) => driver.fetchAsset(url, opts),
      [ref('/a.png'), ref('/b.png')],
      {
        limits,
      },
    );
    expect(result.assets.size).toBe(0);
    expect(result.warnings).toHaveLength(2);
  });
});
