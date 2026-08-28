import { distill, flattenRegions } from '@quickcaps/core/distill';
import { readSession, writeSession } from '../session.js';
import { openUrl } from '../open.js';
import { interact } from '../interact.js';
import { CliError } from '../errors.js';

export { CliError };

export async function runDo(
  handleId: number,
  cwd: string,
  value?: string,
): Promise<string> {
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
    const owningRegion = flattenRegions(session.ir.regions).find((entry) =>
      entry.region.actions.some((action) => action.id === handleId),
    )?.region;
    if (!owningRegion) {
      throw new CliError(
        `Handle ${handleId} could not be resolved to a region.`,
      );
    }
    const action = owningRegion.actions.find((a) => a.id === handleId);
    if (!action) {
      throw new CliError(
        `Handle ${handleId} could not be resolved to a region.`,
      );
    }
    if (!action.domPath) {
      throw new CliError(
        `Handle ${handleId}'s location is missing from this session — re-run 'pc open <url>' to refresh it.`,
      );
    }

    const { ir, driver } = await interact(session.url, action.domPath, {
      kind: handle.kind,
      ...(value !== undefined ? { value } : {}),
    });
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
