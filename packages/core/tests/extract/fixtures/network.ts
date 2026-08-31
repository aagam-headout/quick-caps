import { parseHTML } from 'linkedom';
import type { PageIR } from '../../../src/ir.js';
import type {
  RecordedBody,
  RecordedRequest,
  Recording,
} from '../../../src/observe/types.js';
import { collectFromDocument } from '../../../src/collect.js';
import { defaultSettings } from '../../../src/settings.js';
import type { ExtractContext } from '../../../src/extract/types.js';

/** The document is beside the point here — `network` reads `ir.recording` and
 * never `ctx.doc` — but the context type carries one, so it is the smallest
 * page that still produces a real IR. */
const SHELL_HTML =
  '<!doctype html><html lang="en"><head><title>Checkout</title></head><body><main><p>Checkout.</p></main></body></html>';

function shellIr(): { doc: Document; ir: PageIR } {
  const { document } = parseHTML(SHELL_HTML);
  const doc = document as unknown as Document;
  const ir = collectFromDocument(doc, {
    settings: defaultSettings,
    pageUrl: 'https://www.shop.example/checkout/step-1',
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
  });
  return { doc, ir };
}

/** An unarmed session: no `recording` at all. Nobody was watching. */
export function unarmedContext(): ExtractContext {
  return shellIr();
}

export function recordingContext(recording: Recording): ExtractContext {
  const { doc, ir } = shellIr();
  return { doc, ir: { ...ir, recording } };
}

const STARTED_AT = '2026-08-31T10:00:00.000Z';

/** Armed, and the page was quiet. Distinct from unarmed in exactly one field,
 * which is the point of having both. */
export const EMPTY_RECORDING: Recording = {
  startedAt: STARTED_AT,
  requests: [],
  redacted: true,
  bodyBytes: 0,
};

function req(partial: Partial<RecordedRequest>): RecordedRequest {
  return {
    at: 0,
    method: 'GET',
    url: 'https://www.shop.example/',
    status: 200,
    resourceType: 'other',
    requestHeaders: {},
    responseHeaders: {},
    durationMs: 10,
    transferSizeBytes: 0,
    body: { kept: false, reason: 'binary-type' },
    ...partial,
  };
}

/**
 * One checkout page's traffic, carrying every ugly case at once: a two-hop
 * redirect chain, the page's own JSON API calls buried among CDN assets and a
 * tracking pixel, one body skipped for each of the four reasons, a request
 * that never got a response, and a `data:` URL that has no host to tally.
 *
 * The counts here are asserted directly in the suite, so the numbers below and
 * the expectations there have to be edited together — deliberately, since a
 * fixture whose totals drift silently proves nothing.
 */
