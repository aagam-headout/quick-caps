import {
  buildSingleFile,
  buildTokens,
  buildZip,
  type CaptureSettings,
  type FetchOptions,
  type PageIR,
  type Warning,
} from 'quick-caps-core';
import type { CaptureProgress } from './messages.js';

export type Frame = { dataUrl: string; offsetY: number };

/** Ceiling on a screenshot embedded inline in single-file output. */
const MAX_INLINE_SCREENSHOT_BYTES = 24 * 1024 * 1024;

const formatMB = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export type CaptureInput = {
  ir: PageIR;
  /** Already self-contained: single-file-core inlined it in the page. */
  html: string;
  settings: CaptureSettings;
  frames?: Frame[] | undefined;
  /**
   * Canvas size for stitching, from chrome-driver's own scroll-root-aware
   * measurement (chrome-driver.ts's viewport()). Falls back to
   * ir.metadata.documentSize when absent, but that field comes from a
   * simpler document.documentElement.scrollWidth/scrollHeight in the content
   * collector and under-reports on app-shell pages that scroll an inner
   * container instead of <html>/<body> - using it for canvas sizing there
   * clips every frame captured past the first viewport.
   */
  screenshotGeometry?:
    { width: number; height: number; devicePixelRatio: number } | undefined;
};

export type CaptureDeps = {
  fetchText: (url: string, options: FetchOptions) => Promise<string>;
  stitch: (input: {
    frames: Frame[];
    width: number;
    height: number;
    devicePixelRatio: number;
  }) => Promise<Uint8Array>;
  createObjectUrl: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  onProgress: (progress: CaptureProgress) => void;
};

export type CaptureResult = {
  filename: string;
  mimeType: string;
  byteLength: number;
  objectUrl: string;
  warnings: Warning[];
  hasTokens: boolean;
};

/**
 * Assembles the archive from a serialized page.
 *
 * Asset fetching and inlining used to live here; single-file-core does both in
 * the page context now, far better than the hand-rolled version did. What
 * remains is what SingleFile does not produce: the screenshot, the design-token
 * report, raw sources, and the archive itself.
 */
