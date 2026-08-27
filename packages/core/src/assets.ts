import type { PageDriver } from './driver.js';
import type { AssetRef, Warning } from './ir.js';
import type { CaptureSettings } from './settings.js';

export type FetchedAsset = {
  ref: AssetRef;
  bytes: Uint8Array;
  contentType: string | null;
};

export type FetchAssetsOptions = {
  limits: CaptureSettings['limits'];
  onProgress?: (progress: { done: number; total: number }) => void;
};

export type FetchAssetsResult = {
  assets: Map<string, FetchedAsset>;
  warnings: Warning[];
  totalBytes: number;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Fetches every reference through the driver under the configured policy.
 * Never rejects: a failure becomes a Warning so the capture can continue with
 * whatever it did manage to collect.
 */
export async function fetchAssets(
  driver: PageDriver,
  refs: AssetRef[],
  options: FetchAssetsOptions,
): Promise<FetchAssetsResult> {
  const { limits } = options;
  const assets = new Map<string, FetchedAsset>();
  const warnings: Warning[] = [];
  let totalBytes = 0;
  let done = 0;
  let skippedForCap = 0;
  let cursor = 0;

  const attempt = async (ref: AssetRef): Promise<void> => {
    for (let tries = 0; tries <= limits.retries; tries++) {
      try {
        const asset = await withTimeout(
          driver.fetchAsset(ref.url, {
            timeoutMs: limits.assetTimeoutMs,
            maxBytes: limits.maxAssetBytes,
          }),
          limits.assetTimeoutMs,
        );
        if (asset.bytes.byteLength > limits.maxAssetBytes) {
          warnings.push({
            phase: 'assets',
            url: ref.url,
            reason: `exceeds per-asset cap of ${limits.maxAssetBytes} bytes`,
            detail: `${asset.bytes.byteLength} bytes`,
          });
          return;
        }
        if (totalBytes + asset.bytes.byteLength > limits.maxTotalBytes) {
          skippedForCap++;
          return;
        }
        totalBytes += asset.bytes.byteLength;
        assets.set(ref.url, {
          ref,
          bytes: asset.bytes,
          contentType: asset.contentType,
        });
        return;
      } catch (error) {
        if (tries === limits.retries) {
          warnings.push({
            phase: 'assets',
            url: ref.url,
            reason: error instanceof Error ? error.message : String(error),
            detail: ref.referencedBy,
          });
        }
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (cursor < refs.length) {
      const ref = refs[cursor++];
      if (!ref) return;
      if (totalBytes >= limits.maxTotalBytes) {
        skippedForCap++;
        continue;
      }
      await attempt(ref);
      done++;
      options.onProgress?.({ done, total: refs.length });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(limits.concurrency, refs.length)) },
      worker,
    ),
  );

  if (skippedForCap > 0) {
    warnings.push({
      phase: 'assets',
      reason: `total size cap of ${limits.maxTotalBytes} bytes reached`,
      detail: `${skippedForCap} asset(s) skipped`,
    });
  }

  return { assets, warnings, totalBytes };
}
