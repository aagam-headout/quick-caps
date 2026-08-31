import type { ExtractDomain } from 'quick-caps-core/extract';
import { CliError } from '../errors.js';
import { executeCrawl, type PageFetcher } from '../crawl/runner.js';
import { Frontier } from '../crawl/frontier.js';
import { Politeness } from '../crawl/politeness.js';
import {
  CrawlStore,
  createCrawlState,
  deriveCrawlName,
  latestCrawlName,
  summarizeCrawl,
  type CrawlSummary,
} from '../crawl/store.js';

/**
 * The domains a crawl can extract. The observation domains — network, stack,
 * vitals — are deliberately absent: they need a page armed with `--record`
 * before it loads, and a browser plus a settle window per page across
 * hundreds of pages is a different tool, which is why `pc crawl` has no
 * `--record`. Offering them would only write "not recorded" 200 times.
 */
export const CRAWL_DOMAINS = [
  'structured',
  'entities',
  'content',
  'design',
  'links',
] as const satisfies readonly ExtractDomain[];

/** With no domain flag: the declared-data domains plus the link graph. Not
 * the availability summary `pc data` prints for a single page — a crawl of
 * 200 pages that extracted nothing is 200 wasted fetches. */
const DEFAULT_DOMAINS: ExtractDomain[] = ['structured', 'entities', 'links'];

export const DEFAULT_LIMIT = 25;
export const DEFAULT_DEPTH = 3;
/** One request per second per host, per the design's politeness defaults. */
export const DEFAULT_RATE = 1;
export const DEFAULT_CONCURRENCY = 1;

export type CrawlArgs = {
  url?: string;
  /** Continue a named crawl from its state file. */
  resume?: string;
  /** Summarize a store instead of crawling. */
  report?: boolean;
  /** The store to use: the crawl name for a run, the crawl to report on
   * otherwise. Defaults to the seed host, or the most recent crawl. */
  name?: string;
  json?: boolean;
  domains?: ExtractDomain[];
  limit?: number;
  depth?: number;
  rate?: number;
  concurrency?: number;
  ignoreRobots?: boolean;
  /** Injected by tests, so the interrupt path is provable without signalling
   * a real process. */
  signal?: AbortSignal;
  /** Injected by tests; defaults to a line per page on stderr, so the
   * summary on stdout stays machine-readable. */
  onProgress?: (line: string) => void;
  /** Injected by tests that must not touch the network. */
  fetchPage?: PageFetcher;
};

/** Fits the longest label the summary emits ('structured'), so the value
 * column lines up down the whole block — the same reason data-render.ts
 * fixes a LABEL_WIDTH. */
const LABEL_WIDTH = 11;

function pad(label: string): string {
  return label.padEnd(LABEL_WIDTH);
}

function reasons(counts: Record<string, number>): string[] {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([reason, count]) => `  ${pad('')}${count}  ${reason}`);
}

/** The human form. Deliberately the same rendering for a finished crawl and
 * for `--report`, so what a crawl prints is what a report reprints. */
export function renderCrawlSummary(summary: CrawlSummary): string {
  const lines = [
    `crawl ${summary.name}`,
    `  ${pad('store')}${summary.storePath}`,
  ];
  if (summary.seed !== undefined) {
    lines.push(`  ${pad('seed')}${summary.seed}`);
  }
  lines.push(`  ${pad('pages')}${summary.pages}`);
  lines.push(`  ${pad('fetched')}${summary.fetched}`);
  lines.push(`  ${pad('errors')}${summary.errors}`);
  if (summary.errors > 0) lines.push(...reasons(summary.errorReasons));
  lines.push(`  ${pad('skipped')}${summary.skipped}`);
  if (summary.skipped > 0) lines.push(...reasons(summary.skipReasons));
  for (const [domain, count] of Object.entries(summary.byDomain)) {
    lines.push(`  ${pad(domain)}${count}`);
  }
  if (summary.warnings > 0) {
    lines.push(`  ${pad('warnings')}${summary.warnings}`);
  }
  for (const warning of summary.crawlWarnings ?? []) {
    // Stated once for the crawl, as the store holds it: the annotation says
    // why a computed-style field is absent from every record, and it has to
    // stay visible without being counted 500 times.
    lines.push(`  ${pad('note')}${warning.reason}`);
  }
  if (summary.unreadable > 0) {
    // Named, never swallowed: a truncated tail is a fact about the store.
    lines.push(`  ${pad('unread')}${summary.unreadable} unparseable line(s)`);
  }
  if (summary.discoverySkips !== undefined) {
    // Links the frontier refused, with the reasons under the total: this is
    // the answer to "why did a 200-page site yield 40 pages".
    const total = Object.values(summary.discoverySkips).reduce(
      (sum, count) => sum + count,
      0,
    );
    lines.push(`  ${pad('refused')}${total}`);
    lines.push(...reasons(summary.discoverySkips));
  }
  if (summary.queued !== undefined) {
    lines.push(`  ${pad('queued')}${summary.queued}`);
  }
  if (summary.stopReason !== undefined) {
    lines.push(`  ${pad('stopped')}${summary.stopReason}`);
  }
  return lines.join('\n');
}

