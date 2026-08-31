import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  DEFAULT_REQUESTS_PER_SECOND,
  DEFAULT_USER_AGENT,
  Politeness,
  isUrlAllowed,
  matchRobotsGroup,
  parseRobotsTxt,
} from '../../src/crawl/politeness.js';

/**
 * Every decision here is asserted against an injected clock. A politeness unit
 * tested by sleeping would be a politeness unit nobody runs, which is the
 * reason the rate limiter takes a clock instead of reading Date.now itself.
 */
function fakeClock(startMs = 1_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('parseRobotsTxt', () => {
  it('groups rules under their user-agent, comments and blank lines removed', () => {
    const robots = parseRobotsTxt(
      [
        '# a comment',
        'User-agent: *',
        'Disallow: /private   # trailing comment',
        '',
        'User-agent: quick-caps',
        'User-agent: OtherBot',
        'Allow: /private/ok',
        'Disallow: /private',
        'Crawl-delay: 2',
      ].join('\n'),
    );
    expect(robots.groups).toEqual([
      { agents: ['*'], rules: [{ allow: false, path: '/private' }] },
      {
        agents: ['quick-caps', 'otherbot'],
        rules: [
          { allow: true, path: '/private/ok' },
          { allow: false, path: '/private' },
        ],
        crawlDelaySeconds: 2,
      },
    ]);
  });

  it('collects Sitemap lines, which are file-scoped rather than group-scoped', () => {
    const robots = parseRobotsTxt(
      [
        'Sitemap: https://example.com/sitemap.xml',
        'User-agent: *',
        'Disallow:',
        'Sitemap: https://example.com/news.xml',
      ].join('\r\n'),
    );
    expect(robots.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/news.xml',
    ]);
  });

  it('reads a fractional crawl-delay and ignores an unparseable one', () => {
    expect(
      parseRobotsTxt('User-agent: *\nCrawl-delay: 0.5').groups[0]
        ?.crawlDelaySeconds,
    ).toBe(0.5);
    expect(
      parseRobotsTxt('User-agent: *\nCrawl-delay: soon').groups[0]
        ?.crawlDelaySeconds,
    ).toBeUndefined();
    expect(
      parseRobotsTxt('User-agent: *\nCrawl-delay: -3').groups[0]
        ?.crawlDelaySeconds,
    ).toBeUndefined();
  });

  it('degrades to allow-everything on an empty, whitespace, or garbage file', () => {
    for (const text of [
      '',
      '   \n\n',
      '<html><body>404</body></html>',
      'Disallow: /',
    ]) {
      const robots = parseRobotsTxt(text);
      expect(
        isUrlAllowed(robots, 'https://example.com/anything', 'quick-caps')
          .allowed,
      ).toBe(true);
    }
  });

  it('ignores unknown directives and a rule line with no group', () => {
    const robots = parseRobotsTxt(
      'Host: example.com\nDisallow: /orphan\nUser-agent: *\nDisallow: /x',
    );
    expect(robots.groups).toEqual([
      { agents: ['*'], rules: [{ allow: false, path: '/x' }] },
    ]);
    expect(
      isUrlAllowed(robots, 'https://example.com/orphan', '*').allowed,
    ).toBe(true);
  });

  it('tolerates a BOM, odd casing, and missing colons', () => {
    const robots = parseRobotsTxt(
      '\uFEFFuSeR-AgEnT: *\nDISALLOW: /a\nnot a directive at all',
    );
    expect(robots.groups).toEqual([
      { agents: ['*'], rules: [{ allow: false, path: '/a' }] },
    ]);
  });
});

describe('matchRobotsGroup', () => {
  const robots = parseRobotsTxt(
    [
      'User-agent: *',
      'Disallow: /',
      'User-agent: quick-caps',
      'Disallow: /admin',
    ].join('\n'),
  );

  it('prefers the most specific matching agent token over the wildcard', () => {
    expect(
      matchRobotsGroup(robots, 'quick-caps/0.1 (+https://example)')?.agents,
    ).toEqual(['quick-caps']);
  });

  it('falls back to the wildcard group for an unrelated agent', () => {
    expect(matchRobotsGroup(robots, 'SomeoneElse/2')?.agents).toEqual(['*']);
  });

  it('matches the agent token case-insensitively', () => {
    expect(matchRobotsGroup(robots, 'QUICK-CAPS')?.agents).toEqual([
      'quick-caps',
    ]);
  });

  it('returns nothing when no group applies', () => {
    const specific = parseRobotsTxt('User-agent: GoogleBot\nDisallow: /');
    expect(matchRobotsGroup(specific, 'quick-caps')).toBeUndefined();
  });
});

