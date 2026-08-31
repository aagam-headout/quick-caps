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
/** How many hosts must be failing at once for the whole-crawl stop to trip.
 * Three rather than two, so a crawl of one or two hosts is left to the per-host
 * ladder — the instrument built for it — and this condition only speaks when a
 * crawl is broad enough that "none of them is answering" says something the
 * per-host counters cannot. */
export const MAX_FAILING_HOSTS = 3;
/** Host-level failures the whole crawl may accumulate before it gives up,
 * counted once per failure and never reset. The per-host ladder cannot see a
 * crawl that is broadly broken: forty hosts each sitting one failure short of
 * their own limit, with one host still answering, trips neither the per-host
 * stop nor `all-hosts-failing`, and the README promises we stop hammering.
 * Fifty is far past any healthy crawl — the default page limit is 25 — so this
 * speaks only for a crawl whose failures are its defining feature. */
export const DEFAULT_MAX_TOTAL_ERRORS = 50;
export const BACKOFF_BASE_MS = 1_000;
/** A minute is long enough to ride out a deploy and short enough that a
 * resumed crawl is not indistinguishable from a hung one. */
export const BACKOFF_MAX_MS = 60_000;
/** Node's setTimeout ceiling. A wait past it does not wait longer — it
 * overflows, warns, and fires after 1ms — so a backoff above this would mean
 * *no* backoff, the exact opposite of what a large `Retry-After` asked for.
 * BACKOFF_MAX_MS is well inside it; this is the guard that keeps that true if
 * the ceiling is ever raised. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The backoff actually applied, whoever proposed it.
 *
 * Both ends matter, and both were reachable through a server-sent
 * `Retry-After` before this existed:
 *
 * - Floored at the base, because `Retry-After: 0` — or a stale HTTP-date
 *   behind a clock-skewed proxy, which reads as the same 0 — would otherwise
 *   buy a failing host five instant retries, which is the hammering the
 *   ladder exists to prevent. A server asking for *less* than the ladder is
 *   still honoured; asking for nothing is not.
 * - Capped at the ceiling, because `Retry-After: 86400` parks a worker for a
 *   day and `Retry-After: 2592000` overflows the timer. A crawl that has to
 *   wait longer than a minute is a crawl to resume later, which is what the
 *   store is for.
 */
export function clampBackoffMs(ms: number): number {
  if (!Number.isFinite(ms)) return Math.min(BACKOFF_MAX_MS, MAX_TIMER_MS);
  return Math.min(Math.max(ms, BACKOFF_BASE_MS), BACKOFF_MAX_MS, MAX_TIMER_MS);
}
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
  /** The crawl-wide budget, alongside the per-host one. */
  maxTotalErrors?: number;
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

/**
 * A `Retry-After` header as seconds, measured from `nowMs`. Both legal forms
 * are honoured: delay-seconds, and an HTTP-date.
 *
 * Pure, and given the clock rather than reading one, for the same reason the
 * rest of this unit is: the runner has the header, this decides what it means.
 *
 * A value that cannot be read returns undefined so the caller falls back to
 * its own ladder. Reading it as zero would turn one garbled header into a
 * crawler that retries a failing host with no backoff at all, which is the
 * behaviour the ladder exists to prevent.
 */
