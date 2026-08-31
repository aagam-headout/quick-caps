import { describe, expect, it } from 'vitest';
import type {
  Extracted,
  LinkEntry,
  LinkReport,
  LinkZone,
  PaginationTarget,
} from 'quick-caps-core/extract';
import {
  DEFAULT_TRACKING_PARAMS,
  Frontier,
  normalizeUrl,
  type FrontierState,
} from '../../src/crawl/frontier.js';

/**
 * The frontier is the unit a crawl's termination depends on, so every rule it
 * encodes is asserted here rather than inferred from a runner integration
 * test: by the time a runner is looping, a normalization bug looks like a slow
 * network.
 */

const SEED = 'https://example.com/';

function link(href: string, over: Partial<LinkEntry> = {}): LinkEntry {
  const host = (() => {
    try {
      return new URL(href, SEED).host;
    } catch {
      return '';
    }
  })();
  return {
    href,
    text: href,
    internal: host === 'example.com',
    zone: 'content',
    rel: [],
    host,
    ...over,
  };
}

function links(entries: LinkEntry[]): Pick<LinkReport, 'links'> {
  return { links: entries };
}

function pageLink(href: string, zone: LinkZone): LinkEntry {
  return link(href, { zone });
}

function paginated(
  kind: PaginationTarget['kind'],
  href?: string,
): Extracted<PaginationTarget> {
  // Built conditionally rather than with an undefined href: under
  // exactOptionalPropertyTypes an absent href and one holding undefined are
  // different types, and a load-more control genuinely has no href.
  const value: PaginationTarget =
    href === undefined ? { kind } : { kind, href };
  return { value, source: 'semantic-markup', confidence: 'medium' };
}

describe('normalizeUrl', () => {
  it('resolves a relative href against the page URL', () => {
    expect(normalizeUrl('../b/c', 'https://example.com/a/x/')).toBe(
      'https://example.com/a/b/c',
    );
    expect(normalizeUrl('/root', 'https://example.com/a/x/')).toBe(
      'https://example.com/root',
    );
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section-2', SEED)).toBe(
      'https://example.com/a',
    );
    expect(normalizeUrl('#top', 'https://example.com/a')).toBe(
      'https://example.com/a',
    );
  });

  it('lowercases the host but never the path', () => {
    expect(normalizeUrl('https://EXAMPLE.COM/Some/Path', SEED)).toBe(
      'https://example.com/Some/Path',
    );
  });

  it('strips a trailing index.html but leaves lookalikes alone', () => {
    expect(normalizeUrl('https://example.com/docs/index.html', SEED)).toBe(
      'https://example.com/docs/',
    );
    expect(normalizeUrl('https://example.com/index.html', SEED)).toBe(
      'https://example.com/',
    );
    expect(normalizeUrl('https://example.com/notindex.html', SEED)).toBe(
      'https://example.com/notindex.html',
    );
    expect(normalizeUrl('https://example.com/index.htmlx', SEED)).toBe(
      'https://example.com/index.htmlx',
    );
  });

  it('sorts query parameters and keeps repeated values in order', () => {
    expect(normalizeUrl('https://example.com/a?b=2&a=1', SEED)).toBe(
      'https://example.com/a?a=1&b=2',
    );
    expect(normalizeUrl('https://example.com/a?t=2&t=1', SEED)).toBe(
      'https://example.com/a?t=2&t=1',
    );
  });

  it('drops the default tracking parameters, prefixes included', () => {
    expect(DEFAULT_TRACKING_PARAMS).toContain('gclid');
    expect(
      normalizeUrl(
        'https://example.com/a?utm_source=x&utm_medium=y&gclid=1&fbclid=2&page=3',
        SEED,
      ),
    ).toBe('https://example.com/a?page=3');
  });

  it('drops the question mark entirely when only tracking params were there', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x', SEED)).toBe(
      'https://example.com/a',
    );
  });

  it('accepts extra tracking parameters without losing the defaults', () => {
    const options = { trackingParams: ['sessionid'] };
    expect(
      normalizeUrl(
        'https://example.com/a?sessionid=9&gclid=1&keep=2',
        SEED,
        options,
      ),
    ).toBe('https://example.com/a?keep=2');
  });

  it('rejects non-document schemes and unparseable hrefs', () => {
    for (const href of [
      'mailto:hi@example.com',
      'tel:+15551234',
      'javascript:void(0)',
      'data:text/html,<p>x',
      'ftp://example.com/f',
      '',
      '   ',
    ]) {
      expect(normalizeUrl(href, SEED)).toBeNull();
    }
  });

  it('is idempotent — normalizing a normalized URL changes nothing', () => {
    const once = normalizeUrl(
      'https://EXAMPLE.com/A/index.html?utm_source=n&b=2&a=1#x',
      SEED,
    );
    expect(once).toBe('https://example.com/A/?a=1&b=2');
    expect(normalizeUrl(once!, SEED)).toBe(once);
  });
});