describe('isUrlAllowed', () => {
  it('lets the longest matching rule win, whichever kind it is', () => {
    const robots = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /a', 'Allow: /a/b', 'Disallow: /a/b/c'].join(
        '\n',
      ),
    );
    expect(isUrlAllowed(robots, 'https://example.com/a/x', '*').allowed).toBe(
      false,
    );
    expect(isUrlAllowed(robots, 'https://example.com/a/b/x', '*').allowed).toBe(
      true,
    );
    expect(
      isUrlAllowed(robots, 'https://example.com/a/b/c/x', '*').allowed,
    ).toBe(false);
    expect(isUrlAllowed(robots, 'https://example.com/z', '*').allowed).toBe(
      true,
    );
  });

  it('resolves an equal-length tie in favour of Allow', () => {
    const robots = parseRobotsTxt(
      'User-agent: *\nDisallow: /page\nAllow: /page',
    );
    const verdict = isUrlAllowed(robots, 'https://example.com/page', '*');
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBe('allow-rule');
  });

  it('treats an empty Disallow as permission, not as a bare-slash block', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow:');
    expect(isUrlAllowed(robots, 'https://example.com/anything', '*')).toEqual({
      allowed: true,
      reason: 'no-rule-matched',
    });
  });

  it('honours * and $ in a rule path', () => {
    const robots = parseRobotsTxt(
      ['User-agent: *', 'Disallow: /*.pdf$', 'Disallow: /p/*/private'].join(
        '\n',
      ),
    );
    expect(
      isUrlAllowed(robots, 'https://example.com/docs/a.pdf', '*').allowed,
    ).toBe(false);
    expect(
      isUrlAllowed(robots, 'https://example.com/docs/a.pdf.html', '*').allowed,
    ).toBe(true);
    expect(
      isUrlAllowed(robots, 'https://example.com/p/9/private/x', '*').allowed,
    ).toBe(false);
  });

  it('matches against the path and query together', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /search?q=');
    expect(
      isUrlAllowed(robots, 'https://example.com/search?q=shoes', '*').allowed,
    ).toBe(false);
    expect(
      isUrlAllowed(robots, 'https://example.com/search', '*').allowed,
    ).toBe(true);
  });

  it('names the rule it decided by, so a skip can be recorded explicably', () => {
    const robots = parseRobotsTxt('User-agent: *\nDisallow: /admin');
    expect(
      isUrlAllowed(robots, 'https://example.com/admin/users', 'quick-caps'),
    ).toEqual({
      allowed: false,
      reason: 'disallow-rule',
      rule: { allow: false, path: '/admin' },
    });
  });

  it('allows everything when there is no robots.txt at all', () => {
    expect(
      isUrlAllowed(undefined, 'https://example.com/x', 'quick-caps'),
    ).toEqual({
      allowed: true,
      reason: 'no-robots',
    });
  });

  it('allows everything when no group matches the agent', () => {
    const robots = parseRobotsTxt('User-agent: GoogleBot\nDisallow: /');
    expect(isUrlAllowed(robots, 'https://example.com/x', 'quick-caps')).toEqual(
      {
        allowed: true,
        reason: 'no-group-matched',
      },
    );
  });

  it('reports an unparseable URL rather than guessing', () => {
    const verdict = isUrlAllowed(
      parseRobotsTxt('User-agent: *\nDisallow: /'),
      'not a url',
      '*',
    );
    expect(verdict).toEqual({ allowed: false, reason: 'unparseable-url' });
  });
});

