import type { Page } from 'playwright';
import { defaultSettings, type PageIR } from '@quickcaps/core';
import { collectorBundleSource } from './collector-bundle.js';

/**
 * Injects the cached collector bundle into a real, already-navigated page
 * and calls it. The rest of CollectOptions (pageUrl, userAgent, viewport,
 * documentSize, devicePixelRatio) is read inside the page itself, from
 * location/navigator/window — the same values apps/extension's
 * runCollector reads, because both are answering "what does this page
 * look like from inside itself," which only the page can answer honestly.
 */
export async function collectViaPlaywright(page: Page): Promise<PageIR> {
  const source = await collectorBundleSource();
  await page.addScriptTag({ content: source });

  return page.evaluate((settings) => {
    const collect = (
      globalThis as unknown as {
        __quickcapsCollect: (options: unknown) => unknown;
      }
    ).__quickcapsCollect;

    return collect({
      settings,
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentSize: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
      },
      devicePixelRatio: window.devicePixelRatio,
    });
  }, defaultSettings) as Promise<PageIR>;
}
