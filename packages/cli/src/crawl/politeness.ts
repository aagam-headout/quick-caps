/**
 * Politeness: robots.txt rules, per-host pacing, backoff, and the stop
 * conditions.
 *
 * Pure policy plus an injected clock. Nothing here fetches anything — the
 * runner fetches `/robots.txt` and hands the text to `parseRobotsTxt`, and the
 * runner waits out the delay this unit computes. That split is what makes
 * "one request per second" provable without a test that sleeps, and
 * "disallowed for this reason" recordable instead of silently dropped.
 */

// ---------------------------------------------------------------------------
// robots.txt parsing
// ---------------------------------------------------------------------------

export type RobotsRule = {
  allow: boolean;
  /** The path pattern as written, `*` and `$` included. */
  path: string;
};

export type RobotsGroup = {
  /** Product tokens, lowercased. `*` is the wildcard group. */
  agents: string[];
  rules: RobotsRule[];
  /** Absent when the group declared none, or declared an unusable one. */
  crawlDelaySeconds?: number;
};

export type RobotsTxt = {
  groups: RobotsGroup[];
  /** File-scoped, not group-scoped: a `Sitemap` line applies to the host
   * regardless of which user-agent block it happens to sit in. */
  sitemaps: string[];
};

/**
 * Parses a robots.txt. Never throws: a 404 body, an HTML error page, or a
 * truncated file all parse to something that allows everything.
 *
 * That degradation is deliberate. A parser that threw, or that read a garbage
 * file as `Disallow: /`, would turn one unreadable file into a crawl that
 * politely refuses to do anything — the failure mode nobody can debug from the
 * output.
 */
export function parseRobotsTxt(text: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let group: RobotsGroup | undefined;
  // Consecutive User-agent lines share one group; the first rule line closes
  // the agent list, so the next User-agent starts a new group.
  let acceptingAgents = false;

  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    const comment = line.indexOf('#');
    const stripped = (comment === -1 ? line : line.slice(0, comment)).trim();
    if (!stripped) continue;
    const colon = stripped.indexOf(':');
    if (colon === -1) continue; // not a directive; robots.txt has no other syntax
    const field = stripped.slice(0, colon).trim().toLowerCase();
    const value = stripped.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!group || !acceptingAgents) {
        group = { agents: [], rules: [] };
        groups.push(group);
        acceptingAgents = true;
      }
      if (value) group.agents.push(value.toLowerCase());
      continue;
    }
    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    // A rule outside any group binds to nobody, so it is ignored rather than
    // guessed at as a wildcard rule.
    if (!group) continue;

    if (field === 'allow' || field === 'disallow') {
      acceptingAgents = false;
      // An empty Disallow is the documented way to say "everything", so it
      // contributes no rule rather than a rule matching every path.
      if (value) group.rules.push({ allow: field === 'allow', path: value });
      continue;
    }
    if (field === 'crawl-delay') {
      acceptingAgents = false;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        group.crawlDelaySeconds = seconds;
      }
      continue;
    }
    // Anything else — Host, Noindex, a vendor extension — is not ours to
    // interpret.
  }

  return { groups, sitemaps };
}

/**
 * The group governing a user agent: the longest matching product token, or the
 * wildcard group, or nothing.
 *
 * Longest-token-wins is what makes `quick-caps` beat `*`, and matching by
 * substring is what makes a group named `quick-caps` apply to a full
 * `quick-caps/1 (+url)` header.
 */
export function matchRobotsGroup(
  robots: RobotsTxt | undefined,
  userAgent: string,
): RobotsGroup | undefined {
  if (!robots) return undefined;
  const agent = userAgent.toLowerCase();
  let best: RobotsGroup | undefined;
  let bestLength = -1;
  let wildcard: RobotsGroup | undefined;

  for (const group of robots.groups) {
    for (const token of group.agents) {
      if (token === '*') {
        wildcard ??= group;
        continue;
      }
      if (agent.includes(token) && token.length > bestLength) {
        best = group;
        bestLength = token.length;
      }
    }
  }
  return best ?? wildcard;
}

export type RobotsReason =
  /** No robots.txt for this host, or it could not be fetched. */
  | 'no-robots'
  /** A robots.txt with no group naming this agent or `*`. */
  | 'no-group-matched'
  /** A group applied, but no rule in it matched the path. */
  | 'no-rule-matched'
  | 'allow-rule'
  | 'disallow-rule'
  /** The caller passed --ignore-robots; no rules were consulted. */
  | 'robots-ignored'
  | 'unparseable-url';

/** A decision with its grounds, so a skipped URL can be recorded with the
 * reason it was skipped rather than disappearing from the dataset. */
export type RobotsVerdict = {
  allowed: boolean;
  reason: RobotsReason;
  /** The rule that decided it, when one did. */
  rule?: RobotsRule;
};

/** A rule path to a matcher. `*` is any run of characters and a trailing `$`
 * anchors the end; everything else is literal, `?` and `.` included. */