describe('Politeness defaults', () => {
  it('are one request per second, concurrency one, and an identifiable agent', () => {
    expect(DEFAULT_REQUESTS_PER_SECOND).toBe(1);
    expect(DEFAULT_CONCURRENCY).toBe(1);
    expect(DEFAULT_MAX_CONSECUTIVE_ERRORS).toBeGreaterThan(0);
    expect(DEFAULT_USER_AGENT).toContain('quick-caps');
    expect(DEFAULT_USER_AGENT).toMatch(/https?:\/\//);
  });
});

describe('Politeness rate limiting', () => {
  it('lets the first request through and holds the second for the interval', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock });
    expect(politeness.permit('example.com')).toEqual({ kind: 'go' });
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 1_000,
      reason: 'rate-limit',
    });
    clock.advance(400);
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 600,
      reason: 'rate-limit',
    });
    clock.advance(600);
    expect(politeness.permit('example.com')).toEqual({ kind: 'go' });
  });

  it('rate-limits per host, so a slow host never gates another', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock });
    politeness.noteRequest('a.example');
    politeness.noteOutcome('a.example', { ok: true, status: 200 });
    expect(politeness.permit('a.example').kind).toBe('wait');
    expect(politeness.permit('b.example')).toEqual({ kind: 'go' });
  });

  it('scales the interval with --rate', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 4 });
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 250,
      reason: 'rate-limit',
    });
  });

  it('lets a crawl-delay override a faster requested rate', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 10 });
    politeness.setRobots(
      'example.com',
      parseRobotsTxt('User-agent: *\nCrawl-delay: 3'),
    );
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 3_000,
      reason: 'crawl-delay',
    });
    expect(politeness.crawlDelayMs('example.com')).toBe(3_000);
  });

  it('never lets a crawl-delay make the crawler faster than the requested rate', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 1 });
    politeness.setRobots(
      'example.com',
      parseRobotsTxt('User-agent: *\nCrawl-delay: 0.2'),
    );
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 1_000,
      reason: 'rate-limit',
    });
  });

  it('reports a host as busy while its concurrency slots are all in flight', () => {
    const clock = fakeClock();
    const politeness = new Politeness({
      clock,
      concurrency: 2,
      requestsPerSecond: 1_000,
    });
    politeness.noteRequest('example.com');
    clock.advance(1); // past the 1ms interval a 1000/s rate leaves
    expect(politeness.permit('example.com').kind).toBe('go');
    politeness.noteRequest('example.com');
    expect(politeness.permit('example.com')).toEqual({ kind: 'busy' });
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    clock.advance(1);
    expect(politeness.permit('example.com').kind).toBe('go');
  });
});

describe('Politeness backoff and stop conditions', () => {
  it('backs off exponentially on 429 and clears on success', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 1_000 });
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: false, status: 429 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: BACKOFF_BASE_MS,
      reason: 'backoff',
    });

    clock.advance(BACKOFF_BASE_MS);
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: false, status: 503 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: BACKOFF_BASE_MS * 2,
      reason: 'backoff',
    });

    clock.advance(BACKOFF_BASE_MS * 2);
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    clock.advance(1); // past the 1ms interval a 1000/s rate leaves
    expect(politeness.permit('example.com')).toEqual({ kind: 'go' });
  });

  it('caps the backoff rather than growing without bound', () => {
    const clock = fakeClock();
    const politeness = new Politeness({
      clock,
      requestsPerSecond: 1_000,
      maxConsecutiveErrors: 100,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      politeness.noteRequest('example.com');
      politeness.noteOutcome('example.com', { ok: false, status: 500 });
      clock.advance(BACKOFF_MAX_MS);
    }
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: false, status: 500 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: BACKOFF_MAX_MS,
      reason: 'backoff',
    });
  });

  it('prefers a Retry-After the server actually sent over its own guess', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 1_000 });
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', {
      ok: false,
      status: 429,
      retryAfterSeconds: 7,
    });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 7_000,
      reason: 'backoff',
    });
  });

  it('does not back off on a 404 — a missing page is that page, not a failing host', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 1_000 });
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: false, status: 404 });
    clock.advance(1); // past the 1ms interval a 1000/s rate leaves
    expect(politeness.permit('example.com')).toEqual({ kind: 'go' });
  });

  it('backs off on a transport failure that carries no status', () => {
    const clock = fakeClock();
    const politeness = new Politeness({ clock, requestsPerSecond: 1_000 });
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: false });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: BACKOFF_BASE_MS,
      reason: 'backoff',
    });
  });

  it('stops the crawl after N consecutive host errors', () => {
    const clock = fakeClock();
    const politeness = new Politeness({
      clock,
      requestsPerSecond: 1_000,
      maxConsecutiveErrors: 3,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      politeness.noteRequest('example.com');
      politeness.noteOutcome('example.com', { ok: false, status: 500 });
      clock.advance(BACKOFF_MAX_MS);
    }
    expect(politeness.stop).toEqual({
      kind: 'consecutive-errors',
      host: 'example.com',
      count: 3,
    });
    expect(politeness.permit('other.example')).toEqual({
      kind: 'stop',
      reason: { kind: 'consecutive-errors', host: 'example.com', count: 3 },
    });
  });

  it('counts consecutive errors across hosts but forgives on any success', () => {
    const clock = fakeClock();
    const politeness = new Politeness({
      clock,
      requestsPerSecond: 1_000,
      maxConsecutiveErrors: 2,
    });
    politeness.noteRequest('a.example');
    politeness.noteOutcome('a.example', { ok: false, status: 500 });
    politeness.noteRequest('b.example');
    politeness.noteOutcome('b.example', { ok: true, status: 200 });
    politeness.noteRequest('a.example');
    politeness.noteOutcome('a.example', { ok: false, status: 500 });
    expect(politeness.stop).toBeUndefined();
    politeness.noteRequest('a.example');
    politeness.noteOutcome('a.example', { ok: false, status: 500 });
    expect(politeness.stop?.kind).toBe('consecutive-errors');
  });
});

