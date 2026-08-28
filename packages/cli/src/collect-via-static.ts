import {
  collectFromDocument,
  defaultSettings,
  type PageIR,
} from 'quickcaps-core';
import { StaticDriver } from './drivers/static-driver.js';

/**
 * Same Node process, same in-memory linkedom document as StaticDriver
 * parsed — collectFromDocument is called directly against it, no
 * serialization boundary, no injection (contrast collectViaPlaywright).
 */
export async function collectViaStatic(url: string): Promise<PageIR> {
  const driver = await StaticDriver.fetch(url);
  const viewport = await driver.viewport();

  return collectFromDocument(driver.document, {
    settings: defaultSettings,
    pageUrl: driver.url ?? url,
    userAgent: 'quickcaps-cli/static',
    viewport: { width: viewport.width, height: viewport.height },
    documentSize: {
      width: viewport.documentWidth,
      height: viewport.documentHeight,
    },
    devicePixelRatio: viewport.devicePixelRatio,
  });
}
