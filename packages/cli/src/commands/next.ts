import { distill, distillWithScoring } from '@quickcaps/core/distill';
import type { Handle } from '@quickcaps/core/distill';
import { renderLayout } from '@quickcaps/core/layout';
import { readSession, writeSession } from '../session.js';
import { findScore } from './find.js';

function handlesFromRegionIds(regionIds: number[]): Record<number, Handle> {
  const handles: Record<number, Handle> = {};
  for (const id of regionIds) handles[id] = { id, kind: 'region' };
  return handles;
}

export async function runNext(cwd: string): Promise<string> {
  const session = await readSession(cwd);

  if (session.renderer === 'layout') {
    const result = renderLayout(session.ir, {
      tokenBudget: 500,
      page: session.page + 1,
    });

    await writeSession(cwd, {
      ...session,
      page: session.page + 1,
      hasMore: result.hasMore,
      handles: handlesFromRegionIds(result.regionIds),
      renderer: 'layout',
    });

    return result.text.length > 0 ? result.text : 'No more content.';
  }

  const query = session.query;
  const distillation = query
    ? distillWithScoring(
        session.ir,
        (region, baseScore) => findScore(region, baseScore, query),
        { tokenBudget: 500, page: session.page + 1 },
      )
    : distill(session.ir, { tokenBudget: 500, page: session.page + 1 });

  await writeSession(cwd, {
    ...session,
    page: session.page + 1,
    hasMore: distillation.hasMore,
    handles: distillation.handles,
  });

  return distillation.text.length > 0 ? distillation.text : 'No more content.';
}