describe('Politeness robots decisions', () => {
  it('reports a disallowed URL with its reason rather than swallowing it', () => {
    const politeness = new Politeness({
      clock: fakeClock(),
      userAgent: 'quick-caps/0.1',
    });
    politeness.setRobots(
      'example.com',
      parseRobotsTxt('User-agent: *\nDisallow: /admin'),
    );
    expect(politeness.check('https://example.com/admin/x')).toEqual({
      allowed: false,
      reason: 'disallow-rule',
      rule: { allow: false, path: '/admin' },
    });
    expect(politeness.check('https://example.com/public')).toEqual({
      allowed: true,
      reason: 'no-rule-matched',
    });
  });

  it('allows a host whose robots.txt could not be fetched', () => {
    const politeness = new Politeness({ clock: fakeClock() });
    politeness.setRobots('example.com', undefined);
    expect(politeness.hasRobots('example.com')).toBe(true);
    expect(politeness.check('https://example.com/x')).toEqual({
      allowed: true,
      reason: 'no-robots',
    });
  });

  it('says it has not seen a host yet, so the runner knows to fetch robots.txt', () => {
    const politeness = new Politeness({ clock: fakeClock() });
    expect(politeness.hasRobots('example.com')).toBe(false);
  });

  it('short-circuits to robots-ignored when the caller typed --ignore-robots', () => {
    const politeness = new Politeness({
      clock: fakeClock(),
      ignoreRobots: true,
    });
    politeness.setRobots(
      'example.com',
      parseRobotsTxt('User-agent: *\nDisallow: /'),
    );
    expect(politeness.check('https://example.com/admin')).toEqual({
      allowed: true,
      reason: 'robots-ignored',
    });
  });

  it('keeps honouring crawl-delay under --ignore-robots — the flag waives rules, not courtesy', () => {
    const clock = fakeClock();
    const politeness = new Politeness({
      clock,
      ignoreRobots: true,
      requestsPerSecond: 10,
    });
    politeness.setRobots(
      'example.com',
      parseRobotsTxt('User-agent: *\nCrawl-delay: 5'),
    );
    expect(politeness.crawlDelayMs('example.com')).toBe(5_000);
    politeness.noteRequest('example.com');
    politeness.noteOutcome('example.com', { ok: true, status: 200 });
    expect(politeness.permit('example.com')).toEqual({
      kind: 'wait',
      ms: 5_000,
      reason: 'crawl-delay',
    });
  });

  it('exposes declared sitemaps, which are a better frontier seed than a crawl', () => {
    const politeness = new Politeness({ clock: fakeClock() });
    politeness.setRobots(
      'example.com',
      parseRobotsTxt(
        'Sitemap: https://example.com/sitemap.xml\nUser-agent: *\nDisallow:',
      ),
    );
    expect(politeness.sitemaps('example.com')).toEqual([
      'https://example.com/sitemap.xml',
    ]);
    expect(politeness.sitemaps('unknown.example')).toEqual([]);
  });
});
