import type { FetchOptions } from 'quick-caps-core';
// Narrow subpath, not the root barrel — see chrome-driver.ts.
import { fetchAssetBytes } from 'quick-caps-core/http';
import type { ResourceFetchResponse } from '../content/serialize.js';

/** base64 without Buffer: service workers have btoa, not Node. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Fetches a resource on behalf of the page-context serializer.
 *
 * SingleFile runs in the page, where cross-origin requests are subject to the
 * page's CORS policy; the worker fetches under the extension's host permissions
 * instead. Bytes cross the message boundary base64-encoded because a Chrome
 * message is JSON.
 */
export async function fetchResourceForPage(
  url: string,
  options: FetchOptions,
): Promise<ResourceFetchResponse> {
  try {
    const asset = await fetchAssetBytes(url, options);
    return {
      ok: true,
      status: 200,
      body: toBase64(asset.bytes),
      headers: asset.contentType ? { 'content-type': asset.contentType } : {},
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
