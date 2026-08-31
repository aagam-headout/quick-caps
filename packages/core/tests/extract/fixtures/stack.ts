import { parseHTML } from 'linkedom';
import { emptyTally } from '../../../src/collect.js';
import type { AssetRef, LogEntry, PageIR, Warning } from '../../../src/ir.js';
import type { RecordedRequest, Recording } from '../../../src/observe/types.js';
import type { ExtractorContext } from '../../../src/extract/types.js';

/**
 * Stack fixtures are hand-built rather than run through
 * `collectFromDocument`, for the same reason design's are: the extractor reads
 * `ir.assets`, `ir.logs`, `ir.recording` and a handful of markup signatures,
 * and a hand-built IR lets a case state exactly which of those four channels
 * carries the evidence — which is the distinction the three-state rule turns
 * on.
 */
export function stackContext(input: {
  html?: string;
  pageUrl?: string;
  assets?: AssetRef[];
  logs?: LogEntry[];
  recording?: Recording;
}): { ctx: ExtractorContext; warnings: Omit<Warning, 'phase'>[] } {
  const html = input.html ?? CLEAN_HTML;
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;
  const ir: PageIR = {
    metadata: {
      url: input.pageUrl ?? 'https://example.com/page',
      title: doc.title,
      capturedAt: '2026-08-31T10:00:00.000Z',
      viewport: { width: 1280, height: 800 },
      documentSize: { width: 1280, height: 2400 },
      devicePixelRatio: 2,
      userAgent: 'test-agent',
      charset: 'utf-8',
      meta: metaFrom(doc),
    },
    html,
    regions: [],
    styles: [],
    assets: input.assets ?? [],
    styleTally: emptyTally(),
    ...(input.logs ? { logs: input.logs } : {}),
    ...(input.recording ? { recording: input.recording } : {}),
    warnings: [],
  };
  const warnings: Omit<Warning, 'phase'>[] = [];
  return {
    ctx: { doc, ir, warn: (warning) => warnings.push(warning) },
    warnings,
  };
}

/** `collectFromDocument` fills `metadata.meta` from the document; these
 * fixtures skip that pass, so the one meta the extractor reads is filled the
 * same way here rather than duplicated per case. */
function metaFrom(doc: Document): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const el of doc.querySelectorAll('meta[name][content]')) {
    const name = el.getAttribute('name');
    const content = el.getAttribute('content');
    if (name && content) meta[name.toLowerCase()] = content;
  }
  return meta;
}

export const script = (url: string): AssetRef => ({
  url,
  kind: 'script',
  referencedBy: 'script[src]',
});

export const image = (url: string): AssetRef => ({
  url,
  kind: 'image',
  referencedBy: 'img[src]',
});

export const requestLog = (url: string): LogEntry => ({
  kind: 'request',
  at: 120,
  method: 'GET',
  url,
  status: 200,
  durationMs: 30,
  size: 512,
});

export function request(input: {
  url: string;
  at?: number;
  resourceType?: string;
  responseHeaders?: Record<string, string>;
}): RecordedRequest {
  return {
    at: input.at ?? 100,
    method: 'GET',
    url: input.url,
    status: 200,
    resourceType: input.resourceType ?? 'xhr',
    requestHeaders: {},
    responseHeaders: input.responseHeaders ?? {},
    durationMs: 20,
    transferSizeBytes: 256,
    body: { kept: false, reason: 'binary-type' },
  };
}

export function recording(input: {
  requests: RecordedRequest[];
  redacted?: boolean;
}): Recording {
  return {
    startedAt: '2026-08-31T10:00:00.000Z',
    requests: input.requests,
    redacted: input.redacted ?? false,
    bodyBytes: 0,
  };
}

/** A page that is what it appears to be: no third party, no banner, no
 * generator. The empty-report baseline, and the only fixture where an empty
 * report is the correct answer. */
export const CLEAN_HTML = `<!doctype html>
<html lang="en"><head><title>Clean</title></head>
<body><main><h1>Hand-written</h1><p>No trackers here.</p></main></body></html>`;

/**
 * The common case, with each detection channel represented exactly once: a
 * hydration payload id, a framework attribute, a `<meta name=generator>`, a
 * global name in an inline script, and a named CMP's banner container.
 */
export const TRACKED_HTML = `<!doctype html>
<html lang="en"><head>
<title>Tracked</title>
<meta name="generator" content="WordPress 6.7.1">
<script>window.dataLayer=window.dataLayer||[];dataLayer.push({event:'pv'});</script>
</head>
<body>
<div id="onetrust-banner-sdk" role="dialog">
  <p>We use cookies.</p><button>Accept all</button>
</div>
<div id="app" ng-version="18.2.0"><h1>Buy things</h1></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
</body></html>`;

/** An unnamed banner: the shape most of the web actually ships, where the
 * only signal is a cookie-ish container with a button in it. Paired below with
 * prose that mentions cookies outside any dialog, which must not match. */
export const GENERIC_BANNER_HTML = `<!doctype html>
<html lang="en"><head><title>Recipes</title></head>
<body>
<article><h1>Chocolate cookies</h1><p>Our cookie recipe, refined.</p></article>
<div class="cookie-notice"><span>This site uses cookies.</span>
<button type="button">Got it</button></div>
</body></html>`;

/** Cookie prose and a button, but no banner container — the false positive a
 * text-only heuristic would report. */
export const COOKIE_PROSE_HTML = `<!doctype html>
<html lang="en"><head><title>Recipes</title></head>
<body><article><h1>Cookies</h1><p>Consent to eat this cookie.</p>
<button>Bake</button></article></body></html>`;

/** Third parties across four classifications plus one nobody can name, and a
 * first-party bundle that must stay out of the inventory. */
export const TRACKED_ASSETS: AssetRef[] = [
  script('https://example.com/_next/static/chunks/main-9f2.js'),
  script('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'),
  script('https://cdn.segment.com/analytics.js/v1/abc/analytics.min.js'),
  script('https://js.stripe.com/v3/'),
  script('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js'),
  script('https://widgets.partner.test/embed.js'),
  image('https://www.google-analytics.com/collect?v=2&tid=G-X'),
];

/** Two `Set-Cookie` responses: a first-party session cookie the page's own
 * origin set, and a third-party tracker's. Enough to exercise both party
 * sides, both expiry forms, and every flag. */
export const COOKIE_REQUESTS: RecordedRequest[] = [
  request({
    url: 'https://example.com/api/session',
    at: 250,
    responseHeaders: {
      server: 'cloudflare',
      'set-cookie': [
        'sid=s%3Aabc; Path=/; Expires=Wed, 09 Sep 2026 10:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
        '_ga=GA1.1.1234.5678; Domain=.example.com; Max-Age=63072000; Path=/',
      ].join('\n'),
    },
  }),
  request({
    url: 'https://track.partner.test/px',
    at: 300,
    resourceType: 'image',
    responseHeaders: {
      'set-cookie': '_fbp=fb.1.99; Domain=.partner.test; Max-Age=7776000',
    },
  }),
];
