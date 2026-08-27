import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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

  it('builds the injected collector', () => {
    expect(existsSync(join(dist, 'collector.js'))).toBe(true);
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

  it('registers the recorder content script in the built manifest', () => {
    const manifest = JSON.parse(
      readFileSync(join(dist, 'manifest.json'), 'utf8'),
    ) as { content_scripts: { js: string[]; world: string }[] };
    expect(manifest.content_scripts[0]!.world).toBe('MAIN');
    expect(manifest.content_scripts[0]!.js.length).toBeGreaterThan(0);
  });
});
