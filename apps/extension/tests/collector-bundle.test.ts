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
      'run `pnpm --filter @quickcaps/extension build` first',
    ).toBe(true);
  });

  it('contains no import or export statement', () => {
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/^\s*export\s/m);
  });

  it('is a single self-contained expression', () => {
    // The precise invariant: an IIFE with no module scaffolding. A substring
    // search for `from "..."` false-positives on string literals inside a
    // 900 kB minified bundle, so anchor on statement position instead.
    expect(code.trimStart().startsWith('(function(')).toBe(true);
    expect(code).not.toMatch(/^\s*from\s*["']/m);
    expect(code).not.toMatch(/^\s*(?:import|export)\b/m);
  });

  it('resolves no workspace package at runtime', () => {
    expect(code).not.toContain('quickcaps-core');
    expect(code).not.toContain('single-file-core/single-file.js');
  });

  it('inlines both the core logic and the serializer it depends on', () => {
    // Proof it is genuinely self-contained rather than accidentally empty.
    expect(code).toContain('data-quickcaps-logs');
    // single-file-core is ~900 kB; anything much smaller means it was not
    // bundled and injection would fail at runtime.
    expect(code.length).toBeGreaterThan(500_000);
  });

  it('does not pull in an unused heavyweight dependency (e.g. a tokenizer BPE table)', () => {
    // Verified build size at time of writing is ~907 kB (single-file-core
    // dominates). A prior regression had `quickcaps-core`'s barrel export
    // re-exporting `distill` (unused by the extension), which transitively
    // pulled in `gpt-tokenizer`'s vocab table and roughly doubled this file
    // to ~1.89 MB. This ceiling — current size plus ~20% headroom — is
    // there to catch that class of regression again, not to pin the exact
    // byte count.
    expect(code.length).toBeLessThan(1_100_000);
  });
});