export const UGLY_RECORDING: Recording = {
  startedAt: STARTED_AT,
  redacted: true,
  // Sum of the kept bodies below: 0 + 0 + 34_000 + 1_200 + 26.
  bodyBytes: 35_226,
  requests: [
    // Redirect chain, one entry per hop. Collapsing these would hide the very
    // thing a caller reproducing the navigation needs.
    req({
      at: 0,
      url: 'https://shop.example/checkout',
      status: 301,
      resourceType: 'document',
      responseHeaders: {
        location: 'https://www.shop.example/checkout',
        'content-type': 'text/html',
      },
      durationMs: 40,
      transferSizeBytes: 300,
      body: { kept: true, text: '', bytes: 0 },
    }),
    req({
      at: 45,
      url: 'https://www.shop.example/checkout',
      status: 302,
      resourceType: 'document',
      responseHeaders: {
        location: '/checkout/step-1',
        'content-type': 'text/html',
      },
      durationMs: 30,
      transferSizeBytes: 280,
      body: { kept: true, text: '', bytes: 0 },
    }),
    req({
      at: 80,
      url: 'https://www.shop.example/checkout/step-1',
      status: 200,
      resourceType: 'document',
      responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
      durationMs: 120,
      transferSizeBytes: 12_000,
      body: {
        kept: true,
        text: '<!doctype html><html>…</html>',
        bytes: 34_000,
      },
    }),
    // Asset noise, and two of the four skip reasons.
    req({
      at: 210,
      url: 'https://cdn.shop.example/app.abc123.js',
      status: 200,
      resourceType: 'script',
      responseHeaders: { 'content-type': 'application/javascript' },
      durationMs: 220,
      transferSizeBytes: 190_000,
      body: { kept: false, reason: 'over-cap', bytes: 512_000 },
    }),
    req({
      at: 215,
      url: 'https://cdn.shop.example/hero.webp',
      status: 200,
      resourceType: 'image',
      responseHeaders: { 'content-type': 'image/webp' },
      durationMs: 180,
      transferSizeBytes: 84_000,
      body: { kept: false, reason: 'binary-type', bytes: 84_000 },
    }),
    // The request the whole domain exists for.
    req({
      at: 400,
      method: 'POST',
      url: 'https://api.shop.example/api/cart',
      status: 200,
      resourceType: 'xhr',
      requestHeaders: {
        'content-type': 'application/json',
        authorization: '[redacted]',
      },
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 95,
      transferSizeBytes: 1_200,
      body: {
        kept: true,
        text: '{"cartId":"c_42","items":[{"sku":"widget","qty":2}]}',
        bytes: 1_200,
      },
    }),
    req({
      at: 520,
      url: 'https://api.shop.example/api/recommendations?limit=4',
      status: 200,
      resourceType: 'fetch',
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 140,
      transferSizeBytes: 91_000,
      body: { kept: false, reason: 'evicted', bytes: 90_000 },
    }),
    req({
      at: 640,
      method: 'POST',
      url: 'https://api.shop.example/api/cart/apply-coupon',
      status: 422,
      resourceType: 'fetch',
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 60,
      transferSizeBytes: 300,
      body: { kept: true, text: '{"error":"coupon_expired"}', bytes: 26 },
    }),
    // Aborted mid-flight: no status, no duration, nothing measurable.
    req({
      at: 700,
      url: 'https://api.shop.example/api/stream/prices',
      status: null,
      resourceType: 'eventsource',
      durationMs: null,
      transferSizeBytes: null,
      body: { kept: false, reason: 'unreadable' },
    }),
    req({
      at: 710,
      url: 'https://metrics.thirdparty.test/collect?e=pageview',
      status: 204,
      resourceType: 'image',
      durationMs: 25,
      transferSizeBytes: 60,
      body: { kept: false, reason: 'binary-type', bytes: 0 },
    }),
    // A URL with no host at all. Normal, and not a warning.
    req({
      at: 720,
      url: 'data:image/svg+xml,%3Csvg/%3E',
      resourceType: 'image',
      durationMs: 0,
      transferSizeBytes: 0,
      body: { kept: false, reason: 'binary-type', bytes: 0 },
    }),
  ],
};

/** `--no-redact`: the credentials are still live in both a header and a query
 * parameter, which is exactly what the report has to say out loud. */
export const UNREDACTED_RECORDING: Recording = {
  startedAt: STARTED_AT,
  redacted: false,
  bodyBytes: 18,
  requests: [
    req({
      at: 30,
      method: 'POST',
      url: 'https://api.shop.example/api/cart?token=live-token-xyz',
      resourceType: 'xhr',
      requestHeaders: {
        authorization: 'Bearer live-token-xyz',
        cookie: 'sid=live-session',
      },
      responseHeaders: { 'content-type': 'application/json' },
      durationMs: 70,
      transferSizeBytes: 400,
      body: { kept: true, text: '{"cartId":"c_42"}', bytes: 18 },
    }),
  ],
};

/** A recording that came back off disk wrong. The types say this cannot
 * happen; `session.json` is a JSON document a previous version — or a hand
 * edit — could have written, so the extractor is tested against it anyway. */
export const MALFORMED_RECORDING = {
  startedAt: STARTED_AT,
  redacted: true,
  bodyBytes: 999,
  requests: [
    req({ at: 0, url: 'https://ok.example/api/thing', resourceType: 'fetch' }),
    // Not a request object at all.
    null,
    // A URL nothing can parse into a host.
    req({ at: 10, url: 'http://exa mple.com/broken' }),
    // A skip with a reason from no known vocabulary.
    req({
      at: 20,
      url: 'https://ok.example/b',
      body: { kept: false, reason: 'because' } as unknown as RecordedBody,
    }),
    // No body field whatsoever.
    { ...req({ at: 30, url: 'https://ok.example/c' }), body: undefined },
  ],
} as unknown as Recording;

/** `requests` is not a list. The worst shape, and the one that would throw. */
export const NOT_A_LIST_RECORDING = {
  startedAt: STARTED_AT,
  redacted: true,
  bodyBytes: 0,
  requests: { '0': 'nope' },
} as unknown as Recording;
