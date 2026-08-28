import { distill, distillWithScoring } from '@quickcaps/core/distill';
import { readSession, writeSession } from '../session.js';
import { findScore } from './find.js';

export async function runNext(cwd: string): Promise<string> {
  const session = await readSession(cwd);
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
