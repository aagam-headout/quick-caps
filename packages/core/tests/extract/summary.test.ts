import { describe, expect, it } from 'vitest';
import {
  domainAvailability,
  formatAvailability,
} from '../../src/extract/summary.js';
import type {
  ContentReport,
  DataReport,
  DesignReport,
  EntityReport,
  LinkReport,
  StructuredReport,
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
