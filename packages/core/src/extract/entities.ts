import {
  CONFIDENCE_BY_PROVENANCE,
  type Author,
  type Availability,
  type Confidence,
  type EntityDates,
  type Extracted,
  type ExtractorContext,
  type ExtractorMap,
  type MicrodataItem,
  type PaginationTarget,
  type PostalAddress,
  type Price,
  type Provenance,
  type Rating,
  type RdfaItem,
  type SocialHandle,
  type StructuredReport,
} from './types.js';

/** Confidence as a sortable rank, so "the highest-confidence source wins" is
 * one comparison rather than a chain of ifs. */
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

function mark<T>(value: T, source: Provenance, matched?: string): Extracted<T> {
  return {
    value,
    source,
    confidence: CONFIDENCE_BY_PROVENANCE[source],
    // Carried only for the low tier, where a reviewer needs to see what the
    // heuristic read; on a declared value it would just repeat the value.
    ...(source === 'text-heuristic' && matched !== undefined
      ? { matched }
      : {}),
  };
}

/**
 * The spec's conflict rule — an entity found from several sources reports the
 * best source and never merges — applied per semantic ROLE within a field
 * rather than per field. A declared value is only the last word on the thing
 * it describes: a JSON-LD sale price says what is charged and says nothing
 * about the struck-through original beside it, so gating the whole field on it
 * would delete a fact the page stated outright. Every field routes through
 * here; a field whose values have no role to tell apart passes one constant
 * role and gets exactly the old per-field behaviour.
 */
function bestTierByRole<T>(
  candidates: Extracted<T>[],
  roleOf: (value: T) => string,
): Extracted<T>[] {
  const best = new Map<string, number>();
  for (const candidate of candidates) {
    const role = roleOf(candidate.value);
    const rank = RANK[candidate.confidence];
    if (rank < (best.get(role) ?? Number.POSITIVE_INFINITY)) {
      best.set(role, rank);
    }
  }
  // Filtered rather than grouped, so document order survives across roles and
  // a page's own ordering of a discount pair reaches the report intact.
  return candidates.filter(
    (candidate) =>
      RANK[candidate.confidence] === best.get(roleOf(candidate.value)),
  );
}

const bestTier = <T>(candidates: Extracted<T>[]): Extracted<T>[] =>
  bestTierByRole(candidates, () => '');

