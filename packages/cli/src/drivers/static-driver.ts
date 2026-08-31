import { parseHTML } from 'linkedom';
import {
  fetchAssetBytes,
  type AssetBytes,
  type FetchOptions,
  type PageDriver,
  type Viewport,
} from 'quick-caps-core';
import { HttpStatusError } from '../errors.js';

/** `fetch`, but a refused response arrives as an HttpStatusError rather than
 * as bytes core will reject with a bare string. Only the document fetch uses
 * it: a sub-asset's status is nothing any caller acts on, and assets.ts already
 * degrades those to warnings. */
const failOnErrorStatus: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new HttpStatusError(
      response.status,
      response.statusText,
      response.headers.get('retry-after') ?? undefined,
    );
  }
  return response;
};

/**
 * PageDriver over a linkedom-parsed document with no browser and no layout
 * engine — the fast path for pages that don't need rendered-DOM fidelity
 * (spec §12.1).
 *
 * `screenshotFullPage` throws rather than returning empty bytes: there is
 * nothing to screenshot, and a caller that asked for one has a real bug to
 * fix (falling back to PlaywrightDriver), not a value to silently accept.
 */
export class StaticDriver implements PageDriver {
  private readonly window: Window & typeof globalThis;
  /** Public so collect-via-static.ts can call collectFromDocument directly
   * against this in-memory document — no serialization boundary exists
   * within the same Node process, unlike PlaywrightDriver's page. */
  readonly document: Document;
  private scroll = { x: 0, y: 0 };
  readonly url: string | undefined;

  constructor(html: string, url?: string) {
    const parsed = parseHTML(html);
    this.window = parsed.window as unknown as Window & typeof globalThis;
    this.document = parsed.document as unknown as Document;
    this.url = url;
  }

  static async fetch(url: string): Promise<StaticDriver> {
    const asset = await fetchAssetBytes(
      url,
      {
        timeoutMs: 15_000,
        maxBytes: 20 * 1024 * 1024,
      },
      // core refuses a non-ok response with a message-only Error, which loses
      // the status and every header. It takes a fetch, so the refusal happens
      // here instead, one step earlier, where the response is still a
      // response — the crawler's backoff needs `Retry-After`, and a caller
      // that only wanted the bytes still sees the same message.
      failOnErrorStatus,
    );
    return new StaticDriver(new TextDecoder().decode(asset.bytes), asset.url);
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousDocument = globals['document'];
    const previousWindow = globals['window'];
    globals['document'] = this.document;
    globals['window'] = this.window;
    try {
      return fn();
    } finally {
      globals['document'] = previousDocument;
      globals['window'] = previousWindow;
    }
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    return fetchAssetBytes(url, options);
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    throw new Error(
      'StaticDriver has no renderer — use PlaywrightDriver for a screenshot',
    );
  }

  async scrollTo(x: number, y: number): Promise<void> {
    this.scroll = { x, y };
  }

  async viewport(): Promise<Viewport> {
    return {
      // linkedom has no layout engine — these are the only two dimensions it
      // can answer honestly, and both are 0 for a page with no styled boxes.
      width: 0,
      height: 0,
      documentWidth: this.document.documentElement.scrollWidth,
      documentHeight: this.document.documentElement.scrollHeight,
      scrollX: this.scroll.x,
      scrollY: this.scroll.y,
      devicePixelRatio: 1,
    };
  }
}
