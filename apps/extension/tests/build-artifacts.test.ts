import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/**
 * Runtime-resolved paths that no unit test can verify, because the tests that
 * exercise them mock the Chrome API that would do the resolving. If a path here
 * is missing from the build, the extension fails only when a user clicks.
 */
describe('build artifacts', () => {
  it('builds the popup page', () => {
    expect(existsSync(join(dist, 'src/popup/index.html'))).toBe(true);
  });

  it('builds the offscreen document at the path the client requests', () => {
    // Must match DOCUMENT_PATH in src/background/offscreen-client.ts.
    expect(existsSync(join(dist, 'src/offscreen/index.html'))).toBe(true);
  });

  it('builds the onboarding page at the path onInstalled opens', () => {
    // Must match the url passed to chrome.tabs.create in src/background/index.ts.
    expect(existsSync(join(dist, 'src/onboarding/index.html'))).toBe(true);
  });

  it('builds the injected collector', () => {
    expect(existsSync(join(dist, 'collector.js'))).toBe(true);
  });

  it('builds the injected element picker', () => {
    expect(existsSync(join(dist, 'picker.js'))).toBe(true);
  });

  it('ships the manifest, icons, and vendored fonts', () => {
    for (const path of [
      'manifest.json',
      'icons/icon-16.png',
      'icons/icon-128.png',
      'fonts/Geist-Variable.woff2',
      'fonts/OFL-Geist.txt',
    ]) {
      expect(existsSync(join(dist, path)), path).toBe(true);
    }
  });

  /**
   * The offscreen chunk is where core's './extract' subpath lands, and it
   * regressed to ~2.08 MB once when extract/content.ts imported flattenRegions
   * from distill.ts and transitively pulled gpt-tokenizer's BPE table. Vite's
   * own 500 kB warning only prints; this is the guard that fails — the same
   * class of regression collector-bundle.test.ts watches for.
   */
  it('keeps the offscreen chunk free of a heavyweight vendor dependency', () => {
    const chunk = readdirSync(join(dist, 'assets')).find(
      (name) => name.startsWith('offscreen-') && name.endsWith('.js'),
    );
    expect(chunk, 'no offscreen chunk in dist/assets').toBeDefined();
    // Measured at ~45 kB after the flatten.ts split; this is that plus ~15%
    // headroom, not a pin on the exact byte count.
    expect(statSync(join(dist, 'assets', chunk!)).size).toBeLessThan(52_000);
  });

  it('registers the recorder content script in the built manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(dist, 'manifest.json'), 'utf8'),
    ) as { content_scripts: { js: string[]; world: string }[] };
    expect(manifest.content_scripts[0]!.world).toBe('MAIN');
    expect(manifest.content_scripts[0]!.js.length).toBeGreaterThan(0);
  });
});
