import type {
  AssetKind,
  AssetRef,
  PageIR,
  PageMetadata,
  StyleSource,
  StyleTally,
  Warning,
} from './ir.js';
import type { CaptureSettings } from './settings.js';
import { buildRegions } from './regions.js';
import { tallyComputedStyles } from './tokens.js';

export type CollectOptions = {
  settings: CaptureSettings;
  pageUrl: string;
  userAgent: string;
  viewport: { width: number; height: number };
  documentSize: { width: number; height: number };
  devicePixelRatio: number;
  now?: () => Date;
  /** Injected because the global is unavailable to core by design. */
  computedStyle?: (el: Element) => Record<string, string>;
  logs?: PageIR['logs'];
  perf?: PageIR['perf'];
  maxRegionDepth?: number;
};

export const emptyTally = (): StyleTally => ({
  color: {},
  backgroundColor: {},
  borderColor: {},
  fontFamily: {},
  fontSize: {},
  lineHeight: {},
  fontWeight: {},
  spacing: {},
  borderRadius: {},
  boxShadow: {},
});

function absolutize(
  raw: string,
  base: string,
  warnings: Warning[],
  referencedBy: string,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) {
    return null;
  }
  try {
    return new URL(trimmed, base).href;
  } catch {
    warnings.push({
      phase: 'collect',
      url: trimmed,
      reason: 'unparseable url',
      detail: referencedBy,
    });
    return null;
  }
}

function emptyMetadata(options: CollectOptions): PageMetadata {
  return {
    url: options.pageUrl,
    title: '',
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    viewport: options.viewport,
    documentSize: options.documentSize,
    devicePixelRatio: options.devicePixelRatio,
    userAgent: options.userAgent,
    charset: 'utf-8',
    meta: {},
  };
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

/**
 * Reads a document into a PageIR. Records references only — nothing is fetched
 * here, because fetching needs host credentials and lives behind PageDriver.
 */
export function collectFromDocument(
  doc: Document,
  options: CollectOptions,
): PageIR {
  const warnings: Warning[] = [];
  const { settings, pageUrl } = options;

  // Checked before anything walks the tree: a document with no root element
  // cannot be queried at all, so this has to fail fast rather than defensively.
  if (!doc.documentElement) {
    return {
      metadata: emptyMetadata(options),
      html: '',
      regions: [],
      styles: [],
      assets: [],
      styleTally: emptyTally(),
      warnings: [
        {
          phase: 'collect',
          reason: 'the document has no root element',
          detail: 'nothing to capture',
        },
      ],
    };
  }

  const base = doc.querySelector('base')?.getAttribute('href') ?? pageUrl;

  const assets = new Map<string, AssetRef>();
  const addAsset = (
    raw: string | null,
    kind: AssetKind,
    referencedBy: string,
  ): void => {
    if (!raw) return;
    const url = absolutize(raw, base, warnings, referencedBy);
    if (!url || assets.has(url)) return;
    assets.set(url, { url, kind, referencedBy });
  };

  const styles: StyleSource[] = [];
  let inlineIndex = 0;
  for (const el of doc.querySelectorAll('style')) {
    styles.push({
      kind: 'inline',
      text: el.textContent ?? '',
      index: inlineIndex++,
    });
  }

  if (settings.include.styles) {
    // A page url that will not parse is not a reason to abandon the capture;
    // it only means cross-origin cannot be judged, so nothing is treated as
    // same-origin.
    let pageOrigin: string | null = null;
    try {
      pageOrigin = new URL(pageUrl).origin;
    } catch {
      warnings.push({
        phase: 'collect',
        url: pageUrl,
        reason: 'page url could not be parsed',
        detail: 'stylesheets were treated as cross-origin',
      });
    }
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const url = absolutize(
        link.getAttribute('href') ?? '',
        base,
        warnings,
        'link[rel=stylesheet]',
      );
      if (!url) continue;
      if (pageOrigin !== null && new URL(url).origin === pageOrigin) {
        addAsset(url, 'stylesheet', 'link[rel=stylesheet]');
      } else {
        styles.push({ kind: 'cross-origin', href: url });
      }
    }
  }

  if (settings.include.images) {
    for (const img of doc.querySelectorAll('img')) {
      addAsset(img.getAttribute('src'), 'image', 'img[src]');
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        for (const url of srcsetUrls(srcset)) {
          addAsset(url, 'image', 'img[srcset]');
        }
      }
    }
    for (const source of doc.querySelectorAll('picture source[srcset]')) {
      for (const url of srcsetUrls(source.getAttribute('srcset') ?? '')) {
        addAsset(url, 'image', 'source[srcset]');
      }
    }
  }

  if (settings.include.scripts) {
    for (const script of doc.querySelectorAll('script[src]')) {
      addAsset(script.getAttribute('src'), 'script', 'script[src]');
    }
  }

  for (const el of doc.querySelectorAll('video[src], audio[src]')) {
    addAsset(el.getAttribute('src'), 'media', el.tagName.toLowerCase());
  }

  const meta: Record<string, string> = {};
  for (const tag of doc.querySelectorAll('meta[name][content]')) {
    const name = tag.getAttribute('name');
    const content = tag.getAttribute('content');
    if (name && content) meta[name] = content;
  }

  const metadata: PageMetadata = {
    url: pageUrl,
    title: doc.title,
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    viewport: options.viewport,
    documentSize: options.documentSize,
    devicePixelRatio: options.devicePixelRatio,
    userAgent: options.userAgent,
    charset: doc.characterSet?.toLowerCase() || 'utf-8',
    meta,
  };

  return {
    metadata,
    html: doc.documentElement.outerHTML,
    regions: buildRegions(doc, { maxDepth: options.maxRegionDepth ?? 12 }),
    styles,
    assets: [...assets.values()],
    styleTally: options.computedStyle
      ? tallyComputedStyles(
          doc.querySelectorAll('body *'),
          options.computedStyle,
          emptyTally(),
        )
      : emptyTally(),
    ...(options.logs ? { logs: options.logs } : {}),
    ...(options.perf ? { perf: options.perf } : {}),
    warnings,
  };
}
