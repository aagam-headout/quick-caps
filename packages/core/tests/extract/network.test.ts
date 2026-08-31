import { describe, expect, it } from 'vitest';
import { extractNetwork } from '../../src/extract/network.js';
import {
  RECORDING_TOTAL_BODY_CAP_BYTES,
  type Recording,
} from '../../src/observe/types.js';
import type { Warning } from '../../src/ir.js';
import type { ExtractContext, NetworkReport } from '../../src/extract/types.js';
import {
  EMPTY_RECORDING,
  MALFORMED_RECORDING,
  NOT_A_LIST_RECORDING,
  UGLY_RECORDING,
  UNREDACTED_RECORDING,
  recordingContext,
  unarmedContext,
} from './fixtures/network.js';

type Run = { report: NetworkReport; warnings: Array<Omit<Warning, 'phase'>> };

function run(base: ExtractContext): Run {
  const warnings: Array<Omit<Warning, 'phase'>> = [];
  const report = extractNetwork({
    ...base,
    warn: (warning) => warnings.push(warning),
  });
  return { report, warnings };
}

function fromRecording(recording: Recording): Run {
  return run(recordingContext(recording));
}

function host(report: NetworkReport, name: string) {
  const found = report.byHost.find((entry) => entry.host === name);
  expect(found, `no summary for ${name}`).toBeDefined();
  return found!;
}

