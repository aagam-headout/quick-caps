import type { AssetBytes, FetchOptions } from './driver.js';

/**
 * A credentialed-but-cookieless asset fetch with a hard size cap.
 *
 * Shared by every PageDriver implementation — the extension's ChromeDriver
 * and offscreen document, the CLI's PlaywrightDriver and StaticDriver — so
 * the cap and credential policy live in exactly one place. `fetch`,
 * `AbortController`, and `setTimeout` are web-standard globals available in
 * both a browser and Node 18+, so this needs no host-specific branch.
 */
export async function fetchAssetBytes(
  url: string,
  options: FetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<AssetBytes> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // A capture must not carry the user's session anywhere.
      credentials: 'omit',
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    // Refuse on the declared length before downloading: reading the body
    // first would defeat the purpose of a cap.
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > options.maxBytes) {
      throw new Error(`exceeds per-asset cap: declared ${declared} bytes`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > options.maxBytes) {
      throw new Error(`exceeds per-asset cap: ${buffer.byteLength} bytes`);
    }
    return {
      url: response.url || url,
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAssetText(
  url: string,
  options: FetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const asset = await fetchAssetBytes(url, options, fetchImpl);
  return new TextDecoder().decode(asset.bytes);
}
