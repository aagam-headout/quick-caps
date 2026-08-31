import type { PageIR, Warning } from '../ir.js';
import type { PerfReport } from '../perf.js';
import type { BodySkipReason, RecordedRequest } from '../observe/types.js';

/** Where a value came from. Ordered loosely from declared to guessed, which
 * is also the tiering order below. */
export type Provenance =
  | 'json-ld'
  | 'microdata'
  | 'rdfa'
  | 'meta'
  | 'semantic-markup' // <time datetime>, <address>, itemprop, aria
  | 'text-heuristic';

export type Confidence = 'high' | 'medium' | 'low';

export type Extracted<T> = {
  value: T;
  source: Provenance;
  confidence: Confidence;
  /** The literal text a heuristic matched on. Present only for
   * 'text-heuristic', so a reviewer can judge a low-confidence value
   * without re-reading the page. */
  matched?: string;
};

/** Tiering is fixed rather than per-extractor discretion: a declared source
 * is high, marked-up semantics are medium, and reading the prose is low. */
export const CONFIDENCE_BY_PROVENANCE: Record<Provenance, Confidence> = {
  'json-ld': 'high',
  microdata: 'high',
  rdfa: 'high',
  meta: 'high',
  'semantic-markup': 'medium',
  'text-heuristic': 'low',
};

export type ExtractDomain =
  | 'structured'
  | 'entities'
  | 'content'
  | 'design'
  | 'links'
  | 'network'
  | 'stack'
  | 'vitals';

export type ExtractContext = {
  doc: Document;
  ir: PageIR;
  /** Injected for the same reason CollectOptions injects it: the global is
   * unavailable to core by design. Absent on a static session, so any
   * extractor reading it must degrade rather than throw. */
  computedStyle?: (el: Element) => Record<string, string>;
};

/** What an extractor actually receives: the caller's context plus the
 * registry's warning sink, so a partially-derived report can say what it
 * skipped without a second return channel. `phase` is the registry's to
 * set. */
export type ExtractorContext = ExtractContext & {
  warn: (warning: Omit<Warning, 'phase'>) => void;
};

// ---------------------------------------------------------------------------
// structured — data the page already declares
// ---------------------------------------------------------------------------

/** One JSON-LD node, as published. Left unvalidated on purpose: schema.org is
 * open-ended and a caller that knows its @type reads it better than a lossy
 * normalization would. */
export type JsonLdNode = Record<string, unknown>;

export type MicrodataItem = {
  /** itemtype URLs, empty when the scope declared none. */
  types: string[];
  /** itemid, when present. */
  id?: string;
  /** itemprop name to its values; a nested itemscope appears as an item. */
  properties: Record<string, Array<string | MicrodataItem>>;
};

export type RdfaItem = {
  vocab?: string;
  /** typeof values. */
  types: string[];
  /** property name to its values. */
  properties: Record<string, string[]>;
};

/** Open Graph and Twitter cards resolved into one shape, rather than a raw
 * meta bag the caller has to reconcile itself. */
export type SocialPreview = {
  title?: string;
  description?: string;
  image?: string;
  type?: string;
  siteName?: string;
};

export type HreflangAlternate = { lang: string; href: string };

export type FeedLink = { href: string; type: string; title?: string };

export type SeoReport = {
  canonical?: string;
  alternates: HreflangAlternate[];
  /** Directive tokens from the robots meta, lowercased, in declared order. */
  robots: string[];
  feeds: FeedLink[];
};

export type StructuredReport = {
  /** Every node found, with @graph containers flattened into their members so
   * a caller never walks a graph wrapper itself. */
  jsonLd: JsonLdNode[];
  microdata: MicrodataItem[];
  rdfa: RdfaItem[];
  social: SocialPreview;
  seo: SeoReport;
};

// ---------------------------------------------------------------------------
// entities — the valuable-fetch layer
// ---------------------------------------------------------------------------

export type Price = {
  amount: number;
  /** ISO 4217 where the page declared one; absent when only a bare number or
   * an unrecognized symbol was found. */
  currency?: string;
  /** Which side of a discount this is, where the page expressed one — a
   * <del>/<ins> pair or a schema.org priceSpecification. Absent when the page
   * states a single price, which must not be reported as 'current': that
   * would imply a discount nobody offered. */
  kind?: 'original' | 'current';
};