function dedupe<T>(
  candidates: Extracted<T>[],
  key: (value: T) => string,
): Extracted<T>[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const id = key(candidate.value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// value normalization
// ---------------------------------------------------------------------------

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const MONTH_NAME = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const PROSE_DATE = String.raw`(?:${MONTH_NAME}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH_NAME},?\s+\d{4}|\d{4}-\d{2}-\d{2})`;
const MONTH_FIRST = new RegExp(
  String.raw`^(${MONTH_NAME})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$`,
  'i',
);
const DAY_FIRST = new RegExp(
  String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_NAME}),?\s+(\d{4})$`,
  'i',
);

function utcDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString();
}

/**
 * To ISO, or null when the value is not a date at all. Month-name forms are
 * resolved arithmetically instead of through Date.parse, which reads them as
 * local midnight and would make every extracted date depend on the host's
 * timezone.
 */
function normalizeDate(raw: string): string | null {
  const value = collapse(raw);
  // A declared date-only value stays date-only: widening it to midnight UTC
  // invents a precision the page never claimed.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const monthFirst = MONTH_FIRST.exec(value);
  if (monthFirst) {
    const month = MONTHS.indexOf(monthFirst[1]!.slice(0, 3).toLowerCase());
    return utcDay(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  const dayFirst = DAY_FIRST.exec(value);
  if (dayFirst) {
    const month = MONTHS.indexOf(dayFirst[2]!.slice(0, 3).toLowerCase());
    return utcDay(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

const SYMBOL_CURRENCY: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₽': 'RUB',
  '₩': 'KRW',
};
const CURRENCY_CODES = [
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'INR',
  'CAD',
  'AUD',
  'CHF',
  'CNY',
  'SEK',
  'NOK',
  'DKK',
  'NZD',
  'BRL',
  'MXN',
  'ZAR',
  'SGD',
  'HKD',
  'PLN',
  'TRY',
  'AED',
  'KRW',
];

const PRICE_TEXT = new RegExp(
  String.raw`(?:([$€£¥₹₽₩]|\b(?:${CURRENCY_CODES.join('|')})\b)\s?(\d[\d.,\s']*\d|\d)|(\d[\d.,\s']*\d|\d)\s?([$€£¥₹₽₩]|\b(?:${CURRENCY_CODES.join('|')})\b))`,
  'gi',
);

/** The Price one PRICE_TEXT match describes, or null when the digits were not
 * an amount after all. Shared by the semantic and text tiers, which read the
 * same money out of the page and differ only in what the markup around it
 * means. */
function priceFromMatch(match: RegExpMatchArray): Price | null {
  const marker = (match[1] ?? match[4] ?? '').trim();
  const amount = parseAmount(match[2] ?? match[3] ?? '');
  if (amount === null) return null;
  const currency =
    SYMBOL_CURRENCY[marker] ??
    (CURRENCY_CODES.includes(marker.toUpperCase())
      ? marker.toUpperCase()
      : undefined);
  return { amount, ...(currency ? { currency } : {}) };
}

/** The first price in a run of text. */
function firstPrice(text: string): Price | null {
  for (const match of text.matchAll(PRICE_TEXT)) {
    const price = priceFromMatch(match);
    if (price) return price;
  }
  return null;
}

/**
 * A human-written amount to a number. The decimal separator is decided by the
 * last group's length, which is the only reliable signal when a page mixes
 * `1,299.00` and `1.299,00` — a locale table would need a locale the page
 * rarely declares.
 */
function parseAmount(raw: string): number | null {
  // \s covers the non-breaking spaces real price markup is full of.
  const cleaned = raw.replace(/[\s']/g, '');
  // Bare punctuation or an empty string is not a zero-priced anything.
  if (!/^\d[\d.,]*$/.test(cleaned)) return null;
  const lastSeparator = Math.max(
    cleaned.lastIndexOf('.'),
    cleaned.lastIndexOf(','),
  );
  const tail = lastSeparator === -1 ? '' : cleaned.slice(lastSeparator + 1);
  const digits =
    lastSeparator !== -1 && tail.length <= 2
      ? `${cleaned.slice(0, lastSeparator).replace(/[.,]/g, '')}.${tail}`
      : cleaned.replace(/[.,]/g, '');
  const amount = Number(digits);
  return Number.isFinite(amount) ? amount : null;
}

function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  return parseAmount(raw.trim());
}

const AVAILABILITY_PATTERNS: Array<[RegExp, Availability]> = [
  [/(out ?of ?stock|soldout|oos|unavailable)/, 'out-of-stock'],
  [/(pre-?order|presale)/, 'preorder'],
  [/back-?order/, 'backorder'],
  [/discontinued/, 'discontinued'],
  [
    /(in ?stock|instoreonly|onlineonly|limitedavailability|available)/,
    'in-stock',
  ],
];

/** schema.org spells this as a URL, Open Graph as a bare word, and shops as
 * prose; all three reduce to the same tail. */
function normalizeAvailability(raw: string): Availability | null {
  const tail = raw.split(/[/#]/).pop()?.toLowerCase() ?? '';
  for (const [pattern, value] of AVAILABILITY_PATTERNS) {
    if (pattern.test(tail)) return value;
  }
  return null;
}

const SOCIAL_HOSTS: Record<string, string> = {
  'twitter.com': 'twitter',
  'x.com': 'x',
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'linkedin.com': 'linkedin',
  'github.com': 'github',
  'youtube.com': 'youtube',
  'tiktok.com': 'tiktok',
  'threads.net': 'threads',
  'pinterest.com': 'pinterest',
  'reddit.com': 'reddit',
  'mastodon.social': 'mastodon',
};
/** Path segments that are a container, not the account. */
const HANDLE_CONTAINERS = new Set([
  'company',
  'in',
  'school',
  'showcase',
  'pages',
  'groups',
  'channel',
  'c',
  'user',
  'u',
  'r',
]);
const AT_PLATFORMS = new Set([
  'twitter',
  'x',
  'instagram',
  'threads',
  'tiktok',
  'mastodon',
]);

function socialFrom(href: string, base: string): SocialHandle | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  const platform = SOCIAL_HOSTS[host];
  if (!platform) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0]?.toLowerCase() ?? '';
  const account = HANDLE_CONTAINERS.has(first) ? segments[1] : segments[0];
  if (!account) return null;

  const bare = account.replace(/^@/, '');
  return {
    platform,
    handle: AT_PLATFORMS.has(platform) ? `@${bare}` : bare,
    url: url.href,
  };
}

// ---------------------------------------------------------------------------
// candidate sink
// ---------------------------------------------------------------------------

type Candidates = {
  prices: Extracted<Price>[];
  availability: Extracted<Availability>[];
  published: Extracted<string>[];
  modified: Extracted<string>[];
  eventStart: Extracted<string>[];
  eventEnd: Extracted<string>[];
  authors: Extracted<Author>[];
  ratings: Extracted<Rating>[];
  emails: Extracted<string>[];
  phones: Extracted<string>[];
  addresses: Extracted<PostalAddress>[];
  socials: Extracted<SocialHandle>[];
  pagination: Extracted<PaginationTarget>[];
};

const emptyCandidates = (): Candidates => ({
  prices: [],
  availability: [],
  published: [],
  modified: [],
  eventStart: [],
  eventEnd: [],
  authors: [],
  ratings: [],
  emails: [],
  phones: [],
  addresses: [],
  socials: [],
  pagination: [],
});

type DateField = 'published' | 'modified' | 'eventStart' | 'eventEnd';

/** Property names shared by JSON-LD, microdata, and RDFa, mapped to the date
 * field they fill. Lowercased because RDFa and microdata authors are not
 * consistent about case. */
const DATE_PROPERTIES: Record<string, DateField> = {
  datepublished: 'published',
  datecreated: 'published',
  publishdate: 'published',
  datemodified: 'modified',
  dateupdated: 'modified',
  startdate: 'eventStart',
  enddate: 'eventEnd',
};

// ---------------------------------------------------------------------------
// declared tier — json-ld, microdata, rdfa (all 'high')
// ---------------------------------------------------------------------------

/** Microdata and RDFa items carry the same schema.org property names as
 * JSON-LD, so they are flattened into plain records and read by one walker
 * rather than three near-identical ones. */
function fromMicrodata(item: MicrodataItem): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(item.properties)) {
    const read = values.map((value) =>
      typeof value === 'string' ? value : fromMicrodata(value),
    );
    record[name] = read.length === 1 ? read[0] : read;
  }
  return record;
}

function fromRdfa(item: RdfaItem): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(item.properties)) {
    // `schema:price` and `price` mean the same thing to everything below.
    record[name.split(':').pop() ?? name] =
      values.length === 1 ? values[0] : values;
  }
  return record;
}

function authorsFrom(raw: unknown): Author[] {
  if (typeof raw === 'string') {
    const name = collapse(raw);
    return name ? [{ name }] : [];
  }
  if (Array.isArray(raw)) return raw.flatMap(authorsFrom);
  if (typeof raw !== 'object' || raw === null) return [];

  const record = raw as Record<string, unknown>;
  const name = record['name'];
  if (typeof name !== 'string' || !collapse(name)) return [];
  const url = record['url'];
  return [
    {
      name: collapse(name),
      ...(typeof url === 'string' && url ? { url } : {}),
    },
  ];
}

const ADDRESS_FIELDS: Array<[string, keyof PostalAddress]> = [
  ['streetaddress', 'street'],
  ['addresslocality', 'locality'],
  ['addressregion', 'region'],
  ['postalcode', 'postalCode'],
  ['addresscountry', 'country'],
];

function addressFrom(raw: unknown): PostalAddress | null {
  if (typeof raw === 'string') {
    const value = collapse(raw);
    return value ? { raw: value } : null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const lower = lowerKeyed(raw as Record<string, unknown>);
  const address: PostalAddress = {};
  for (const [property, field] of ADDRESS_FIELDS) {
    const value = lower[property];
    if (typeof value === 'string' && collapse(value)) {
      address[field] = collapse(value);
    } else if (typeof value === 'object' && value !== null) {
      // addressCountry is often a nested Country node rather than a code.
      const name = (value as Record<string, unknown>)['name'];
      if (typeof name === 'string') address[field] = collapse(name);
    }
  }
  return Object.keys(address).length > 0 ? address : null;
}

function lowerKeyed(record: Record<string, unknown>): Record<string, unknown> {
  const lower: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    lower[key.toLowerCase()] ??= value;
  }
  return lower;
}

const RATING_KEYS = ['ratingvalue', 'bestrating', 'reviewcount', 'ratingcount'];

/** priceType values naming the pre-discount price. schema.org spells it as a
 * URL, merchant feeds as a bare word. */
const LIST_PRICE_TYPE = /list ?price|msrp|strikethrough|regular/i;

/**
 * The prices one declared node states, each with the discount role its shape
 * gives it. schema.org has three spellings of a pair and this is where they
 * become roles: a priceSpecification typed as a list price, an explicit
 * listPrice, or highPrice and lowPrice together. Either bound alone is a range
 * end rather than a discount, so it carries no role.
 */
function declaredPrices(
  lower: Record<string, unknown>,
): Array<[number, Price['kind'] | undefined]> {
  const priceType = lower['pricetype'];
  const listed =
    typeof priceType === 'string' && LIST_PRICE_TYPE.test(priceType);
  const high = parseNumber(lower['highprice']);
  const low = parseNumber(lower['lowprice']);
  const bothBounds = high !== null && low !== null;

  const prices: Array<[number, Price['kind'] | undefined]> = [];
  const own = parseNumber(lower['price']);
  if (own !== null) prices.push([own, listed ? 'original' : undefined]);
  const list = parseNumber(lower['listprice']);
  if (list !== null) prices.push([list, 'original']);
  if (high !== null) prices.push([high, bothBounds ? 'original' : undefined]);
  if (low !== null) prices.push([low, bothBounds ? 'current' : undefined]);
  return prices;
}

/**
 * Reads one declared node and everything nested under it. Currency descends
 * because schema.org routinely puts `priceCurrency` on an Offer and `price` on
 * the `priceSpecification` inside it.
 */
function walkDeclared(
  node: unknown,
  source: Provenance,
  into: Candidates,
  warn: (reason: string, detail: string) => void,
  currency?: string,
  depth = 0,
): void {
  if (depth > 10) return;
  if (Array.isArray(node)) {
    for (const member of node) {
      walkDeclared(member, source, into, warn, currency, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object' || node === null) return;

  const lower = lowerKeyed(node as Record<string, unknown>);
  const declaredCurrency = lower['pricecurrency'];
  const inherited =
    typeof declaredCurrency === 'string' && declaredCurrency.trim()
      ? declaredCurrency.trim().toUpperCase()
      : currency;

  for (const [amount, kind] of declaredPrices(lower)) {
    into.prices.push(
      mark(
        {
          amount,
          ...(inherited ? { currency: inherited } : {}),
          ...(kind ? { kind } : {}),
        },
        source,
      ),
    );
  }

  const availability = lower['availability'];
  if (typeof availability === 'string') {
    const value = normalizeAvailability(availability);
    if (value) into.availability.push(mark(value, source));
  }

  for (const [property, field] of Object.entries(DATE_PROPERTIES)) {
    const raw = lower[property];
    if (typeof raw !== 'string') continue;
    const iso = normalizeDate(raw);
    if (iso) into[field].push(mark(iso, source));
    else warn(`unparseable ${property}`, raw);
  }

  for (const author of authorsFrom(lower['author'])) {
    into.authors.push(mark(author, source));
  }

  const ratingValue = parseNumber(lower['ratingvalue']);
  if (ratingValue !== null) {
    const best = parseNumber(lower['bestrating']);
    const count =
      parseNumber(lower['reviewcount']) ?? parseNumber(lower['ratingcount']);
    into.ratings.push(
      mark(
        {
          value: ratingValue,
          ...(best !== null ? { best } : {}),
          ...(count !== null ? { reviewCount: count } : {}),
        },
        source,
      ),
    );
  }

  const email = lower['email'];
  if (typeof email === 'string' && email.includes('@')) {
    into.emails.push(mark(collapse(email.replace(/^mailto:/i, '')), source));
  }
  const phone = lower['telephone'] ?? lower['phone'];
  if (typeof phone === 'string' && /\d/.test(phone)) {
    into.phones.push(mark(collapse(phone.replace(/^tel:/i, '')), source));
  }
  const address = addressFrom(lower['address']);
  if (address) into.addresses.push(mark(address, source));

  const sameAs = lower['sameas'];
  for (const href of Array.isArray(sameAs) ? sameAs : [sameAs]) {
    if (typeof href !== 'string') continue;
    const social = socialFrom(href, href);
    if (social) into.socials.push(mark(social, source));
  }

  for (const [key, value] of Object.entries(lower)) {
    // Already read above; recursing would double-count the rating's own keys.
    if (RATING_KEYS.includes(key) || key === 'author') continue;
    walkDeclared(value, source, into, warn, inherited, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// meta tier ('high')
// ---------------------------------------------------------------------------

const META_DATES: Array<[string[], DateField]> = [
  [['article:published_time', 'datepublished', 'pubdate'], 'published'],
  [['article:modified_time', 'og:updated_time', 'lastmod'], 'modified'],
  [['event:start_time'], 'eventStart'],
  [['event:end_time'], 'eventEnd'],
];

function readMeta(
  doc: Document,
  into: Candidates,
  warn: (reason: string, detail: string) => void,
): void {
  const bag = new Map<string, string>();
  for (const tag of doc.querySelectorAll('meta[content]')) {
    // itemprop-only meta tags belong to the semantic pass, which knows how to
    // scope them; here they would arrive without a key.
    const key = (tag.getAttribute('property') ?? tag.getAttribute('name') ?? '')
      .trim()
      .toLowerCase();
    const content = (tag.getAttribute('content') ?? '').trim();
    if (!key || !content || bag.has(key)) continue;
    bag.set(key, content);
  }
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = bag.get(key);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  const amount = parseNumber(
    first('product:price:amount', 'og:price:amount') ?? '',
  );
  if (amount !== null) {
    const currency = first('product:price:currency', 'og:price:currency');
    into.prices.push(
      mark(
        { amount, ...(currency ? { currency: currency.toUpperCase() } : {}) },
        'meta',
      ),
    );
  }

  const availability = first('product:availability', 'og:availability');
  if (availability) {
    const value = normalizeAvailability(availability);
    if (value) into.availability.push(mark(value, 'meta'));
  }

  for (const [keys, field] of META_DATES) {
    const raw = first(...keys);
    if (raw === undefined) continue;
    const iso = normalizeDate(raw);
    if (iso) into[field].push(mark(iso, 'meta'));
    else warn(`unparseable ${keys[0]}`, raw);
  }

  const author = first('author', 'article:author', 'twitter:creator');
  // A bare profile URL is skipped rather than reported as a name: Author.name
  // is required, and a URL is not one.
  if (author && !/^https?:\/\//i.test(author) && !author.startsWith('@')) {
    into.authors.push(mark({ name: collapse(author) }, 'meta'));
  }
}

// ---------------------------------------------------------------------------
// semantic-markup tier ('medium')
// ---------------------------------------------------------------------------

const elements = (doc: Document, selector: string): Element[] =>
  Array.from(doc.querySelectorAll(selector));

/** Child-index chain from body, the same addressing ActionRef uses, so a host
 * can act on a control that has no href. */
function domPathOf(el: Element, body: Element | null): number[] {
  const path: number[] = [];
  let node: Element | null = el;
  while (node && node !== body) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    path.unshift(Array.from(parent.children).indexOf(node));
    node = parent;
  }
  return path;
}

/**
 * Which date field a `<time>` fills. The attributes come first; the enclosing
 * text is consulted only as a fallback, because "Published on <time>" is how
 * most pages label a date and the value itself is still machine-readable.
 */
function timeField(el: Element): DateField | null {
  const declared = [
    el.getAttribute('itemprop'),
    el.getAttribute('property'),
    el.getAttribute('class'),
    el.getAttribute('rel'),
  ]
    .join(' ')
    .toLowerCase();
  const context = `${declared} ${collapse(el.parentElement?.textContent ?? '')
    .slice(0, 120)
    .toLowerCase()}`;

  if (/dtstart|start/.test(context)) return 'eventStart';
  if (/dtend|\bend/.test(context)) return 'eventEnd';
  if (/modif|updat|revis/.test(context)) return 'modified';
  if (/publish|pubdate|posted|\bdate/.test(context)) return 'published';
  return null;
}

/** The value microdata would read off this element, without re-implementing a
 * microdata parser: the attributes that carry a value, then the text. */
function itempropValue(el: Element): string {
  const attribute =
    el.getAttribute('content') ??
    el.getAttribute('datetime') ??
    el.getAttribute('value');
  if (attribute !== null) return collapse(attribute);
  const href = el.getAttribute('href');
  if (href !== null && el.tagName.toLowerCase() !== 'a') return href.trim();
  return collapse(el.textContent ?? '');
}

/**
 * itemprops with no itemscope above them. Inside a scope they are microdata,
 * which `structured` already parsed and reports as high; loose, they are just
 * markup with useful names, which is exactly the medium tier.
 */
function readLooseItemprops(doc: Document, into: Candidates): void {
  const bag = new Map<string, string>();
  for (const el of elements(doc, '[itemprop]')) {
    if (el.closest('[itemscope]')) continue;
    const name = el.getAttribute('itemprop')?.trim().toLowerCase();
    if (!name) continue;
    const value = itempropValue(el);
    if (value && !bag.has(name)) bag.set(name, value);
  }
  if (bag.size === 0) return;

  const amount = parseNumber(bag.get('price'));
  if (amount !== null) {
    const currency = bag.get('pricecurrency');
    into.prices.push(
      mark(
        { amount, ...(currency ? { currency: currency.toUpperCase() } : {}) },
        'semantic-markup',
      ),
    );
  }

  const availability = bag.get('availability');
  if (availability) {
    const value = normalizeAvailability(availability);
    if (value) into.availability.push(mark(value, 'semantic-markup'));
  }

  const ratingValue = parseNumber(bag.get('ratingvalue'));
  if (ratingValue !== null) {
    const best = parseNumber(bag.get('bestrating'));
    const count =
      parseNumber(bag.get('reviewcount')) ??
      parseNumber(bag.get('ratingcount'));
    into.ratings.push(
      mark(
        {
          value: ratingValue,
          ...(best !== null ? { best } : {}),
          ...(count !== null ? { reviewCount: count } : {}),
        },
        'semantic-markup',
      ),
    );
  }

  const author = bag.get('author');
  if (author) into.authors.push(mark({ name: author }, 'semantic-markup'));

  const email = bag.get('email');
  if (email?.includes('@')) {
    into.emails.push(mark(email.replace(/^mailto:/i, ''), 'semantic-markup'));
  }
  const phone = bag.get('telephone');
  if (phone)
    into.phones.push(mark(phone.replace(/^tel:/i, ''), 'semantic-markup'));

  for (const [property, field] of Object.entries(DATE_PROPERTIES)) {
    const raw = bag.get(property);
    if (raw === undefined) continue;
    const iso = normalizeDate(raw);
    if (iso) into[field].push(mark(iso, 'semantic-markup'));
  }
}

/** Tags whose meaning IS the discount role: <del>/<s>/<strike> is the price no
 * longer charged, <ins> the one that replaced it. That is marked-up semantics
 * rather than a guess about prose, so it reports medium — and the element with
 * no price inside it is an ordinary edit mark, not money. */
const PRICE_ROLE_TAGS: Array<[string, NonNullable<Price['kind']>]> = [
  ['del', 'original'],
  ['s', 'original'],
  ['strike', 'original'],
  ['ins', 'current'],
];

function readPriceRoles(doc: Document, into: Candidates): void {
  for (const [tag, kind] of PRICE_ROLE_TAGS) {
    for (const el of elements(doc, tag)) {
      const price = firstPrice(collapse(el.textContent ?? ''));
      if (price) into.prices.push(mark({ ...price, kind }, 'semantic-markup'));
    }
  }
}

function readSemantic(
  ctx: ExtractorContext,
  into: Candidates,
  warn: (reason: string, detail: string) => void,
): void {
  const { doc } = ctx;
  const base = ctx.ir.metadata.url;

  // A page's only unlabelled <time> is, in practice, its publication date;
  // recorded separately so a labelled one always beats it.
  let unlabelled: string | undefined;
  for (const el of elements(doc, 'time[datetime]')) {
    const raw = el.getAttribute('datetime') ?? '';
    const iso = normalizeDate(raw);
    if (!iso) {
      warn('unparseable time datetime', raw);
      continue;
    }
    const field = timeField(el);
    if (field) into[field].push(mark(iso, 'semantic-markup'));
    else unlabelled ??= iso;
  }
  if (unlabelled !== undefined && into.published.length === 0) {
    into.published.push(mark(unlabelled, 'semantic-markup'));
  }

  for (const el of elements(doc, 'address')) {
    const raw = collapse(el.textContent ?? '');
    // Split only where the page did the splitting for us; a comma-joined line
    // is reported raw rather than guessed into fields.
    if (raw) into.addresses.push(mark({ raw }, 'semantic-markup'));
  }

  for (const el of elements(doc, 'a[href]')) {
    const href = el.getAttribute('href') ?? '';
    if (/^mailto:/i.test(href)) {
      const email = href.slice(7).split('?')[0] ?? '';
      if (email.includes('@')) {
        into.emails.push(mark(decodeURIComponent(email), 'semantic-markup'));
      }
      continue;
    }
    if (/^tel:/i.test(href)) {
      const phone = collapse(href.slice(4));
      if (phone) into.phones.push(mark(phone, 'semantic-markup'));
      continue;
    }
    const social = socialFrom(href, base);
    if (social) into.socials.push(mark(social, 'semantic-markup'));
  }

  readLooseItemprops(doc, into);
  readPriceRoles(doc, into);
}

// ---------------------------------------------------------------------------
// pagination — declared rel, then aria-labelled pagers, then text
// ---------------------------------------------------------------------------

const NEXT_TEXT = /^(next|next page|older|older posts?|»|›|→|>)$/i;
const PREV_TEXT = /^(prev|previous|previous page|newer|newer posts?|«|‹|←|<)$/i;
const MORE_TEXT = /\b(load|show|view|see)\s+more\b/i;

/**
 * The document's href base, derived exactly as `links` derives it: a <base
 * href> may itself be relative, so it resolves against the page url first, and
 * an unparseable page url leaves hrefs as written.
 */
function resolutionBase(ctx: ExtractorContext): string | null {
  const pageUrl = ctx.ir.metadata.url;
  const declared = ctx.doc.querySelector('base[href]')?.getAttribute('href');
  try {
    return declared ? new URL(declared, pageUrl).href : new URL(pageUrl).href;
  } catch {
    return null;
  }
}

/**
 * Pagination hrefs are absolutized because `links` reports absolute urls for
 * the same page, and a consumer joining the two reports must not have to guess
 * which convention it is holding. An href that will not resolve is kept as
 * written rather than dropped: unlike a link in the crawl frontier, a pager
 * target is a fact about the page whether or not it parses.
 */
function absolutize(href: string, base: string | null): string {
  if (base === null) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function readPagination(ctx: ExtractorContext, into: Candidates): void {
  const { doc } = ctx;
  const body = doc.body ?? null;
  const base = resolutionBase(ctx);
  const hrefOf = (el: Element): string | undefined => {
    const raw = el.getAttribute('href')?.trim();
    return raw ? absolutize(raw, base) : undefined;
  };

  for (const el of elements(doc, 'link[rel], a[rel]')) {
    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const kind: PaginationTarget['kind'] | undefined = rel.includes('next')
      ? 'next'
      : rel.includes('prev') || rel.includes('previous')
        ? 'prev'
        : undefined;
    if (!kind) continue;
    const href = hrefOf(el);
    const label = collapse(el.textContent ?? '');
    into.pagination.push(
      mark(
        {
          kind,
          ...(href ? { href } : {}),
          ...(label ? { label } : {}),
          domPath: domPathOf(el, body),
        },
        'semantic-markup',
      ),
    );
  }

  // A pager the page identified as one: its numbered links are markup-declared
  // targets, not a guess that some digits happen to be links.
  const pagers = elements(
    doc,
    'nav[aria-label], nav[class], ul[class], ol[class], div[role="navigation"]',
  ).filter((el) =>
    /pag/i.test(
      `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('class') ?? ''}`,
    ),
  );
  for (const pager of pagers) {
    for (const link of Array.from(pager.querySelectorAll('a[href]'))) {
      const label = collapse(link.textContent ?? '');
      if (!/^\d+$/.test(label)) continue;
      into.pagination.push(
        mark(
          {
            kind: 'numbered',
            href: hrefOf(link) ?? '',
            label,
            domPath: domPathOf(link, body),
          },
          'semantic-markup',
        ),
      );
    }
  }

  for (const el of elements(doc, 'a, button, [role="button"]')) {
    const label = collapse(el.textContent ?? '');
    const aria = collapse(el.getAttribute('aria-label') ?? '');
    const text = label || aria;
    if (!text) continue;
    const href = hrefOf(el);
    const kind: PaginationTarget['kind'] | undefined = MORE_TEXT.test(text)
      ? 'load-more'
      : NEXT_TEXT.test(text)
        ? 'next'
        : PREV_TEXT.test(text)
          ? 'prev'
          : undefined;
    if (!kind) continue;
    into.pagination.push(
      mark(
        {
          kind,
          ...(href ? { href } : {}),
          label: text,
          domPath: domPathOf(el, body),
        },
        'text-heuristic',
        text,
      ),
    );
  }
}

/** A pagination target's role is where it goes — or, for a control that goes
 * nowhere, the control itself. Two spellings of "next page" are one target, so
 * `<a rel=next>` beating a "Next" link is the same tiering every other field
 * gets rather than a rule of its own. */
const paginationRole = (target: PaginationTarget): string =>
  `${target.kind}|${target.href ?? `@${target.domPath?.join('.') ?? ''}`}`;

// ---------------------------------------------------------------------------
// text-heuristic tier ('low')
// ---------------------------------------------------------------------------

const AVAILABILITY_TEXT: Array<[RegExp, Availability]> = [
  [/\b(out of stock|sold out|unavailable)\b/i, 'out-of-stock'],
  [/\b(pre-?order)\b/i, 'preorder'],
  [/\b(back-?order(?:ed)?)\b/i, 'backorder'],
  [/\b(discontinued)\b/i, 'discontinued'],
  [/\b(in stock|available now)\b/i, 'in-stock'],
];
const PUBLISHED_TEXT = new RegExp(
  String.raw`\b(?:published|posted)(?:\s+(?:on|at))?\s+(${PROSE_DATE})`,
  'i',
);
const MODIFIED_TEXT = new RegExp(
  String.raw`\b(?:updated|modified|revised)(?:\s+(?:on|at))?\s+(${PROSE_DATE})`,
  'i',
);
// The name has to end on a letter, or a sentence-final period lands inside it.
const NAME_WORD = String.raw`\p{Lu}(?:[\p{L}'’.-]*\p{L})?`;
const BYLINE_TEXT = new RegExp(
  String.raw`\bby\s+(${NAME_WORD}(?:\s+${NAME_WORD}){0,2})`,
  'u',
);
const RATING_TEXT =
  /\b(\d(?:[.,]\d)?)\s*(?:out of|\/)\s*(\d(?:[.,]\d)?)\s*stars?/i;
const REVIEWS_TEXT = /\b(\d[\d.,\s]*\d|\d)\s+(?:reviews?|ratings?)\b/i;
const EMAIL_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]{2,})+/g;
const PHONE_TEXT =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}/g;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** Own text per element, not the whole body: a regex over concatenated
 * descendants matches across element boundaries and reports phrases no reader
 * ever saw. */