describe('Frontier', () => {
  it('seeds itself with the normalized seed at depth 0', () => {
    const frontier = new Frontier('https://EXAMPLE.com/start/index.html#x');
    expect(frontier.seedUrl).toBe('https://example.com/start/');
    expect(frontier.pending).toBe(1);
    expect(frontier.take()).toEqual({
      url: 'https://example.com/start/',
      depth: 0,
      reason: 'seed',
    });
    expect(frontier.take()).toBeUndefined();
  });

  it('rejects a seed that is not a crawlable document URL', () => {
    expect(() => new Frontier('mailto:hi@example.com')).toThrow(/seed/i);
  });

  it('ranks pagination ahead of content, and content ahead of chrome', () => {
    const frontier = new Frontier(SEED);
    frontier.take();
    frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([
        pageLink('/footer-page', 'footer'),
        pageLink('/nav-page', 'nav'),
        pageLink('/aside-page', 'aside'),
        pageLink('/content-page', 'content'),
      ]),
      pagination: [
        paginated('numbered', '/page/2'),
        paginated('next', '/page/1'),
      ],
    });
    expect(frontier.drain().map((entry) => entry.url)).toEqual([
      'https://example.com/page/1',
      'https://example.com/page/2',
      'https://example.com/content-page',
      'https://example.com/aside-page',
      'https://example.com/nav-page',
      'https://example.com/footer-page',
    ]);
  });

  it('keeps discovery order within one rank', () => {
    const frontier = new Frontier(SEED);
    frontier.take();
    frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([pageLink('/c', 'content'), pageLink('/a', 'content')]),
    });
    expect(frontier.drain().map((entry) => entry.url)).toEqual([
      'https://example.com/c',
      'https://example.com/a',
    ]);
  });

  it('follows only next and numbered pagination, not prev or load-more', () => {
    const frontier = new Frontier(SEED);
    frontier.take();
    const expansion = frontier.expand({
      pageUrl: SEED,
      depth: 0,
      pagination: [
        paginated('next', '/n'),
        paginated('numbered', '/2'),
        paginated('prev', '/p'),
        paginated('load-more'),
      ],
    });
    expect(expansion.added.map((entry) => entry.reason)).toEqual([
      'pagination-next',
      'pagination-numbered',
    ]);
  });

  it('records a reason for every URL it refuses, rather than dropping it', () => {
    const frontier = new Frontier(SEED, { maxDepth: 1 });
    frontier.take();
    const expansion = frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([
        link('https://other.example/page'),
        link('mailto:hi@example.com'),
        link('/dup'),
        link('/dup?utm_source=twice'),
        link('/'),
      ]),
    });
    expect(expansion.added.map((entry) => entry.url)).toEqual([
      'https://example.com/dup',
    ]);
    expect(expansion.skipped).toEqual([
      {
        href: 'https://other.example/page',
        url: 'https://other.example/page',
        reason: 'external-host',
      },
      { href: 'mailto:hi@example.com', reason: 'non-document-scheme' },
      {
        href: '/dup?utm_source=twice',
        url: 'https://example.com/dup',
        reason: 'already-seen',
      },
      { href: '/', url: 'https://example.com/', reason: 'already-seen' },
    ]);
  });

  it('respects the depth cap and reports what it cut', () => {
    const frontier = new Frontier(SEED, { maxDepth: 1 });
    frontier.take();
    frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([pageLink('/a', 'content')]),
    });
    const deep = frontier.take();
    expect(deep).toEqual({
      url: 'https://example.com/a',
      depth: 1,
      reason: 'content-link',
    });
    const expansion = frontier.expand({
      pageUrl: deep!.url,
      depth: deep!.depth,
      links: links([pageLink('/b', 'content')]),
    });
    expect(expansion.added).toEqual([]);
    expect(expansion.skipped).toEqual([
      { href: '/b', url: 'https://example.com/b', reason: 'depth-cap' },
    ]);
    expect(frontier.pending).toBe(0);
  });

  it('treats additional hosts as internal when told to', () => {
    const frontier = new Frontier(SEED, { hosts: ['www.example.com'] });
    frontier.take();
    const expansion = frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([link('https://WWW.example.com/a')]),
    });
    expect(expansion.added.map((entry) => entry.url)).toEqual([
      'https://www.example.com/a',
    ]);
  });

  it('does not trust a page-relative internal flag over its own host check', () => {
    // Piece 1 classifies `internal` against the page's own origin, which on a
    // page reached from an allowed second host would mark an off-crawl link
    // internal. The frontier's host set is the authority.
    const frontier = new Frontier(SEED);
    frontier.take();
    const expansion = frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([link('https://other.example/a', { internal: true })]),
    });
    expect(expansion.added).toEqual([]);
    expect(expansion.skipped[0]?.reason).toBe('external-host');
  });

  it('converges on a cyclic site whose links carry tracking parameters', () => {
    // The classic infinite crawl: three pages, each linking to all three (and
    // to itself) with a per-visit tracking parameter and a fragment. Without
    // normalization the frontier never empties.
    const pages = [
      'https://example.com/a',
      'https://example.com/b',
      'https://example.com/c',
    ];
    const frontier = new Frontier('https://example.com/a', { maxDepth: 10 });
    const visited: string[] = [];
    let visits = 0;
    for (let entry = frontier.take(); entry; entry = frontier.take()) {
      visits += 1;
      expect(visits).toBeLessThan(50); // fails loud instead of hanging the suite
      visited.push(entry.url);
      frontier.expand({
        pageUrl: entry.url,
        depth: entry.depth,
        links: links(
          pages.map((page, index) =>
            pageLink(
              `${page}?utm_campaign=run-${visits}-${index}#top`,
              'content',
            ),
          ),
        ),
        pagination: [paginated('next', `${entry.url}?gclid=${visits}`)],
      });
    }
    expect(visited.sort()).toEqual(pages);
    expect(frontier.pending).toBe(0);
  });

  it('round-trips its state so a crawl can be resumed', () => {
    const frontier = new Frontier(SEED, { maxDepth: 4 });
    frontier.take();
    frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([pageLink('/a', 'content'), pageLink('/b', 'nav')]),
    });
    const state: FrontierState = frontier.toState();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);

    const resumed = Frontier.fromState(state, { maxDepth: 4 });
    expect(resumed.seedUrl).toBe(frontier.seedUrl);
    expect(resumed.seen).toBe(frontier.seen);
    expect(resumed.drain()).toEqual(frontier.drain());
  });

  it('will not re-enqueue a URL taken from a resumed queue', () => {
    const frontier = new Frontier(SEED);
    frontier.take();
    frontier.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([pageLink('/a', 'content')]),
    });
    const resumed = Frontier.fromState(frontier.toState());
    const expansion = resumed.expand({
      pageUrl: SEED,
      depth: 0,
      links: links([pageLink('/a', 'content')]),
    });
    expect(expansion.added).toEqual([]);
    expect(expansion.skipped[0]?.reason).toBe('already-seen');
  });
});