export type Availability =
  'in-stock' | 'out-of-stock' | 'preorder' | 'backorder' | 'discontinued';

export type PostalAddress = {
  street?: string;
  locality?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  /** The address as the page presented it, when it could not be split. */
  raw?: string;
};

export type SocialHandle = { platform: string; handle: string; url?: string };

export type Rating = {
  value: number;
  /** Scale maximum, when declared — a 4.5 means nothing without it. */
  best?: number;
  reviewCount?: number;
};

export type Author = { name: string; url?: string };

export type PaginationTarget = {
  kind: 'next' | 'prev' | 'numbered' | 'load-more';
  href?: string;
  label?: string;
  /** Child-index chain from body, for a control with no href (a load-more
   * button), so a host can still act on it. */
  domPath?: number[];
};

export type EntityDates = {
  published?: Extracted<string>;
  modified?: Extracted<string>;
  eventStart?: Extracted<string>;
  eventEnd?: Extracted<string>;
};

export type ContactReport = {
  emails: Extracted<string>[];
  phones: Extracted<string>[];
  addresses: Extracted<PostalAddress>[];
  socials: Extracted<SocialHandle>[];
};

export type EntityReport = {
  prices: Extracted<Price>[];
  availability?: Extracted<Availability>;
  dates: EntityDates;
  authors: Extracted<Author>[];
  ratings: Extracted<Rating>[];
  contacts: ContactReport;
  pagination: Extracted<PaginationTarget>[];
};

// ---------------------------------------------------------------------------
// content — content quality
// ---------------------------------------------------------------------------

export type HeadingNode = {
  level: number;
  text: string;
  /** Child-index chain from body, so a caller can relocate the heading. */
  domPath: number[];
};

export type OutlineViolation = {
  kind: 'skipped-level' | 'multiple-h1' | 'missing-h1';
  /** Index into ContentReport.outline, absent for a page-wide violation. */
  headingIndex?: number;
  detail: string;
};

export type MediaItem = {
  src: string;
  alt?: string;
  /** Lowercased format guessed from the extension or type attribute. */
  format?: string;
  lazy: boolean;
  /** Displayed size from the IR's boxes. Natural size needs Stage 2's
   * sampled per-element styles and is deliberately absent here. */
  displayed?: { w: number; h: number };
};

export type MediaInventory = {
  items: MediaItem[];
  /** Share of items carrying a non-empty alt, 0..1. Zero when there are none. */
  altCoverage: number;
  /** Item count per format. */
  formats: Record<string, number>;
  /** Share of items with lazy loading, 0..1. */
  lazyShare: number;
};

export type ContentSplit = {
  mainRegionIds: number[];
  boilerplateRegionIds: number[];
  mainWordCount: number;
  /** 0..1 confidence in the split itself, not a judgement of the page. */
  confidence: number;
};

export type ContentReport = {
  wordCount: number;
  readingTimeMinutes: number;
  /** BCP 47 tag as declared or detected. */
  language?: string;
  outline: HeadingNode[];
  outlineViolations: OutlineViolation[];
  media: MediaInventory;
  split: ContentSplit;
};

// ---------------------------------------------------------------------------
// design — design-system depth
// ---------------------------------------------------------------------------

export type ComponentVariant = {
  /** The normalized tag/role/class shape instances were grouped by. */
  signature: string;
  count: number;
  /** Child-index chains to a few instances, so a caller can go look. */
  examples: number[][];
};

/**
 * Instances grouped by family, then by shape within it. Variants nest rather
 * than sitting flat because a design system's value is in the set: a page with
 * one .btn-primary and one .btn-secondary has two button variants, and a
 * flat list with a repetition threshold reports neither.
 */
export type ComponentPattern = {
  /** Coarse family the signatures were recognized as, e.g. 'button', 'card'. */
  kind: string;
  /** Instances across every variant, so the threshold applies to the family. */
  count: number;
  variants: ComponentVariant[];
};

export type DeclaredFont = {
  family: string;
  /** src URLs from an @font-face rule; empty for a bare family reference.
   * Which of these actually loaded is Stage 2's question. */
  sources: string[];
  weights: string[];
  styles: string[];
};

