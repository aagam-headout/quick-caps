import { describe, expect, it } from 'vitest';
import { extractEntities } from '../../src/extract/entities.js';
import {
  BARE_PAGE,
  BASED_PAGINATION,
  CONTACTS,
  DECLARED_AND_TEXT_PRICE,
  EVENT_TIMES,
  FOOTER_PRICE,
  HIGH_LOW_NODE,
  ITEMPROP_ONLY,
  LINKED_SOCIAL,
  MULTI_CURRENCY,
  PAGINATION,
  PRICE_SPEC_NODE,
  PRODUCT_NODE,
  PROSE_DATE_ONLY,
  RATING_IN_PROSE,
  SALE_OFFER_NODE,
  SALE_PAIR,
  SALE_PRICE,
  TIME_AND_PROSE_DATE,
  entityContext,
  jsonLd,
  structuredReport,
} from './fixtures/entities.js';

describe('extractEntities', () => {
  it('returns a well-formed empty report for a page with no entities', () => {
    const { ctx, warnings } = entityContext(BARE_PAGE);

    expect(extractEntities(ctx, structuredReport())).toEqual({
      prices: [],
      dates: {},
      authors: [],
      ratings: [],
      contacts: { emails: [], phones: [], addresses: [], socials: [] },
      pagination: [],
    });
    expect(warnings).toEqual([]);
  });

  it('does not throw on a document with no body', () => {
    const { ctx } = entityContext('<!doctype html><html></html>');

    expect(() => extractEntities(ctx, structuredReport())).not.toThrow();
  });
});

describe('prices', () => {
  it('reads a declared offer with its currency and availability', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(ctx, jsonLd(PRODUCT_NODE));

    expect(report.prices).toEqual([
      {
        value: { amount: 19.99, currency: 'USD' },
        source: 'json-ld',
        confidence: 'high',
      },
    ]);
    expect(report.availability).toEqual({
      value: 'in-stock',
      source: 'json-ld',
      confidence: 'high',
    });
  });

  it('lets a declared price win outright over a prose price', () => {
    const { ctx } = entityContext(DECLARED_AND_TEXT_PRICE);

    const report = extractEntities(ctx, jsonLd(PRODUCT_NODE));

    expect(report.prices).toHaveLength(1);
    expect(report.prices[0]?.value.amount).toBe(19.99);
    expect(report.prices[0]?.confidence).toBe('high');
  });

  it('reports a footer-only prose price as low, with the text it matched', () => {
    const { ctx } = entityContext(FOOTER_PRICE);

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices).toEqual([
      {
        value: { amount: 24.99, currency: 'USD' },
        source: 'text-heuristic',
        confidence: 'low',
        matched: '$24.99',
      },
    ]);
  });

  it('keeps each currency on a multi-currency page distinct', () => {
    const { ctx } = entityContext(MULTI_CURRENCY);

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices.map((p) => p.value)).toEqual([
      { amount: 19.99, currency: 'USD' },
      { amount: 24.5, currency: 'EUR' },
      { amount: 3200, currency: 'JPY' },
    ]);
    expect(report.prices.every((p) => p.confidence === 'low')).toBe(true);
    expect(report.prices[1]?.matched).toBe('24,50 €');
  });

  it('reports an original and a discounted price in document order', () => {
    const { ctx } = entityContext(SALE_PRICE);

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices.map((p) => p.value.amount)).toEqual([49, 29]);
  });

  it('reads a bare itemprop price as semantic markup, not declared', () => {
    const { ctx } = entityContext(ITEMPROP_ONLY);

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices).toEqual([
      {
        value: { amount: 12.5, currency: 'GBP' },
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
  });

  it('reads a price declared only in meta tags', () => {
    const { ctx } = entityContext(
      `<!doctype html><html><head>
       <meta property="product:price:amount" content="34.00">
       <meta property="product:price:currency" content="CAD">
       <meta property="product:availability" content="oos">
       </head><body><p>Sold out</p></body></html>`,
    );

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices).toEqual([
      {
        value: { amount: 34, currency: 'CAD' },
        source: 'meta',
        confidence: 'high',
      },
    ]);
    expect(report.availability?.value).toBe('out-of-stock');
    expect(report.availability?.source).toBe('meta');
  });

  it('reads availability from prose when nothing declares it', () => {
    const { ctx } = entityContext(
      '<!doctype html><html><body><p>Currently out of stock.</p></body></html>',
    );

    const report = extractEntities(ctx, structuredReport());

    expect(report.availability).toEqual({
      value: 'out-of-stock',
      source: 'text-heuristic',
      confidence: 'low',
      matched: 'out of stock',
    });
  });
});

