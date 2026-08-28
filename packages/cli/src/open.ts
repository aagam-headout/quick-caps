import { chromium } from 'playwright';
import { assertFetchableUrl, type PageIR } from 'quickcaps-core';
import { flattenRegions } from 'quickcaps-core/distill';
import { collectViaStatic } from './collect-via-static.js';
import { collectViaPlaywright } from './collect-via-playwright.js';
import { CliError } from './errors.js';

/** Both thresholds are validated against the acceptance corpus (spec §7),
 * not derived in the abstract. */
export const EMPTY_SHELL_TEXT_THRESHOLD = 200;
export const EMPTY_SHELL_REGION_THRESHOLD = 5;

/**
 * True iff the static fetch looks like an unrendered SPA shell: both the
 * total text across every region and the region count itself are below
 * threshold. Either condition alone can be true of a legitimately thin
 * real page (a single big image, a one-line landing page) — both together
 * is the SPA-shell signature.
 *
 * `Region.textLength` is cumulative subtree text (own text plus every
 * descendant's), so a top-level region's `textLength` already includes
 * everything beneath it. Summing across every flattened region would
 * double/triple-count the same characters once per ancestor level — only
 * depth-1 (top-level) entries are summed to get the page's total text
 * exactly once.
 */
export function looksLikeEmptyShell(ir: PageIR): boolean {
  const flat = flattenRegions(ir.regions);
  const totalText = flat
    .filter((entry) => entry.depth === 1)
    .reduce((sum, entry) => sum + entry.region.textLength, 0);
  return (
    totalText < EMPTY_SHELL_TEXT_THRESHOLD &&
    flat.length < EMPTY_SHELL_REGION_THRESHOLD
  );
}

export type OpenResult = {
  ir: PageIR;
  driver: 'static' | 'playwright';
};

/**
 * Launches a fresh browser, navigates to url, collects, closes the
 * browser. Extracted out of openUrl's escalation branch so
 * ensure-playwright.ts (Phase C2) can reuse the exact same
 * launch/navigate/collect/close sequence for its own unconditional
 * escalation, rather than duplicating it.
 *
 * Validates the URL both before and after navigation. The pre-navigation
 * check makes this function self-validating regardless of caller —
 * ensure-playwright.ts calls this directly with a session-stored URL and
 * has no check of its own, so this is the only guard on that path. The
 * post-navigation check re-validates `page.url()` (what the browser
 * actually landed on after following any redirects), since a redirect can
 * carry the request to a private/internal address the pre-navigation
 * check on the original `url` never saw.
 */
export async function collectViaPlaywrightFor(url: string): Promise<PageIR> {
  try {
    await assertFetchableUrl(url);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url);
    try {
      await assertFetchableUrl(page.url());
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : String(error),
      );
    }
    return await collectViaPlaywright(page);
  } finally {
    await browser.close();
  }
}

/**
 * Static-first with escalation (spec §4): fetch via StaticDriver, and only
 * if it looks like an empty shell — and the caller hasn't opted out with
 * `static: true` — discard it and re-collect through a real browser.
 */
export async function openUrl(
  url: string,
  opts: { static?: boolean } = {},
): Promise<OpenResult> {
  try {
    await assertFetchableUrl(url);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const staticIr = await collectViaStatic(url);
  if (opts.static === true || !looksLikeEmptyShell(staticIr)) {
    return { ir: staticIr, driver: 'static' };
  }

  const ir = await collectViaPlaywrightFor(url);
  return { ir, driver: 'playwright' };
}
