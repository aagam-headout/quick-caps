import { parseHTML } from 'linkedom';
import { fetchAssetText } from 'quick-caps-core';
import { extractData } from 'quick-caps-core/extract';
import type { DataReport, ExtractDomain } from 'quick-caps-core/extract';
import type { Warning } from 'quick-caps-core';
import { openUrl } from '../open.js';
import type {
  FrontierEntry,
  FrontierExpansion,
  FrontierState,
  PageDiscovery,
} from './frontier.js';
import { parseRobotsTxt } from './politeness.js';
import type {
  Permit,
  RobotsTxt,
  RobotsVerdict,
  StopReason,
} from './politeness.js';
import type { CrawlRecord, CrawlState, CrawlStore } from './store.js';

/**
 * The loop, and nothing that decides anything.
 *
 * Which URL comes next, whether a URL may be fetched, and how long to wait
 * are the three decisions a crawl gets wrong, so all three live in the pure
 * units — crawl/frontier.ts and crawl/politeness.ts — and reach this file
 * only through the two interfaces below. What is left here is mechanical:
 * take, ask, wait, fetch, extract, expand, append. That is why this is the
 * one unit of the four that is inherently integration-tested.
 *
 * The interfaces are declared structurally at the call site, the same seam
 * `RecordableRequest` uses for the slice of Playwright's `Request` the
 * recorder reads: the real `Frontier` and `Politeness` satisfy them, and a
 * test can drive the loop with a double that has no clock and no network.
 */

export type FrontierLike = {
  /** Highest-priority URL first. A URL is marked seen when it is *enqueued*,
   * which is the property that makes a cycle terminate. */
  take(): FrontierEntry | undefined;
  readonly pending: number;
  /** Folds one page's links and pagination in, reporting what it refused and
   * why — the runner counts those reasons rather than dropping them. */
  expand(discovery: PageDiscovery): FrontierExpansion;
  toState(): FrontierState;
};

export type PolitenessLike = {
  /** Whether this host's robots.txt has been looked at. Politeness does not
   * fetch — the runner owes it the file, which is what keeps that unit pure. */
  hasRobots(host: string): boolean;
  setRobots(host: string, robots: RobotsTxt | undefined): void;
  check(url: string): RobotsVerdict;
  /** Returns the wait rather than performing it: sleeping is the runner's
   * job, and that split is what makes the rate limiter testable against an
   * injected clock with no real timers. */
  permit(host: string): Permit;
  /** Immediately before the request: takes the concurrency slot and starts
   * the rate-limit interval. */
  noteRequest(host: string): void;
  noteOutcome(host: string, outcome: { ok: boolean; status?: number }): void;
  readonly stop: StopReason | undefined;
};

export type CrawledPage = {
  driver: 'static' | 'playwright';
  /** Only the requested domains. The discovery domains are extracted too but
   * are not persisted unless the caller asked for them. */
  data: Partial<DataReport>;
  warnings: Warning[];
  links?: NonNullable<PageDiscovery['links']>;
  pagination?: NonNullable<PageDiscovery['pagination']>;
};

export type PageFetcher = (
  url: string,
  domains: ExtractDomain[],
) => Promise<CrawledPage>;

/** The domains the frontier needs whether or not the caller asked to keep
 * them: without `links` and `entities.pagination` there is nowhere to go
 * next. */
const DISCOVERY_DOMAINS: ExtractDomain[] = ['links', 'entities'];

/**
 * The default fetch-and-extract, which is `pc data`'s path exactly: static
 * first, escalating to a browser only where `openUrl` already escalates (an
 * unrendered SPA shell). No session is written — a crawl's output is its
 * store, and 200 pages must not fight over one session file — and no
 * `--record`: a browser plus a settle window per page is a different tool.
 */
export async function fetchAndExtract(
  url: string,
  domains: ExtractDomain[],
): Promise<CrawledPage> {
  const { ir, driver } = await openUrl(url);
  const { document } = parseHTML(ir.html);
  const requested = new Set(domains);
  // One extraction pass over the union: running the discovery domains
  // separately would parse and walk the same document twice per page.
  const union = [...new Set([...domains, ...DISCOVERY_DOMAINS])];
  const report = extractData(
    { doc: document as unknown as Document, ir },
    union,
  );

  const data: Partial<DataReport> = {};
  for (const domain of union) {
    if (!requested.has(domain)) continue;
    const value = report[domain];
    // A per-domain assignment off a Partial<DataReport> needs the cast the
    // registry avoids by spelling its domains out; here the set of domains is
    // the caller's, so the loop is worth one cast.
    if (value !== undefined) (data as Record<string, unknown>)[domain] = value;
  }

  return {
    driver,
    data,
    warnings: report.warnings ?? [],
    ...(report.links !== undefined && { links: { links: report.links.links } }),
    ...(report.entities !== undefined && {
      pagination: report.entities.pagination,
    }),
  };
}

