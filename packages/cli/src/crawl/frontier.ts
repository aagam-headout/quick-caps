import type {
  Extracted,
  LinkReport,
  LinkZone,
  PaginationTarget,
} from 'quick-caps-core/extract';
import { CliError } from '../errors.js';

/**
 * The frontier: given a seed, the pages already accounted for, and one page's
 * `links` and `entities.pagination` reports, what to visit next.
 *
 * Pure by construction — no fetch, no disk, no clock. A crawl that fails to
 * terminate, revisits a page a hundred times, or spends its `--limit` on the
 * same footer links from every page is failing here, and none of those
 * failures need a network to reproduce.
 */

// ---------------------------------------------------------------------------
// URL normalization
//
// This is the part that decides whether a crawl terminates. Two URLs that
// address the same page must normalize to the same string, or a finite site
// looks infinite: the classic case is a per-visit tracking parameter, which
// mints a fresh "unseen" URL on every hop.
// ---------------------------------------------------------------------------

/** Schemes a crawler can fetch a document from. Everything else — `mailto:`,
 * `tel:`, `javascript:`, `data:`, `ftp:` — is a link a browser would act on
 * and a crawler cannot. */
const DOCUMENT_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Query parameters that identify a referral rather than a page. A trailing `*`
 * matches by prefix, which is how the `utm_` family is covered without listing
 * its members.
 *
 * Extensible rather than exhaustive: every analytics vendor invents its own,
 * and a caller crawling a site that carries a `sessionid` in every link needs
 * to say so without waiting for this list to grow.
 */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  'utm_*',
  'gclid',
  'fbclid',
];

export type NormalizeOptions = {
  /** Added to DEFAULT_TRACKING_PARAMS rather than replacing it, so extending
   * the set cannot silently lose the defaults. */
  trackingParams?: readonly string[];
};

function isTrackingParam(name: string, patterns: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.endsWith('*') ? lower.startsWith(p.slice(0, -1)) : lower === p;
  });
}

/**
 * One href to the canonical string this crawl will key it by, or null when it
 * is not a crawlable document URL.
 *
 * Every rule is applied here and nowhere else, so "is this the same page"
 * has exactly one answer in the codebase:
 *
 * - resolved against the page it was found on, so relative hrefs work;
 * - fragment dropped — `#section` is a position in a document, not a document;
 * - host lowercased (hosts are case-insensitive) but **never the path**, which
 *   is case-sensitive on most servers: lowercasing it would fetch 404s;
 * - a trailing `index.html` stripped, since a directory and its index are one
 *   page;
 * - query parameters sorted, so declaration order stops mattering, with
 *   tracking parameters dropped entirely.
 *
 * Deliberately *not* normalized: a trailing slash on a non-index path. `/a`
 * and `/a/` are the same page on most servers and different pages on some,
 * and guessing wrong loses pages rather than merely re-fetching one.
 */
export function normalizeUrl(
  href: string,
  pageUrl: string,
  options: NormalizeOptions = {},
): string | null {
  const raw = href.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw, pageUrl);
  } catch {
    return null;
  }
  if (!DOCUMENT_PROTOCOLS.has(url.protocol)) return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  const INDEX = '/index.html';
  if (url.pathname.endsWith(INDEX)) {
    url.pathname = url.pathname.slice(0, -INDEX.length + 1);
  }

  const patterns = [
    ...DEFAULT_TRACKING_PARAMS,
    ...(options.trackingParams ?? []),
  ];
  const kept = [...url.searchParams].filter(
    ([name]) => !isTrackingParam(name, patterns),
  );
  // Sorted by name only, and Array#sort is stable, so repeated names keep the
  // order the page declared them in — `?t=2&t=1` is not `?t=1&t=2` to a server
  // that reads the first occurrence.
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = new URLSearchParams(kept).toString();
  url.search = search ? `?${search}` : '';

  return url.toString();
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** Why a URL is in the frontier — also its priority, via RANK below, and the
 * provenance a report can print beside a crawled page. */
export type FrontierReason =
  | 'seed'
  | 'pagination-next'
  | 'pagination-numbered'
  | 'content-link'
  | 'other-link'
  | 'nav-link'
  | 'footer-link';

