import type { PageIR } from '../ir.js';
import type { RecordedRequest } from '../observe/types.js';
import { REDACTED } from '../observe/redact.js';
import type {
  ConsentBanner,
  CookieInventorySource,
  CookieRecord,
  DetectedTechnology,
  ExtractorMap,
  HostClassification,
  StackCategory,
  StackEvidence,
  ThirdPartyHost,
} from './types.js';

/**
 * A URL substring and what it gives away. Deliberately a short hand-written
 * list rather than a signature dataset: a table like Wappalyzer's grows
 * without bound, and every row of it is a maintenance liability in a bundle
 * that ships to a browser. These cover the vendors a page is actually likely
 * to carry; adding one more is appending a row here and nothing else.
 *
 * First match wins per URL, so a more specific needle precedes a looser one
 * on the same host — `gtm.js` and `gtag/js` are the same host and different
 * products.
 */
type UrlSignature = [needle: string, category: StackCategory, name: string];

const URL_SIGNATURES: UrlSignature[] = [
  ['/_next/static/', 'framework', 'Next.js'],
  ['/_nuxt/', 'framework', 'Nuxt'],
  ['/wp-content/', 'framework', 'WordPress'],
  ['/wp-includes/', 'framework', 'WordPress'],
  ['cdn.shopify.com', 'framework', 'Shopify'],
  ['googletagmanager.com/gtm.js', 'tag-manager', 'Google Tag Manager'],
  ['assets.adobedtm.com', 'tag-manager', 'Adobe Experience Platform Tag'],
  ['tags.tiqcdn.com', 'tag-manager', 'Tealium'],
  ['googletagmanager.com/gtag/js', 'analytics', 'Google Analytics'],
  ['google-analytics.com', 'analytics', 'Google Analytics'],
  ['cdn.segment.com', 'analytics', 'Segment'],
  ['plausible.io/js', 'analytics', 'Plausible'],
  ['static.hotjar.com', 'analytics', 'Hotjar'],
  ['cdn.amplitude.com', 'analytics', 'Amplitude'],
  ['cdn.mxpnl.com', 'analytics', 'Mixpanel'],
  ['clarity.ms', 'analytics', 'Microsoft Clarity'],
  ['js.hs-scripts.com', 'analytics', 'HubSpot'],
  ['doubleclick.net', 'ad-network', 'Google Ads'],
  ['googlesyndication.com', 'ad-network', 'Google AdSense'],
  ['connect.facebook.net', 'ad-network', 'Meta Pixel'],
  ['analytics.tiktok.com', 'ad-network', 'TikTok Pixel'],
  ['snap.licdn.com', 'ad-network', 'LinkedIn Insight'],
  ['cdn.jsdelivr.net', 'cdn', 'jsDelivr'],
  ['unpkg.com', 'cdn', 'unpkg'],
  ['cdnjs.cloudflare.com', 'cdn', 'cdnjs'],
  ['ajax.googleapis.com', 'cdn', 'Google Hosted Libraries'],
  ['cdn.optimizely.com', 'ab-testing', 'Optimizely'],
  ['visualwebsiteoptimizer.com', 'ab-testing', 'VWO'],
  ['widget.intercom.io', 'chat-widget', 'Intercom'],
  ['js.intercomcdn.com', 'chat-widget', 'Intercom'],
  ['embed.tawk.to', 'chat-widget', 'Tawk.to'],
  ['static.zdassets.com', 'chat-widget', 'Zendesk'],
  ['client.crisp.chat', 'chat-widget', 'Crisp'],
  ['js.stripe.com', 'payment', 'Stripe'],
  ['paypalobjects.com', 'payment', 'PayPal'],
  ['checkout.razorpay.com', 'payment', 'Razorpay'],
  ['js.braintreegateway.com', 'payment', 'Braintree'],
];

/**
 * Markup a framework leaves behind that no URL reveals — a hydration payload
 * under a fixed id, or a version attribute. Same growth story as above.
 *
 * These report `global-name`, which is the closest `StackEvidence` has: the
 * vocabulary is fixed and carries no 'markup' member, and `matched` names the
 * id or attribute so a reviewer can still go look.
 */
const MARKUP_SIGNATURES: Array<
  [selector: string, matched: string, category: StackCategory, name: string]
> = [
  ['script#__NEXT_DATA__', '__NEXT_DATA__', 'framework', 'Next.js'],
  ['#__NUXT_DATA__', '__NUXT_DATA__', 'framework', 'Nuxt'],
  ['#___gatsby', '___gatsby', 'framework', 'Gatsby'],
  ['[ng-version]', 'ng-version', 'framework', 'Angular'],
  ['[data-reactroot]', 'data-reactroot', 'framework', 'React'],
  ['[data-v-app]', 'data-v-app', 'framework', 'Vue'],
];

