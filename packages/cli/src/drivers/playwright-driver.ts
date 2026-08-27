import type { Page } from 'playwright';
import {
  fetchAssetBytes,
  type AssetBytes,
  type FetchOptions,
  type PageDriver,
  type Viewport,
} from '@page-capture/core';

/**
 * PageDriver over a live Playwright page. Every core function already proven
 * against FakeDriver runs against this one unchanged — see
 * packages/cli/tests/driver-conformance.ts.
 */
export class PlaywrightDriver implements PageDriver {
  constructor(private readonly page: Page) {}

  async evaluate<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn);
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    // Deliberately the default global fetch, not Playwright's context-bound
    // request API: that API shares the page's cookies and auth state, which
    // would make this the only driver whose asset fetches carry the user's
    // session — fetchAssetBytes's cookieless policy ("A capture must not
    // carry the user's session anywhere") applies the same way here as it
    // does for ChromeDriver and StaticDriver.
    return fetchAssetBytes(url, options);
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    return this.page.screenshot({ fullPage: true, type: 'png' });
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.page.evaluate(([px, py]) => window.scrollTo(px, py), [x, y] as [
      number,
      number,
    ]);
  }

  async viewport(): Promise<Viewport> {
    const size = this.page.viewportSize() ?? { width: 0, height: 0 };
    const metrics = await this.page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
    return { width: size.width, height: size.height, ...metrics };
  }
}
