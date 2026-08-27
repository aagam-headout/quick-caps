import type { FetchedAsset } from './assets.js';
import type { Warning } from './ir.js';
import type { CaptureSettings } from './settings.js';

export type InlineInput = {
  pageUrl: string;
  settings: CaptureSettings;
  assets: Map<string, FetchedAsset>;
  /** Stylesheet text fetched by the host, keyed by absolute url. */
  styleTexts: Map<string, string>;
  /** Zip mode supplies this to get relative paths instead of data uris. */
  assetPath?: ((url: string) => string) | undefined;
  /** @import recursion cap. Cycles are the reason this exists. */
  importDepth?: number | undefined;
};

export type InlineResult = { warnings: Warning[] };

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without Node's Buffer or the browser's btoa, both banned in core. */
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out +=
      b1 === undefined
        ? '='
        : BASE64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 63];
  }
  return out;
}

export function toDataUri(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  return `data:${contentType ?? 'application/octet-stream'};base64,${base64(bytes)}`;
}

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

export function rewriteCssUrls(
  css: string,
  mapUrl: (url: string) => string,
): string {
  return css.replace(URL_PATTERN, (match, quote: string, url: string) => {
    if (url.startsWith('data:')) return match;
    return `url(${quote}${mapUrl(url)}${quote})`;
  });
}

const IMPORT_PATTERN =
  /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/g;

export function resolveImports(
  css: string,
  resolve: (url: string) => string | null,
  depth: number,
): string {
  if (depth <= 0) return css;
  return css.replace(
    IMPORT_PATTERN,
    (match, _quote1, url1: string, _quote2, url2: string) => {
      const text = resolve(url1 ?? url2);
      if (text === null) return match;
      return resolveImports(text, resolve, depth - 1);
    },
  );
}

function absolutize(raw: string | null, base: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) {
    return null;
  }
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

/**
 * Rewrites the document in place so it renders standalone. The mutation is
 * deliberate: on a large page, cloning the tree is the difference between
 * working and running out of memory.
 */
export function inlineDocument(
  doc: Document,
  input: InlineInput,
): InlineResult {
  const warnings: Warning[] = [];
  const { pageUrl, settings, assets, styleTexts, assetPath } = input;
  const baseHref = doc.querySelector('base')?.getAttribute('href') ?? pageUrl;

  const referenceFor = (url: string, referencedBy: string): string | null => {
    if (assetPath) return assetPath(url);
    const fetched = assets.get(url);
    if (!fetched) {
      warnings.push({
        phase: 'assets',
        url,
        reason: 'asset not available',
        detail: referencedBy,
      });
      return null;
    }
    return toDataUri(fetched.bytes, fetched.contentType);
  };

  const rewriteSrcset = (value: string, referencedBy: string): string =>
    value
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        const url = absolutize(parts[0] ?? '', baseHref);
        if (!url) return candidate.trim();
        const replacement = referenceFor(url, referencedBy);
        if (!replacement) return candidate.trim();
        return [replacement, ...parts.slice(1)].join(' ');
      })
      .join(', ');

  for (const anchor of doc.querySelectorAll('a[href]')) {
    const absolute = absolutize(anchor.getAttribute('href'), baseHref);
    if (absolute) anchor.setAttribute('href', absolute);
  }
  doc.querySelector('base')?.remove();

  for (const img of doc.querySelectorAll('img')) {
    const absolute = absolutize(img.getAttribute('src'), baseHref);
    if (absolute) {
      const replacement = referenceFor(absolute, 'img[src]');
      if (replacement) img.setAttribute('src', replacement);
    }
    const srcset = img.getAttribute('srcset');
    if (srcset)
      img.setAttribute('srcset', rewriteSrcset(srcset, 'img[srcset]'));
  }

  for (const source of doc.querySelectorAll('picture source[srcset]')) {
    source.setAttribute(
      'srcset',
      rewriteSrcset(source.getAttribute('srcset') ?? '', 'source[srcset]'),
    );
  }

  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const href = absolutize(link.getAttribute('href'), baseHref);
    const text = href ? styleTexts.get(href) : undefined;
    if (!href || text === undefined) {
      if (href) {
        warnings.push({
          phase: 'styles',
          url: href,
          reason: 'stylesheet not available',
          detail: 'link removed from the snapshot',
        });
      }
      link.remove();
      continue;
    }

    const resolved = resolveImports(
      text,
      (importUrl) => {
        const absolute = absolutize(importUrl, href);
        if (!absolute) return null;
        const imported = styleTexts.get(absolute);
        if (imported === undefined) {
          warnings.push({
            phase: 'styles',
            url: absolute,
            reason: 'imported stylesheet not available',
            detail: `left as @import in ${href}`,
          });
          return null;
        }
        return imported;
      },
      input.importDepth ?? 5,
    );

    const style = doc.createElement('style');
    style.setAttribute('data-capture-src', href);
    style.textContent = rewriteCssUrls(resolved, (url) => {
      const assetUrl = absolutize(url, href);
      if (!assetUrl) return url;
      return referenceFor(assetUrl, 'css url()') ?? url;
    });
    link.replaceWith(style);
  }

  for (const style of doc.querySelectorAll('style')) {
    if (style.hasAttribute('data-capture-src')) continue;
    style.textContent = rewriteCssUrls(style.textContent ?? '', (url) => {
      const assetUrl = absolutize(url, baseHref);
      if (!assetUrl) return url;
      return referenceFor(assetUrl, 'inline css url()') ?? url;
    });
  }

  for (const script of doc.querySelectorAll('script')) {
    if (!settings.include.scripts) {
      script.remove();
      continue;
    }
    const src = absolutize(script.getAttribute('src'), baseHref);
    if (src) {
      const replacement = referenceFor(src, 'script[src]');
      if (replacement) script.setAttribute('src', replacement);
    }
    if (settings.inertSnapshot) {
      // Archived scripts stay readable but must not execute when the snapshot
      // is reopened — a saved page should not re-run analytics or phone home.
      const original = script.getAttribute('type');
      if (original) script.setAttribute('data-capture-type', original);
      script.setAttribute('type', 'text/plain');
    }
  }

  if (settings.inertSnapshot) {
    for (const el of doc.querySelectorAll('*')) {
      for (const attribute of [...el.attributes]) {
        if (attribute.name.startsWith('on')) {
          el.setAttribute(`data-capture-${attribute.name}`, attribute.value);
          el.removeAttribute(attribute.name);
        }
      }
    }
  }

  return { warnings };
}