function ruleMatcher(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = anchored ? path.slice(0, -1) : path;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Whether a URL is allowed, by the group governing `userAgent`.
 *
 * Longest match wins, and an equal-length tie goes to Allow — the rule Google
 * publishes, and the one that reads a site's intent correctly: an operator who
 * writes both about the same path meant to carve out an exception.
 */
export function isUrlAllowed(
  robots: RobotsTxt | undefined,
  url: string,
  userAgent: string,
): RobotsVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Refusing is the honest answer: nothing here can say what this addresses.
    return { allowed: false, reason: 'unparseable-url' };
  }
  if (!robots) return { allowed: true, reason: 'no-robots' };
  const group = matchRobotsGroup(robots, userAgent);
  if (!group) return { allowed: true, reason: 'no-group-matched' };

  // Rules match against path and query together, because a Disallow like
  // `/search?q=` is about the query, not the path.
  const target = `${parsed.pathname}${parsed.search}`;
  let winner: RobotsRule | undefined;
  for (const rule of group.rules) {
    if (!ruleMatcher(rule.path).test(target)) continue;
    if (!winner) {
      winner = rule;
      continue;
    }
    if (rule.path.length > winner.path.length) winner = rule;
    else if (rule.path.length === winner.path.length && rule.allow)
      winner = rule;
  }
  if (!winner) return { allowed: true, reason: 'no-rule-matched' };
  return {
    allowed: winner.allow,
    reason: winner.allow ? 'allow-rule' : 'disallow-rule',
    rule: winner,
  };
}

// ---------------------------------------------------------------------------
// Pacing, backoff, and stopping
// ---------------------------------------------------------------------------

/** Injected for the same reason `CollectOptions.now` is: a policy that reads
 * the global clock can only be tested by waiting for it. */
export type Clock = { now: () => number };

export const DEFAULT_REQUESTS_PER_SECOND = 1;
export const DEFAULT_CONCURRENCY = 1;
/** Consecutive host-level failures before the crawl gives up. A crawler that
 * keeps hammering a host that is failing is the behaviour that gets tools
 * blocked. */
export const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
export const BACKOFF_BASE_MS = 1_000;
/** A minute is long enough to ride out a deploy and short enough that a
 * resumed crawl is not indistinguishable from a hung one. */
export const BACKOFF_MAX_MS = 60_000;
/** An identifiable agent, so an operator reading their logs can tell what hit
 * them and act on it. */
export const DEFAULT_USER_AGENT =
  'quick-caps-crawler/1 (+https://github.com/aagam-headout/quick-caps)';

export type PolitenessOptions = {
  userAgent?: string;
  requestsPerSecond?: number;
  concurrency?: number;
  /** Waives robots *rules*. Crawl-delay is still honoured — the flag exists
   * for sites the caller is entitled to crawl, not as licence to hammer one. */
  ignoreRobots?: boolean;
  maxConsecutiveErrors?: number;
  clock?: Clock;
};

/** What the runner reports back about one request. `ok` is the runner's
 * judgement so a transport failure, which has no status at all, is
 * expressible. */
export type RequestOutcome = {
  ok: boolean;
  status?: number;
  /** From a `Retry-After` header, when the server sent one. */
  retryAfterSeconds?: number;
};

export type StopReason = {
  kind: 'consecutive-errors';
  /** The host whose failure tripped it. */
  host: string;
  count: number;
};

/**
 * Whether a request to a host may go now, and if not, why not. One decision
 * surface rather than three predicates: a runner that has to combine "is it
 * rate limited", "is it backing off" and "is a slot free" itself will combine
 * them differently from the tests.
 */
export type Permit =
  | { kind: 'go' }
  | {
      kind: 'wait';
      ms: number;
      reason: 'rate-limit' | 'crawl-delay' | 'backoff';
    }
  /** Every concurrency slot for this host is in flight. */
  | { kind: 'busy' }
  | { kind: 'stop'; reason: StopReason };

type HostState = {
  lastRequestAtMs?: number;
  inFlight: number;
  consecutiveErrors: number;
  /** Set while backing off; the clock time the host may be tried again. */
  retryAtMs?: number;
};

/** A status the host, not the page, is responsible for. A 404 is a fact about
 * one URL and must not slow the crawl or count toward stopping it; a 429 or a
 * 5xx says the host wants less traffic. A failure with no status at all is a
 * transport failure, which is host-level by default. */
function isHostFailure(outcome: RequestOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.status === undefined) return true;
  return outcome.status === 429 || outcome.status >= 500;
}

export class Politeness {
  readonly userAgent: string;
  private readonly intervalMs: number;
  private readonly concurrency: number;
  private readonly ignoreRobots: boolean;
  private readonly maxConsecutiveErrors: number;
  private readonly clock: Clock;
  private readonly hosts = new Map<string, HostState>();
  /** Absent for a host whose robots.txt is missing or unreadable — present as
   * a key either way, so `hasRobots` answers "have we looked". */
  private readonly robots = new Map<string, RobotsTxt | undefined>();
  private stopReason: StopReason | undefined;