describe('dates', () => {
  it('normalizes declared dates to ISO', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(
      ctx,
      jsonLd({
        '@type': 'Article',
        datePublished: '2026-08-30',
        dateModified: 'Mon, 31 Aug 2026 12:00:00 GMT',
      }),
    );

    expect(report.dates.published).toEqual({
      value: '2026-08-30',
      source: 'json-ld',
      confidence: 'high',
    });
    expect(report.dates.modified?.value).toBe('2026-08-31T12:00:00.000Z');
  });

  it('prefers a <time datetime> over a prose date for the same field', () => {
    const { ctx } = entityContext(TIME_AND_PROSE_DATE);

    const report = extractEntities(ctx, structuredReport());

    expect(report.dates.published).toEqual({
      value: '2026-08-30T09:15:00.000Z',
      source: 'semantic-markup',
      confidence: 'medium',
    });
    expect(report.dates.modified).toEqual({
      value: '2026-03-03T00:00:00.000Z',
      source: 'text-heuristic',
      confidence: 'low',
      matched: 'updated March 3, 2026',
    });
  });

  it('falls back to a prose publication date, with its matched text', () => {
    const { ctx } = entityContext(PROSE_DATE_ONLY);

    const report = extractEntities(ctx, structuredReport());

    expect(report.dates.published?.confidence).toBe('low');
    expect(report.dates.published?.value).toBe('2026-08-12T00:00:00.000Z');
    expect(report.dates.published?.matched).toBe('Posted on August 12, 2026');
  });

  it('reads event start and end from hinted time elements', () => {
    const { ctx } = entityContext(EVENT_TIMES);

    const report = extractEntities(ctx, structuredReport());

    expect(report.dates.eventStart?.value).toBe('2026-09-01T18:00:00.000Z');
    expect(report.dates.eventEnd?.value).toBe('2026-09-01T21:00:00.000Z');
    expect(report.dates.eventStart?.source).toBe('semantic-markup');
  });

  it('warns rather than reporting a declared date it cannot parse', () => {
    const { ctx, warnings } = entityContext(BARE_PAGE);

    const report = extractEntities(
      ctx,
      jsonLd({ '@type': 'Article', datePublished: 'last thursday' }),
    );

    expect(report.dates.published).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.detail).toContain('last thursday');
  });
});