/** Globals an inline script references. Only worth listing where the global is
 * the *only* evidence on a server-rendered page — a tag manager injected
 * without its own <script src> still pushes to its queue. */
const GLOBAL_SIGNATURES: Array<
  [global: string, category: StackCategory, name: string]
> = [
  ['dataLayer', 'tag-manager', 'Google Tag Manager'],
  ['__NUXT__', 'framework', 'Nuxt'],
  ['Shopify', 'framework', 'Shopify'],
];

/** Response headers that name the edge or the server. An empty needle means
 * presence alone is the signal, because a vendor-prefixed header nobody else
 * sends is already the whole signature. */
const HEADER_SIGNATURES: Array<
  [header: string, needle: string, category: StackCategory, name: string]
> = [
  ['server', 'cloudflare', 'cdn', 'Cloudflare'],
  ['x-vercel-id', '', 'cdn', 'Vercel'],
  ['x-amz-cf-id', '', 'cdn', 'Amazon CloudFront'],
  ['x-fastly-request-id', '', 'cdn', 'Fastly'],
  ['x-powered-by', 'next.js', 'framework', 'Next.js'],
  ['x-shopify-stage', '', 'framework', 'Shopify'],
];

/** Cookie name prefixes that name their setter. Kept to the handful whose
 * names are unmistakable: a cookie is weak evidence for anything whose name
 * could plausibly be someone else's. */
const COOKIE_SIGNATURES: Array<
  [prefix: string, category: StackCategory, name: string]
> = [
  ['_ga', 'analytics', 'Google Analytics'],
  ['_fbp', 'ad-network', 'Meta Pixel'],
  ['_hjSession', 'analytics', 'Hotjar'],
  ['__stripe_mid', 'payment', 'Stripe'],
];

/** Consent platforms by the container they render. A named CMP is worth more
 * than the generic pass below: it survives a redesign of the banner's classes,
 * and it tells the caller *whose* consent state the page is in. */
const CMP_SELECTORS: Array<[selector: string, name: string]> = [
  ['#onetrust-banner-sdk', 'OneTrust'],
  ['#CybotCookiebotDialog', 'Cookiebot'],
  ['#usercentrics-root', 'Usercentrics'],
  ['#didomi-host', 'Didomi'],
  ['#truste-consent-track', 'TrustArc'],
  ['#cookie-law-info-bar', 'CookieYes'],
  ['.cc-window', 'Cookie Consent'],
];

/**
 * The generic banner pass: a container that names itself after cookies or
 * consent. Attribute substring matching is case-sensitive here — the `i` flag
 * is not portable across the DOM implementations this runs on — which is
 * acceptable because the CamelCase spellings in the wild belong to the named
 * CMPs above.
 */
const BANNER_SELECTOR = [
  '[id*="cookie"]',
  '[class*="cookie"]',
  '[id*="consent"]',
  '[class*="consent"]',
  '[id*="gdpr"]',
  '[class*="gdpr"]',
].join(',');

/** A banner asks for something, so it has a control; prose about cookies does
 * not. Both tests must pass, or a recipe page becomes a consent banner. */
const BANNER_CONTROL = 'button,[role="button"],input[type="button"],a[href]';
const BANNER_TEXT = /cookie|consent|privacy/i;

/** What a category implies about the host serving it. 'unknown' stays the
 * answer for a host no signature covered: an unrecognized host is a fact, and
 * calling it functional would assert something nothing supports. */
const CLASSIFICATION_BY_CATEGORY: Record<StackCategory, HostClassification> = {
  framework: 'functional',
  analytics: 'tracker',
  'tag-manager': 'tracker',
  'ad-network': 'advertising',
  cdn: 'cdn',
  'ab-testing': 'tracker',
  'chat-widget': 'functional',
  payment: 'functional',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // Routine on a real page: a data: URI, a template-mangled src, a
    // protocol-relative URL with no base. Signature matching still runs on
    // the raw string; only the host inventory needs it to parse.
    return '';
  }
}

/**
 * Same-site test without a public suffix list. Comparing the last two labels
 * is an approximation that errs toward calling a host first-party — two
 * unrelated `*.co.uk` sites read as one site — and the alternative is either a
 * dependency or a vendored suffix list that goes stale. Under-reporting a
 * third party is the safer direction: the inventory never accuses a host it
 * cannot place.
 */
