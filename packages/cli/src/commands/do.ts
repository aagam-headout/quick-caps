import { distill } from '@quickcaps/core/distill';
import { readSession, writeSession } from '../session.js';
import { openUrl } from '../open.js';
import { CliError } from '../errors.js';

export { CliError };

export async function runDo(handleId: number, cwd: string): Promise<string> {
  const session = await readSession(cwd);
  const handle = session.handles[handleId];

  if (!handle) {
    const valid = Object.keys(session.handles).join(', ') || '(none)';
    throw new CliError(
      `No handle ${handleId} in the current session. Valid handles: ${valid}.`,
    );
  }

  if (handle.kind === 'region') {
    throw new CliError(
      `Handle ${handleId} is a region, not a link — 'do' only follows ` +
        `links in this version. Try 'pc read ${handleId}' instead.`,
    );
  }

  if (handle.kind === 'button' || handle.kind === 'input') {
    return 'not yet supported in this version — coming in a later phase';
  }

  const resolvedUrl = new URL(handle.href ?? '', session.url).href;
  const { ir, driver } = await openUrl(resolvedUrl);
  const distillation = distill(ir, { tokenBudget: 500, page: 0 });

  await writeSession(cwd, {
    url: ir.metadata.url,
    driver,
    ir,
    page: 0,
    hasMore: distillation.hasMore,
    handles: distillation.handles,
  });

  return distillation.text;
}