describe('extractNetwork', () => {
  it('reports not-recorded, with no warning, when nobody was watching', () => {
    const { report, warnings } = run(unarmedContext());

    expect(report).toEqual({
      recorded: false,
      requests: [],
      byHost: [],
      skippedByReason: {
        'binary-type': 0,
        'over-cap': 0,
        evicted: 0,
        unreadable: 0,
      },
      totals: {
        requestCount: 0,
        bodiesKept: 0,
        bodyBytes: 0,
        bodyCapBytes: RECORDING_TOTAL_BODY_CAP_BYTES,
        transferSizeBytes: 0,
      },
      containsUnredactedCredentials: false,
    });
    // Not being armed is a choice the caller made, not a problem to report.
    expect(warnings).toEqual([]);
  });

  it('distinguishes an armed-but-quiet page from an unarmed session', () => {
    const armed = fromRecording(EMPTY_RECORDING);
    const unarmed = run(unarmedContext());

    expect(armed.report.recorded).toBe(true);
    expect(unarmed.report.recorded).toBe(false);
    // Every other field agrees, which is exactly why `recorded` has to exist.
    expect({ ...armed.report, recorded: false }).toEqual(unarmed.report);
    expect(armed.warnings).toEqual([]);
  });

  it('carries every recorded request through in observation order', () => {
    const { report, warnings } = fromRecording(UGLY_RECORDING);

    expect(report.requests).toEqual(UGLY_RECORDING.requests);
    expect(report.requests.map((request) => request.at)).toEqual([
      0, 45, 80, 210, 215, 400, 520, 640, 700, 710, 720,
    ]);
    expect(warnings).toEqual([]);
  });

  it('keeps a redirect chain as one entry per hop', () => {
    const { report } = fromRecording(UGLY_RECORDING);
    const chain = report.requests.filter(
      (request) => request.resourceType === 'document',
    );

    expect(chain.map((request) => request.status)).toEqual([301, 302, 200]);
    expect(chain[0]?.responseHeaders.location).toBe(
      'https://www.shop.example/checkout',
    );
    // Three hops, two hosts, and both are named.
    expect(host(report, 'shop.example').statusClasses).toEqual(['3xx']);
    expect(host(report, 'www.shop.example').statusClasses).toEqual([
      '2xx',
      '3xx',
    ]);
  });

  it('surfaces the kept body of an API call the page made', () => {
    const { report } = fromRecording(UGLY_RECORDING);
    const cart = report.requests.find(
      (request) => request.url === 'https://api.shop.example/api/cart',
    );

    expect(cart?.method).toBe('POST');
    expect(cart?.status).toBe(200);
    expect(cart?.body).toEqual({
      kept: true,
      text: '{"cartId":"c_42","items":[{"sku":"widget","qty":2}]}',
      bytes: 1_200,
    });
    // Headers travel whole in both directions — reproducing the call needs
    // the request side, reading the answer needs the response side.
    expect(cart?.requestHeaders['content-type']).toBe('application/json');
    expect(cart?.responseHeaders['content-type']).toBe('application/json');
  });

  it('orders hosts so the API surface leads the asset noise', () => {
    const { report } = fromRecording(UGLY_RECORDING);

    expect(report.byHost.map((entry) => entry.host)).toEqual([
      // Four xhr/fetch/eventsource calls: the API surface, first.
      'api.shop.example',
      // Then by volume, ties broken by name, so the order is stable.
      'cdn.shop.example',
      'www.shop.example',
      'metrics.thirdparty.test',
      'shop.example',
    ]);
  });

  it('rolls up each host request count, transfer size, and status classes', () => {
    const { report } = fromRecording(UGLY_RECORDING);

    expect(host(report, 'api.shop.example')).toEqual({
      host: 'api.shop.example',
      requestCount: 4,
      // The aborted request measured nothing and contributes nothing.
      transferSizeBytes: 92_500,
      statusClasses: ['2xx', '4xx', 'none'],
    });
    expect(host(report, 'cdn.shop.example')).toEqual({
      host: 'cdn.shop.example',
      requestCount: 2,
      transferSizeBytes: 274_000,
      statusClasses: ['2xx'],
    });
  });

  it('leaves a hostless URL out of the per-host rollup without warning', () => {
    const { report, warnings } = fromRecording(UGLY_RECORDING);

    expect(report.requests.some((r) => r.url.startsWith('data:'))).toBe(true);
    expect(report.byHost.map((entry) => entry.host)).not.toContain('');
    expect(
      report.byHost.reduce((sum, entry) => sum + entry.requestCount, 0),
    ).toBe(10);
    expect(warnings).toEqual([]);
  });

  it('counts every skipped body against its reason', () => {
    const { report } = fromRecording(UGLY_RECORDING);

    expect(report.skippedByReason).toEqual({
      'binary-type': 3,
      'over-cap': 1,
      evicted: 1,
      unreadable: 1,
    });
    // Kept plus skipped accounts for every request: an unaccounted body would
    // be a gap the caller cannot see.
    const skipped = Object.values(report.skippedByReason).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(report.totals.bodiesKept + skipped).toBe(report.totals.requestCount);
  });

  it('totals the recording against the cap those bytes were spent on', () => {
    const { report } = fromRecording(UGLY_RECORDING);

    expect(report.totals).toEqual({
      requestCount: 11,
      bodiesKept: 5,
      bodyBytes: 35_226,
      bodyCapBytes: RECORDING_TOTAL_BODY_CAP_BYTES,
      transferSizeBytes: 379_140,
    });
  });

  it('says out loud when the recording carries live credentials', () => {
    const unredacted = fromRecording(UNREDACTED_RECORDING);
    const redacted = fromRecording(UGLY_RECORDING);

    expect(unredacted.report.containsUnredactedCredentials).toBe(true);
    expect(redacted.report.containsUnredactedCredentials).toBe(false);
    // Nothing is scrubbed here: redaction is a record-time concern that
    // already happened, or was declined. Reporting a token as absent when it
    // is present on disk would be the actual danger.
    expect(unredacted.report.requests[0]?.requestHeaders.authorization).toBe(
      'Bearer live-token-xyz',
    );
    expect(unredacted.report.requests[0]?.url).toContain(
      'token=live-token-xyz',
    );
    expect(unredacted.warnings).toEqual([]);
  });

  it('never claims unredacted credentials for a session nobody recorded', () => {
    const { report } = run(unarmedContext());

    expect(report.containsUnredactedCredentials).toBe(false);
  });

  it('degrades a malformed recording through warn instead of throwing', () => {
    const { report, warnings } = fromRecording(MALFORMED_RECORDING);

    // The one well-formed request survives; the broken ones are dropped or
    // bucketed, and each is named.
    expect(report.recorded).toBe(true);
    expect(report.requests.map((request) => request.url)).toEqual([
      'https://ok.example/api/thing',
      'http://exa mple.com/broken',
      'https://ok.example/b',
      'https://ok.example/c',
    ]);
    expect(report.byHost.map((entry) => entry.host)).toEqual(['ok.example']);
    expect(host(report, 'ok.example').requestCount).toBe(3);
    // An unrecognized skip reason and an absent body both land in
    // 'unreadable' rather than vanishing from the accounting.
    expect(report.skippedByReason.unreadable).toBe(2);
    expect(warnings.map((warning) => warning.reason)).toEqual([
      'malformed recorded request',
      'unparseable recorded url',
      'unrecognized body skip reason',
      'recorded request has no body record',
      'kept body bytes disagree with the recording running total',
    ]);
  });

  it('survives a recording whose request list is not a list', () => {
    const { report, warnings } = fromRecording(NOT_A_LIST_RECORDING);

    expect(report.recorded).toBe(true);
    expect(report.requests).toEqual([]);
    expect(report.totals.requestCount).toBe(0);
    expect(warnings.map((warning) => warning.reason)).toEqual([
      'recording has no request list',
    ]);
  });
});
