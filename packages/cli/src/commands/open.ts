import { distill } from 'quick-caps-core/distill';
import { openUrl } from '../open.js';
import { writeSession } from '../session.js';

export type OpenCommandArgs = {
  url: string;
  static?: boolean;
};

export async function runOpen(
  args: OpenCommandArgs,
  cwd: string,
): Promise<string> {
  const { ir, driver } = await openUrl(args.url, {
    static: args.static === true,
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