function ownTexts(doc: Document): string[] {
  const body = doc.body;
  if (!body) return [];
  const texts: string[] = [];
  for (const el of [body, ...Array.from(body.querySelectorAll('*'))]) {
    if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;
    let own = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) own += node.nodeValue ?? '';
    }
    const text = collapse(own);
    if (text) texts.push(text);
  }
  return texts;
}

/** A run of digits long enough to be a phone number and shaped unlike a date.
 * Both guards are needed: `2026-08-30` passes the separator test and a bare
 * `555 0132` passes the length test. */
function isPhoneLike(match: string): boolean {
  const digits = match.replace(/\D/g, '').length;
  if (digits < 9 || digits > 15) return false;
  return /[+()\s]/.test(match) || digits >= 10;
}

function readText(ctx: ExtractorContext, into: Candidates): void {
  for (const text of ownTexts(ctx.doc)) {
    for (const match of text.matchAll(PRICE_TEXT)) {
      const price = priceFromMatch(match);
      if (price) {
        into.prices.push(mark(price, 'text-heuristic', match[0].trim()));
      }
    }

    for (const [pattern, value] of AVAILABILITY_TEXT) {
      const match = pattern.exec(text);
      if (match) {
        into.availability.push(mark(value, 'text-heuristic', match[0]));
        break;
      }
    }

    for (const [pattern, field] of [
      [PUBLISHED_TEXT, 'published'],
      [MODIFIED_TEXT, 'modified'],
    ] as Array<[RegExp, DateField]>) {
      const match = pattern.exec(text);
      const iso = match?.[1] ? normalizeDate(match[1]) : null;
      if (match && iso) into[field].push(mark(iso, 'text-heuristic', match[0]));
    }

    const byline = BYLINE_TEXT.exec(text);
    if (byline?.[1]) {
      into.authors.push(mark({ name: byline[1] }, 'text-heuristic', byline[0]));
    }

    const rating = RATING_TEXT.exec(text);
    if (rating) {
      const value = parseAmount(rating[1] ?? '');
      const best = parseAmount(rating[2] ?? '');
      // Only counted when it sits in the same run of text as the rating —
      // elsewhere on the page it could belong to something else entirely.
      const reviews = REVIEWS_TEXT.exec(text);
      const count = reviews ? parseAmount(reviews[1] ?? '') : null;
      if (value !== null) {
        into.ratings.push(
          mark(
            {
              value,
              ...(best !== null ? { best } : {}),
              ...(count !== null ? { reviewCount: count } : {}),
            },
            'text-heuristic',
            rating[0],
          ),
        );
      }
    }

    for (const match of text.matchAll(EMAIL_TEXT)) {
      into.emails.push(mark(match[0], 'text-heuristic', match[0]));
    }
    for (const match of text.matchAll(PHONE_TEXT)) {
      const phone = match[0].trim();
      if (isPhoneLike(phone)) {
        into.phones.push(mark(phone, 'text-heuristic', phone));
      }
    }
  }
}

