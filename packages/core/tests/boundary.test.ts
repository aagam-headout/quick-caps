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
