import { distillWithScoring, type Region } from 'quickcaps-core/distill';
import { readSession, writeSession } from '../session.js';

/** Dwarfs any role/density/action score, guaranteeing matches sort first. */
const FIND_BONUS = 1000;

export function findScore(
  region: Region,
  baseScore: number,
  query: string,
): number {
  const q = query.toLowerCase();
  const matches =
    region.snippet.toLowerCase().includes(q) ||
    region.actions.some((action) => action.label.toLowerCase().includes(q));
  return baseScore + (matches ? FIND_BONUS : 0);
}

/**
 * Same selection/paging/rendering pipeline distill() uses — only the
 * ranking differs. No second budget-enforcement or ancestor-pull-in
 * implementation (spec §5.5).
 */
export async function runFind(query: string, cwd: string): Promise<string> {
  const session = await readSession(cwd);
  const distillation = distillWithScoring(
    session.ir,
    (region, baseScore) => findScore(region, baseScore, query),
    { tokenBudget: 500, page: 0 },
  );

  // Destructure `renderer` out rather than spreading it forward: `find`
  // produces a distillation, not a layout render, so a stale `renderer:
  // 'layout'` here would make a later `next` silently keep rendering
  // structural layout output instead of query-scored content.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { renderer, ...rest } = session;
  await writeSession(cwd, {
    ...rest,
    page: 0,
    hasMore: distillation.hasMore,
    handles: distillation.handles,
    query,
  });

  return distillation.text;
}
