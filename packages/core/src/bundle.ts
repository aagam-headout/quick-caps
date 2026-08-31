import { strToU8, zipSync } from 'fflate';
import type { AssetKind, PageIR } from './ir.js';
import type { CaptureSettings } from './settings.js';
import type { TokenReport } from './tokens.js';
// Type-only, so this stays erased at build time: the extract layer must not
// become reachable from this barrel's runtime graph. See index.ts.
import type { DataReport } from './extract/types.js';
import { viewerPanelBlock } from './viewer.js';

export type BundleInput = {
  ir: PageIR;
  settings: CaptureSettings;
  /**
   * The self-contained document. Produced by single-file-core in the page
   * context, so assets are already inlined by the time it arrives here.
   */
  html: string;
  tokens?: TokenReport | undefined;
  /** The extraction report, when the host ran it. Partial because a failed
   * domain is absent rather than empty. */
  data?: Partial<DataReport> | undefined;
  screenshot?: Uint8Array | undefined;
  rawSources?: Map<string, string> | undefined;
};

export type BundleOutput = {
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
};

const ILLEGAL_CHARACTERS = /[^a-zA-Z0-9._-]/g;

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(ILLEGAL_CHARACTERS, '-').replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/** 32-bit FNV-1a. Short, stable, and not used for anything security-bearing. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function captureFilename(
  url: string,
  capturedAt: string,
  extension: string,
  template = '{host}-{timestamp}',
): string {
  let host = 'capture';
  try {
    host = new URL(url).hostname || host;
  } catch {
    /* an unparseable url keeps the fallback name */
  }
  // yyyyMMdd-HHmmss, split so {date} and {time} are usable independently.
  const timestamp = capturedAt
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  const [date = timestamp, time = ''] = timestamp.split('-');
  const tokens: Record<string, string> = { host, date, time, timestamp };
  // An unknown {token} degrades to its bare key name rather than throwing —
  // a typo in a custom template should still produce a usable filename, not
  // block the capture. (The braces themselves are illegal on some
  // platforms and would just get stripped anyway.)
  const rendered = template.replace(
    /\{(\w+)\}/g,
    (_whole, key: string) => tokens[key] ?? key,
  );
  const name = safeSegment(rendered, 'capture');
  return `${name.slice(0, 120 - extension.length - 1)}.${extension}`;
}

const DIRECTORY_BY_KIND: Record<AssetKind, string> = {
  image: 'images',
  font: 'fonts',
  script: 'scripts',
  media: 'media',
  stylesheet: 'styles',
};

/**
 * A relative path inside the archive. Built from a sanitized basename plus a
 * hash of the full url, so a `..` in the url cannot reach the output path and
 * two same-named files from different directories never collide.
 */
export function assetPathFor(url: string, kind: AssetKind): string {
  const directory = DIRECTORY_BY_KIND[kind];
  let basename = 'asset';
  let extension = '';
  try {
    const last =
      new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'asset';
    const dot = last.lastIndexOf('.');
    basename = dot > 0 ? last.slice(0, dot) : last;
    extension = dot > 0 ? last.slice(dot + 1) : '';
  } catch {
    /* an unparseable url keeps the fallbacks */
  }
  const safeExtension = safeSegment(extension, '');
  const suffix = safeExtension && extension ? `.${safeExtension}` : '';
  return `${directory}/${safeSegment(basename, 'asset')}-${shortHash(url)}${suffix}`;
}

/** Chunked so a multi-megabyte screenshot does not blow the argument limit of
 * String.fromCharCode with a single spread. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(
      ...(bytes.subarray(index, index + CHUNK) as unknown as number[]),
    );
  }
  return btoa(binary);
}

/**
 * The screenshot, embedded in single-file output.
 *
 * Hidden, because the capture must still open looking like the page it
 * captured — the viewer panel is what surfaces it. Without this the whole
 * screenshot pipeline (scrolling the page, capturing every viewport,
 * stitching) ran for single-file captures and its result was dropped on the
 * floor: the setting appeared to do nothing but make the capture slow.
 */
