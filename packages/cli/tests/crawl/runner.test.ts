import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  CrawlStore,
  createCrawlState,
  readCrawlRecords,
  type CrawlFrontierSnapshot,
  type CrawlState,
} from '../../src/crawl/store.js';
import {
  executeCrawl,
  type FrontierLike,
  type PolitenessLike,
} from '../../src/crawl/runner.js';
import type {
  FrontierEntry,
  FrontierExpansion,
  PageDiscovery,
} from '../../src/crawl/frontier.js';
import type { Permit, RobotsVerdict } from '../../src/crawl/politeness.js';

// ---------------------------------------------------------------------------
// The fixture site. Every case the runner has to survive is one route:
// a cycle, a paginated catalogue, a 404, a slow page, and a path a
// politeness policy disallows.
// ---------------------------------------------------------------------------

const CATALOGUE_PAGES = 3;

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
}

let server: Server;
let baseUrl: string;
let cwd: string;
/** Set by the /slow route so a test can prove the page was actually served
 * rather than skipped. */
let slowHits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const html = (title: string, body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(title, body));
    };

    if (path === '/') {
      html(
        'home',
        `<a href="/a">A</a><a href="/b">B</a><a href="/catalogue?page=1&utm_source=nl">Catalogue</a><a href="/missing">Gone</a><a href="/private">Private</a><a href="https://example.com/out">Out</a><a href="mailto:x@example.com">Mail</a>`,
      );
      return;
    }
    // The cycle: /a links to /b, /b links back to /a and to the seed.
    if (path === '/a') {
      html('a', '<a href="/b">B</a><a href="/">Home</a>');
      return;
    }
    if (path === '/b') {
      html('b', '<a href="/a">A</a><a href="/">Home</a>');
      return;
    }
    if (path === '/catalogue') {
      const number = Number(url.searchParams.get('page') ?? '1');
      const next =
        number < CATALOGUE_PAGES
          ? `<a rel="next" href="/catalogue?page=${number + 1}">Next</a>`
          : '';
      html('catalogue', `<h1>Page ${number}</h1>${next}`);
      return;
    }
    if (path === '/private') {
      html('private', '<p>should never be fetched</p>');
      return;
    }
    if (path === '/slow') {
      slowHits += 1;
      // Long enough not to look like an unrendered SPA shell: openUrl
      // escalates a thin static page to a browser, which would fetch twice.
      setTimeout(
        () => html('slow', `<p>${'eventually. '.repeat(40)}</p>`),
        200,
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(page('missing', '<p>not here</p>'));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-crawl-runner-'));
  slowHits = 0;
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test doubles for the two pure units the runner drives. They implement the
// structural types the runner declares at its call site, deliberately rather
// than importing crawl/frontier.ts and crawl/politeness.ts: the runner's
// contract is the interface, and these suites must fail for the runner's own
// reasons only.
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = /^(utm_|gclid$|fbclid$)/;

/** The one frontier rule this suite depends on: two URLs differing only by a
 * fragment or a tracking parameter are one page. Without it a cyclic fixture
 * never terminates, which is exactly what the first test below asserts. */
function normalize(href: string): string {
  const url = new URL(href);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

function testFrontier(seed: string, maxDepth: number): FrontierLike {
  const seedUrl = normalize(seed);
  const seen = new Set<string>([seedUrl]);
  const queue: FrontierEntry[] = [{ url: seedUrl, depth: 0, reason: 'seed' }];
  const origin = new URL(seed).origin;

  const push = (
    href: string,
    depth: number,
    skipped: FrontierExpansion['skipped'],
  ): void => {
    let url: string;
    try {
      url = normalize(new URL(href, seed).toString());
    } catch {
      skipped.push({ href, reason: 'non-document-scheme' });
      return;
    }
    if (!url.startsWith(origin)) {
      skipped.push({ href, url, reason: 'external-host' });
      return;
    }
    if (seen.has(url)) {
      skipped.push({ href, url, reason: 'already-seen' });
      return;
    }
    if (depth > maxDepth) {
      skipped.push({ href, url, reason: 'depth-cap' });
      return;
    }
    // Seen at enqueue, not at visit: the property that makes a cycle
    // terminate.
    seen.add(url);
    queue.push({ url, depth, reason: 'content-link' });
  };

  return {
    take: () => queue.shift(),
    get pending() {
      return queue.length;
    },
    expand: (discovery: PageDiscovery): FrontierExpansion => {
      const skipped: FrontierExpansion['skipped'] = [];
      const depth = discovery.depth + 1;
      for (const target of discovery.pagination ?? []) {
        if (target.value.href !== undefined) {
          push(target.value.href, depth, skipped);
        }
      }
      for (const link of discovery.links?.links ?? []) {
        if (link.internal) push(link.href, depth, skipped);
      }
      return { added: [], skipped };
    },
    toState: (): CrawlFrontierSnapshot => ({
      seedUrl,
      seen: [...seen],
      queue: queue.map((entry) => ({ ...entry })),
    }),
  };
}

/**
 * Politeness as the runner sees it: a synchronous verdict, a permit that
 * *returns* a wait instead of sleeping it, and the noteRequest/noteOutcome
 * pair around the request. The double records the calls so the loop's
 * ordering is provable without a clock.
 */
function testPoliteness(
  options: {
    disallow?: RegExp;
    stopAfterFailures?: number;
    waitMs?: number;
  } = {},
): PolitenessLike & { requests: string[] } {
  let failures = 0;
  let stop:
    { kind: 'consecutive-errors'; host: string; count: number } | undefined;
  const robots = new Set<string>();
  let waitsLeft = options.waitMs === undefined ? 0 : 1;
  const requests: string[] = [];

  return {
    requests,
    hasRobots: (host) => robots.has(host),
    setRobots: (host) => robots.add(host),
    check: (url: string): RobotsVerdict =>
      options.disallow?.test(new URL(url).pathname) === true
        ? {
            allowed: false,
            reason: 'disallow-rule',
            rule: { allow: false, path: '/private' },
          }
        : { allowed: true, reason: 'no-rule-matched' },
    permit: (): Permit => {
      if (stop !== undefined) return { kind: 'stop', reason: stop };
      if (waitsLeft > 0 && options.waitMs !== undefined) {
        waitsLeft -= 1;
        return { kind: 'wait', ms: options.waitMs, reason: 'rate-limit' };
      }
      return { kind: 'go' };
    },
    noteRequest: (host) => requests.push(host),
    noteOutcome: (host, outcome) => {
      if (outcome.ok) {
        failures = 0;
        return;
      }
      failures += 1;
      if (
        options.stopAfterFailures !== undefined &&
        failures >= options.stopAfterFailures
      ) {
        stop = { kind: 'consecutive-errors', host, count: failures };
      }
    },
    get stop() {
      return stop;
    },
  };
}

type RunOptions = {
  seed?: string;
  limit?: number;
  maxDepth?: number;
  concurrency?: number;
  politeness?: PolitenessLike;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
};

async function run(options: RunOptions = {}): Promise<CrawlState> {
  const seed = options.seed ?? `${baseUrl}/`;
  const maxDepth = options.maxDepth ?? 3;
  const store = await CrawlStore.open(cwd, 'fixture');
  const state = createCrawlState({
    name: 'fixture',
    seed,
    domains: ['links'],
    limit: options.limit ?? 50,
    maxDepth,
    rate: 0,
    concurrency: options.concurrency ?? 1,
    ignoreRobots: false,
  });
  return executeCrawl({
    store,
    state,
    frontier: testFrontier(seed, maxDepth),
    politeness: options.politeness ?? testPoliteness(),
    ...(options.signal !== undefined && { signal: options.signal }),
    ...(options.sleep !== undefined && { sleep: options.sleep }),
    // The fixture serves no robots.txt, and fetching one per test would only
    // prove core's fetch works. Politeness's own suite covers the parsing.
    robotsFor: async () => undefined,
    onProgress: options.onProgress ?? (() => undefined),
  });
}

describe('executeCrawl', () => {
  // The test that proves the design: the fixture's /a and /b link to each
  // other and back to the seed, so a crawler without a seen set runs
  // forever. This asserts it stops on its own, without --limit saving it.
  it('terminates on a cyclic fixture', async () => {
    const state = await run({ limit: 500 });

    expect(state.stopReason).toBe('frontier exhausted');
    const { records } = await readCrawlRecords(
      CrawlStore.dirFor(cwd, 'fixture'),
    );
    const urls = records.map((record) => record.url);
    expect(new Set(urls).size).toBe(urls.length);
    // Every fixture route, each exactly once: the two cycle pages included.
    expect(urls.filter((url) => url.endsWith('/a'))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith('/b'))).toHaveLength(1);
  }, 30_000);

  it('follows a paginated catalogue to its last page', async () => {
    const state = await run({ seed: `${baseUrl}/catalogue?page=1` });

    const { records } = await readCrawlRecords(
      CrawlStore.dirFor(cwd, 'fixture'),
    );
    expect(records).toHaveLength(CATALOGUE_PAGES);
    expect(state.counters.fetched).toBe(CATALOGUE_PAGES);
  }, 30_000);

  it('keeps a 404 as a record with its error, not an absence', async () => {
    await run({ limit: 500 });

    const { records } = await readCrawlRecords(
      CrawlStore.dirFor(cwd, 'fixture'),
    );
    const missing = records.find((record) => record.url.endsWith('/missing'));
    expect(missing).toBeDefined();
    expect(missing?.outcome.kind).toBe('error');
    expect(JSON.stringify(missing?.outcome)).toContain('404');
  }, 30_000);

  it('waits for a slow page rather than dropping it', async () => {
    const state = await run({ seed: `${baseUrl}/slow` });

    expect(slowHits).toBe(1);
    expect(state.counters.fetched).toBe(1);
  }, 30_000);

  it('records a disallowed URL as skipped with its reason', async () => {
    await run({
      limit: 500,
      politeness: testPoliteness({ disallow: /private/ }),
    });

    const { records } = await readCrawlRecords(
      CrawlStore.dirFor(cwd, 'fixture'),
    );
    const skipped = records.find((record) => record.url.endsWith('/private'));
    // The grounds and the deciding rule, both, so a thin crawl is explicable
    // from the store alone.
    expect(skipped?.outcome).toEqual({
      kind: 'skipped',
      reason: 'robots: disallow-rule (/private)',
    });
    // Skipped means not fetched: no data was extracted for it.
    expect(skipped?.data).toBeUndefined();
  }, 30_000);

  it('ends with a reason when repeated host failures trip the stop condition', async () => {
    const state = await run({
      seed: `${baseUrl}/missing`,
      politeness: testPoliteness({ stopAfterFailures: 1 }),
    });

    expect(state.stopReason).toMatch(/^stopped after 1 consecutive error on /);
  }, 30_000);

  it('stops at the limit and leaves the rest of the frontier for a resume', async () => {
    const state = await run({ limit: 2 });

    expect(state.counters.pages).toBe(2);
    expect(state.stopReason).toBe('limit reached (2 pages)');
    expect(state.frontier.queue.length).toBeGreaterThan(0);
    const saved = CrawlStore.dirFor(cwd, 'fixture');
    const { records } = await readCrawlRecords(saved);
    expect(records).toHaveLength(2);
  }, 30_000);

  it('respects the depth cap', async () => {
    const state = await run({ maxDepth: 0, limit: 500 });

    expect(state.counters.pages).toBe(1);
  }, 30_000);

  it('flushes state and stops cleanly when the signal aborts', async () => {
    const controller = new AbortController();
    const state = await run({
      limit: 500,
      onProgress: () => controller.abort(),
      signal: controller.signal,
    });

    expect(state.stopReason).toBe('interrupted');
    // The point of the flush: what is on disk matches what was crawled, so
    // the crawl resumes rather than restarts.
    const persisted = await CrawlStore.open(cwd, 'fixture').then((store) =>
      store.readState(),
    );
    expect(persisted?.counters.pages).toBe(state.counters.pages);
    expect(persisted?.stopReason).toBe('interrupted');
  }, 30_000);

  it('prints progress as it goes', async () => {
    const lines: string[] = [];
    await run({ limit: 3, onProgress: (line) => lines.push(line) });

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/1 page.*queued/);
  }, 30_000);

  it('crawls with concurrency above one', async () => {
    const state = await run({ limit: 4, concurrency: 3 });

    expect(state.counters.pages).toBe(4);
  }, 30_000);

  it('sleeps the wait politeness returns, rather than politeness sleeping it', async () => {
    const slept: number[] = [];
    await run({
      seed: `${baseUrl}/a`,
      limit: 1,
      politeness: testPoliteness({ waitMs: 40 }),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    expect(slept).toEqual([40]);
  }, 30_000);

  it('takes the rate-limit slot before the request, once per fetched page', async () => {
    const politeness = testPoliteness();
    const state = await run({ limit: 3, politeness });

    // noteRequest is what starts the interval and takes the concurrency
    // slot, so a page fetched without it is a page that outran the limiter.
    expect(politeness.requests).toHaveLength(state.counters.fetched);
  }, 30_000);

  it('extracts only the requested domains', async () => {
    await run({ seed: `${baseUrl}/a`, limit: 1 });

    const { records } = await readCrawlRecords(
      CrawlStore.dirFor(cwd, 'fixture'),
    );
    expect(Object.keys(records[0]?.data ?? {})).toEqual(['links']);
  }, 30_000);
});