/** robots.txt for a host, or undefined when there is none to read. Undefined
 * is a fact politeness distinguishes from "not looked at yet", so a failed
 * fetch is still recorded as an answer. */
export async function fetchRobots(
  origin: string,
): Promise<RobotsTxt | undefined> {
  try {
    return parseRobotsTxt(
      await fetchAssetText(`${origin}/robots.txt`, {
        timeoutMs: 5_000,
        maxBytes: 512 * 1024,
      }),
    );
  } catch {
    return undefined;
  }
}

export type ExecuteCrawlOptions = {
  store: CrawlStore;
  /** Mutated as the crawl runs and returned at the end: the same object the
   * store persists, so what a resume reads is what the crawl believed. */
  state: CrawlState;
  frontier: FrontierLike;
  politeness: PolitenessLike;
  fetchPage?: PageFetcher;
  robotsFor?: (origin: string) => Promise<RobotsTxt | undefined>;
  /** One line per page. A silent multi-minute command is indistinguishable
   * from a hung one. */
  onProgress?: (line: string) => void;
  /** Aborted by the command's SIGINT handler. The loop leaves the page it is
   * on, flushes state, and returns — so the store is resumable rather than
   * corrupt. */
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** How long a worker waits before re-asking a host that has every concurrency
 * slot in flight. Short enough not to idle the crawl, long enough not to spin. */
const BUSY_TICK_MS = 25;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describeStop(stop: StopReason): string {
  return `stopped after ${plural(stop.count, 'consecutive error')} on ${stop.host}`;
}

/** The robots verdict as a skip reason worth reading in the store: the
 * grounds, plus the rule that decided it when one did. */
function skipReason(verdict: RobotsVerdict): string {
  const rule = verdict.rule === undefined ? '' : ` (${verdict.rule.path})`;
  return `robots: ${verdict.reason}${rule}`;
}

/**
 * Runs the crawl to a stop condition and returns the final state, which the
 * caller renders. Every exit is a named `stopReason`: a crawl that produced a
 * short dataset for a reason nobody can see is the failure this exists to
 * prevent.
 */
export async function executeCrawl(
  options: ExecuteCrawlOptions,
): Promise<CrawlState> {
  const {
    store,
    state,
    frontier,
    politeness,
    fetchPage = fetchAndExtract,
    robotsFor = fetchRobots,
    onProgress,
    signal,
  } = options;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();

  let stopReason: string | undefined;
  /** Set once, by whichever worker gets there first; the others see it on
   * their next turn and leave rather than racing to overwrite it. */
  const stop = (reason: string): void => {
    stopReason ??= reason;
  };

  /** Taken from the frontier but not yet written. Flushed back into the
   * persisted queue, because a URL the frontier has already marked seen would
   * otherwise be lost to a resume — an interrupt must cost no page. */
  const inFlight = new Set<FrontierEntry>();

  /** One robots fetch per host even under concurrency: two workers reaching a
   * new host together would otherwise both fetch it. */
  const robotsPending = new Map<string, Promise<void>>();
  const ensureRobots = async (origin: string, host: string): Promise<void> => {
    if (politeness.hasRobots(host)) return;
    let pending = robotsPending.get(host);
    if (pending === undefined) {
      pending = robotsFor(origin).then((robots) => {
        politeness.setRobots(host, robots);
      });
      robotsPending.set(host, pending);
    }
    await pending;
  };

  const flush = async (): Promise<void> => {
    const snapshot = frontier.toState();
    state.frontier = {
      ...snapshot,
      // In-flight first: they were next in priority order when they were
      // taken.
      queue: [...inFlight, ...snapshot.queue],
    };
    state.updatedAt = new Date().toISOString();
    if (stopReason !== undefined) state.stopReason = stopReason;
    await store.saveState(state);
  };

  const write = async (
    entry: FrontierEntry,
    record: CrawlRecord,
  ): Promise<void> => {
    // Out of the in-flight set before the flush below: a page that has a
    // record is visited, and must not also come back as queued on a resume.
    inFlight.delete(entry);
    await store.append(record);
    state.counters.pages += 1;
    switch (record.outcome.kind) {
      case 'fetched':
        state.counters.fetched += 1;
        break;
      case 'error':
        state.counters.errors += 1;
        break;
      case 'skipped':
        state.counters.skipped += 1;
        break;
    }
    // State is flushed after every page, not at the end: the state file exists
    // to survive a kill that arrives without warning, and it is a few hundred
    // bytes.
    await flush();
    onProgress?.(
      `${plural(state.counters.pages, 'page')}, ${frontier.pending} queued, ${(
        (now() - startedAt) /
        1000
      ).toFixed(1)}s`,
    );
  };

  /** Waits out whatever politeness asks for, and reports whether the request
   * may still go. `abandon` leaves the URL in flight, so it is flushed back
   * into the queue rather than counted as visited. */
  const awaitTurn = async (host: string): Promise<'go' | 'abandon'> => {
    for (;;) {
      if (signal?.aborted === true) return 'abandon';
      const permit = politeness.permit(host);
      switch (permit.kind) {
        case 'go':
          return 'go';
        case 'stop':
          stop(describeStop(permit.reason));
          return 'abandon';
        case 'busy':
          await sleep(BUSY_TICK_MS);
          break;
        case 'wait':
          await sleep(permit.ms);
          break;
      }
    }
  };

  const visit = async (entry: FrontierEntry): Promise<void> => {
    const at = new Date().toISOString();
    const { origin, host } = new URL(entry.url);
    // Fetched even under --ignore-robots: that flag waives rules about where
    // to go, not the crawl-delay politeness reads from the same file.
    await ensureRobots(origin, host);

    const verdict = politeness.check(entry.url);
    if (!verdict.allowed) {
      // A skip is a record, not an absence: a thin crawl has to be
      // explicable afterwards.
      await write(entry, {
        url: entry.url,
        depth: entry.depth,
        at,
        outcome: { kind: 'skipped', reason: skipReason(verdict) },
      });
      return;
    }

    if ((await awaitTurn(host)) === 'abandon') return;
    politeness.noteRequest(host);

    let page: CrawledPage;
    try {
      page = await fetchPage(entry.url, state.domains);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = statusFrom(message);
      // The failure stays with the page. Whether it also says something about
      // the host — a 429 or a 5xx does, a 404 does not — is politeness's call,
      // not this loop's.
      politeness.noteOutcome(host, {
        ok: false,
        ...(status !== undefined && { status }),
      });
      await write(entry, {
        url: entry.url,
        depth: entry.depth,
        at,
        outcome: { kind: 'error', reason: 'fetch failed', detail: message },
      });
      return;
    }

    politeness.noteOutcome(host, { ok: true, status: 200 });
    const expansion = frontier.expand({
      pageUrl: entry.url,
      depth: entry.depth,
      ...(page.links !== undefined && { links: page.links }),
      ...(page.pagination !== undefined && { pagination: page.pagination }),
    });
    // Counted by reason rather than written one record per refused href:
    // 'already-seen' fires for every chrome link on every page, so a record
    // each would bury the pages the caller asked for under its own bookkeeping.
    // The tally keeps a thin crawl explicable at a cost that does not grow
    // with the site.
    for (const skip of expansion.skipped) {
      const tally = (state.discoverySkips ??= {});
      tally[skip.reason] = (tally[skip.reason] ?? 0) + 1;
    }

    await write(entry, {
      url: entry.url,
      depth: entry.depth,
      at,
      outcome: { kind: 'fetched', driver: page.driver },
      ...(Object.keys(page.data).length > 0 && { data: page.data }),
      ...(page.warnings.length > 0 && { warnings: page.warnings }),
    });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopReason !== undefined) return;
      if (signal?.aborted === true) {
        stop('interrupted');
        return;
      }
      const hostStop = politeness.stop;
      if (hostStop !== undefined) {
        stop(describeStop(hostStop));
        return;
      }
      if (state.counters.pages >= state.limit) {
        stop(`limit reached (${state.limit} pages)`);
        return;
      }
      const entry = frontier.take();
      // An empty frontier is not proof the crawl is over: another worker may
      // be about to expand one more page into it. The caller below decides.
      if (entry === undefined) return;
      inFlight.add(entry);
      try {
        await visit(entry);
      } finally {
        inFlight.delete(entry);
      }
    }
  };

  const concurrency = Math.max(1, state.concurrency);
  for (;;) {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (stopReason !== undefined) break;
    if (frontier.pending === 0) {
      stop('frontier exhausted');
      break;
    }
  }

  await flush();
  return state;
}

/** The HTTP status out of fetchAssetBytes's `"404 Not Found"` message, when
 * there is one. Read from the message because that is the only place the
 * status survives — a shared fetch helper that threw is not going to grow a
 * status field for the crawler's sake. */
function statusFrom(message: string): number | undefined {
  const match = /\b(\d{3})\b/.exec(message);
  if (match === null) return undefined;
  const status = Number(match[1]);
  return status >= 100 && status <= 599 ? status : undefined;
}
