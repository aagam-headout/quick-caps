import { chromium, type Page } from 'playwright';
import { assertFetchableUrl, type PageIR } from 'quick-caps-core';
import { flattenRegions } from 'quick-caps-core/distill';
import { collectViaStatic } from './collect-via-static.js';
import { collectViaPlaywright } from './collect-via-playwright.js';
import {
  attachNetworkRecorder,
  type NetworkRecorder,
} from './drivers/playwright-driver.js';
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
 * How long a recorded load is given to go quiet after `load` fires. The
 * traffic worth recording — the XHR a shell fires once it has booted — happens
 * *after* load, so returning at load would record the page's assets and miss
 * its API. Bounded and best-effort rather than an unbounded `networkidle`
 * wait: a page with a poll or a websocket never idles, and a recording is
 * never worth failing an `open` over.
 */
export const RECORDING_SETTLE_MS = 2_000;

export type RecordOptions = {
  /** Arms network recording for this load. */
  record?: boolean;
  /** Opts out of record-time redaction. Full fidelity is a decision, never a
   * default — see the design's "Redaction". */
  noRedact?: boolean;
};

/** Arms the page if asked, warning into the IR rather than failing: a
 * recording that could not be set up must cost the caller a warning, not their
 * `open`. Returns undefined when nothing was armed. */
function armRecording(
  page: Page,
  opts: RecordOptions,
  warnings: PageIR['warnings'],
): NetworkRecorder | undefined {
  if (opts.record !== true) return undefined;
  try {
    return attachNetworkRecorder(page, { redact: opts.noRedact !== true });
  } catch (error) {
    warnings.push({
      phase: 'collect',
      reason: 'network recording could not be armed',
      detail: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

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
export async function collectViaPlaywrightFor(
  url: string,
  opts: RecordOptions = {},
): Promise<PageIR> {
  try {
    await assertFetchableUrl(url);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const browser = await chromium.launch();
  const warnings: PageIR['warnings'] = [];
  try {
    const page = await browser.newPage();
    // Armed before goto: the load is the thing being observed, so there is no
    // way to arm it afterwards.
    const recorder = armRecording(page, opts, warnings);
    await page.goto(url);
    try {
      await assertFetchableUrl(page.url());
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (recorder !== undefined) {
      await page
        .waitForLoadState('networkidle', { timeout: RECORDING_SETTLE_MS })
        // A page that never goes quiet is normal, not an error; whatever was
        // observed by now is what gets recorded.
        .catch(() => undefined);
    }
    const ir = await collectViaPlaywright(page);
    if (recorder !== undefined) {
      try {
        ir.recording = await recorder.finish();
      } catch (error) {
        warnings.push({
          phase: 'collect',
          reason: 'network recording could not be finished',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (warnings.length > 0) ir.warnings = [...ir.warnings, ...warnings];
    return ir;
  } finally {
    await browser.close();
  }
}

/**
 * Static-first with escalation (spec §4): fetch via StaticDriver, and only
 * if it looks like an empty shell — and the caller hasn't opted out with
 * `static: true` — discard it and re-collect through a real browser.
 *
 * `record: true` skips the static attempt entirely. A static fetch witnesses
 * nothing — there is no page to watch, so there is nothing for a recording to
 * observe — which makes this the one option that decides the driver outright
 * rather than voting on it.
 */
export async function openUrl(
  url: string,
  opts: { static?: boolean } & RecordOptions = {},
): Promise<OpenResult> {
  try {
    await assertFetchableUrl(url);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  if (opts.record === true) {
    // Not even fetched statically first: the static IR would be discarded
    // whatever it looked like, and paying for a request to throw it away is
    // worse than skipping it.
    const ir = await collectViaPlaywrightFor(url, {
      record: true,
      ...(opts.noRedact === true && { noRedact: true }),
    });
    return { ir, driver: 'playwright' };
  }

  const staticIr = await collectViaStatic(url);
  if (opts.static === true || !looksLikeEmptyShell(staticIr)) {
    return { ir: staticIr, driver: 'static' };
  }

  const ir = await collectViaPlaywrightFor(url);
  return { ir, driver: 'playwright' };
}
