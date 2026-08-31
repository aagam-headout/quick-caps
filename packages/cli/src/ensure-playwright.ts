import { distill } from 'quick-caps-core/distill';
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
 *
 * `record: true` is the one case where an already-playwright session is still
 * re-collected: observation has to be armed *before* the page loads, so a
 * recording cannot be added to a load that already happened. The caller pays
 * a re-numbered handle map for it, which is why it is opt-in.
 */
export async function ensurePlaywrightSession(
  cwd: string,
  opts: { record?: boolean } = {},
): Promise<Session> {
  const session = await readSession(cwd);
  const needsRecording =
    opts.record === true && session.ir.recording === undefined;
  if (session.driver === 'playwright' && !needsRecording) return session;

  // Re-derive session state from the freshly-collected `ir` rather than
  // inheriting the old session's paging/handle state: region/action ids
  // come from a per-collection counter in buildRegions, so a re-collected
  // page has entirely different id numbering — the old session's
  // `handles`/`page`/`hasMore`/`query`/`renderer` would point at nothing
  // real, or worse, at the wrong element in the new tree. This is a full
  // re-open in disguise, not a partial update.
  // Arming is forwarded, not just decided on: without it a `--record`
  // escalation would re-collect the page with nobody watching. There is no
  // `--no-redact` on this path — a capture-adjacent re-collection always
  // redacts.
  const ir = await collectViaPlaywrightFor(session.url, {
    record: needsRecording,
  });
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
