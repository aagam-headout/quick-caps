import { unzipSync, strFromU8 } from 'fflate';
import type { CaptureSettings } from '@page-capture/core';

/**
 * The `data-capture="metadata"` block bundle.ts embeds when the Metadata
 * toggle is on — see packages/core/src/bundle.ts:metadataDocument. Compare
 * reads back only what that function actually writes.
 */
export type CaptureMetadataDoc = {
  url: string;
  capturedAt: string;
  title?: string;
  warnings?: unknown[];
  regionCount?: number;
  settings?: CaptureSettings;
};

const METADATA_SCRIPT =
  /<script type="application\/json" data-capture="metadata">([\s\S]*?)<\/script>/;

/**
 * Reads the embedded metadata block back out of a previously captured file.
 * Returns null rather than throwing when the file has none — an archive
 * captured with Metadata off, or any other file the user picked by mistake,
 * is a "can't compare this one" state for the caller to show, not a crash.
 */
export async function extractCaptureMetadata(
  file: File,
): Promise<CaptureMetadataDoc | null> {
  try {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const entries = unzipSync(bytes);
      const entry = entries['metadata.json'];
      if (!entry) return null;
      return JSON.parse(strFromU8(entry)) as CaptureMetadataDoc;
    }
    const text = await file.text();
    const match = METADATA_SCRIPT.exec(text);
    if (!match?.[1]) return null;
    // Reverses the `</` escaping bundle.ts applies so the block can ride
    // inside a <script> without terminating it early.
    return JSON.parse(match[1].replace(/<\\\//g, '</')) as CaptureMetadataDoc;
  } catch {
    return null;
  }
}

export type CaptureSide = {
  filename: string;
  byteLength: number;
  doc: CaptureMetadataDoc;
};

export type SettingsChange = { key: string; a: unknown; b: unknown };

export type CaptureDiff = {
  sameUrl: boolean;
  byteLengthDelta: number;
  warningCountDelta: number;
  regionCountDelta: number | null;
  settingsChanges: SettingsChange[];
};

/** Shallow diff over the flat, boolean-and-string-heavy CaptureSettings shape. */
function diffSettings(
  a: CaptureSettings | undefined,
  b: CaptureSettings | undefined,
): SettingsChange[] {
  if (!a || !b) return [];
  const changes: SettingsChange[] = [];
  for (const key of Object.keys(a.include) as (keyof typeof a.include)[]) {
    if (a.include[key] !== b.include[key]) {
      changes.push({
        key: `include.${key}`,
        a: a.include[key],
        b: b.include[key],
      });
    }
  }
  for (const key of [
    'output',
    'excludeSelector',
    'filenameTemplate',
  ] as const) {
    if (a[key] !== b[key]) changes.push({ key, a: a[key], b: b[key] });
  }
  return changes;
}

export function diffCaptures(a: CaptureSide, b: CaptureSide): CaptureDiff {
  return {
    sameUrl: a.doc.url === b.doc.url,
    byteLengthDelta: b.byteLength - a.byteLength,
    warningCountDelta:
      (b.doc.warnings?.length ?? 0) - (a.doc.warnings?.length ?? 0),
    regionCountDelta:
      typeof a.doc.regionCount === 'number' &&
      typeof b.doc.regionCount === 'number'
        ? b.doc.regionCount - a.doc.regionCount
        : null,
    settingsChanges: diffSettings(a.doc.settings, b.doc.settings),
  };
}
