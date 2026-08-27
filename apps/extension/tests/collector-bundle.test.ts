import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const artifact = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'collector.js',
);

/**
 * The zero-import property belongs to the built artifact, not the source: a
 * bundler config change could start emitting an import statement while every
 * source file still looks correct. chrome.scripting cannot resolve module
 * specifiers, so this is the test that keeps injection working — and keeps the
 * collector reusable by a non-extension host later.
 */
describe('built collector artifact', () => {
  const code = existsSync(artifact) ? readFileSync(artifact, 'utf8') : '';

  it('exists after a build', () => {
    expect(
      existsSync(artifact),
      'run `pnpm --filter @page-capture/extension build` first',
    ).toBe(true);
  });

  it('contains no import or export statement', () => {
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/^\s*export\s/m);
  });

  it('references no bare module specifier', () => {
    expect(code).not.toMatch(/\bfrom\s*["'][^"'.][^"']*["']/);
    expect(code).not.toContain('@page-capture/core');
  });

  it('is not a module', () => {
    expect(code).not.toContain('import.meta');
  });

  it('inlines the core logic it depends on', () => {
    // Proof it is genuinely self-contained rather than accidentally empty.
    expect(code).toContain('data-page-capture-logs');
    expect(code.length).toBeGreaterThan(10_000);
  });
});