/**
 * Visit order, lowest first.
 *
 * Pagination outranks everything because pagination is how a catalogue exposes
 * its own contents: page 2 of a listing is more of what the caller asked for,
 * where an incidental link is a detour.
 *
 * Content outranks chrome because a site's chrome links to the same twenty
 * pages from every page. Walking content first reaches new material sooner and
 * makes a `--limit` spend its budget on pages worth having, instead of
 * re-discovering the nav from page one.
 */
const RANK: Record<FrontierReason, number> = {
  seed: 0,
  'pagination-next': 1,
  'pagination-numbered': 2,
  'content-link': 3,
  // An aside or an unclassified zone is not chrome, but nothing confirmed it
  // as content either, so it queues behind content and ahead of known chrome.
  'other-link': 4,
  'nav-link': 5,
  'footer-link': 6,
};

const REASON_BY_ZONE: Record<LinkZone, FrontierReason> = {
  content: 'content-link',
  nav: 'nav-link',
  footer: 'footer-link',
  aside: 'other-link',
  unknown: 'other-link',
};

export type FrontierEntry = {
  /** Normalized, so this is also the key the seen-set and the store use. */
  url: string;
  depth: number;
  reason: FrontierReason;
};

/** Why a discovered href did not become an entry. Recorded rather than
 * dropped: a thin crawl with reasons is explicable, a thin crawl without them
 * is a mystery. */
export type FrontierSkipReason =
  'non-document-scheme' | 'external-host' | 'already-seen' | 'depth-cap';

export type FrontierSkip = {
  /** The href as the page wrote it. */
  href: string;
  /** Its normalized form, absent when it had none. */
  url?: string;
  reason: FrontierSkipReason;
};

export type FrontierExpansion = {
  added: FrontierEntry[];
  skipped: FrontierSkip[];
};

/**
 * What one crawled page contributes. The two report fields are narrow
 * structural slices rather than the full `LinkReport`/`EntityReport` — the
 * same seam `RecordableResponse` uses in the Playwright driver: a full report
 * satisfies them, and a test can hand over two links without building an IR.
 */
export type PageDiscovery = {
  /** The URL the links were found on, used as the resolution base. */
  pageUrl: string;
  /** The depth that page was visited at; its links sit one below. */
  depth: number;
  links?: Pick<LinkReport, 'links'>;
  pagination?: readonly Extracted<PaginationTarget>[];
};

/** Levels below the seed, when the caller names none. Two hops covers a
 * listing and its detail pages, which is the common shape; `--depth` raises
 * it. */
export const DEFAULT_MAX_DEPTH = 3;

export type FrontierOptions = {
  maxDepth?: number;
  /** Hosts crawled in addition to the seed's — an apex plus its `www`, say.
   * Compared after lowercasing, like every other host comparison here. */
  hosts?: readonly string[];
  trackingParams?: readonly string[];
};

/**
 * The frontier's whole state, in a shape `JSON.stringify` round-trips. The
 * store owns persisting it; the frontier owns what is in it, so resume cannot
 * drift from a live crawl's rules.
 */
export type FrontierState = {
  seedUrl: string;
  /** Every URL enqueued or visited. A URL is marked seen when it is
   * *enqueued*, not when it is visited — that is what stops a cycle from
   * queueing the same page once per inbound link. */
  seen: string[];
  queue: FrontierEntry[];
};

/** Pagination kinds worth following. `prev` walks backwards into pages the
 * crawl either has or will reach, and `load-more` has no href to follow. */
const FOLLOWED_PAGINATION = new Set<PaginationTarget['kind']>([
  'next',
  'numbered',
]);

export class Frontier {
  readonly seedUrl: string;
  private readonly maxDepth: number;
  private readonly hosts: Set<string>;
  private readonly trackingParams: readonly string[];
  private readonly seenUrls = new Set<string>();
  private queue: FrontierEntry[] = [];

  constructor(seed: string, options: FrontierOptions = {}) {
    const seedUrl = normalizeUrl(seed, seed, options);
    if (!seedUrl) {
      throw new CliError(`Not a crawlable seed URL: ${seed}`);
    }
    this.seedUrl = seedUrl;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.trackingParams = options.trackingParams ?? [];
    this.hosts = new Set(
      [new URL(seedUrl).host, ...(options.hosts ?? [])].map((host) =>
        host.toLowerCase(),
      ),
    );
    this.enqueue({ url: seedUrl, depth: 0, reason: 'seed' });
  }

