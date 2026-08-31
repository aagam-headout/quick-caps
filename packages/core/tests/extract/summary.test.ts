import { describe, expect, it } from 'vitest';
import {
  domainAvailability,
  formatAvailability,
  OBSERVATION_DOMAINS,
} from '../../src/extract/summary.js';
import type {
  ContentReport,
  DataReport,
  DesignReport,
  EntityReport,
  LinkReport,
  NetworkReport,
  StackReport,
  StructuredReport,
  VitalsReport,
} from '../../src/extract/types.js';

const structured: StructuredReport = {
  jsonLd: [{ '@type': 'Product' }, { '@type': 'Offer' }],
  microdata: [{ types: ['https://schema.org/Product'], properties: {} }],
  rdfa: [],
  social: { title: 'A Product' },
  seo: {
    canonical: 'https://example.com/p',
    alternates: [],
    robots: [],
    feeds: [],
  },
};

const entities: EntityReport = {
  prices: [{ value: { amount: 9.99 }, source: 'json-ld', confidence: 'high' }],
  dates: {
    published: { value: '2026-08-31', source: 'meta', confidence: 'high' },
  },
  authors: [{ value: { name: 'A' }, source: 'json-ld', confidence: 'high' }],
  ratings: [],
  contacts: { emails: [], phones: [], addresses: [], socials: [] },
  pagination: [],
};

const content: ContentReport = {
  wordCount: 120,
  readingTimeMinutes: 1,
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

const design: DesignReport = {
  components: [],
  fonts: [],
  breakpoints: [],
  grid: { templateColumns: {}, gaps: {}, containerWidths: [] },
};

const links: LinkReport = {
  links: [
    {
      href: 'https://example.com/a',
      text: 'a',
      internal: true,
      zone: 'content',
      rel: [],
      host: 'example.com',
    },
  ],
  internalCount: 1,
  externalCount: 0,
  byHost: {},
};

const full: Partial<DataReport> = {
  structured,
  entities,
  content,
  design,
  links,
  warnings: [],
};

describe('domainAvailability', () => {
  it('counts findings per domain, in domain order, skipping domains that are absent', () => {
    expect(domainAvailability({ links, warnings: [] })).toEqual([
      { domain: 'links', count: 1 },
    ]);
  });

  it('reports no count for the whole-page domains', () => {
    expect(domainAvailability(full)).toEqual([
      { domain: 'structured', count: 5 },
      { domain: 'entities', count: 3 },
      { domain: 'content', count: null },
      { domain: 'design', count: null },
      { domain: 'links', count: 1 },
    ]);
  });

  it('ignores the warnings key, which is not a domain', () => {
    expect(
      domainAvailability({
        warnings: [{ phase: 'extract', reason: 'design: threw' }],
      }),
    ).toEqual([]);
  });
});

describe('formatAvailability', () => {
  it('renders countable domains with their count and the rest bare', () => {
    expect(formatAvailability(full)).toBe(
      'structured(5) entities(3) content design links(1)',
    );
  });

  it('renders nothing for a report with no domains', () => {
    expect(formatAvailability({ warnings: [] })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The observation domains
// ---------------------------------------------------------------------------

function network(recorded: boolean, requestCount = 0): NetworkReport {
  return {
    recorded,
    requests: Array.from({ length: requestCount }, () => ({
      at: 0,
      method: 'GET',
      url: 'https://api.example.com/a',
      status: 200,
      resourceType: 'xhr',
      requestHeaders: {},
      responseHeaders: {},
      durationMs: 1,
      transferSizeBytes: 1,
      body: { kept: false, reason: 'binary-type' as const },
    })),
    byHost: [],
    skippedByReason: {
      'binary-type': 0,
      'over-cap': 0,
      evicted: 0,
      unreadable: 0,
    },
    totals: {
      requestCount,
      bodiesKept: 0,
      bodyBytes: 0,
      bodyCapBytes: 2 * 1024 * 1024,
      transferSizeBytes: 0,
    },
    containsUnredactedCredentials: false,
  };
}

function stack(recorded: boolean): StackReport {
  return {
    recorded,
    technologies: recorded
      ? [
          {
            category: 'framework',
            name: 'React',
            evidence: 'global-name',
            matched: '__REACT_DEVTOOLS_GLOBAL_HOOK__',
          },
        ]
      : [],
    thirdPartyHosts: [],
    cookies: { cookies: [], includesHttpOnly: false },
    consentBanner: { present: false },
  };
}

function vitals(recorded: boolean): VitalsReport {
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

describe('OBSERVATION_DOMAINS', () => {
  it('names exactly the three domains that can come back not-recorded', () => {
    expect([...OBSERVATION_DOMAINS]).toEqual(['network', 'stack', 'vitals']);
  });
});

describe('domainAvailability — observation domains', () => {
  it('marks an unarmed domain not-recorded with no count to offer', () => {
    expect(
      domainAvailability({
        network: network(false),
        stack: stack(false),
        vitals: vitals(false),
      }),
    ).toEqual([
      { domain: 'network', count: null, notRecorded: true },
      { domain: 'stack', count: null, notRecorded: true },
      { domain: 'vitals', count: null, notRecorded: true },
    ]);
  });

  /** The distinction the flag exists for: an armed host that saw nothing
   * counts zero, which is a finding; an unarmed one has no count at all. */
  it('counts an armed-but-quiet domain rather than calling it not-recorded', () => {
    expect(domainAvailability({ network: network(true) })).toEqual([
      { domain: 'network', count: 0 },
    ]);
    expect(domainAvailability({ network: network(true, 47) })).toEqual([
      { domain: 'network', count: 47 },
    ]);
  });

  it('treats vitals as a whole-page summary, like content and design', () => {
    expect(domainAvailability({ vitals: vitals(true) })).toEqual([
      { domain: 'vitals', count: null },
    ]);
  });
});

describe('formatAvailability — observation domains', () => {
  it('prints not-recorded as one hyphenated token, not a count', () => {
    expect(
      formatAvailability({
        links,
        network: network(false),
        stack: stack(false),
        vitals: vitals(false),
      }),
    ).toBe(
      'links(1) network(not-recorded) stack(not-recorded) vitals(not-recorded)',
    );
  });

  it('prints an armed domain with its count, zero included', () => {
    expect(
      formatAvailability({
        network: network(true),
        stack: stack(true),
        vitals: vitals(true),
      }),
    ).toBe('network(0) stack(1) vitals');
  });
});
