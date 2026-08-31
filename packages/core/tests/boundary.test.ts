import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * Lints `code` as if it were a file under packages/core/src, so the boundary
 * rules in eslint.config.js apply to it. This test file itself is exempt from
 * those rules — only src/ is constrained — and it exists to prove the rules
 * actually bite rather than sitting inert in the config.
 */
async function lintAsCoreSource(code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, {
    filePath: 'packages/core/src/probe.ts',
  });
  if (!result) throw new Error('eslint returned no result');
  return result;
}

describe('core boundary rule', () => {
  it('rejects a core source file that touches document', async () => {
    const result = await lintAsCoreSource(
      'export const t = () => document.title;',
    );
    expect(result.messages.map((m) => m.ruleId)).toContain(
      'no-restricted-globals',
    );
  });

  it('rejects a core source file that touches chrome', async () => {
    const result = await lintAsCoreSource(
      'export const t = () => chrome.runtime.id;',
    );
    expect(result.messages.map((m) => m.ruleId)).toContain(
      'no-restricted-globals',
    );
  });

  it('rejects a core source file importing a Node built-in', async () => {
    const result = await lintAsCoreSource(
      "import { readFile } from 'node:fs/promises';\nexport const t = readFile;",
    );
    expect(result.messages.map((m) => m.ruleId)).toContain(
      'no-restricted-imports',
    );
  });

  it('accepts a core source file that takes its DOM as a parameter', async () => {
    const result = await lintAsCoreSource(
      'export const title = (doc: { title: string }) => doc.title;',
    );
    expect(result.errorCount).toBe(0);
  });
});

describe('extract/ sources', () => {
  it('reaches for no DOM global, taking its document as a parameter instead', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/extract');
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(dir, name));
    // A silent zero-file lint would pass vacuously, which is the one way this
    // test could stop protecting the boundary without anyone noticing.
    expect(files.length).toBeGreaterThan(0);

    const results = await new ESLint().lintFiles(files);
    const violations = results.flatMap((result) =>
      result.messages.map(
        (message) => `${result.filePath}: ${message.message}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});
