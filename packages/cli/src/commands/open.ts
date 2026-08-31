import { distill } from 'quick-caps-core/distill';
import { openUrl } from '../open.js';
import { writeSession } from '../session.js';
import { CliError } from '../errors.js';

export type OpenCommandArgs = {
  url: string;
  static?: boolean;
  /** Arms observation: forces a browser session, because a static fetch
   * witnesses nothing. See openUrl. */
  record?: boolean;
};

export async function runOpen(
  args: OpenCommandArgs,
  cwd: string,
): Promise<string> {
  // Refused rather than silently resolved: both flags were passed explicitly
  // and they ask for opposite drivers, so picking one would leave the caller
  // with a session they did not ask for.
  if (args.record === true && args.static === true) {
    throw new CliError(
      '--record needs a real browser to watch the page; drop --static.',
    );
  }

  const { ir, driver } = await openUrl(args.url, {
    static: args.static === true,
    record: args.record === true,
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