export async function runCapture(
  input: CaptureInput,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const { ir, settings } = input;
  const warnings: Warning[] = [...ir.warnings];

  // An empty document would bundle happily into a zero-byte page that looks
  // like a successful capture. Refusing is the honest outcome.
  if (input.html.trim().length === 0) {
    throw new Error('the serialized page was empty - nothing was captured');
  }
  const report = (
    phase: CaptureProgress['phase'],
    done = 0,
    total = 0,
  ): void => {
    deps.onProgress({ phase, done, total, warningCount: warnings.length });
  };

  const fetchOptions: FetchOptions = {
    timeoutMs: settings.limits.assetTimeoutMs,
    maxBytes: settings.limits.maxAssetBytes,
  };

  const isSelective = settings.selectionSelector.trim().length > 0;

  // Raw network sources: what the server sent, before any JavaScript ran. The
  // one thing a serialized live DOM cannot tell you.
  //
  // Skipped for a selective capture: the DOM was pruned down to one
  // element's ancestor chain, but `<head>` (and so ir.assets, gathered by
  // walking the whole document) is untouched by that pruning - this would
  // otherwise still re-fetch every stylesheet and script on the page in
  // full, in service of a capture the user asked to be just one element.
  let rawSources: Map<string, string> | undefined;
  if (settings.include.rawSources && isSelective) {
    warnings.push({
      phase: 'assets',
      reason:
        'raw sources are skipped for a selective (single-element) capture',
      detail: 'the rest of the capture is intact',
    });
  } else if (settings.include.rawSources) {
    rawSources = new Map();
    // Deduplicated: a page listing the same stylesheet twice would otherwise
    // be fetched twice and stored once, so the progress total overcounts and
    // the network work is wasted.
    const urls = [
      ...new Set([
        ir.metadata.url,
        ...ir.assets
          .filter(
            (asset) => asset.kind === 'script' || asset.kind === 'stylesheet',
          )
          .map((asset) => asset.url),
      ]),
    ].filter((url) => typeof url === 'string' && url.length > 0);
    report('fetching-assets', 0, urls.length);
    let done = 0;
    for (const url of urls) {
      try {
        rawSources.set(url, await deps.fetchText(url, fetchOptions));
      } catch (error) {
        warnings.push({
          phase: 'assets',
          url,
          reason: error instanceof Error ? error.message : String(error),
          detail: 'raw source omitted',
        });
      }
      report('fetching-assets', ++done, urls.length);
    }
  }

  // Skipped for a selective capture for the same reason as raw sources:
  // frame capture (chrome-driver.ts) scrolls and screenshots the whole
  // document, unaware of any DOM pruning - a picked element would otherwise
  // still embed a full-page screenshot alongside it.
  let screenshot: Uint8Array | undefined;
  if (settings.include.screenshot && isSelective) {
    report('screenshot');
    warnings.push({
      phase: 'screenshot',
      reason:
        'the screenshot is skipped for a selective (single-element) capture',
      detail: 'the rest of the capture is intact',
    });
  } else if (settings.include.screenshot) {
    report('screenshot');
    if (!input.frames || input.frames.length === 0) {
      // The caller that does the framing (chrome-driver, via the worker)
      // reports its own reason when it fails; a second, vaguer warning saying
      // the same thing helps nobody.
      if (!warnings.some((warning) => warning.phase === 'screenshot')) {
        warnings.push({
          phase: 'screenshot',
          reason: 'no frames were captured',
          detail:
            'the screenshot was omitted; the rest of the capture is intact',
        });
      }
    } else {
      try {
        screenshot = await deps.stitch({
          frames: input.frames,
          width:
            input.screenshotGeometry?.width ?? ir.metadata.documentSize.width,
          height:
            input.screenshotGeometry?.height ?? ir.metadata.documentSize.height,
          devicePixelRatio:
            input.screenshotGeometry?.devicePixelRatio ??
            ir.metadata.devicePixelRatio,
        });
      } catch (error) {
        warnings.push({
          phase: 'screenshot',
          reason: error instanceof Error ? error.message : String(error),
          detail:
            'the screenshot was omitted; the rest of the capture is intact',
        });
      }
    }
  }

  // Single-file output carries the screenshot base64-encoded inline, which
  // costs a third again in size and has to be held as one string. A zip stores
  // the same bytes verbatim, so this ceiling applies only to the html path.
  if (
    screenshot &&
    settings.output !== 'zip' &&
    screenshot.byteLength > MAX_INLINE_SCREENSHOT_BYTES
  ) {
    warnings.push({
      phase: 'screenshot',
      reason: `the screenshot is ${formatMB(screenshot.byteLength)}, too large to embed in a single HTML file`,
      detail:
        'switch Output to "ZIP folder" to keep it; the rest of the capture is intact',
    });
    screenshot = undefined;
  }

  report('bundling');
  const tokens = settings.include.tokens
    ? buildTokens(ir.styleTally, { minCount: 2, maxPerGroup: 24 })
    : undefined;

  const bundleInput = {
    ir: { ...ir, warnings },
    settings,
    html: input.html,
    tokens,
    screenshot,
    rawSources,
  };
  // Packaging is the one step with no partial result to fall back on: it is
  // synchronous, it holds the whole capture in memory at once, and what it
  // throws on a very large page ("Array buffer allocation failed") means
  // nothing to the person who pressed Capture.
  let bundle;
  try {
    bundle =
      settings.output === 'zip'
        ? buildZip(bundleInput)
        : buildSingleFile(bundleInput);
  } catch (error) {
    throw new Error(
      `The capture was too large to package (${error instanceof Error ? error.message : String(error)}). Try turning off raw sources or the screenshot.`,
      { cause: error },
    );
  }

  let objectUrl: string;
  try {
    objectUrl = await deps.createObjectUrl(bundle.bytes, bundle.mimeType);
  } catch {
    throw new Error(
      'The capture could not be prepared for download - it may be too large. Try a smaller page or fewer extras.',
    );
  }
  report('done');

  return {
    filename: bundle.filename,
    mimeType: bundle.mimeType,
    byteLength: bundle.bytes.byteLength,
    objectUrl,
    warnings,
    hasTokens: tokens !== undefined,
  };
}