async function report(args: CrawlArgs, cwd: string): Promise<string> {
  const name = args.name ?? (await latestCrawlName(cwd));
  if (name === undefined) {
    throw new CliError(
      `No crawl found in ${cwd} — run 'pc crawl <url>' first.`,
    );
  }
  // Streams the store rather than reading it: a 200-page dataset is not
  // something a summary should have to hold.
  const summary = await summarizeCrawl(CrawlStore.dirFor(cwd, name), name);
  return args.json === true
    ? JSON.stringify(summary)
    : renderCrawlSummary(summary);
}

/**
 * Walks a site and extracts from each page, writing one record per page into
 * a resumable store.
 *
 * Everything decision-shaped is elsewhere: the frontier decides where to go,
 * politeness decides whether and when, Piece 1 decides what a page contains,
 * and the store decides how that survives an interrupt. This function parses
 * the surface, wires those four together, and renders the summary.
 */
export async function runCrawl(args: CrawlArgs, cwd: string): Promise<string> {
  if (args.report === true) return report(args, cwd);

  const resuming = args.resume !== undefined;
  const name =
    args.resume ??
    args.name ??
    (args.url === undefined ? undefined : deriveCrawlName(args.url));
  if (name === undefined) {
    throw new CliError(
      'Usage: pc crawl <url> [--limit N] [--depth N] [--name <name>] [--structured] [--entities] [--content] [--design] [--links] [--all] [--rate N] [--concurrency N] [--ignore-robots], or pc crawl --resume <name>, or pc crawl --report [<name>]',
    );
  }

  const store = await CrawlStore.open(cwd, name);
  const stored = resuming ? await store.readState() : undefined;
  if (resuming && stored === undefined) {
    throw new CliError(
      `No crawl named '${name}' in ${cwd} — 'pc crawl --report' lists what a crawl left behind.`,
    );
  }

  const state =
    stored ??
    createCrawlState({
      name,
      seed: args.url ?? '',
      domains: args.domains?.length ? args.domains : DEFAULT_DOMAINS,
      limit: args.limit ?? DEFAULT_LIMIT,
      maxDepth: args.depth ?? DEFAULT_DEPTH,
      rate: args.rate ?? DEFAULT_RATE,
      concurrency: args.concurrency ?? DEFAULT_CONCURRENCY,
      ignoreRobots: args.ignoreRobots === true,
    });

  if (stored !== undefined) {
    // A limit is a budget per run, not a permanent ceiling: resuming a crawl
    // that spent its budget is a request for another one, while resuming an
    // interrupted crawl is a request to finish the budget it had.
    const perRun = args.limit ?? stored.limit;
    if (stored.counters.pages >= stored.limit) {
      state.limit = stored.counters.pages + perRun;
    }
    // A resume starts clean: last run's stop reason is not this run's.
    delete state.stopReason;
  }

  // The frontier's options are not persisted with its state — the state
  // carries what was decided, not the rules that decided it — so a resume
  // rebuilds them from the same stored settings the first leg used.
  const frontierOptions = { maxDepth: state.maxDepth };
  const frontier =
    stored === undefined
      ? new Frontier(state.seed, frontierOptions)
      : Frontier.fromState(stored.frontier, frontierOptions);
  // The seed as the frontier keys it, so the store, the report, and the
  // frontier all name the same URL.
  state.seed = frontier.seedUrl;
  const politeness = new Politeness({
    // rate 0 means "as fast as it will go", which a local fixture wants and a
    // real site never does; Politeness takes a rate, so express it as a very
    // large one rather than teaching that unit about zero.
    requestsPerSecond: state.rate > 0 ? state.rate : 1_000_000,
    concurrency: state.concurrency,
    ignoreRobots: state.ignoreRobots,
  });

  // SIGINT is wired here rather than in the runner: the runner takes a
  // signal, which is what makes the interrupt path testable without a real
  // process to signal. Flushing happens inside the loop, so an interrupt
  // leaves a resumable store rather than a corrupt one.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  if (args.signal === undefined) process.once('SIGINT', onSigint);

  try {
    const finished = await executeCrawl({
      store,
      state,
      frontier,
      politeness,
      signal: args.signal ?? controller.signal,
      onProgress:
        args.onProgress ?? ((line) => process.stderr.write(`${line}\n`)),
      ...(args.fetchPage !== undefined && { fetchPage: args.fetchPage }),
    });
    const summary = await summarizeCrawl(store.dir, finished.name);
    return args.json === true
      ? JSON.stringify(summary)
      : renderCrawlSummary(summary);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
