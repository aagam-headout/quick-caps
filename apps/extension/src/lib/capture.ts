import {
  buildSingleFile,
  buildTokens,
  buildZip,
  type CaptureSettings,
  type FetchOptions,
  type PageIR,
  type Warning,
} from '@page-capture/core';
import type { CaptureProgress } from './messages.js';

export type Frame = { dataUrl: string; offsetY: number };

export type CaptureInput = {
  ir: PageIR;
  /** Already self-contained: single-file-core inlined it in the page. */
  html: string;
  settings: CaptureSettings;
  frames?: Frame[] | undefined;
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

  // Raw network sources: what the server sent, before any JavaScript ran. The
  // one thing a serialized live DOM cannot tell you.
  let rawSources: Map<string, string> | undefined;
  if (settings.include.rawSources) {
    rawSources = new Map();
    const urls = [
      ir.metadata.url,
      ...ir.assets
        .filter(
          (asset) => asset.kind === 'script' || asset.kind === 'stylesheet',
        )
        .map((asset) => asset.url),
    ];
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

  let screenshot: Uint8Array | undefined;
  if (settings.include.screenshot) {
    report('screenshot');
    if (!input.frames || input.frames.length === 0) {
      warnings.push({
        phase: 'screenshot',
        reason: 'no frames were captured',
        detail: 'the screenshot was omitted; the rest of the capture is intact',
      });
    } else {
      try {
        screenshot = await deps.stitch({
          frames: input.frames,
          width: ir.metadata.documentSize.width,
          height: ir.metadata.documentSize.height,
          devicePixelRatio: ir.metadata.devicePixelRatio,
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
  const bundle =
    settings.output === 'zip'
      ? buildZip(bundleInput)
      : buildSingleFile(bundleInput);

  const objectUrl = await deps.createObjectUrl(bundle.bytes, bundle.mimeType);
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