export type Breakpoint = {
  /** The media query as written, deduplicated across stylesheets. */
  query: string;
  /** Parsed px bound, when the query is a simple min/max-width. */
  minWidth?: number;
  maxWidth?: number;
  /** Rules behind this query — a proxy for how load-bearing it is. */
  ruleCount: number;
};

export type GridInference = {
  /** grid-template-columns values by occurrence count. */
  templateColumns: Record<string, number>;
  /** Gap values by occurrence count. */
  gaps: Record<string, number>;
  /** Inferred container max-widths in px, ascending. */
  containerWidths: number[];
};

export type DesignReport = {
  components: ComponentPattern[];
  fonts: DeclaredFont[];
  breakpoints: Breakpoint[];
  grid: GridInference;
};

// ---------------------------------------------------------------------------
// links — link graph
// ---------------------------------------------------------------------------

export type LinkZone = 'nav' | 'content' | 'footer' | 'aside' | 'unknown';

export type LinkEntry = {
  /** Absolute where the page's base allowed it, else as written. */
  href: string;
  text: string;
  internal: boolean;
  /** Page zone from the enclosing region's role. */
  zone: LinkZone;
  /** rel tokens as declared, lowercased. */
  rel: string[];
  /** Host of href, for the outbound tally. Empty for a non-absolute href. */
  host: string;
  /** The action handle this link already carries in the IR, when it has one,
   * so a caller can `do` it without re-finding the element. */
  handle?: number;
};

export type LinkReport = {
  links: LinkEntry[];
  internalCount: number;
  externalCount: number;
  /** Outbound link count per external host. */
  byHost: Record<string, number>;
};

// ---------------------------------------------------------------------------
// The observation domains — network, stack, vitals
//
// These three read `ir.recording` / `ir.logs` / `ir.perf` instead of `ctx.doc`:
// what a page asked the network for, what it is built out of, and how fast it
// was do not survive in a serialized DOM, so only a host that was watching can
// answer them. That makes "nobody was watching" a possible answer, and the
// shared `recorded` flag below is how each report says so — distinctly from an
// empty report, which is the honest answer to "nothing happened".
// ---------------------------------------------------------------------------

/**
 * The common head of every observation-derived report. Not a base class and
 * not optional: an agent that cannot distinguish an unarmed session from a
 * quiet page will draw the wrong conclusion from both.
 */
export type ObservationReport = {
  /** False when the observation this domain derives from was never armed.
   * Every other field is then at its empty value and means nothing. */
  recorded: boolean;
};

// --- network ---------------------------------------------------------------

/** Per-host rollup over the recorded requests: the API surface behind a page,
 * which is the thing no amount of DOM reading reveals. */
export type NetworkHostSummary = {
  host: string;
  requestCount: number;
  /** Summed transfer size across requests to this host, counting only the
   * ones where the host could measure it. */
  transferSizeBytes: number;
  /** Status classes seen, as '2xx'/'3xx'/'4xx'/'5xx', ascending. A request
   * that never got a response contributes 'none'. */
  statusClasses: string[];
};

export type NetworkTotals = {
  requestCount: number;
  bodiesKept: number;
  /** Kept body bytes as observed — what the session caps were spent on. */
  bodyBytes: number;
  /** The per-session cap those bytes are measured against, carried in the
   * report so a reader never has to know the constant to read the number. */
  bodyCapBytes: number;
  /** Summed transfer size across every request that reported one. */
  transferSizeBytes: number;
};

export type NetworkReport = ObservationReport & {
  /** Every recorded response, in observation order. A redirect chain appears
   * as one entry per hop. */
  requests: RecordedRequest[];
  byHost: NetworkHostSummary[];
  /** How many bodies were skipped, per reason. Always carries every reason as
   * a key, zero included, so a reader can tell "no evictions" from "eviction
   * not accounted for". */
  skippedByReason: Record<BodySkipReason, number>;
  totals: NetworkTotals;
  /** True when the recording was written without redaction, i.e. the caller
   * opted out. A consumer pasting these requests anywhere needs to know. */
  containsUnredactedCredentials: boolean;
};

// --- stack -----------------------------------------------------------------

