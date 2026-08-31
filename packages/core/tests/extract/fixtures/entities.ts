import { parseHTML } from 'linkedom';
import { collectFromDocument } from '../../../src/collect.js';
import { defaultSettings } from '../../../src/settings.js';
import type { Warning } from '../../../src/ir.js';
import type {
  ExtractorContext,
  JsonLdNode,
  StructuredReport,
} from '../../../src/extract/types.js';

/**
 * `structured` is a separate extractor, so these tests never run it: they hand
 * `extractEntities` the report it would have produced. That keeps the declared
 * tier's fixtures readable as "what the page published" and keeps this suite
 * from failing for someone else's parser bug.
 */
export function structuredReport(
  parts: Partial<StructuredReport> = {},
): StructuredReport {
  return {
    jsonLd: [],
    microdata: [],
    rdfa: [],
    social: {},
    seo: { alternates: [], robots: [], feeds: [] },
    ...parts,
  };
}

export function jsonLd(...nodes: JsonLdNode[]): StructuredReport {
  return structuredReport({ jsonLd: nodes });
}

export type EntityFixture = {
  ctx: ExtractorContext;
  warnings: Warning[];
};

/** Parses `html` into the context the registry would build, plus the warning
 * sink so a test can assert a degradation rather than only its absence. */
export function entityContext(html: string): EntityFixture {
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;
  const ir = collectFromDocument(doc, {
    settings: defaultSettings,
    pageUrl: 'https://shop.example.com/p/42',
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
  });
  const warnings: Warning[] = [];
  return {
    ctx: {
      doc,
      ir,
      warn: (warning) => warnings.push({ ...warning, phase: 'extract' }),
    },
    warnings,
  };
}

/** No entities of any kind — the page that must come back well-formed and
 * empty rather than throwing or inventing. */
export const BARE_PAGE = `<!doctype html><html><head><title>About</title></head>
<body><main><h1>About us</h1><p>We make things. We have made them since the
beginning, and we intend to keep making them.</p></main></body></html>`;

/** The ugly case: the only price on the page is in the footer, in prose, with
 * no markup at all. */
export const FOOTER_PRICE = `<!doctype html><html><body>
<main><h1>Widget</h1><p>A widget for widgeting.</p></main>
<footer><p>All widgets from $24.99 while stocks last.</p></footer>
</body></html>`;

/** A declared price and a prose price disagreeing on the same page. */
export const DECLARED_AND_TEXT_PRICE = `<!doctype html><html><body>
<main><h1>Widget</h1><p class="price">Now only $9.99!</p></main>
</body></html>`;

export const PRODUCT_NODE: JsonLdNode = {
  '@type': 'Product',
  name: 'Widget',
  offers: {
    '@type': 'Offer',
    price: '19.99',
    priceCurrency: 'USD',
    availability: 'https://schema.org/InStock',
  },
  aggregateRating: {
    '@type': 'AggregateRating',
    ratingValue: 4.5,
    bestRating: 5,
    reviewCount: 312,
  },
};

/** Two currencies side by side, neither declared. */
export const MULTI_CURRENCY = `<!doctype html><html><body>
<main><h1>Widget</h1>
<p>United States: $19.99</p>
<p>Germany: 24,50 €</p>
<p>Japan: ¥3,200</p>
</main></body></html>`;

/** A struck-through original beside the price actually charged. */
export const SALE_PRICE = `<!doctype html><html><body>
<main><p class="price"><del>$49.00</del> <ins>$29.00</ins></p></main>
</body></html>`;

/** A machine-readable date and a prose date for the same article. */
export const TIME_AND_PROSE_DATE = `<!doctype html><html><body>
<article>
<h1>A post</h1>
<p>Published on <time datetime="2026-08-30T09:15:00Z">yesterday</time></p>
<p>Last updated March 3, 2026 by the editors.</p>
</article></body></html>`;

/** Only prose dates, so the low tier is the only tier. */
export const PROSE_DATE_ONLY = `<!doctype html><html><body>
<article><h1>A post</h1><p>Posted on August 12, 2026 by Ada Lovelace.</p>
</article></body></html>`;

export const EVENT_TIMES = `<!doctype html><html><body>
<div class="event">
<time class="dtstart" datetime="2026-09-01T18:00:00Z">Sep 1, 6pm</time>
<time class="dtend" datetime="2026-09-01T21:00:00Z">9pm</time>
</div></body></html>`;

export const CONTACTS = `<!doctype html><html><body>
<footer>
<address>221B Baker Street, London NW1 6XE, United Kingdom</address>
<a href="mailto:hello@example.com">Email us</a>
<a href="tel:+442071234567">Call us</a>
<a href="https://twitter.com/example">Twitter</a>
<a href="https://www.linkedin.com/company/example/">LinkedIn</a>
<p>Or reach sales@example.com on +1 (415) 555-0132.</p>
</footer></body></html>`;

export const PAGINATION = `<!doctype html><html><head>
<link rel="next" href="/p/43">
<link rel="prev" href="/p/41">
</head><body>
<nav aria-label="Pagination">
<a href="/list?page=1">1</a>
<a href="/list?page=2">2</a>
<a href="/list?page=3">3</a>
</nav>
<button type="button" id="more">Load more results</button>
</body></html>`;

export const ITEMPROP_ONLY = `<!doctype html><html><body>
<div class="product">
<span itemprop="price" content="12.50">12.50</span>
<meta itemprop="priceCurrency" content="GBP">
<span itemprop="ratingValue">4.1</span>
<span itemprop="reviewCount">88</span>
</div></body></html>`;

export const RATING_IN_PROSE = `<!doctype html><html><body>
<main><p>Rated 4.2 out of 5 stars by 1,204 reviews.</p></main>
</body></html>`;

/** The case a per-field gate loses: a struck-through original beside the price
 * actually charged, where the charged one is also declared. */
export const SALE_PAIR = `<!doctype html><html><body>
<main><h1>Widget</h1>
<p class="price"><del>$79.00</del> <ins>$49.99</ins></p>
</main></body></html>`;

export const SALE_OFFER_NODE: JsonLdNode = {
  '@type': 'Product',
  name: 'Widget',
  offers: { '@type': 'Offer', price: '49.99', priceCurrency: 'USD' },
};

/** schema.org's own discount spelling: the list price in a priceSpecification
 * beside the price charged. */
export const PRICE_SPEC_NODE: JsonLdNode = {
  '@type': 'Product',
  offers: {
    '@type': 'Offer',
    price: 49.99,
    priceCurrency: 'USD',
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: 79,
      priceType: 'https://schema.org/ListPrice',
    },
  },
};

/** An Offer carrying both bounds of the pair itself. */
export const HIGH_LOW_NODE: JsonLdNode = {
  '@type': 'AggregateOffer',
  highPrice: '79.00',
  lowPrice: '49.99',
  priceCurrency: 'USD',
};

/** A LinkedIn account linked in the footer while JSON-LD declares only the
 * Twitter one — two platforms, so two roles. */
export const LINKED_SOCIAL = `<!doctype html><html><body>
<footer><a href="https://www.linkedin.com/company/example/">LinkedIn</a></footer>
</body></html>`;

/** A relative <base href>, which resolves against the page url before any
 * pagination href resolves against it. */
export const BASED_PAGINATION = `<!doctype html><html><head>
<base href="/list/">
<link rel="next" href="?page=3">
<link rel="prev" href="http://">
</head><body><p>Page 2</p></body></html>`;
