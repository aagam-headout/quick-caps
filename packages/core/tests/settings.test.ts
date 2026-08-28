import { describe, expect, it } from 'vitest';
import {
  captureSettingsSchema,
  defaultSettings,
  parseSettings,
} from '../src/settings.js';

describe('capture settings', () => {
  it('defaults match the spec', () => {
    expect(defaultSettings.include.html).toBe(true);
    expect(defaultSettings.include.screenshot).toBe(false);
    expect(defaultSettings.include.perf).toBe(false);
    expect(defaultSettings.inertSnapshot).toBe(true);
    expect(defaultSettings.embedViewer).toBe(false);
    expect(defaultSettings.output).toBe('single-file');
    expect(defaultSettings.excludeSelector).toBe('');
    expect(defaultSettings.selectionSelector).toBe('');
    expect(defaultSettings.filenameTemplate).toBe('{host}-{timestamp}');
    expect(defaultSettings.limits).toEqual({
      concurrency: 6,
      assetTimeoutMs: 10_000,
      retries: 1,
      maxAssetBytes: 5 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      logRingSize: 500,
    });
  });

  it('fills missing fields from defaults', () => {
    const parsed = parseSettings({ output: 'zip' });
    expect(parsed.output).toBe('zip');
    expect(parsed.limits.concurrency).toBe(6);
  });

  it('rejects an unknown output mode', () => {
    expect(() => parseSettings({ output: 'pdf' })).toThrow();
  });

  it('rejects a non-positive concurrency', () => {
    expect(() => parseSettings({ limits: { concurrency: 0 } })).toThrow();
  });

  it('exposes a schema usable for generating a JSON schema later', () => {
    expect(captureSettingsSchema.safeParse(defaultSettings).success).toBe(true);
  });
});
