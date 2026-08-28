import { distill } from 'quickcaps-core/distill';
import { collectViaPlaywrightFor } from './open.js';
import { readSession, writeSession, type Session } from './session.js';

/**
 * Upgrades a StaticDriver-backed session to Playwright in place, when the
 * command calling this needs something StaticDriver structurally cannot
 * provide (real layout geometry, real computed styles). Unconditional —
 * unlike openUrl's looksLikeEmptyShell heuristic, there is no "maybe" here:
 * the data either exists (a real browser rendered it) or it doesn't
 * (linkedom has no layout engine, no getComputedStyle).
 *
 * A no-op, returning the session unchanged, if it's already
 * playwright-backed — re-collecting a page that's already been rendered
 * would just be a slower way to get the same PageIR.
 */
export async function ensurePlaywrightSession(cwd: string): Promise<Session> {
  const session = await readSession(cwd);
  if (session.driver === 'playwright') return session;

  // Re-derive session state from the freshly-collected `ir` rather than
  // inheriting the old session's paging/handle state: region/action ids
  // come from a per-collection counter in buildRegions, so a re-collected
  // page has entirely different id numbering — the old session's
  // `handles`/`page`/`hasMore`/`query`/`renderer` would point at nothing
  // real, or worse, at the wrong element in the new tree. This is a full
  // re-open in disguise, not a partial update.
  const ir = await collectViaPlaywrightFor(session.url);
  const d = distill(ir, { tokenBudget: 500, page: 0 });
  const escalated: Session = {
    url: ir.metadata.url,
    driver: 'playwright',
    ir,
    page: 0,
    hasMore: d.hasMore,
    handles: d.handles,
  };
  await writeSession(cwd, escalated);
  return escalated;
}