// ---------------------------------------------------------------------------

function firstOf<T>(candidates: Extracted<T>[]): Extracted<T> | undefined {
  return bestTier(candidates)[0];
}

/**
 * Prices grouped into discount roles. A bare price only becomes 'current' when
 * the page expressed a pair somewhere — then it is the price charged, and a
 * declared one can take that role from the <ins> that spelled it out. With no
 * pair on the page kind stays absent, because labelling a lone price 'current'
 * would imply a discount nobody offered.
 */
function withPriceRoles(candidates: Extracted<Price>[]): Extracted<Price>[] {
  if (!candidates.some((candidate) => candidate.value.kind !== undefined)) {
    return candidates;
  }
  return candidates.map((candidate) =>
    candidate.value.kind === undefined
      ? {
          ...candidate,
          value: { ...candidate.value, kind: 'current' as const },
        }
      : candidate,
  );
}

function datesFrom(candidates: Candidates): EntityDates {
  const dates: EntityDates = {};
  for (const field of [
    'published',
    'modified',
    'eventStart',
    'eventEnd',
  ] as const) {
    const best = firstOf(candidates[field]);
    if (best) dates[field] = best;
  }
  return dates;
}

/**
 * Takes `structured`'s report as its second argument — the registry always runs
 * that pass first, so this one never re-parses JSON-LD.
 *
 * Every field is collected from all three tiers and then filtered to the best
 * tier that found anything *per role*, which is where the spec's "highest
 * confidence wins, never merge" rule lives — see bestTierByRole for why the
 * gate is per role and not per field. Collecting the low tier even when a
 * declared value exists costs one text scan and keeps the tiering in one place
 * instead of spread through every reader as an early return.
 *
 * Dates need no role function: their roles are the four candidate arrays, so
 * gating each array is already gating per role.
 */
