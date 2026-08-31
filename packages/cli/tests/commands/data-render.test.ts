import { describe, expect, it } from 'vitest';
import type {
  ContentReport,
  DesignReport,
  EntityReport,
  LinkReport,
  NetworkReport,
  StackReport,
  StructuredReport,
  VitalsReport,
} from 'quick-caps-core/extract';
import { renderDataReport } from '../../src/commands/data-render.js';

function emptyStructured(): StructuredReport {
  return {
    jsonLd: [],
    microdata: [],
    rdfa: [],
    social: {},
    seo: { alternates: [], robots: [], feeds: [] },
  };
}

function emptyEntities(): EntityReport {
  return {
    prices: [],
    dates: {},
    authors: [],
    ratings: [],
    contacts: { emails: [], phones: [], addresses: [], socials: [] },
    pagination: [],
  };
}

function emptyContent(): ContentReport {
  return {
    wordCount: 0,
    readingTimeMinutes: 0,
    outline: [],
    outlineViolations: [],
    media: { items: [], altCoverage: 0, formats: {}, lazyShare: 0 },
    split: {
      mainRegionIds: [],
      boilerplateRegionIds: [],
      mainWordCount: 0,
      confidence: 0,
    },
  };
}

function emptyDesign(): DesignReport {
  return {
    components: [],
    fonts: [],
    breakpoints: [],
    grid: { templateColumns: {}, gaps: {}, containerWidths: [] },
  };
}

function emptyLinks(): LinkReport {
  return { links: [], internalCount: 0, externalCount: 0, byHost: {} };
}