export type StackCategory =
  | 'framework'
  | 'analytics'
  | 'tag-manager'
  | 'ad-network'
  | 'cdn'
  | 'ab-testing'
  | 'chat-widget'
  | 'payment';

/** What gave a technology away. Kept alongside the name for the same reason
 * `Extracted` keeps `matched`: a reviewer can judge a detection without
 * re-reading the page. */
export type StackEvidence =
  'script-url' | 'global-name' | 'asset-host' | 'cookie' | 'response-header';

export type DetectedTechnology = {
  category: StackCategory;
  name: string;
  evidence: StackEvidence;
  /** The literal script URL, global name, host, cookie, or header value the
   * signature matched. */
  matched: string;
};

/** How a third-party host was classified. 'unknown' rather than a guess: an
 * unrecognized host is a fact, and calling it functional would be an
 * assertion nothing supports. */
export type HostClassification =
  'tracker' | 'advertising' | 'cdn' | 'functional' | 'unknown';

export type ThirdPartyHost = {
  host: string;
  requestCount: number;
  classification: HostClassification;
};

export type CookieRecord = {
  name: string;
  domain: string;
  /** ISO expiry. Absent for a session cookie, which is a different thing from
   * one that expires at an unknown time. */
  expires?: string;
  /** Against the page origin, not against the cookie's own domain. */
  firstParty: boolean;
  /** Absent when the host could not see the flag at all — see
   * `CookieInventory.includesHttpOnly`. */
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
};

export type CookieInventory = {
  cookies: CookieRecord[];
  /**
   * False when the host could only read `document.cookie`, which by
   * definition cannot see an `HttpOnly` cookie — the extension's case, and a
   * permanent asymmetry with the CLI reading Playwright's context. The
   * inventory is then partial by construction and says so here rather than
   * presenting a subset as a whole.
   */
  includesHttpOnly: boolean;
};

export type ConsentBanner = {
  present: boolean;
  /** The signature that matched — a known CMP name, or the selector that hit.
   * Absent when nothing matched. */
  matched?: string;
};

export type StackReport = ObservationReport & {
  technologies: DetectedTechnology[];
  thirdPartyHosts: ThirdPartyHost[];
  cookies: CookieInventory;
  consentBanner: ConsentBanner;
};

// --- vitals ----------------------------------------------------------------

export type VitalsReport = ObservationReport & {
  /** The five field metrics, null where the browser never reported one — an
   * INP of null means no interaction happened, not an INP of zero. */
  largestContentfulPaintMs: number | null;
  cumulativeLayoutShift: number | null;
  interactionToNextPaintMs: number | null;
  ttfbMs: number | null;
  firstContentfulPaintMs: number | null;
  /** The navigation and resource summary `buildPerfReport` already produces,
   * carried whole rather than re-flattened: this domain adds observation over
   * time, it does not replace the one-shot snapshot. */
  perf: PerfReport | null;
  /** PerformanceObserver entry types the browser did not support, named here
   * rather than thrown — an absent metric with no explanation is the gap this
   * field exists to close. */
  unsupportedEntryTypes: string[];
};

// ---------------------------------------------------------------------------

export type DataReport = {
  structured: StructuredReport;
  entities: EntityReport;
  content: ContentReport;
  design: DesignReport;
  links: LinkReport;
  network: NetworkReport;
  stack: StackReport;
  vitals: VitalsReport;
  /** Not a domain: extractor failures and degradations, phase 'extract'.
   * Lives here because extractData returns a Partial<DataReport> and a
   * failed domain's absence alone cannot say why it is absent. */
  warnings: Warning[];
};

/** Extractors take the context and nothing else, except `entities`, which the
 * registry additionally hands `structured`'s report — it must not re-parse
 * JSON-LD itself. */
export type ExtractorMap = {
  structured: (ctx: ExtractorContext) => StructuredReport;
  entities: (
    ctx: ExtractorContext,
    structured: StructuredReport,
  ) => EntityReport;
  content: (ctx: ExtractorContext) => ContentReport;
  design: (ctx: ExtractorContext) => DesignReport;
  links: (ctx: ExtractorContext) => LinkReport;
  network: (ctx: ExtractorContext) => NetworkReport;
  stack: (ctx: ExtractorContext) => StackReport;
  vitals: (ctx: ExtractorContext) => VitalsReport;
};
