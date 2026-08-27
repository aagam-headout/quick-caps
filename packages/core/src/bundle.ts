import { strToU8, zipSync } from 'fflate';
import type { AssetKind, PageIR } from './ir.js';
import type { FetchedAsset } from './assets.js';
import type { CaptureSettings } from './settings.js';
import type { TokenReport } from './tokens.js';

export type BundleInput = {
  ir: PageIR;
  settings: CaptureSettings;
  /** The rewritten document, already serialized by the caller. */
  html: string;
  assets: Map<string, FetchedAsset>;
  styleTexts: Map<string, string>;
  tokens?: TokenReport | undefined;
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
): string {
  let host = 'capture';
  try {
    host = new URL(url).hostname || host;
  } catch {
    /* an unparseable url keeps the fallback name */
  }
  const stamp = capturedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${safeSegment(host, 'capture')}-${stamp}`;
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
  if (input.settings.include.metadata) {
    parts.push(jsonBlock('metadata', metadataDocument(input)));
  }
  if (input.tokens) parts.push(jsonBlock('tokens', input.tokens));
  if (input.settings.include.logs && input.ir.logs) {
    parts.push(jsonBlock('logs', input.ir.logs));
  }
  if (input.settings.include.rawSources && input.rawSources) {
    parts.push(jsonBlock('raw', Object.fromEntries(input.rawSources)));
  }
  return {
    filename: captureFilename(
      input.ir.metadata.url,
      input.ir.metadata.capturedAt,
      'html',
    ),
    bytes: strToU8(parts.join('')),
    mimeType: 'text/html',
  };
}

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
  if (input.settings.include.logs && input.ir.logs) {
    entries['logs.json'] = strToU8(JSON.stringify(input.ir.logs, null, 2));
  }
  if (input.screenshot) entries['screenshot.png'] = input.screenshot;

  for (const [url, text] of input.styleTexts) {
    entries[assetPathFor(url, 'stylesheet')] = strToU8(text);
  }
  for (const [url, asset] of input.assets) {
    entries[assetPathFor(url, asset.ref.kind)] = asset.bytes;
  }
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
    ),
    bytes: zipSync(entries, { level: 6 }),
    mimeType: 'application/zip',
  };
}