function screenshotBlock(bytes: Uint8Array): string {
  return `\n<img data-capture="screenshot" alt="Full-page screenshot of the captured page" style="display:none" src="data:image/png;base64,${toBase64(bytes)}">`;
}

function jsonBlock(name: string, value: unknown): string {
  // Escaping `</` keeps embedded json from terminating the script element it
  // rides in — the archive must not become an injection vector for its source.
  const json = JSON.stringify(value).replace(/<\//g, '<\\/');
  return `\n<script type="application/json" data-capture="${name}">${json}</script>`;
}

function metadataDocument(input: BundleInput) {
  return {
    ...input.ir.metadata,
    warnings: input.ir.warnings,
    regionCount: input.ir.regions.length,
    settings: input.settings,
  };
}

export function buildSingleFile(input: BundleInput): BundleOutput {
  const parts = [input.html];
  let hasDataBlock = false;
  if (input.screenshot && input.screenshot.byteLength > 0) {
    parts.push(screenshotBlock(input.screenshot));
    hasDataBlock = true;
  }
  if (input.settings.include.metadata) {
    parts.push(jsonBlock('metadata', metadataDocument(input)));
    hasDataBlock = true;
  }
  if (input.tokens) {
    parts.push(jsonBlock('tokens', input.tokens));
    hasDataBlock = true;
  }
  if (input.data) {
    parts.push(jsonBlock('data', input.data));
    hasDataBlock = true;
  }
  if (input.settings.include.logs && input.ir.logs) {
    parts.push(jsonBlock('logs', input.ir.logs));
    hasDataBlock = true;
  }
  if (input.ir.perf) {
    parts.push(jsonBlock('perf', input.ir.perf));
    hasDataBlock = true;
  }
  if (input.settings.include.rawSources && input.rawSources) {
    parts.push(jsonBlock('raw', Object.fromEntries(input.rawSources)));
    hasDataBlock = true;
  }
  // Nothing to browse without at least one data block, so the panel would
  // just be dead weight — skip it even if the setting is on.
  if (input.settings.embedViewer && hasDataBlock) {
    parts.push(viewerPanelBlock());
  }
  return {
    filename: captureFilename(
      input.ir.metadata.url,
      input.ir.metadata.capturedAt,
      'html',
      input.settings.filenameTemplate,
    ),
    bytes: strToU8(parts.join('')),
    mimeType: 'text/html',
  };
}

/**
 * Zip output is the self-contained page plus the artifacts a single file cannot
 * carry naturally: the screenshot, the token report, metadata, logs, and raw
 * sources. There are no asset directories — single-file-core inlines assets
 * into page.html, and splitting them back out would only risk breaking what it
 * got right.
 */
export function buildZip(input: BundleInput): BundleOutput {
  const entries: Record<string, Uint8Array> = {
    'page.html': strToU8(input.html),
  };

  if (input.settings.include.metadata) {
    entries['metadata.json'] = strToU8(
      JSON.stringify(metadataDocument(input), null, 2),
    );
  }
  if (input.tokens) {
    entries['tokens.json'] = strToU8(JSON.stringify(input.tokens, null, 2));
  }
  if (input.data) {
    entries['data.json'] = strToU8(JSON.stringify(input.data, null, 2));
  }
  if (input.settings.include.logs && input.ir.logs) {
    entries['logs.json'] = strToU8(JSON.stringify(input.ir.logs, null, 2));
  }
  if (input.ir.perf) {
    entries['perf.json'] = strToU8(JSON.stringify(input.ir.perf, null, 2));
  }
  if (input.screenshot) entries['screenshot.png'] = input.screenshot;

  if (input.settings.include.rawSources && input.rawSources) {
    for (const [url, text] of input.rawSources) {
      const basename = assetPathFor(url, 'script').split('/').pop() ?? 'source';
      entries[`raw/${basename}`] = strToU8(text);
    }
  }

  return {
    filename: captureFilename(
      input.ir.metadata.url,
      input.ir.metadata.capturedAt,
      'zip',
      input.settings.filenameTemplate,
    ),
    bytes: zipSync(entries, { level: 6 }),
    mimeType: 'application/zip',
  };
}
