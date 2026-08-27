import {
  assetPathFor,
  buildSingleFile,
  buildTokens,
  buildZip,
  extractCssUrls,
  fetchAssets,
  inlineDocument,
  type AssetBytes,
  type AssetKind,
  type AssetRef,
  type CaptureSettings,
  type FetchOptions,
  type FetchedAsset,
  type PageIR,
  type Warning,
} from '@page-capture/core';
import type { CaptureProgress } from './messages.js';

export type Frame = { dataUrl: string; offsetY: number };

export type CaptureInput = {
  ir: PageIR;
  settings: CaptureSettings;
  /** False when the user declined the cross-origin host permission. */
  hasHostPermission: boolean;
  /** Screenshot frames captured by the worker, which owns chrome.tabs. */
  frames?: Frame[] | undefined;
};

export type CaptureDeps = {
  fetchAsset: (url: string, options: FetchOptions) => Promise<AssetBytes>;
  fetchText: (url: string, options: FetchOptions) => Promise<string>;
  stitch: (input: {
    frames: Frame[];
    width: number;
    height: number;
    devicePixelRatio: number;
  }) => Promise<Uint8Array>;
  parseDocument: (html: string) => Document;
  serializeDocument: (doc: Document) => string;
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
 * Everything between a collected PageIR and a downloadable archive.
 *
 * Runs in the offscreen document, not the service worker: parsing HTML needs
 * DOMParser and producing a download needs createObjectURL, neither of which a
 * worker has. Fetching happens here too, so asset bytes never cross a message
 * boundary — only the IR, the frame data URLs, and the finished object URL do.
 *
 * Every dependency is injected, which is what lets this be tested in Node
 * against linkedom with no browser at all.
 */
export async function runCapture(
  input: CaptureInput,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const { ir, settings } = input;
  const warnings: Warning[] = [...ir.warnings];
  const report = (
    phase: CaptureProgress['phase'],
    done = 0,
    total = 0,
  ): void => {
    deps.onProgress({ phase, done, total, warningCount: warnings.length });
  };

  if (!input.hasHostPermission) {
    warnings.push({
      phase: 'permissions',
      reason:
        'host permission declined - cross-origin stylesheets and assets were skipped',
    });
  }

  const fetchOptions: FetchOptions = {
    timeoutMs: settings.limits.assetTimeoutMs,
    maxBytes: settings.limits.maxAssetBytes,
  };

  // Assets. Cross-origin references are only reachable with the host grant.
  const fetchable = input.hasHostPermission
    ? ir.assets
    : ir.assets.filter(
        (asset) =>
          new URL(asset.url).origin === new URL(ir.metadata.url).origin,
      );

  report('fetching-assets', 0, fetchable.length);
  const fetched = await fetchAssets(deps.fetchAsset, fetchable, {
    limits: settings.limits,
    onProgress: ({ done, total }) => report('fetching-assets', done, total),
  });
  warnings.push(...fetched.warnings);

  // Stylesheet text, keyed by absolute url.
  const styleTexts = new Map<string, string>();
  for (const style of ir.styles) {
    if (style.kind === 'same-origin') {
      styleTexts.set(style.href, style.text);
      continue;
    }
    if (style.kind !== 'cross-origin') continue;
    if (!input.hasHostPermission) continue;
    try {
      styleTexts.set(
        style.href,
        await deps.fetchText(style.href, fetchOptions),
      );
    } catch (error) {
      warnings.push({
        phase: 'styles',
        url: style.href,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const [url, asset] of fetched.assets) {
    if (asset.ref.kind === 'stylesheet') {
      styleTexts.set(url, new TextDecoder().decode(asset.bytes));
    }
  }

  // Second pass: webfonts and CSS background images are referenced only from
  // inside stylesheets, so nothing in the DOM points at them and the first pass
  // never saw them. Without this, every capture silently loses its fonts.
  const cssReferenced = new Map<string, AssetRef>();
  const noteCssReference = (url: string, from: string): void => {
    const kind: AssetKind = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i.test(url)
      ? 'font'
      : 'image';
    if (kind === 'font' && !settings.include.fonts) return;
    if (kind === 'image' && !settings.include.images) return;
    if (fetched.assets.has(url) || cssReferenced.has(url)) return;
    if (
      !input.hasHostPermission &&
      new URL(url).origin !== new URL(ir.metadata.url).origin
    ) {
      return;
    }
    cssReferenced.set(url, { url, kind, referencedBy: from });
  };

  for (const [href, css] of styleTexts) {
    for (const url of extractCssUrls(css, href)) {
      noteCssReference(url, `css url() in ${href}`);
    }
  }
  for (const style of ir.styles) {
    if (style.kind !== 'inline') continue;
    for (const url of extractCssUrls(style.text, ir.metadata.url)) {
      noteCssReference(url, 'css url() in inline style');
    }
  }

  if (cssReferenced.size > 0) {
    report('fetching-assets', 0, cssReferenced.size);
    const extra = await fetchAssets(
      deps.fetchAsset,
      [...cssReferenced.values()],
      {
        limits: {
          ...settings.limits,
          // Both passes share one budget.
          maxTotalBytes: Math.max(
            0,
            settings.limits.maxTotalBytes - fetched.totalBytes,
          ),
        },
        onProgress: ({ done, total }) => report('fetching-assets', done, total),
      },
    );
    for (const [url, asset] of extra.assets) fetched.assets.set(url, asset);
    warnings.push(...extra.warnings);
  }

  // Raw network sources: what the server sent, before any JavaScript ran.
  let rawSources: Map<string, string> | undefined;
  if (settings.include.rawSources) {
    rawSources = new Map();
    const urls = [
      ir.metadata.url,
      ...ir.assets
        .filter((a) => a.kind === 'script' || a.kind === 'stylesheet')
        .map((a) => a.url),
    ];
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
    }
  }

  // Screenshot.
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

  // Rewrite and bundle.
  report('bundling');
  const assets: Map<string, FetchedAsset> = fetched.assets;
  const document_ = deps.parseDocument(ir.html);
  const inlined = inlineDocument(document_, {
    pageUrl: ir.metadata.url,
    settings,
    assets,
    styleTexts,
    assetPath:
      settings.output === 'zip'
        ? (url) => assetPathFor(url, assets.get(url)?.ref.kind ?? 'image')
        : undefined,
  });
  warnings.push(...inlined.warnings);

  const tokens = settings.include.tokens
    ? buildTokens(ir.styleTally, { minCount: 2, maxPerGroup: 24 })
    : undefined;

  const bundleInput = {
    ir: { ...ir, warnings },
    settings,
    html: `<!doctype html>\n${deps.serializeDocument(document_)}`,
    assets,
    styleTexts,
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