export const extractEntities: ExtractorMap['entities'] = (
  ctx: ExtractorContext,
  structured: StructuredReport,
) => {
  const candidates = emptyCandidates();
  const warn = (reason: string, detail: string): void =>
    ctx.warn({ reason, detail });

  for (const node of structured.jsonLd) {
    walkDeclared(node, 'json-ld', candidates, warn);
  }
  for (const item of structured.microdata) {
    walkDeclared(fromMicrodata(item), 'microdata', candidates, warn);
  }
  for (const item of structured.rdfa) {
    walkDeclared(fromRdfa(item), 'rdfa', candidates, warn);
  }
  readMeta(ctx.doc, candidates, warn);
  readSemantic(ctx, candidates, warn);
  readPagination(ctx, candidates);
  readText(ctx, candidates);

  const availability = firstOf(candidates.availability);
  return {
    prices: dedupe(
      bestTierByRole(
        withPriceRoles(candidates.prices),
        (price) => price.kind ?? '',
      ),
      (price) => `${price.amount}|${price.currency ?? ''}|${price.kind ?? ''}`,
    ),
    ...(availability ? { availability } : {}),
    dates: datesFrom(candidates),
    authors: dedupe(bestTier(candidates.authors), (author) => author.name),
    ratings: dedupe(
      bestTier(candidates.ratings),
      (rating) => `${rating.value}|${rating.reviewCount ?? ''}`,
    ),
    contacts: {
      emails: dedupe(bestTier(candidates.emails), (email) =>
        email.toLowerCase(),
      ),
      phones: dedupe(bestTier(candidates.phones), (phone) =>
        phone.replace(/\D/g, ''),
      ),
      addresses: dedupe(bestTier(candidates.addresses), (address) =>
        JSON.stringify(address),
      ),
      // Platform is the role here: a declared Twitter account is not a claim
      // about the LinkedIn one linked in the footer.
      socials: dedupe(
        bestTierByRole(candidates.socials, (social) => social.platform),
        (social) => `${social.platform}|${social.handle.toLowerCase()}`,
      ),
    },
    pagination: dedupe(
      bestTierByRole(candidates.pagination, paginationRole),
      paginationRole,
    ),
  };
};
