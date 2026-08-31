import { parseHTML } from 'linkedom';
import {
  extractData,
  formatAvailability,
  EXTRACT_DOMAINS,
  type DataReport,
  type ExtractDomain,
} from 'quick-caps-core/extract';
import { runOpen } from './open.js';
import { readSession } from '../session.js';

export type DataArgs = {
  /** Opens this url first, so one call takes a caller from url to data. */
  url?: string;
  /** Empty means "tell me what's here" rather than "give me everything". */
  domains: ExtractDomain[];
  json?: boolean;
};

/** Domains carrying fields that need per-element computed styles — natural
 * image size, fonts actually loaded, z-index and contrast. A stored session
 * has no live element to compute a style from, and upgrading it to a
 * browser-backed one would re-number every handle the caller is holding, so
 * these run degraded and say so. */
const NEEDS_COMPUTED_STYLE: ExtractDomain[] = ['content', 'design'];

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
  if (args.url !== undefined) await runOpen({ url: args.url }, cwd);
  const session = await readSession(cwd);
  const { document } = parseHTML(session.ir.html);

  const summaryOnly = args.domains.length === 0;
  const domains = summaryOnly ? [...EXTRACT_DOMAINS] : args.domains;
  const report = extractData(
    { doc: document as unknown as Document, ir: session.ir },
    domains,
  );

  const degraded = NEEDS_COMPUTED_STYLE.filter((domain) =>
    domains.includes(domain),
  );
  if (degraded.length > 0) {
    report.warnings = [
      ...(report.warnings ?? []),
      {
        phase: 'extract',
        reason: `${degraded.join(', ')}: skipped every field needing computed styles`,
        detail:
          'the stored session has no live page to compute styles from, and upgrading it would re-number every handle',
      },
    ];
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
    : JSON.stringify(report as DataReport, null, 2);
}