  /** Rebuilds a frontier mid-crawl. The options must match the ones the crawl
   * started with — the state carries what was decided, not the rules that
   * decided it. */
  static fromState(
    state: FrontierState,
    options: FrontierOptions = {},
  ): Frontier {
    const frontier = new Frontier(state.seedUrl, options);
    frontier.seenUrls.clear();
    for (const url of state.seen) frontier.seenUrls.add(url);
    frontier.queue = state.queue.map((entry) => ({ ...entry }));
    return frontier;
  }

  /** URLs waiting to be visited. */
  get pending(): number {
    return this.queue.length;
  }

  /** URLs enqueued at any point, visited or not — the crawl's dedupe universe. */
  get seen(): number {
    return this.seenUrls.size;
  }

  has(url: string): boolean {
    return this.seenUrls.has(url);
  }

  /** The next URL to visit, highest priority first and in discovery order
   * within a priority. */
  take(): FrontierEntry | undefined {
    return this.queue.shift();
  }

  /** Everything left, in visit order. For tests and for a report over an
   * interrupted crawl; a runner uses `take`. */
  drain(): FrontierEntry[] {
    const entries = this.queue;
    this.queue = [];
    return entries;
  }

  toState(): FrontierState {
    return {
      seedUrl: this.seedUrl,
      seen: [...this.seenUrls],
      queue: this.queue.map((entry) => ({ ...entry })),
    };
  }

  /**
   * Folds one page's discoveries into the queue, reporting both what it added
   * and what it refused. Pagination is offered before links so that, all ranks
   * being equal, the catalogue's own ordering survives.
   */
  expand(discovery: PageDiscovery): FrontierExpansion {
    const added: FrontierEntry[] = [];
    const skipped: FrontierSkip[] = [];
    const depth = discovery.depth + 1;

    for (const { href, reason } of candidates(discovery)) {
      const url = normalizeUrl(href, discovery.pageUrl, {
        trackingParams: this.trackingParams,
      });
      if (!url) {
        skipped.push({ href, reason: 'non-document-scheme' });
        continue;
      }
      // The crawl's host set is the authority, not the link's `internal` flag:
      // that flag is computed against the page's own origin, so on a page
      // reached through a second allowed host it would mark off-crawl links
      // internal. One rule also covers pagination targets, which carry no flag.
      if (!this.hosts.has(new URL(url).host)) {
        skipped.push({ href, url, reason: 'external-host' });
        continue;
      }
      if (this.seenUrls.has(url)) {
        skipped.push({ href, url, reason: 'already-seen' });
        continue;
      }
      if (depth > this.maxDepth) {
        skipped.push({ href, url, reason: 'depth-cap' });
        continue;
      }
      const entry: FrontierEntry = { url, depth, reason };
      this.enqueue(entry);
      added.push(entry);
    }

    return { added, skipped };
  }

  private enqueue(entry: FrontierEntry): void {
    this.seenUrls.add(entry.url);
    this.queue.push(entry);
    // Re-sorting the whole queue on every expansion is O(n log n) per page,
    // which at crawl sizes is nothing next to one HTTP request, and it keeps
    // priority in one readable place instead of a heap. Array#sort is stable,
    // so equal ranks stay in discovery order.
    this.queue.sort((a, b) => RANK[a.reason] - RANK[b.reason]);
  }
}

/** Discovered hrefs with the reason each would enter the frontier under, in
 * offer order. */
function candidates(
  discovery: PageDiscovery,
): Array<{ href: string; reason: FrontierReason }> {
  const out: Array<{ href: string; reason: FrontierReason }> = [];
  for (const target of discovery.pagination ?? []) {
    const { kind, href } = target.value;
    if (!href || !FOLLOWED_PAGINATION.has(kind)) continue;
    out.push({
      href,
      reason: kind === 'next' ? 'pagination-next' : 'pagination-numbered',
    });
  }
  for (const entry of discovery.links?.links ?? []) {
    out.push({ href: entry.href, reason: REASON_BY_ZONE[entry.zone] });
  }
  return out;
}