export function parseRetryAfterSeconds(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  // delay-seconds first: Date.parse would read a bare number as a year.
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Numeric-looking but not legal delay-seconds — negative, or fractional — is
  // not a date either, and Date.parse reads `-5` as the year 5 BC rather than
  // refusing it.
  if (/^[+-]?[\d.]+$/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  // A date already past means "now", not a negative wait — a wait below zero
  // would read as "the server asked for no backoff", which it did not.
  return Math.max(0, (at - nowMs) / 1_000);
}

export type StopReason =
  /** One host failed this many times in a row. Per host, like every other
   * decision in this unit: two unrelated hosts failing once each is two hosts
   * with one problem, not one host with two, and a stop that summed them would
   * end the crawl naming a host that never reached its own limit. */
  | {
      kind: 'consecutive-errors';
      /** The host whose failure tripped it. */
      host: string;
      count: number;
    }
  /** Every host the crawl has actually requested is failing at once. A
   * deliberately separate condition from the per-host one, and counted in
   * hosts rather than in errors so it can never be the per-host counter in
   * disguise: a crawl fanned out across several hosts where none of them is
   * answering is a crawl with a problem of its own, and should stop even
   * though no single host has spent its own budget. */
  | {
      kind: 'all-hosts-failing';
      /** How many hosts are failing — all of the ones tried, by definition. */
      hosts: number;
    }
  /** The crawl spent its whole-crawl failure budget. Its own reason, naming no
   * host, because it is a fact about the crawl and not about any one host: a
   * broad crawl can accumulate failures indefinitely without any single host
   * reaching its own limit and without every host being down at once. The
   * count is failures *observed*, incremented once each — deliberately not the
   * per-host counters summed, which would end a crawl blaming a host that
   * never spent its own budget. */
  | { kind: 'error-budget'; errors: number; budget: number };

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
  private readonly maxTotalErrors: number;
  private readonly clock: Clock;
  /** Host-level failures this crawl has seen, one per failure. A single
   * counter, not a sum over hosts: see the `error-budget` stop reason. */
  private totalErrors = 0;
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
    this.maxTotalErrors = options.maxTotalErrors ?? DEFAULT_MAX_TOTAL_ERRORS;
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
      // A success says *this* host is healthy, so its backoff ladder and its
      // stop counter both reset. Only its own: another host's failures are
      // that host's, and clearing them here is what made a stop attributable
      // to nobody.
      state.consecutiveErrors = 0;
      // Deleted rather than set to undefined: exactOptionalPropertyTypes makes
      // "no backoff" the absence of the field, not a field holding undefined.
      delete state.retryAtMs;
      return;
    }
    if (!isHostFailure(outcome)) return;

    state.consecutiveErrors += 1;
    this.totalErrors += 1;
    const ladder = BACKOFF_BASE_MS * 2 ** (state.consecutiveErrors - 1);
    // A server that said when to come back knows better than the ladder does —
    // within the same bounds the ladder itself obeys, which is what
    // clampBackoffMs is for. Neither proposal escapes them.
    const backoffMs = clampBackoffMs(
      outcome.retryAfterSeconds !== undefined
        ? outcome.retryAfterSeconds * 1_000
        : ladder,
    );
    state.retryAtMs = this.clock.now() + backoffMs;

    if (state.consecutiveErrors >= this.maxConsecutiveErrors) {
      this.raise({
        kind: 'consecutive-errors',
        host: host.toLowerCase(),
        count: state.consecutiveErrors,
      });
      return;
    }
    // The whole-crawl condition, checked only once no single host has tripped
    // its own: a crawl where nothing it has tried is answering should stop,
    // and saying so as itself keeps the per-host reason honest. Nothing is
    // summed across hosts here — breadth is the signal, which is what keeps
    // this from being the per-host counter under another name.
    //
    // Only hosts actually requested count. `permit` creates a host's state on
    // first sight, so a host merely asked about would otherwise sit at zero
    // errors and hold this condition off forever.
    const now = this.clock.now();
    const attempted = [...this.hosts.values()].filter(
      (other) => other.lastRequestAtMs !== undefined,
    );
    // "Failing" means failing *now*, not failing once at some point. A host's
    // consecutiveErrors is cleared only by a success on that host, so a host
    // that 500ed once in the first minute and holds one URL is never requested
    // again and sits at 1 forever; without a recency bound those stale
    // counters make this fire the moment the one host doing the work has a
    // single transient blip. Its live backoff window is the bound: it is
    // exactly the period during which the crawl believes the host needs
    // leaving alone, and a success clears it.
    const failing = attempted.filter(
      (other) =>
        other.consecutiveErrors > 0 &&
        other.retryAtMs !== undefined &&
        other.retryAtMs > now,
    );
    if (
      attempted.length >= MAX_FAILING_HOSTS &&
      failing.length === attempted.length
    ) {
      this.raise({ kind: 'all-hosts-failing', hosts: attempted.length });
      return;
    }
    // Last, because it is the least specific of the three: it says the crawl
    // as a whole is failing without being able to name who. Reached only when
    // neither of the attributable conditions applies.
    if (this.totalErrors >= this.maxTotalErrors) {
      this.raise({
        kind: 'error-budget',
        errors: this.totalErrors,
        budget: this.maxTotalErrors,
      });
    }
  }

  /** First reason wins. A crawl ends once, and an in-flight request landing
   * after the stop must not rewrite why. */
  private raise(reason: StopReason): void {
    this.stopReason ??= reason;
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
