import { describe, expect, it } from 'vitest';
import { extractStack } from '../../src/extract/stack.js';
import { REDACTED } from '../../src/observe/redact.js';
import type { Warning } from '../../src/ir.js';
import type {
  DetectedTechnology,
  StackReport,
} from '../../src/extract/types.js';
import {
  CLEAN_HTML,
  COOKIE_PROSE_HTML,
  COOKIE_REQUESTS,
  GENERIC_BANNER_HTML,
  TRACKED_ASSETS,
  TRACKED_HTML,
  image,
  recording,
  request,
  requestLog,
  script,
  stackContext,
} from './fixtures/stack.js';

type Input = Parameters<typeof stackContext>[0];

function run(input: Input): {
  report: StackReport;
  warnings: Omit<Warning, 'phase'>[];
} {
  const { ctx, warnings } = stackContext(input);
  return { report: extractStack(ctx), warnings };
}

/** Detections are asserted by name because the category and evidence are the
 * interesting part of the row, and a name lookup keeps the assertion readable
 * when a fixture carries eight of them. */
function tech(report: StackReport, name: string): DetectedTechnology {
  const matches = report.technologies.filter((row) => row.name === name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('extractStack — the three states', () => {
  it('reports not-recorded and empty for an unarmed session with nothing to find', () => {
    const { report, warnings } = run({ html: CLEAN_HTML });

    expect(report).toEqual({
      recorded: false,
      technologies: [],
      thirdPartyHosts: [],
      cookies: { cookies: [], includesHttpOnly: false },
      consentBanner: { present: false },
    });
    expect(warnings).toEqual([]);
  });

  it('reports recorded and empty when the host was armed and saw nothing', () => {
    const { report, warnings } = run({
      html: CLEAN_HTML,
      recording: recording({ requests: [] }),
    });

    expect(report.recorded).toBe(true);
    expect(report.technologies).toEqual([]);
    expect(report.thirdPartyHosts).toEqual([]);
    expect(report.cookies).toEqual({ cookies: [], includesHttpOnly: false });
    expect(warnings).toEqual([]);
  });

  it('detects, classifies, and finds the banner with no recording at all', () => {
    const { report, warnings } = run({
      html: TRACKED_HTML,
      assets: TRACKED_ASSETS,
    });

    // Everything except cookies and response headers is markup and asset
    // evidence, so being unarmed costs the caller none of it.
    expect(report.recorded).toBe(false);
    expect(report.technologies.length).toBeGreaterThan(5);
    expect(report.thirdPartyHosts.length).toBeGreaterThan(3);
    expect(report.consentBanner.present).toBe(true);
    // Cookies are the one field that genuinely needs the recording, and an
    // unarmed session is the caller's choice rather than a fault.
    expect(report.cookies).toEqual({ cookies: [], includesHttpOnly: false });
    expect(warnings).toEqual([]);
  });
});

describe('extractStack — technology detection', () => {
  it('names a technology per category from script URLs and asset hosts', () => {
    const { report } = run({ html: CLEAN_HTML, assets: TRACKED_ASSETS });

    expect(tech(report, 'Next.js')).toMatchObject({
      category: 'framework',
      evidence: 'script-url',
      matched: 'https://example.com/_next/static/chunks/main-9f2.js',
    });
    expect(tech(report, 'Google Tag Manager').category).toBe('tag-manager');
    expect(tech(report, 'Segment').category).toBe('analytics');
    expect(tech(report, 'Stripe').category).toBe('payment');
    expect(tech(report, 'jsDelivr').category).toBe('cdn');
    // A tracking pixel is not a script, and reporting it as a script URL
    // would misdescribe the evidence.
    expect(tech(report, 'Google Analytics').evidence).toBe('asset-host');
  });

  it('reads the framework off markup the page ships with no assets recorded', () => {
    const { report } = run({ html: TRACKED_HTML });

    expect(tech(report, 'Next.js').evidence).toBe('global-name');
    expect(tech(report, 'Next.js').matched).toBe('__NEXT_DATA__');
    expect(tech(report, 'Angular')).toMatchObject({
      category: 'framework',
      evidence: 'global-name',
    });
    // One meta covers every generator-declaring CMS at once; the version is
    // kept as the matched text but must not become part of the name.
    expect(tech(report, 'WordPress')).toMatchObject({
      category: 'framework',
      matched: 'WordPress 6.7.1',
    });
    expect(tech(report, 'Google Tag Manager').matched).toBe('dataLayer');
  });

  it('keeps one row per technology, preferring the URL that names it', () => {
    const { report } = run({ html: TRACKED_HTML, assets: TRACKED_ASSETS });

    // TRACKED_HTML alone detects GTM by its global and Next.js by its payload
    // id; the assets name both by URL, which is the stronger evidence.
    expect(tech(report, 'Google Tag Manager').evidence).toBe('script-url');
    expect(tech(report, 'Next.js').evidence).toBe('script-url');
  });

  it('detects a CDN from response headers, which need the recording', () => {
    const armed = run({
      html: CLEAN_HTML,
      recording: recording({ requests: COOKIE_REQUESTS }),
    });

    expect(tech(armed.report, 'Cloudflare')).toMatchObject({
      category: 'cdn',
      evidence: 'response-header',
      matched: 'server: cloudflare',
    });

    // The same page unarmed cannot see a header, and says nothing rather than
    // guessing.
    const unarmed = run({ html: CLEAN_HTML });
    expect(unarmed.report.technologies).toEqual([]);
  });

  it('detects a tracker from the cookie it sets when nothing else names it', () => {
    const { report } = run({
      html: CLEAN_HTML,
      recording: recording({ requests: COOKIE_REQUESTS }),
    });

    expect(tech(report, 'Meta Pixel')).toMatchObject({
      category: 'ad-network',
      evidence: 'cookie',
      matched: '_fbp',
    });
  });

  it('reports nothing for a host no signature covers', () => {
    const { report } = run({
      html: CLEAN_HTML,
      assets: [script('https://widgets.partner.test/embed.js')],
    });

    expect(report.technologies).toEqual([]);
    expect(report.thirdPartyHosts).toEqual([
      {
        host: 'widgets.partner.test',
        requestCount: 1,
        classification: 'unknown',
      },
    ]);
  });
});

describe('extractStack — third-party hosts', () => {
  it('classifies each host from what was detected on it, and skips first party', () => {
    const { report } = run({ html: CLEAN_HTML, assets: TRACKED_ASSETS });
    const byHost = Object.fromEntries(
      report.thirdPartyHosts.map((host) => [host.host, host.classification]),
    );

    expect(byHost).toEqual({
      'www.googletagmanager.com': 'tracker',
      'cdn.segment.com': 'tracker',
      'www.google-analytics.com': 'tracker',
      'cdn.jsdelivr.net': 'cdn',
      'js.stripe.com': 'functional',
      'widgets.partner.test': 'unknown',
    });
  });

  it('treats a sibling subdomain of the page as first party', () => {
    const { report } = run({
      html: CLEAN_HTML,
      pageUrl: 'https://shop.example.com/cart',
      assets: [
        script('https://static.example.com/app.js'),
        script('https://cdn.jsdelivr.net/npm/x/x.js'),
      ],
    });

    expect(report.thirdPartyHosts.map((host) => host.host)).toEqual([
      'cdn.jsdelivr.net',
    ]);
  });

  it('counts recorded requests where there are some, references otherwise', () => {
    const { report } = run({
      html: CLEAN_HTML,
      assets: [
        script('https://cdn.jsdelivr.net/npm/a/a.js'),
        script('https://widgets.partner.test/embed.js'),
      ],
      logs: [requestLog('https://widgets.partner.test/config.json')],
      recording: recording({
        requests: [
          request({ url: 'https://cdn.jsdelivr.net/npm/a/a.js' }),
          request({ url: 'https://cdn.jsdelivr.net/npm/b/b.js' }),
          request({ url: 'https://cdn.jsdelivr.net/npm/c/c.js' }),
        ],
      }),
    });
    const counts = Object.fromEntries(
      report.thirdPartyHosts.map((host) => [host.host, host.requestCount]),
    );

    expect(counts).toEqual({
      'cdn.jsdelivr.net': 3,
      // Never requested during the window, but referenced twice — a reference
      // is a request the page makes, and zero would read as "not used".
      'widgets.partner.test': 2,
    });
  });

  it('degrades on a URL it cannot parse instead of throwing', () => {
    const { report, warnings } = run({
      html: CLEAN_HTML,
      assets: [
        script('not a url at all'),
        image('data:image/gif;base64,R0lGOD'),
        script('https://cdn.jsdelivr.net/npm/a/a.js'),
      ],
    });

    expect(report.thirdPartyHosts.map((host) => host.host)).toEqual([
      'cdn.jsdelivr.net',
    ]);
    expect(warnings).toEqual([]);
  });
});

describe('extractStack — cookies', () => {
  it('inventories both parties, both expiry forms, and every flag', () => {
    const { report, warnings } = run({
      html: CLEAN_HTML,
      recording: recording({ requests: COOKIE_REQUESTS }),
    });

    expect(report.cookies.cookies).toEqual([
      {
        name: 'sid',
        domain: 'example.com',
        expires: '2026-09-09T10:00:00.000Z',
        firstParty: true,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      },
      {
        name: '_ga',
        domain: 'example.com',
        // Max-Age is relative to when the response arrived, which is the
        // recording's start plus the request's offset.
        expires: '2028-08-30T10:00:00.250Z',
        firstParty: true,
        httpOnly: false,
        secure: false,
      },
      {
        name: '_fbp',
        domain: 'partner.test',
        expires: '2026-11-29T10:00:00.300Z',
        firstParty: false,
        httpOnly: false,
        secure: false,
      },
    ]);
    // Set-Cookie carries the flag, so this inventory really does see HttpOnly.
    expect(report.cookies.includesHttpOnly).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('keeps a session cookie without inventing an expiry for it', () => {
    const { report } = run({
      html: CLEAN_HTML,
      recording: recording({
        requests: [
          request({
            url: 'https://example.com/api/ping',
            responseHeaders: {
              'set-cookie': 'csrf=xyz; Path=/; SameSite=Strict',
            },
          }),
        ],
      }),
    });

    expect(report.cookies.cookies).toEqual([
      {
        name: 'csrf',
        domain: 'example.com',
        firstParty: true,
        httpOnly: false,
        secure: false,
        sameSite: 'strict',
      },
    ]);
  });

  it('reports the last value when the same cookie is set twice', () => {
    const { report } = run({
      html: CLEAN_HTML,
      recording: recording({
        requests: [
          request({
            url: 'https://example.com/a',
            responseHeaders: { 'set-cookie': 'sid=one; Path=/' },
          }),
          request({
            url: 'https://example.com/b',
            responseHeaders: { 'set-cookie': 'sid=two; Path=/; HttpOnly' },
          }),
        ],
      }),
    });

    expect(report.cookies.cookies).toHaveLength(1);
    expect(report.cookies.cookies[0]?.httpOnly).toBe(true);
  });

  it('says the inventory is partial when redaction removed the header', () => {
    const { report, warnings } = run({
      html: CLEAN_HTML,
      recording: recording({
        redacted: true,
        requests: [
          request({
            url: 'https://example.com/api/session',
            responseHeaders: { 'set-cookie': REDACTED, server: 'cloudflare' },
          }),
        ],
      }),
    });

    expect(report.recorded).toBe(true);
    expect(report.cookies).toEqual({ cookies: [], includesHttpOnly: false });
    // A cookie that was there and could not be read is a degradation, unlike
    // an unarmed session — so this one warns.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.reason).toContain('cookie');
    // The rest of the report is unaffected by the redaction.
    expect(tech(report, 'Cloudflare').category).toBe('cdn');
  });

  it('does not warn about cookies when nobody was watching', () => {
    const { report, warnings } = run({ html: TRACKED_HTML });

    expect(report.cookies.includesHttpOnly).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe('extractStack — consent banner', () => {
  it('names the CMP when a known one is on the page', () => {
    const { report } = run({ html: TRACKED_HTML });

    expect(report.consentBanner).toEqual({
      present: true,
      matched: 'OneTrust',
    });
  });

  it('reports an unnamed banner by the selector that hit', () => {
    const { report } = run({ html: GENERIC_BANNER_HTML });

    expect(report.consentBanner.present).toBe(true);
    expect(report.consentBanner.matched).toContain('cookie-notice');
  });

  it('does not call cookie prose a banner', () => {
    const { report } = run({ html: COOKIE_PROSE_HTML });

    expect(report.consentBanner).toEqual({ present: false });
  });
});
