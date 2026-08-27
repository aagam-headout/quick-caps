import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  fetchAssets,
  type AssetRef,
} from '@page-capture/core';
import { installChromeMock } from './chrome-mock.js';
import { ChromeDriver } from '../src/background/chrome-driver.js';

beforeEach(() => {
  installChromeMock();
});

function okResponse(bytes: Uint8Array, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => (name === 'content-type' ? contentType : null),
    },
    arrayBuffer: async () => bytes.buffer.slice(0, bytes.byteLength),
  } as unknown as Response;
}

const ref = (url: string): AssetRef => ({
  url,
  kind: 'image',
  referencedBy: 'img[src]',
});

/**
 * The seam test. These core functions were written and tested against
 * FakeDriver; nothing about them changed to run against Chrome. If this file
 * ever needs a core change to pass, the abstraction has sprung a leak.
 */
describe('core pipeline over ChromeDriver', () => {
  it('fetches assets through the real driver implementation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse(new Uint8Array([1, 2])));
    const driver = new ChromeDriver(1, { fetchImpl });

    const result = await fetchAssets(driver, [ref('https://x.test/a.png')], {
      limits: defaultSettings.limits,
    });

    expect(result.assets.size).toBe(1);
    expect(result.totalBytes).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("applies core's cap policy to a driver-reported oversize asset", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(okResponse(new Uint8Array(100)));
    const driver = new ChromeDriver(1, { fetchImpl });

    const result = await fetchAssets(driver, [ref('https://x.test/big.png')], {
      limits: { ...defaultSettings.limits, maxAssetBytes: 10, retries: 0 },
    });

    expect(result.assets.size).toBe(0);
    expect(result.warnings[0]!.reason).toContain('exceeds');
  });

  it("honours core's retry count against a failing driver", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const driver = new ChromeDriver(1, { fetchImpl });

    await fetchAssets(driver, [ref('https://x.test/a.png')], {
      limits: { ...defaultSettings.limits, retries: 2 },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
