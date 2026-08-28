import { buildTokens } from 'quickcaps-core';
import { ensurePlaywrightSession } from '../ensure-playwright.js';

/** Matches apps/extension/src/lib/capture.ts's existing buildTokens usage —
 * values seen fewer than twice are noise, and 24 values per property group
 * is enough to see a real design system without dumping every one-off. */
const MIN_COUNT = 2;
const MAX_PER_GROUP = 24;

export async function runTokens(cwd: string): Promise<string> {
  const session = await ensurePlaywrightSession(cwd);
  const report = buildTokens(session.ir.styleTally, {
    minCount: MIN_COUNT,
    maxPerGroup: MAX_PER_GROUP,
  });
  return JSON.stringify(report, null, 2);
}
