import { describe, expect, it } from 'vitest';
import type { DataReport } from 'quick-caps-core/extract';
import { summarizeData } from '../src/lib/data-summary.js';

const empty: Partial<DataReport> = { warnings: [] };

describe('summarizeData', () => {
  it('says so when the page declared nothing', () => {
    expect(summarizeData(empty)).toBe('No extractable data found.');
  });

  it('leads with the declared entity types, then the headline entities', () => {
    const summary = summarizeData({
      warnings: [],
      structured: {
        jsonLd: [{ '@type': 'Product', name: 'Widget' }],
        microdata: [],
        rdfa: [],
        social: {},
        seo: { alternates: [], robots: [], feeds: [] },
      },
      entities: {
        prices: [
          {
            value: { amount: 49.99, currency: 'USD' },
            source: 'json-ld',
            confidence: 'high',
          },
        ],
        dates: {},
        authors: [
          { value: { name: 'A' }, source: 'json-ld', confidence: 'high' },
          { value: { name: 'B' }, source: 'json-ld', confidence: 'high' },
        ],
        ratings: [],
        contacts: { emails: [], phones: [], addresses: [], socials: [] },
        pagination: [],
      },
      links: {
        links: [],
        internalCount: 10,
        externalCount: 4,
        byHost: {},
      },
    });
    expect(summary).toBe(
      'Found: 1 product, price $49.99, 2 authors, 14 links.',
    );
  });

  it('reports a bare amount when the page declared no currency', () => {
    expect(
      summarizeData({
        warnings: [],
        entities: {
          prices: [
            {
              value: { amount: 12 },
              source: 'text-heuristic',
              confidence: 'low',
            },
          ],
          dates: {},
          authors: [],
          ratings: [],
          contacts: { emails: [], phones: [], addresses: [], socials: [] },
          pagination: [],
        },
      }),
    ).toBe('Found: price 12.');
  });

  it('stays short on a rich page, and names what it left out', () => {
    const summary = summarizeData({
      warnings: [],
      structured: {
        jsonLd: [
          { '@type': 'Product' },
          { '@type': 'Product' },
          { '@type': 'Article' },
          { '@type': 'Person' },
        ],
        microdata: [],
        rdfa: [],
        social: {},
        seo: { alternates: [], robots: [], feeds: [] },
      },
      content: {
        wordCount: 1240,
        readingTimeMinutes: 6,
        outline: [],
        outlineViolations: [],
        media: { items: [], altCoverage: 0, formats: {}, lazyShare: 0 },
        split: {
          mainRegionIds: [],
          boilerplateRegionIds: [],
          mainWordCount: 0,
          confidence: 0,
        },
      },
    });
    // Two lines at most: a capture summary, not a report viewer.
    expect(summary.split('\n').length).toBeLessThanOrEqual(2);
    expect(summary).toContain('2 products');
    expect(summary).toContain('1,240 words');
  });

  it('mentions extraction warnings without spelling them out', () => {
    const summary = summarizeData({
      warnings: [
        { phase: 'extract', reason: 'design: cross-origin stylesheets' },
      ],
    });
    expect(summary).toContain('1 extraction warning');
  });
});
