import {
  RECORDING_TOTAL_BODY_CAP_BYTES,
  type BodySkipReason,
  type RecordedRequest,
} from '../observe/types.js';
import type {
  ExtractorMap,
  NetworkHostSummary,
  NetworkReport,
} from './types.js';

/** The four reasons a body can be absent, as a lookup so a reason arriving off
 * disk from a future — or older — writer can be recognized rather than
 * trusted. A `Recording` is JSON that a previous version of this tool wrote. */
const SKIP_REASONS: Record<BodySkipReason, true> = {
  'binary-type': true,
  'over-cap': true,
  evicted: true,
  unreadable: true,
};

/**
 * Resource types that mean "the page called an API", as opposed to fetching
 * something to render. This is the host's own classification passed through,
 * so the set is small and named: Playwright and the extension's recorder both
 * emit these, and neither invents a type outside its documented list.
 *
 * A websocket or an SSE stream belongs here for the same reason an xhr does —
 * it is the page talking to a backend, not loading an asset.
 */
const API_RESOURCE_TYPES = new Set([
  'xhr',
  'fetch',
  'eventsource',
  'websocket',
]);

/** Status class for the per-host rollup. 'none' for a request that never got a
 * response, which sorts last under a plain lexicographic sort — a letter after
 * every digit — so the classes need no custom comparator. */