describe('authors and ratings', () => {
  it('reads declared authors, keeping the url when one is given', () => {
    const { ctx } = entityContext(PROSE_DATE_ONLY);

    const report = extractEntities(
      ctx,
      jsonLd({
        '@type': 'Article',
        author: [
          { '@type': 'Person', name: 'Ada Lovelace', url: '/people/ada' },
          'Charles Babbage',
        ],
      }),
    );

    expect(report.authors).toEqual([
      {
        value: { name: 'Ada Lovelace', url: '/people/ada' },
        source: 'json-ld',
        confidence: 'high',
      },
      {
        value: { name: 'Charles Babbage' },
        source: 'json-ld',
        confidence: 'high',
      },
    ]);
  });

  it('falls back to a byline in prose', () => {
    const { ctx } = entityContext(PROSE_DATE_ONLY);

    const report = extractEntities(ctx, structuredReport());

    expect(report.authors).toEqual([
      {
        value: { name: 'Ada Lovelace' },
        source: 'text-heuristic',
        confidence: 'low',
        matched: 'by Ada Lovelace',
      },
    ]);
  });

  it('reads a declared rating with its scale and review count', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(ctx, jsonLd(PRODUCT_NODE));

    expect(report.ratings).toEqual([
      {
        value: { value: 4.5, best: 5, reviewCount: 312 },
        source: 'json-ld',
        confidence: 'high',
      },
    ]);
  });

  it('reads a rating from bare itemprops', () => {
    const { ctx } = entityContext(ITEMPROP_ONLY);

    const report = extractEntities(ctx, structuredReport());

    expect(report.ratings).toEqual([
      {
        value: { value: 4.1, reviewCount: 88 },
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
  });

  it('reads a rating and review count from prose', () => {
    const { ctx } = entityContext(RATING_IN_PROSE);

    const report = extractEntities(ctx, structuredReport());

    expect(report.ratings).toEqual([
      {
        value: { value: 4.2, best: 5, reviewCount: 1204 },
        source: 'text-heuristic',
        confidence: 'low',
        matched: '4.2 out of 5 stars',
      },
    ]);
  });
});

describe('contacts', () => {
  it('reads mailto, tel, address, and social links as semantic markup', () => {
    const { ctx } = entityContext(CONTACTS);

    const report = extractEntities(ctx, structuredReport());

    expect(report.contacts.emails).toEqual([
      {
        value: 'hello@example.com',
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
    expect(report.contacts.phones).toEqual([
      {
        value: '+442071234567',
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
    expect(report.contacts.addresses).toEqual([
      {
        value: { raw: '221B Baker Street, London NW1 6XE, United Kingdom' },
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
    expect(report.contacts.socials).toEqual([
      {
        value: {
          platform: 'twitter',
          handle: '@example',
          url: 'https://twitter.com/example',
        },
        source: 'semantic-markup',
        confidence: 'medium',
      },
      {
        value: {
          platform: 'linkedin',
          handle: 'example',
          url: 'https://www.linkedin.com/company/example/',
        },
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
  });

  it('reads a declared postal address into its parts', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(
      ctx,
      jsonLd({
        '@type': 'Organization',
        email: 'press@example.com',
        telephone: '+1-415-555-0100',
        sameAs: ['https://github.com/example'],
        address: {
          '@type': 'PostalAddress',
          streetAddress: '1 Infinite Loop',
          addressLocality: 'Cupertino',
          addressRegion: 'CA',
          postalCode: '95014',
          addressCountry: 'US',
        },
      }),
    );

    expect(report.contacts.addresses[0]).toEqual({
      value: {
        street: '1 Infinite Loop',
        locality: 'Cupertino',
        region: 'CA',
        postalCode: '95014',
        country: 'US',
      },
      source: 'json-ld',
      confidence: 'high',
    });
    expect(report.contacts.emails[0]?.value).toBe('press@example.com');
    expect(report.contacts.phones[0]?.value).toBe('+1-415-555-0100');
    expect(report.contacts.socials[0]?.value.platform).toBe('github');
  });

  it('falls back to emails and phones in prose', () => {
    const { ctx } = entityContext(
      `<!doctype html><html><body><p>Write to sales@example.com or call
       +1 (415) 555-0132 any weekday.</p></body></html>`,
    );

    const report = extractEntities(ctx, structuredReport());

    expect(report.contacts.emails).toEqual([
      {
        value: 'sales@example.com',
        source: 'text-heuristic',
        confidence: 'low',
        matched: 'sales@example.com',
      },
    ]);
    expect(report.contacts.phones[0]?.confidence).toBe('low');
    expect(report.contacts.phones[0]?.matched).toBe('+1 (415) 555-0132');
  });
});

describe('pagination', () => {
  it('reads rel targets, a numbered pager, and a load-more control', () => {
    const { ctx } = entityContext(PAGINATION);

    const report = extractEntities(ctx, structuredReport());

    expect(report.pagination.map((p) => p.value.kind)).toEqual([
      'next',
      'prev',
      'numbered',
      'numbered',
      'numbered',
      'load-more',
    ]);
    expect(report.pagination[0]?.value.href).toBe(
      'https://shop.example.com/p/43',
    );
    expect(report.pagination[0]?.confidence).toBe('medium');
    expect(report.pagination[2]?.value.label).toBe('1');

    const loadMore = report.pagination.at(-1);
    expect(loadMore?.confidence).toBe('low');
    expect(loadMore?.matched).toBe('Load more results');
    expect(loadMore?.value.domPath).toEqual([1]);
  });

  it('keeps the highest-confidence spelling of one target', () => {
    const { ctx } = entityContext(
      `<!doctype html><html><body><nav>
       <a rel="next" href="/page/2">Next</a>
       <a href="/page/2">Next</a>
       </nav></body></html>`,
    );

    const report = extractEntities(ctx, structuredReport());

    expect(report.pagination).toHaveLength(1);
    expect(report.pagination[0]?.confidence).toBe('medium');
  });

  it('finds nothing to page through on a page with no pager', () => {
    const { ctx } = entityContext(BARE_PAGE);

    expect(extractEntities(ctx, structuredReport()).pagination).toEqual([]);
  });
});

describe('discount roles', () => {
  it('keeps a marked-up original beside a declared current price', () => {
    const { ctx } = entityContext(SALE_PAIR);

    const report = extractEntities(ctx, jsonLd(SALE_OFFER_NODE));

    expect(report.prices).toEqual([
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
    ]);
  });

  it('reads a del/ins pair as two roles, both marked up', () => {
    const { ctx } = entityContext(SALE_PRICE);

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices).toEqual([
      {
        value: { amount: 49, currency: 'USD', kind: 'original' },
        source: 'semantic-markup',
        confidence: 'medium',
      },
      {
        value: { amount: 29, currency: 'USD', kind: 'current' },
        source: 'semantic-markup',
        confidence: 'medium',
      },
    ]);
  });

  it('leaves kind absent when the page states a single price', () => {
    const { ctx } = entityContext(FOOTER_PRICE);

    const report = extractEntities(ctx, structuredReport());

    expect(report.prices).toHaveLength(1);
    expect('kind' in report.prices[0]!.value).toBe(false);
  });

  it('leaves kind absent on a lone declared price', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(ctx, jsonLd(PRODUCT_NODE));

    expect('kind' in report.prices[0]!.value).toBe(false);
  });

  it('reads a declared priceSpecification list price as the original', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(ctx, jsonLd(PRICE_SPEC_NODE));

    expect(report.prices.map((p) => p.value)).toEqual([
      { amount: 49.99, currency: 'USD', kind: 'current' },
      { amount: 79, currency: 'USD', kind: 'original' },
    ]);
    expect(report.prices.every((p) => p.confidence === 'high')).toBe(true);
  });

  it('reads highPrice and lowPrice together as a declared pair', () => {
    const { ctx } = entityContext(BARE_PAGE);

    const report = extractEntities(ctx, jsonLd(HIGH_LOW_NODE));

    expect(report.prices.map((p) => p.value)).toEqual([
      { amount: 79, currency: 'USD', kind: 'original' },
      { amount: 49.99, currency: 'USD', kind: 'current' },
    ]);
  });
});

describe('role-level tiering beyond prices', () => {
  it('lets a declared published date leave a heuristic modified date standing', () => {
    const { ctx } = entityContext(TIME_AND_PROSE_DATE);

    const report = extractEntities(
      ctx,
      jsonLd({ '@type': 'Article', datePublished: '2026-08-01' }),
    );

    expect(report.dates.published?.confidence).toBe('high');
    expect(report.dates.modified).toEqual({
      value: '2026-03-03T00:00:00.000Z',
      source: 'text-heuristic',
      confidence: 'low',
      matched: 'updated March 3, 2026',
    });
  });

  it('keeps a linked social account a declared one says nothing about', () => {
    const { ctx } = entityContext(LINKED_SOCIAL);

    const report = extractEntities(
      ctx,
      jsonLd({
        '@type': 'Organization',
        sameAs: ['https://twitter.com/example'],
      }),
    );

    expect(
      report.contacts.socials.map((s) => [s.value.platform, s.confidence]),
    ).toEqual([
      ['twitter', 'high'],
      ['linkedin', 'medium'],
    ]);
  });
});

describe('pagination hrefs', () => {
  it('absolutizes against a relative base, keeping an unresolvable href', () => {
    const { ctx } = entityContext(BASED_PAGINATION);

    const report = extractEntities(ctx, structuredReport());

    expect(report.pagination.map((p) => p.value.href)).toEqual([
      'https://shop.example.com/list/?page=3',
      'http://',
    ]);
  });

  it('absolutizes a numbered pager the same way links does', () => {
    const { ctx } = entityContext(PAGINATION);

    const report = extractEntities(ctx, structuredReport());

    expect(report.pagination[2]?.value.href).toBe(
      'https://shop.example.com/list?page=1',
    );
  });
});