  constructor(options: PolitenessOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const rate = options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND;
    this.intervalMs = Math.ceil(1_000 / rate);
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.ignoreRobots = options.ignoreRobots ?? false;
    this.maxConsecutiveErrors =
      options.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  /** Records a host's robots.txt, or its absence. Pass `undefined` when the
   * fetch failed — that is a different fact from "not looked at yet". */
  setRobots(host: string, robots: RobotsTxt | undefined): void {
    this.robots.set(host.toLowerCase(), robots);
  }

  /** Whether this host's robots.txt has been looked at, so the runner knows
   * whether it still owes a fetch. */
  hasRobots(host: string): boolean {
    return this.robots.has(host.toLowerCase());
  }

  sitemaps(host: string): string[] {
    return this.robots.get(host.toLowerCase())?.sitemaps ?? [];
  }

  /** The host's crawl-delay in ms, 0 when it declared none. Read even under
   * --ignore-robots: the flag waives rules about *where* to go, not courtesy
   * about how fast. */
  crawlDelayMs(host: string): number {
    const group = matchRobotsGroup(
      this.robots.get(host.toLowerCase()),
      this.userAgent,
    );
    return (group?.crawlDelaySeconds ?? 0) * 1_000;
  }

  /** Whether robots allows this URL, with the grounds. The decision to obey is
   * the caller's; this reports the policy. */
  check(url: string): RobotsVerdict {
    if (this.ignoreRobots) return { allowed: true, reason: 'robots-ignored' };
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      return { allowed: false, reason: 'unparseable-url' };
    }
    return isUrlAllowed(this.robots.get(host), url, this.userAgent);
  }

  /** The stop condition, once one has tripped. */
  get stop(): StopReason | undefined {
    return this.stopReason;
  }

  permit(host: string): Permit {
    if (this.stopReason) return { kind: 'stop', reason: this.stopReason };
    const state = this.hostState(host);
    if (state.inFlight >= this.concurrency) return { kind: 'busy' };

    const now = this.clock.now();
    let wait: Extract<Permit, { kind: 'wait' }> | undefined;
    const consider = (
      ms: number,
      reason: 'rate-limit' | 'crawl-delay' | 'backoff',
    ) => {
      if (ms > 0 && ms > (wait?.ms ?? 0)) wait = { kind: 'wait', ms, reason };
    };

    if (state.lastRequestAtMs !== undefined) {
      const elapsed = now - state.lastRequestAtMs;
      consider(this.intervalMs - elapsed, 'rate-limit');
      consider(this.crawlDelayMs(host) - elapsed, 'crawl-delay');
    }
    if (state.retryAtMs !== undefined) {
      consider(state.retryAtMs - now, 'backoff');
    }
    return wait ?? { kind: 'go' };
  }

  /** Call immediately before the request goes out: it both takes the
   * concurrency slot and starts the rate-limit interval. */
  noteRequest(host: string): void {
    const state = this.hostState(host);
    state.inFlight += 1;
    state.lastRequestAtMs = this.clock.now();
  }

  noteOutcome(host: string, outcome: RequestOutcome): void {
    const state = this.hostState(host);
    state.inFlight = Math.max(0, state.inFlight - 1);

    if (outcome.ok) {
      // Any success says the host is healthy, so the backoff ladder and the
      // stop counter both reset. Nothing else clears them.
      state.consecutiveErrors = 0;
      // Deleted rather than set to undefined: exactOptionalPropertyTypes makes
      // "no backoff" the absence of the field, not a field holding undefined.
      delete state.retryAtMs;
      for (const other of this.hosts.values()) other.consecutiveErrors = 0;
      return;
    }
    if (!isHostFailure(outcome)) return;

    state.consecutiveErrors += 1;
    const ladder = Math.min(
      BACKOFF_BASE_MS * 2 ** (state.consecutiveErrors - 1),
      BACKOFF_MAX_MS,
    );
    // A server that said when to come back knows better than the ladder does.
    const backoffMs =
      outcome.retryAfterSeconds !== undefined
        ? outcome.retryAfterSeconds * 1_000
        : ladder;
    state.retryAtMs = this.clock.now() + backoffMs;

    const consecutive = [...this.hosts.values()].reduce(
      (total, other) => total + other.consecutiveErrors,
      0,
    );
    if (consecutive >= this.maxConsecutiveErrors) {
      this.stopReason = {
        kind: 'consecutive-errors',
        host,
        count: consecutive,
      };
    }
  }

  private hostState(host: string): HostState {
    const key = host.toLowerCase();
    const existing = this.hosts.get(key);
    if (existing) return existing;
    const created: HostState = { inFlight: 0, consecutiveErrors: 0 };
    this.hosts.set(key, created);
    return created;
  }
}