function statusClass(status: number | null): string {
  return typeof status === 'number' && Number.isFinite(status)
    ? `${Math.floor(status / 100)}xx`
    : 'none';
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Per-host accumulator. `apiRequestCount` never reaches the report — it only
 * decides the host order, which is where the report says which host is the
 * page's backend and which is a CDN. */
type HostAccumulator = NetworkHostSummary & { apiRequestCount: number };

/**
 * The API surface behind a page: what it asked the network for and what came
 * back. Reads `ir.recording`, never `ctx.doc` — a serialized DOM has no record
 * of a request, so this domain exists only when a host was armed.
 *
 * Three states, not two. An absent recording is `recorded: false` and warns
 * about nothing: not arming is a choice the caller made. A present recording
 * with no requests is `recorded: true` and empty, which is the honest answer to
 * a quiet page. Anything malformed in between degrades through `warn`, because
 * a recording is JSON read back off disk and losing the whole domain over one
 * bad entry would throw away the traffic that did parse.
 *
 * Nothing here redacts anything. Redaction happens at record time so a
 * credential never reaches disk on the default path; by the time a report is
 * derived the decision is already made, and scrubbing here would only make
 * `containsUnredactedCredentials` a lie about what the session file holds.
 */
export const extractNetwork: ExtractorMap['network'] = (ctx) => {
  const recording = ctx.ir.recording;
  const requests: RecordedRequest[] = [];
  const skippedByReason: Record<BodySkipReason, number> = {
    'binary-type': 0,
    'over-cap': 0,
    evicted: 0,
    unreadable: 0,
  };
  const report: NetworkReport = {
    // Absent recording means nobody was watching. Reported as not-recorded
    // rather than as an empty recording, because a caller acts differently on
    // "re-open with --record" than on "this page made no requests".
    recorded: recording !== undefined,
    requests,
    byHost: [],
    skippedByReason,
    totals: {
      requestCount: 0,
      bodiesKept: 0,
      bodyBytes: 0,
      bodyCapBytes: RECORDING_TOTAL_BODY_CAP_BYTES,
      transferSizeBytes: 0,
    },
    containsUnredactedCredentials:
      recording !== undefined && !recording.redacted,
  };
  if (recording === undefined) return report;

  if (!Array.isArray(recording.requests)) {
    // Armed, so `recorded` stays true — the observation happened, the record
    // of it did not survive. Saying "not recorded" here would blame the caller
    // for a file this tool wrote.
    ctx.warn({
      reason: 'recording has no request list',
      detail: `expected an array, found ${typeof recording.requests}`,
    });
    return report;
  }

  const hosts = new Map<string, HostAccumulator>();
  let bodiesKept = 0;
  let bodyBytes = 0;
  let transferSizeBytes = 0;

  for (const request of recording.requests) {
    if (request === null || typeof request !== 'object') {
      ctx.warn({
        reason: 'malformed recorded request',
        detail: `dropped a ${request === null ? 'null' : typeof request} entry from the request list`,
      });
      continue;
    }
    // Kept whole and in observation order, including the entries below that
    // fail to yield a host: a request the page made is a fact even when the
    // rollup cannot place it.
    requests.push(request);
    transferSizeBytes += finiteOrZero(request.transferSizeBytes);

    const body = request.body;
    if (body === null || typeof body !== 'object') {
      // Not silently dropped: an unaccounted body is a gap the caller cannot
      // see, and 'unreadable' is the bucket the error contract already gives
      // to a body that could not be obtained.
      skippedByReason.unreadable += 1;
      ctx.warn({
        url: request.url,
        reason: 'recorded request has no body record',
        detail: 'counted as an unreadable skip',
      });
    } else if (body.kept) {
      bodiesKept += 1;
      bodyBytes += finiteOrZero(body.bytes);
    } else if (body.reason in SKIP_REASONS) {
      skippedByReason[body.reason] += 1;
    } else {
      skippedByReason.unreadable += 1;
      ctx.warn({
        url: request.url,
        reason: 'unrecognized body skip reason',
        detail: `${String(body.reason)} — counted as an unreadable skip`,
      });
    }

    let host: string;
    try {
      host = new URL(request.url).host;
    } catch {
      // A recorded URL that will not parse is a broken record, not a broken
      // page: the browser resolved it once already.
      ctx.warn({
        url: request.url,
        reason: 'unparseable recorded url',
        detail: 'excluded from the per-host summary',
      });
      continue;
    }
    // Empty for data:, blob:, and about: URLs. Normal, and not a warning —
    // there is simply no host to tally.
    if (host === '') continue;

    const entry = hosts.get(host) ?? {
      host,
      requestCount: 0,
      transferSizeBytes: 0,
      statusClasses: [],
      apiRequestCount: 0,
    };
    entry.requestCount += 1;
    entry.transferSizeBytes += finiteOrZero(request.transferSizeBytes);
    const seen = statusClass(request.status);
    if (!entry.statusClasses.includes(seen)) entry.statusClasses.push(seen);
    if (API_RESOURCE_TYPES.has(request.resourceType)) {
      entry.apiRequestCount += 1;
    }
    hosts.set(host, entry);
  }

  /**
   * Hosts the page called as an API come first, then hosts by volume, ties
   * broken by name so the order never depends on Map insertion. This ordering
   * is the report's answer to "which of these forty hosts is the backend":
   * `requests` is pinned to observation order, where a `POST /api/cart` sits
   * buried between a font and a tracking pixel, and the host list is the one
   * place the report gets to say what matters first.
   */
  report.byHost = [...hosts.values()]
    .sort(
      (a, b) =>
        b.apiRequestCount - a.apiRequestCount ||
        b.requestCount - a.requestCount ||
        a.host.localeCompare(b.host),
    )
    .map((entry) => ({
      host: entry.host,
      requestCount: entry.requestCount,
      transferSizeBytes: entry.transferSizeBytes,
      statusClasses: [...entry.statusClasses].sort(),
    }));

  report.totals = {
    requestCount: requests.length,
    bodiesKept,
    // Summed from the bodies actually carried rather than trusting
    // `recording.bodyBytes`: the report has to describe the requests in it.
    bodyBytes,
    bodyCapBytes: RECORDING_TOTAL_BODY_CAP_BYTES,
    transferSizeBytes,
  };
  // The host maintains a running total so it can enforce the cap in constant
  // time; if it disagrees with the bodies present, the cap accounting drifted
  // and a reader deserves to know which number they are holding.
  if (
    Number.isFinite(recording.bodyBytes) &&
    recording.bodyBytes !== bodyBytes
  ) {
    ctx.warn({
      reason: 'kept body bytes disagree with the recording running total',
      detail: `bodies present sum to ${bodyBytes}, recording claims ${recording.bodyBytes}; reporting the sum`,
    });
  }

  return report;
};
