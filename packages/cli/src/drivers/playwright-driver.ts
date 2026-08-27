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
    // Playwright's browser-context request API shares the page's cookies and
    // auth state but is not subject to the page's own CORS policy — the same
    // "credentialed, cross-origin-capable" property ChromeDriver gets from
    // the extension's host permissions.
    //
    // fetchAssetBytes enforces its timeout by aborting an AbortSignal, which
    // this adapter has no way to forward into Playwright's request API — so
    // `timeout` is passed straight through to Playwright itself instead,
    // which enforces it independently. fetchAssetBytes's own timer still
    // runs and still cleans up; whichever of the two fires first is the one
    // that rejects, which is fine, since both are set to the same duration.
    return fetchAssetBytes(
      url,
      options,
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = typeof input === 'string' ? input : input.toString();
        const headers = init?.headers as Record<string, string> | undefined;
        const response = await this.page.context().request.fetch(target, {
          ...(headers ? { headers } : {}),
          timeout: options.timeoutMs,
        });
        return new Response(new Uint8Array(await response.body()), {
          status: response.status(),
          headers: response.headers(),
        });
      }) as typeof fetch,
    );
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    return this.page.screenshot({ fullPage: true, type: 'png' });
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.page.evaluate(
      ([px, py]) => window.scrollTo(px, py),
      [x, y] as [number, number],
    );
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
