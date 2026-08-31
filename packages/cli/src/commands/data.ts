import { parseHTML } from 'linkedom';
import {
  extractData,
  formatAvailability,
  EXTRACT_DOMAINS,
  type ExtractDomain,
} from 'quick-caps-core/extract';
import { computedStyleWarning } from '../computed-style-degradation.js';
import { renderDataReport } from './data-render.js';
import { runOpen } from './open.js';
import { readSession } from '../session.js';

export type DataArgs = {
  /** Opens this url first, so one call takes a caller from url to data. */
  url?: string;
  /** Empty means "tell me what's here" rather than "give me everything". */
  domains: ExtractDomain[];
  /** Machine output: the report as one line of JSON. Off means the human
   * rendering, which is what a person at a terminal asked for. */
  json?: boolean;
  /** Only meaningful alongside `url`: forwarded to the open this performs, so
   * `pc data <url> --record --network` arms the load it is about to report on
   * rather than reporting it as unrecorded. */
  record?: boolean;
  /** Forwarded the same way, and refused by runOpen without `record`. */
  noRedact?: boolean;
};

/**
 * Extracts data from the *stored* session, offline: session.ir.html holds a
 * complete serialized DOM whichever driver produced it, so re-parsing it with
 * linkedom (the technique read.ts and scrape.ts already use) gives the
 * extractors the document core deliberately cannot fetch for itself.
 *
 * Deliberately does not call ensurePlaywrightSession: unlike layout/tokens,
 * nothing here needs real geometry badly enough to be worth re-numbering the
 * caller's handles.
 */
export async function runData(args: DataArgs, cwd: string): Promise<string> {
  if (args.url !== undefined) {
    await runOpen(
      {
        url: args.url,
        ...(args.record === true && { record: true }),
        ...(args.noRedact === true && { noRedact: true }),
      },
      cwd,
    );
  }
  const session = await readSession(cwd);
  const { document } = parseHTML(session.ir.html);

  const summaryOnly = args.domains.length === 0;
  const domains = summaryOnly ? [...EXTRACT_DOMAINS] : args.domains;
  const report = extractData(
    { doc: document as unknown as Document, ir: session.ir },
    domains,
  );

  // Shared with the crawl path, which degrades the same way for its own
  // reason: one wording for one limitation.
  const degraded = computedStyleWarning(
    domains,
    'the stored session has no live page to compute styles from, and upgrading it would re-number every handle',
  );
  if (degraded !== undefined) {
    report.warnings = [...(report.warnings ?? []), degraded];
  }

  if (summaryOnly) {
    const lines = [`available: ${formatAvailability(report)}`];
    for (const warning of report.warnings ?? []) {
      lines.push(`warning: ${warning.reason}`);
    }
    return lines.join('\n');
  }

  return args.json === true
    ? JSON.stringify(report)
    : renderDataReport(report, domains);
}