describe('renderDataReport', () => {
  it('renders only the requested domains, in canonical order', () => {
    const output = renderDataReport(
      {
        structured: emptyStructured(),
        links: emptyLinks(),
        content: emptyContent(),
        warnings: [],
      },
      ['links', 'structured'],
    );

    expect(output.split('\n').filter((line) => /^\S/.test(line))).toEqual([
      'structured',
      'links',
    ]);
    expect(output).not.toContain('content');
  });

  it('carries provenance and a confidence tier for every entity value', () => {
    const entities = emptyEntities();
    entities.prices = [
      {
        value: { amount: 49.99, currency: 'USD', kind: 'current' },
        source: 'json-ld',
        confidence: 'high',
      },
      {
        value: { amount: 79, currency: 'USD', kind: 'original' },
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ];
    entities.ratings = [
      {
        value: { value: 4.6, best: 5, reviewCount: 128 },
        source: 'json-ld',
        confidence: 'high',
      },
    ];

    const output = renderDataReport({ entities, warnings: [] }, ['entities']);

    expect(output).toMatch(/price\s+49\.99 USD \(current\)\s+json-ld\s+high/);
    // Continuation row: same category, no repeated label.
    expect(output).toMatch(
      /\n\s+79 USD \(original\)\s+semantic-markup\s+medium/,
    );
    expect(output).toMatch(/rating\s+4\.6\/5 \(128 reviews\)\s+json-ld\s+high/);
  });

  it('shows the matched text for a low-confidence value, and not above it', () => {
    const entities = emptyEntities();
    entities.dates = {
      published: {
        value: '2026-03-11',
        source: 'text-heuristic',
        confidence: 'low',
        matched: 'Published on March 11, 2026',
      },
      modified: {
        value: '2026-04-01',
        source: 'meta',
        confidence: 'high',
        matched: 'never rendered: not a guess',
      },
    };

    const output = renderDataReport({ entities, warnings: [] }, ['entities']);

    expect(output).toContain('"Published on March 11, 2026"');
    expect(output).not.toContain('never rendered');
  });

  it('reads an empty domain as empty, and a failed one as unavailable', () => {
    const output = renderDataReport(
      { entities: emptyEntities(), warnings: [] },
      ['entities', 'design'],
    );

    expect(output).toContain('entities\n  (empty)');
    expect(output).toContain('design\n  (unavailable)');
  });

  it('truncates a long value rather than wrapping it', () => {
    const structured = emptyStructured();
    structured.seo.canonical = `https://example.com/${'p'.repeat(200)}`;

    const output = renderDataReport({ structured, warnings: [] }, [
      'structured',
    ]);

    const line = output
      .split('\n')
      .find((candidate) => candidate.includes('canonical'));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(80);
    expect(line).toContain('…');
  });

  it('says how many rows it elided, and where to get them', () => {
    const structured = emptyStructured();
    structured.jsonLd = Array.from({ length: 9 }, (_, index) => ({
      '@type': 'Product',
      name: `Widget ${index}`,
    }));

    const output = renderDataReport({ structured, warnings: [] }, [
      'structured',
    ]);

    expect(output).toContain('json-ld');
    expect(output).toContain('Product "Widget 0"');
    expect(output).toContain('… 3 more (--json)');
  });

  it('renders content, design, and links in the terse register', () => {
    const content = emptyContent();
    content.wordCount = 32;
    content.readingTimeMinutes = 0.2;
    content.language = 'en';
    content.outline = [
      { level: 1, text: 'Title', domPath: [0] },
      { level: 3, text: 'Deep', domPath: [1] },
    ];
    content.outlineViolations = [
      { kind: 'skipped-level', headingIndex: 1, detail: 'h1 to h3' },
    ];
    content.media = {
      items: [
        { src: '/a.png', alt: 'a', lazy: false },
        { src: '/b.png', lazy: true },
      ],
      altCoverage: 0.5,
      formats: { png: 2 },
      lazyShare: 0.5,
    };

    const design = emptyDesign();
    design.components = [
      {
        kind: 'button',
        count: 2,
        variants: [
          { signature: 'btn-primary', count: 1, examples: [[0]] },
          { signature: 'btn-secondary', count: 1, examples: [[1]] },
        ],
      },
    ];
    design.breakpoints = [
      { query: '(min-width: 768px)', minWidth: 768, ruleCount: 3 },
    ];

    const links = emptyLinks();
    links.links = [
      {
        href: 'https://example.com/',
        text: 'Home',
        internal: true,
        zone: 'nav',
        rel: [],
        host: 'example.com',
      },
      {
        href: 'https://other.example/',
        text: 'Out',
        internal: false,
        zone: 'footer',
        rel: [],
        host: 'other.example',
      },
    ];
    links.internalCount = 1;
    links.externalCount = 1;
    links.byHost = { 'other.example': 1 };

    const output = renderDataReport({ content, design, links, warnings: [] }, [
      'content',
      'design',
      'links',
    ]);

    expect(output).toContain('  32 words, ~0.2 min, en');
    expect(output).toMatch(/outline\s+h1 > h3 — 1 violation: skipped-level/);
    expect(output).toMatch(/media\s+2 items, 1 without alt/);
    expect(output).toMatch(/button\s+2\s+\(btn-primary, btn-secondary\)/);
    expect(output).toMatch(/breakpoint\s+\(min-width: 768px\) \(3 rules\)/);
    expect(output).toMatch(/total\s+2 — nav 1, footer 1/);
    expect(output).toMatch(/external\s+1 — other\.example 1/);
  });

  it('prints warnings after the domains, as the summary path does', () => {
    const output = renderDataReport(
      {
        links: emptyLinks(),
        warnings: [{ phase: 'extract', reason: 'design: extractor failed' }],
      },
      ['links'],
    );

    expect(output.trimEnd().endsWith('warning: design: extractor failed')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// The observation domains
// ---------------------------------------------------------------------------

function emptyNetwork(recorded: boolean): NetworkReport {
  return {
    recorded,
    requests: [],
    byHost: [],
    skippedByReason: {
      'binary-type': 0,
      'over-cap': 0,
      evicted: 0,
      unreadable: 0,
    },
    totals: {
      requestCount: 0,
      bodiesKept: 0,
      bodyBytes: 0,
      bodyCapBytes: 2 * 1024 * 1024,
      transferSizeBytes: 0,
    },
    containsUnredactedCredentials: false,
  };
}

function emptyStack(recorded: boolean): StackReport {
  return {
    recorded,
    technologies: [],
    thirdPartyHosts: [],
    cookies: { cookies: [], includesHttpOnly: false },
    consentBanner: { present: false },
  };
}

function emptyVitals(recorded: boolean): VitalsReport {
  return {
    recorded,
    largestContentfulPaintMs: null,
    cumulativeLayoutShift: null,
    interactionToNextPaintMs: null,
    ttfbMs: null,
    firstContentfulPaintMs: null,
    perf: null,
    unsupportedEntryTypes: [],
  };
}

describe('renderDataReport — observation domains', () => {
  /** Three states, three renderings. `(unavailable)` already meant "the
   * extractor failed" and `(empty)` "nothing was found"; not-recorded is the
   * third answer and has to be visibly distinct from both. */
  it('renders not-recorded distinctly from empty and from unavailable', () => {
    const notRecorded = renderDataReport(
      {
        network: emptyNetwork(false),
        stack: emptyStack(false),
        vitals: emptyVitals(false),
        warnings: [],
      },
      ['network', 'stack', 'vitals'],
    );
    expect(notRecorded).toContain(
      'network\n  (not recorded — re-open with --record)',
    );
    expect(notRecorded).toContain(
      'stack\n  (not recorded — re-open with --record)',
    );
    expect(notRecorded).not.toContain('(empty)');

    const armedButQuiet = renderDataReport(
      { network: emptyNetwork(true), warnings: [] },
      ['network'],
    );
    expect(armedButQuiet).toBe('network\n  (empty)');

    const failed = renderDataReport({ warnings: [] }, ['network']);
    expect(failed).toBe('network\n  (unavailable)');
  });

  it('renders a recording with its totals against the cap it was measured on', () => {
    const network = emptyNetwork(true);
    network.totals = {
      requestCount: 47,
      bodiesKept: 12,
      bodyBytes: 310 * 1024,
      bodyCapBytes: 2 * 1024 * 1024,
      transferSizeBytes: 900_000,
    };
    network.skippedByReason = {
      'binary-type': 30,
      'over-cap': 5,
      evicted: 0,
      unreadable: 0,
    };
    network.byHost = [
      {
        host: 'api.example.com',
        requestCount: 12,
        transferSizeBytes: 40_000,
        statusClasses: ['2xx', '4xx'],
      },
    ];

    const output = renderDataReport({ network, warnings: [] }, ['network']);

    expect(output).toMatch(/total\s+47 requests/);
    expect(output).toMatch(
      /bodies\s+12 kept, 35 skipped \(binary-type 30, over-cap 5\)/,
    );
    expect(output).toMatch(/bytes\s+310 kB \/ 2\.0 MB cap/);
    expect(output).toMatch(/host\s+api\.example\.com 12 \(2xx\/4xx\)/);
  });

  it('says out loud when a recording was kept without redaction', () => {
    const network = emptyNetwork(true);
    network.totals = { ...network.totals, requestCount: 1 };
    network.containsUnredactedCredentials = true;

    expect(renderDataReport({ network, warnings: [] }, ['network'])).toContain(
      'recorded WITHOUT redaction',
    );
  });

  it('marks a cookie inventory that could not see HttpOnly as partial', () => {
    const stack = emptyStack(true);
    stack.cookies = {
      includesHttpOnly: false,
      cookies: [
        { name: 'sid', domain: 'example.com', firstParty: true },
        { name: '_ga', domain: '.analytics.test', firstParty: false },
      ],
    };
    stack.technologies = [
      {
        category: 'analytics',
        name: 'Google Analytics',
        evidence: 'script-url',
        matched: 'https://www.googletagmanager.com/gtag/js',
      },
    ];

    const output = renderDataReport({ stack, warnings: [] }, ['stack']);

    expect(output).toMatch(/tech\s+analytics: Google Analytics \(script-url\)/);
    expect(output).toMatch(/cookies\s+2, 1 third-party \(document\.cookie/);
  });

  it('omits a vitals metric the browser never reported rather than printing zero', () => {
    const vitals = emptyVitals(true);
    vitals.largestContentfulPaintMs = 1840;
    vitals.cumulativeLayoutShift = 0.04;
    vitals.unsupportedEntryTypes = ['interaction'];

    const output = renderDataReport({ vitals, warnings: [] }, ['vitals']);

    expect(output).toMatch(/lcp\s+1840ms/);
    expect(output).toMatch(/cls\s+0\.04/);
    expect(output).not.toContain('inp');
    expect(output).toMatch(/unsupported\s+interaction/);
  });

  it('prints a rating beside each metric that has one', () => {
    const vitals = emptyVitals(true);
    vitals.largestContentfulPaintMs = 4200;
    vitals.cumulativeLayoutShift = 0.04;
    vitals.ratings = {
      largestContentfulPaint: 'poor',
      cumulativeLayoutShift: 'good',
      // Unobserved, so unrated — and the row is absent anyway. A band here
      // would be the one thing this domain must never print.
      interactionToNextPaint: null,
      ttfb: null,
      firstContentfulPaint: null,
    };

    const output = renderDataReport({ vitals, warnings: [] }, ['vitals']);

    expect(output).toMatch(/lcp\s+4200ms poor/);
    expect(output).toMatch(/cls\s+0\.04 good/);
    expect(output).not.toContain('needs-improvement');
  });

  it('names a Set-Cookie-derived cookie inventory as the weaker source', () => {
    const stack = emptyStack(true);
    stack.cookies = {
      includesHttpOnly: true,
      source: 'set-cookie',
      cookies: [{ name: 'sid', domain: 'example.com', firstParty: true }],
    };

    const output = renderDataReport({ stack, warnings: [] }, ['stack']);

    // Observation sees only what was set while someone was watching, so the
    // reader has to know the logged-in session may simply not be listed.
    expect(output).toMatch(/cookies\s+1, 0 third-party \(from Set-Cookie/);
  });

  it('says nothing extra about a complete jar, which needs no caveat', () => {
    const stack = emptyStack(true);
    stack.cookies = {
      includesHttpOnly: true,
      source: 'cookie-jar',
      cookies: [{ name: 'sid', domain: 'example.com', firstParty: true }],
    };

    const output = renderDataReport({ stack, warnings: [] }, ['stack']);

    expect(output).toMatch(/cookies\s+1, 0 third-party$/m);
  });
});
