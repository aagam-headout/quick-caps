import { parseHTML } from 'linkedom';
import { fetchAssetText } from 'quick-caps-core';
import { extractData } from 'quick-caps-core/extract';
import type { DataReport, ExtractDomain } from 'quick-caps-core/extract';
import type { Warning } from 'quick-caps-core';
import { computedStyleWarning } from '../computed-style-degradation.js';
import { HttpStatusError } from '../errors.js';
import { openUrl } from '../open.js';
import type {
  FrontierEntry,
  FrontierExpansion,
  FrontierState,
  PageDiscovery,
} from './frontier.js';
import { parseRetryAfterSeconds, parseRobotsTxt } from './politeness.js';
import type {
  Permit,
  RequestOutcome,
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
  /** The response as it was, not as an error message described it: the status
   * and the server's own `Retry-After` both reach the backoff, which is the
   * only signal about pacing a host sends deliberately. */
  noteOutcome(host: string, outcome: RequestOutcome): void;
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

  // The computed-style annotation is not appended here: it is the same
  // sentence for every page of the crawl, so `executeCrawl` states it once at
  // the crawl level. What a record carries is what happened to *that* page.
  return {
    driver,
    data,
    warnings: [...(report.warnings ?? [])],
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
  switch (stop.kind) {
    case 'consecutive-errors':
      return `stopped after ${plural(stop.count, 'consecutive error')} on ${stop.host}`;
    // Named as itself: a crawl that stopped because nothing it tried was
    // answering must not read as one host having spent its own budget.
    case 'all-hosts-failing':
      return `stopped after every one of ${plural(stop.hosts, 'host')} tried was failing`;
    // Likewise its own reason, naming no host, because no host is to blame:
    // the crawl as a whole spent its failure budget.
    case 'error-budget':
      return `stopped after ${plural(stop.errors, 'host-level failure')} across the crawl (budget ${stop.budget})`;
  }
}

/**
 * A sleep that ends when the crawl does.
 *
 * The runner is where waiting lives, so it is also where an interrupt has to
 * land: a backoff can be a minute, and a plain setTimeout would queue SIGINT
 * behind it — the command looks hung and the store is never flushed. The timer
 * is cleared rather than merely raced, so an aborted crawl leaves nothing
 * holding the event loop open either.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal === undefined) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
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
  const sleep = options.sleep ?? ((ms: number) => abortableSleep(ms, signal));
  const startedAt = now();

  // Stated once, before the first page: the annotation is a fact about how
  // this crawl extracts — no live page, so no computed styles — and identical
  // on every record. Per record it would add one warning per page to the tally
  // that exists to surface the few real per-page ones, and ~250 bytes to each
  // line of the dataset.
  const degraded = computedStyleWarning(
    state.domains,
    'a crawl extracts from each page as fetched, with no live page to compute styles from, because a browser and a settle window per page is a different tool',
  );
  if (degraded !== undefined) state.warnings = [degraded];

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
      // The failure stays with the page. Whether it also says something about
      // the host — a 429 or a 5xx does, a 404 does not — is politeness's call,
      // not this loop's, and so is what a Retry-After means.
      politeness.noteOutcome(host, outcomeFor(error, now()));
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
      // Removed by `write`, which runs exactly when the page produced a
      // record. A visit that abandoned — an interrupt or a stop arriving
      // mid-wait — leaves it in flight deliberately, so the final flush puts
      // it back on the queue: the frontier has already marked it seen, and an
      // interrupt must cost no page.
      await visit(entry);
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

/**
 * A failed fetch as politeness reads it. A refused response arrives as an
 * HttpStatusError carrying the status and the `Retry-After` the server sent;
 * anything else — a timeout, a DNS failure, a parse failure — has no status,
 * which politeness already treats as a host-level failure.
 *
 * Nothing is inferred from the message. A status regexed out of one is a guess
 * that reads `exceeds per-asset cap: declared 300 bytes` as a 300, and a header
 * never appears in one at all.
 */
function outcomeFor(error: unknown, nowMs: number): RequestOutcome {
  if (!(error instanceof HttpStatusError)) return { ok: false };
  const retryAfterSeconds = parseRetryAfterSeconds(error.retryAfter, nowMs);
  return {
    ok: false,
    status: error.status,
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  };
}
