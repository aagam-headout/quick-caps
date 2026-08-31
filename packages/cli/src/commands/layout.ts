import { renderLayout } from 'quick-caps-core/layout';
import type { Handle } from 'quick-caps-core/distill';
import { ensurePlaywrightSession } from '../ensure-playwright.js';
import { writeSession } from '../session.js';

function handlesFromRegionIds(regionIds: number[]): Record<number, Handle> {
  const handles: Record<number, Handle> = {};
  for (const id of regionIds) handles[id] = { id, kind: 'region' };
  return handles;
}

export async function runLayout(cwd: string): Promise<string> {
  const session = await ensurePlaywrightSession(cwd);
  const result = renderLayout(session.ir, { tokenBudget: 500, page: 0 });

  // Destructure `query` and `renderer` out rather than spreading them
  // forward: layout's paging is document-order, unrelated to any prior
  // `find`'s query-scored paging, so a stale `query` field here would make
  // a later `next` silently resume query-scoring against layout's output.
  // `renderer` is set fresh below to layout's own discriminator.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { query, renderer, ...rest } = session;
  await writeSession(cwd, {
    ...rest,
    page: 0,
    hasMore: result.hasMore,
    handles: handlesFromRegionIds(result.regionIds),
    renderer: 'layout',
  });

  return result.text;
}
