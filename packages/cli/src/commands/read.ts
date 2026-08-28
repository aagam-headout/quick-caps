import { parseHTML } from 'linkedom';
import { flattenRegions } from 'quickcaps-core/distill';
import { readSession } from '../session.js';
import { CliError } from './do.js';

export { CliError };

function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Resolves a handle to a region: directly if it's already a region handle,
 * or by finding the region whose actions array contains it, if it's an
 * action handle (spec §5.4 — reading an action reads the region that owns
 * it, since an action's full text is just its label, already visible).
 */
export async function runRead(handleId: number, cwd: string): Promise<string> {
  const session = await readSession(cwd);
  const handle = session.handles[handleId];
  if (!handle) {
    const valid = Object.keys(session.handles).join(', ') || '(none)';
    throw new CliError(
      `No handle ${handleId} in the current session. Valid handles: ${valid}.`,
    );
  }

  const flat = flattenRegions(session.ir.regions);
  let region = flat.find((entry) => entry.region.id === handleId)?.region;
  if (!region) {
    region = flat.find((entry) =>
      entry.region.actions.some((action) => action.id === handleId),
    )?.region;
  }
  if (!region) {
    throw new CliError(`Handle ${handleId} could not be resolved to a region.`);
  }

  const { document } = parseHTML(session.ir.html);
  let el: Element | null = document.body;
  for (const index of region.domPath) {
    el = el?.children[index] ?? null;
    if (!el) break;
  }
  if (!el) {
    throw new CliError(
      `Could not relocate handle ${handleId} in the stored page HTML.`,
    );
  }

  return collapseWhitespace(el.textContent ?? '');
}