function sameSite(host: string, pageHost: string): boolean {
  if (host === '' || host === pageHost) return true;
  const site = (h: string) => h.split('.').slice(-2).join('.');
  return site(host) === site(pageHost);
}

/** Header lookup that does not care how the host cased its keys. */
function header(request: RecordedRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(request.responseHeaders)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** Every URL the IR knows the page fetched, whatever channel recorded it. A
 * tracker loaded by another script appears only in the recording or the log;
 * one in the markup appears only in the assets. */
function requestedUrls(
  ir: PageIR,
): Array<{ url: string; kind: StackEvidence }> {
  const urls: Array<{ url: string; kind: StackEvidence }> = [];
  for (const asset of ir.assets) {
    urls.push({
      url: asset.url,
      kind: asset.kind === 'script' ? 'script-url' : 'asset-host',
    });
  }
  for (const request of ir.recording?.requests ?? []) {
    urls.push({
      url: request.url,
      kind: request.resourceType === 'script' ? 'script-url' : 'asset-host',
    });
  }
  for (const entry of ir.logs ?? []) {
    if (entry.kind === 'request')
      urls.push({ url: entry.url, kind: 'asset-host' });
  }
  return urls;
}

/** Set-Cookie for one response, split the only way that is safe: a header map
 * collapses repeats onto separate lines, and splitting on commas instead would
 * cut an `Expires=Wed, 09 Sep …` date in half. */
function setCookieLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseSetCookie(
  line: string,
  requestHost: string,
  pageHost: string,
  arrivedAtMs: number | null,
): CookieRecord | null {
  const [pair, ...rest] = line.split(';');
  const eq = pair?.indexOf('=') ?? -1;
  if (!pair || eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  if (name === '') return null;

  const attributes = new Map<string, string>();
  for (const part of rest) {
    const at = part.indexOf('=');
    const key = (at === -1 ? part : part.slice(0, at)).trim().toLowerCase();
    if (key !== '')
      attributes.set(key, at === -1 ? '' : part.slice(at + 1).trim());
  }

  const declaredDomain = attributes.get('domain');
  // A leading dot is legacy syntax for the same thing the attribute already
  // means, so it is dropped rather than reported as part of the domain.
  const domain = (declaredDomain ?? requestHost)
    .replace(/^\./, '')
    .toLowerCase();

  const cookie: CookieRecord = {
    name,
    domain,
    // Judged against the page origin, not the cookie's own domain: a cookie
    // scoped to `.example.com` is first-party to `shop.example.com`.
    firstParty: pageHost === domain || pageHost.endsWith(`.${domain}`),
    httpOnly: attributes.has('httponly'),
    secure: attributes.has('secure'),
  };

  // Max-Age wins over Expires, as it does in a browser. It is relative to when
  // the response arrived, which is the only clock a recording has.
  const maxAge = Number(attributes.get('max-age'));
  const expires = attributes.get('expires');
  if (attributes.has('max-age') && Number.isFinite(maxAge)) {
    if (arrivedAtMs !== null) {
      cookie.expires = new Date(arrivedAtMs + maxAge * 1000).toISOString();
    }
  } else if (expires !== undefined) {
    const parsed = Date.parse(expires);
    // An unparseable date leaves the field absent rather than guessing: an
    // expiry nobody can read is not a session cookie either, but reporting a
    // wrong instant is worse than reporting none.
    if (!Number.isNaN(parsed)) cookie.expires = new Date(parsed).toISOString();
  }

  const sameSite = attributes.get('samesite')?.toLowerCase();
  if (sameSite === 'strict' || sameSite === 'lax' || sameSite === 'none') {
    cookie.sameSite = sameSite;
  }
  return cookie;
}

/**
 * What the page is built out of and who else it talks to.
 *
 * Most of this needs no recording: script URLs and asset hosts live in
 * `ir.assets`, and the framework, generator, and consent banner are in the
 * markup. Two fields do need one — `cookies`, and any detection whose evidence
 * is a response header — and both stay empty rather than warning when nobody
 * was watching, because being unarmed is the caller's choice.
 *
 * The cookie inventory has two sources, and which one a reader got changes what
 * its silence means, so `CookieInventory.source` names it: the host's own jar
 * (complete, and the only channel that sees cookies the page *arrived* with),
 * or reconstruction from `Set-Cookie` on recorded responses (only what was set
 * while someone was watching). `includesHttpOnly` is the second axis: false
 * means the flag was never visible, so the absence of an HttpOnly cookie proves
 * nothing.
 */
export const extractStack: ExtractorMap['stack'] = (ctx) => {
  const { doc, ir } = ctx;
  const recording = ir.recording;
  const pageHost = hostOf(ir.metadata.url);

  const technologies = new Map<string, DetectedTechnology>();
  const hostClassifications = new Map<string, HostClassification>();

  /** First evidence for a technology wins, and the passes below run
   * strongest-first: a URL names a product outright where a global name or a
   * cookie only implies it. */
  function detect(
    category: StackCategory,
    name: string,
    evidence: StackEvidence,
    matched: string,
    host?: string,
  ): void {
    const key = `${category}|${name}`;
    if (!technologies.has(key)) {
      technologies.set(key, { category, name, evidence, matched });
    }
    if (host !== undefined && host !== '' && !hostClassifications.has(host)) {
      hostClassifications.set(host, CLASSIFICATION_BY_CATEGORY[category]);
    }
  }

  // --- URLs: assets, recorded requests, and the network log ----------------
  const urls = requestedUrls(ir);
  for (const { url, kind } of urls) {
    const signature = URL_SIGNATURES.find(([needle]) => url.includes(needle));
    if (signature) detect(signature[1], signature[2], kind, url, hostOf(url));
  }

  // --- Markup and globals: the unarmed path, and often the only one -------
  for (const [selector, matched, category, name] of MARKUP_SIGNATURES) {
    if (doc.querySelector(selector))
      detect(category, name, 'global-name', matched);
  }
  const generator = ir.metadata.meta.generator;
  if (generator !== undefined && generator.trim() !== '') {
    // One meta covers every generator-declaring CMS at once, which is why it
    // is here instead of as seven more rows above. The version is evidence,
    // not part of the product's name.
    const declared = generator.trim();
    const name = declared.replace(/[\s,]+v?\d[\w.+-]*$/, '').trim();
    detect('framework', name === '' ? declared : name, 'global-name', declared);
  }
  for (const el of doc.querySelectorAll('script:not([src])')) {
    const text = el.textContent ?? '';
    if (text === '') continue;
    for (const [global, category, name] of GLOBAL_SIGNATURES) {
      if (text.includes(global)) detect(category, name, 'global-name', global);
    }
  }

  // --- Response headers: armed sessions only -------------------------------
  for (const request of recording?.requests ?? []) {
    for (const [name, needle, category, product] of HEADER_SIGNATURES) {
      const value = header(request, name);
      if (value === undefined) continue;
      if (needle !== '' && !value.toLowerCase().includes(needle)) continue;
      detect(
        category,
        product,
        'response-header',
        `${name}: ${value}`,
        hostOf(request.url),
      );
    }
  }

  // --- Cookies -------------------------------------------------------------
  // The jar wins when the host could read one. `Set-Cookie` observation sees
  // only cookies set *during* the recording — never the session, the consent
  // record, or the visitor id the page arrived carrying — so where a real jar
  // exists, reconstructing from responses would present the smaller set as
  // though it were the whole. Falling back to observation is still far better
  // than nothing, and `source` is how the report says which one a reader got.
  const cookies = new Map<string, CookieRecord>();
  let source: CookieInventorySource = 'none';
  // Assigned by whichever branch below runs, so it has no initializer: a
  // default here would be a third answer neither channel produced.
  let includesHttpOnly: boolean;
  const jar = recording?.cookies;

  /** Name and domain together identify a cookie; NUL joins them because it is
   * the one byte neither half can contain, so no pair of real cookies can
   * collide on the key. */
  const cookieKey = (cookie: CookieRecord): string =>
    `${cookie.name}\u0000${cookie.domain}`;

  /** Shared by both paths below: a cookie's own name is sometimes the only
   * thing that names its setter. */
  function detectFromCookie(cookie: CookieRecord, host: string): void {
    const signature = COOKIE_SIGNATURES.find(([prefix]) =>
      cookie.name.startsWith(prefix),
    );
    if (signature) {
      detect(signature[1], signature[2], 'cookie', cookie.name, host);
    }
  }

  if (jar !== undefined) {
    source = 'cookie-jar';
    includesHttpOnly = jar.complete;
    for (const cookie of jar.cookies) {
      cookies.set(cookieKey(cookie), cookie);
      // The jar has no request to attribute a cookie to, so the cookie's own
      // domain is the host — which is also the more accurate answer.
      detectFromCookie(cookie, cookie.domain);
    }
    if (!jar.complete) {
      // A jar the host could only half-read is a gap with a cause worth
      // naming, unlike an unarmed session: a host limited to `document.cookie`
      // cannot see HttpOnly at all, so an absence here proves nothing.
      ctx.warn({
        reason:
          'cookie inventory is partial: the host could not read the whole jar',
        detail:
          'HttpOnly cookies are invisible to a host limited to document.cookie, so a cookie missing from this inventory may still exist',
      });
    }
  } else {
    let readableSetCookies = 0;
    let unreadableSetCookies = 0;
    const startedAtMs = recording
      ? Date.parse(recording.startedAt)
      : Number.NaN;
    for (const request of recording?.requests ?? []) {
      const value = header(request, 'set-cookie');
      if (value === undefined) continue;
      // A Set-Cookie header was there, so this is the channel the inventory
      // came from even if this particular header turns out unreadable.
      source = 'set-cookie';
      // Redaction now keeps a cookie's metadata and replaces only its value,
      // so a whole-value marker no longer means "redacted" — it means the
      // header failed closed because no parse of it was safe.
      if (value.trim() === REDACTED) {
        unreadableSetCookies += 1;
        continue;
      }
      const arrivedAtMs = Number.isNaN(startedAtMs)
        ? null
        : startedAtMs + request.at;
      const requestHost = hostOf(request.url);
      for (const line of setCookieLines(value)) {
        const cookie = parseSetCookie(line, requestHost, pageHost, arrivedAtMs);
        if (!cookie) continue;
        readableSetCookies += 1;
        // Last write wins, because that is what the browser's jar holds.
        cookies.set(cookieKey(cookie), cookie);
        detectFromCookie(cookie, requestHost);
      }
    }
    // Set-Cookie carries the flag, so a readable one really does see HttpOnly
    // — for the cookies it saw at all, which is not the same as all of them.
    includesHttpOnly = readableSetCookies > 0;
    if (unreadableSetCookies > 0) {
      ctx.warn({
        reason:
          'cookie inventory incomplete: a Set-Cookie header was unreadable',
        detail: `${unreadableSetCookies} response(s) carried a Set-Cookie header no parse could split safely, so it was redacted whole`,
      });
    }
  }

  // --- Third-party hosts ---------------------------------------------------
  const tallies = new Map<string, { recorded: number; referenced: number }>();
  function tally(url: string, channel: 'recorded' | 'referenced'): void {
    const host = hostOf(url);
    if (host === '' || sameSite(host, pageHost)) return;
    const entry = tallies.get(host) ?? { recorded: 0, referenced: 0 };
    entry[channel] += 1;
    tallies.set(host, entry);
  }
  for (const asset of ir.assets) tally(asset.url, 'referenced');
  for (const entry of ir.logs ?? []) {
    if (entry.kind === 'request') tally(entry.url, 'referenced');
  }
  for (const request of recording?.requests ?? [])
    tally(request.url, 'recorded');

  const thirdPartyHosts: ThirdPartyHost[] = [...tallies]
    .map(([host, counts]) => ({
      host,
      // A recorded request is a request; a reference is one the page makes.
      // Zero would read as "unused", which is not what a markup-only
      // reference means.
      requestCount: counts.recorded === 0 ? counts.referenced : counts.recorded,
      classification: hostClassifications.get(host) ?? 'unknown',
    }))
    .sort(
      (a, b) => b.requestCount - a.requestCount || a.host.localeCompare(b.host),
    );

  // --- Consent banner ------------------------------------------------------
  const consentBanner: ConsentBanner = { present: false };
  for (const [selector, name] of CMP_SELECTORS) {
    if (doc.querySelector(selector)) {
      consentBanner.present = true;
      consentBanner.matched = name;
      break;
    }
  }
  if (!consentBanner.present) {
    for (const el of doc.querySelectorAll(BANNER_SELECTOR)) {
      if (!el.querySelector(BANNER_CONTROL)) continue;
      if (!BANNER_TEXT.test(el.textContent ?? '')) continue;
      const id = el.getAttribute('id');
      const className = (el.getAttribute('class') ?? '').split(/\s+/)[0] ?? '';
      consentBanner.present = true;
      consentBanner.matched = `${el.tagName.toLowerCase()}${
        id ? `#${id}` : className ? `.${className}` : ''
      }`;
      break;
    }
  }

  return {
    recorded: recording !== undefined,
    technologies: [...technologies.values()],
    thirdPartyHosts,
    cookies: {
      cookies: [...cookies.values()],
      // False covers every host that could not see the flag — the extension
      // reading `document.cookie`, or a fallback that saw no readable
      // Set-Cookie at all. In either case an absent HttpOnly cookie proves
      // nothing, which is the only thing this boolean is for.
      includesHttpOnly,
      // Which channel produced the list above, because its silence means
      // different things: a jar's omission is a cookie that is not set, a
      // Set-Cookie reconstruction's omission may just be a cookie set before
      // anyone was watching.
      source,
    },
    consentBanner,
  };
};
