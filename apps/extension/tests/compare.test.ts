import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { defaultSettings } from '@page-capture/core';
import {
  diffCaptures,
  extractCaptureMetadata,
  type CaptureMetadataDoc,
} from '../src/popup/lib/compare.js';

function metadataDoc(
  overrides: Partial<CaptureMetadataDoc> = {},
): CaptureMetadataDoc {
  return {
    url: 'https://example.com/page',
    capturedAt: '2026-08-27T10:00:00.000Z',
    warnings: [],
    regionCount: 4,
    settings: defaultSettings,
    ...overrides,
  };
}

function htmlFileWithMetadata(doc: CaptureMetadataDoc): File {
  const json = JSON.stringify(doc).replace(/<\//g, '<\\/');
  const html = `<html><body>Hi</body></html>\n<script type="application/json" data-capture="metadata">${json}</script>`;
  return new File([html], 'capture.html', { type: 'text/html' });
}

function zipFileWithMetadata(doc: CaptureMetadataDoc): File {
  const bytes = zipSync({
    'page.html': strToU8('<html><body>Hi</body></html>'),
    'metadata.json': strToU8(JSON.stringify(doc)),
  });
  return new File([bytes], 'capture.zip', { type: 'application/zip' });
}

describe('extractCaptureMetadata', () => {
  it('reads the embedded metadata block out of a single-file HTML capture', async () => {
    const doc = metadataDoc();
    const result = await extractCaptureMetadata(htmlFileWithMetadata(doc));
    expect(result?.url).toBe(doc.url);
    expect(result?.regionCount).toBe(4);
  });

  it('reads metadata.json out of a zip capture', async () => {
    const doc = metadataDoc({ url: 'https://zip.example/page' });
    const result = await extractCaptureMetadata(zipFileWithMetadata(doc));
    expect(result?.url).toBe('https://zip.example/page');
  });

  it('returns null for a file with no embedded metadata', async () => {
    const file = new File(['<html><body>No metadata</body></html>'], 'x.html');
    expect(await extractCaptureMetadata(file)).toBeNull();
  });

  it('returns null rather than throwing on a corrupt metadata block', async () => {
    const html =
      '<html></html>\n<script type="application/json" data-capture="metadata">not json</script>';
    const file = new File([html], 'x.html');
    expect(await extractCaptureMetadata(file)).toBeNull();
  });
});

describe('diffCaptures', () => {
  it('flags a different source url', () => {
    const a = { filename: 'a.html', byteLength: 100, doc: metadataDoc() };
    const b = {
      filename: 'b.html',
      byteLength: 120,
      doc: metadataDoc({ url: 'https://other.example/page' }),
    };
    expect(diffCaptures(a, b).sameUrl).toBe(false);
  });

  it('computes byte, warning, and region deltas', () => {
    const a = {
      filename: 'a.html',
      byteLength: 100,
      doc: metadataDoc({ regionCount: 4, warnings: [] }),
    };
    const b = {
      filename: 'b.html',
      byteLength: 150,
      doc: metadataDoc({
        regionCount: 6,
        warnings: [{ phase: 'assets', reason: 'timed out' }],
      }),
    };
    const diff = diffCaptures(a, b);
    expect(diff.byteLengthDelta).toBe(50);
    expect(diff.warningCountDelta).toBe(1);
    expect(diff.regionCountDelta).toBe(2);
  });

  it('lists which include toggles changed between the two captures', () => {
    const a = {
      filename: 'a.html',
      byteLength: 100,
      doc: metadataDoc({
        settings: { ...defaultSettings, include: { ...defaultSettings.include, screenshot: false } },
      }),
    };
    const b = {
      filename: 'b.html',
      byteLength: 100,
      doc: metadataDoc({
        settings: { ...defaultSettings, include: { ...defaultSettings.include, screenshot: true } },
      }),
    };
    const diff = diffCaptures(a, b);
    expect(diff.settingsChanges).toEqual([
      { key: 'include.screenshot', a: false, b: true },
    ]);
  });

  it('returns no settings changes when metadata carries no settings (older capture)', () => {
    const { settings, ...withoutSettings } = metadataDoc();
    void settings;
    const a = { filename: 'a.html', byteLength: 100, doc: withoutSettings };
    const b = { filename: 'b.html', byteLength: 100, doc: metadataDoc() };
    expect(diffCaptures(a, b).settingsChanges).toEqual([]);
  });
});
