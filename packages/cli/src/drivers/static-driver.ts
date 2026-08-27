import { parseHTML } from 'linkedom';
import {
  fetchAssetBytes,
  type AssetBytes,
  type FetchOptions,
  type PageDriver,
  type Viewport,
} from '@page-capture/core';

/**
 * PageDriver over a linkedom-parsed document with no browser and no layout
 * engine — the fast path for pages that don't need rendering (spec §12.1:
 * only-cli's ergonomics for the cases that don't need rendered-DOM fidelity).
 *
 * `screenshotFullPage` throws rather than returning empty bytes: there is
 * nothing to screenshot, and a caller that asked for one has a real bug to
 * fix (falling back to PlaywrightDriver), not a value to silently accept.
 */
export class StaticDriver implements PageDriver {
  private readonly window: Window & typeof globalThis;
  private readonly document: Document;
  private scroll = { x: 0, y: 0 };
  readonly url: string | undefined;

  constructor(html: string, url?: string) {
    const parsed = parseHTML(html);
    this.window = parsed.window as unknown as Window & typeof globalThis;
    this.document = parsed.document as unknown as Document;
    this.url = url;
  }

  static async fetch(url: string): Promise<StaticDriver> {
    const asset = await fetchAssetBytes(url, {
      timeoutMs: 15_000,
      maxBytes: 20 * 1024 * 1024,
    });
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
