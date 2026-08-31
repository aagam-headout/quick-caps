import type { Page } from 'playwright';
import {
  fetchAssetBytes,
  type AssetBytes,
  type FetchOptions,
  type PageDriver,
  type Viewport,
} from 'quick-caps-core';
import {
  RECORDABLE_BODY_CONTENT_TYPES,
  RECORDING_BODY_CAP_BYTES,
  RECORDING_TOTAL_BODY_CAP_BYTES,
  redactRequest,
  type RecordedBody,
  type RecordedRequest,
  type Recording,
} from 'quick-caps-core/observe';
import {
  buildPerfReport,
  type PerfReport,
  type RawNavigationTiming,
  type RawPaintEntry,
  type RawResourceTiming,
} from 'quick-caps-core/perf';

/**
 * PageDriver over a live Playwright page. Every core function already proven
 * against FakeDriver runs against this one unchanged — see
 * packages/cli/tests/driver-conformance.ts.
 */
export class PlaywrightDriver implements PageDriver {
  constructor(private readonly page: Page) {}

  async evaluate<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn);
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    // Deliberately the default global fetch, not Playwright's context-bound
    // request API: that API shares the page's cookies and auth state, which
    // would make this the only driver whose asset fetches carry the user's
    // session — fetchAssetBytes's cookieless policy ("A capture must not
    // carry the user's session anywhere") applies the same way here as it
    // does for ChromeDriver and StaticDriver.
    return fetchAssetBytes(url, options);
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    return this.page.screenshot({ fullPage: true, type: 'png' });
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.page.evaluate(([px, py]) => window.scrollTo(px, py), [x, y] as [
      number,
      number,
    ]);
  }

  async viewport(): Promise<Viewport> {
    const size = this.page.viewportSize() ?? { width: 0, height: 0 };
    const metrics = await this.page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
    return { width: size.width, height: size.height, ...metrics };
  }
}

// ---------------------------------------------------------------------------
// Network recording
//
// Listening to `response` events, never `route` interception: a route has to
// fulfil the request itself, which breaks streaming and long-polling and makes
// the observer part of the page's critical path. Listening cannot.
// ---------------------------------------------------------------------------

/**
 * The slice of Playwright's `Request` the recorder reads. Declared here rather
 * than imported so a test can drive the recorder with a fake page — the same
 * reason PageDriver exists at all, and the reason every policy decision below
 * is provable without launching a browser.
 */
export type RecordableRequest = {
  method(): string;
  url(): string;
  resourceType(): string;
  headers(): Record<string, string>;
  timing(): { startTime: number; responseEnd: number };
};

/** The slice of Playwright's `Response` the recorder reads. */
export type RecordableResponse = {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Uint8Array>;
  request(): RecordableRequest;
};

/** Two overloads so a real `Page` satisfies this structurally. */
export type RecordablePage = {
  on(
    event: 'response',
    handler: (response: RecordableResponse) => unknown,
  ): unknown;
  on(
    event: 'requestfailed',
    handler: (request: RecordableRequest) => unknown,
  ): unknown;
};

const decoder = new TextDecoder();

/** Case-insensitive because a header name's case carries no meaning, and
 * Playwright's lowercasing is a detail of Playwright, not a contract. */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** Prefix matching, per RECORDABLE_BODY_CONTENT_TYPES' own reasoning: a real
 * `content-type` carries parameters and vendor suffixes. An absent or empty
 * one is not recordable — nothing claims it is text, and guessing is how a
 * font ends up in the session file. */
function isRecordableContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const normalized = contentType.trim().toLowerCase();
  return RECORDABLE_BODY_CONTENT_TYPES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

function parseContentLength(headers: Record<string, string>): number | null {
  const raw = headerValue(headers, 'content-length');
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Applies the storage policy from `observe/types.ts` to a stream of observed
 * responses, redacting each one as it arrives.
 *
 * Redaction is deliberately at *ingest* rather than on the way out: the
 * recorder never holds an unredacted request beyond the event handler's own
 * stack frame, so there is no state a later bug — an extra debug dump, a
 * second writer, an exception path — could serialize a credential out of.
 * `redactRecording` on the way to disk would also work, but only for the one
 * writer that remembered to call it.
 */
export class NetworkRecorder {
  private readonly startedAtIso = new Date().toISOString();
  private readonly startedAtMs = Date.now();
  private readonly requests: RecordedRequest[] = [];
  /** Body reads are started from Playwright's emitter, which does not await
   * handlers, so `finish` has to know what is still in flight. */
  private readonly pending = new Set<Promise<void>>();
  private keptBodyBytes = 0;

  constructor(private readonly redact: boolean) {}

  /** Records everything knowable synchronously — metadata for every request,
   * always — then reads the body off the emitter's critical path. */
  onResponse(response: RecordableResponse): void {
    let slot: number;
    try {
      slot = this.append(this.describe(response));
    } catch {
      // A response that cannot even be described is dropped rather than
      // thrown: this runs inside Playwright's emitter, where a throw becomes
      // an unhandled error nobody can turn back into a warning.
      return;
    }
    this.track(this.readBody(slot, response));
  }

  /** An aborted request, or one the page navigated away from, is a fact worth
   * keeping — with no status and no readable body. */
  onRequestFailed(request: RecordableRequest): void {
    try {
      this.append({
        at: this.elapsedMs(),
        method: request.method(),
        url: request.url(),
        status: null,
        resourceType: request.resourceType(),
        requestHeaders: request.headers(),
        responseHeaders: {},
        durationMs: null,
        transferSizeBytes: null,
        body: { kept: false, reason: 'unreadable' },
      });
    } catch {
      // Same reason as onResponse.
    }
  }

  /** The recording as it stands, without waiting for bodies still being read.
   * Already redacted, which is the point: there is no unsafe intermediate
   * state to observe. */
  snapshot(): Recording {
    return {
      startedAt: this.startedAtIso,
      requests: [...this.requests],
      redacted: this.redact,
      bodyBytes: this.keptBodyBytes,
    };
  }

  /** The complete recording, once every in-flight body read has settled. */
  async finish(): Promise<Recording> {
    // A settling body read can start no new work, but it can still be racing
    // one that was queued after it — so drain until the set is empty.
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
    return this.snapshot();
  }

  private elapsedMs(): number {
    return Math.max(0, Date.now() - this.startedAtMs);
  }

  private describe(response: RecordableResponse): RecordedRequest {
    const request = response.request();
    const responseHeaders = response.headers();
    return {
      at: this.elapsedMs(),
      method: request.method(),
      // The response's URL, not the request's: after a redirect chain they
      // differ, and each hop is its own recorded entry.
      url: response.url(),
      status: response.status(),
      resourceType: request.resourceType(),
      requestHeaders: request.headers(),
      responseHeaders,
      durationMs: durationOf(request),
      transferSizeBytes: parseContentLength(responseHeaders),
      // Replaced once the body is read; 'unreadable' is the honest state until
      // then, because a browser closing right now is exactly that.
      body: { kept: false, reason: 'unreadable' },
    };
  }

  /** Redaction happens here and nowhere else, so every path into
   * `this.requests` goes through it. Re-running it on an already-redacted
   * record (as `setBody` does) is a no-op: a redacted value's name is still
   * sensitive, so it is replaced with the same marker. */
  private protect(request: RecordedRequest): RecordedRequest {
    return this.redact ? redactRequest(request) : request;
  }

  private append(request: RecordedRequest): number {
    // Pushed synchronously so the array stays in observation order even though
    // bodies resolve out of order — which is also what makes "oldest evicted
    // first" mean what it says.
    this.requests.push(this.protect(request));
    return this.requests.length - 1;
  }

  private setBody(slot: number, body: RecordedBody): void {
    const request = this.requests[slot];
    if (request === undefined) return;
    this.requests[slot] = this.protect({ ...request, body });
  }

  private async readBody(
    slot: number,
    response: RecordableResponse,
  ): Promise<void> {
    const request = this.requests[slot];
    if (request === undefined) return;

    const contentType = headerValue(request.responseHeaders, 'content-type');
    if (!isRecordableContentType(contentType)) {
      this.setBody(slot, {
        kept: false,
        reason: 'binary-type',
        ...(request.transferSizeBytes !== null && {
          bytes: request.transferSizeBytes,
        }),
      });
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = await response.body();
    } catch {
      // Stream already consumed, request aborted, page gone: the error
      // contract says this degrades to a recorded skip.
      this.setBody(slot, { kept: false, reason: 'unreadable' });
      return;
    }

    const size = bytes.byteLength;
    if (size > RECORDING_BODY_CAP_BYTES) {
      this.setBody(slot, { kept: false, reason: 'over-cap', bytes: size });
      return;
    }

    this.setBody(slot, {
      kept: true,
      text: decoder.decode(bytes),
      bytes: size,
    });
    // Charged as observed. Redaction can shorten the text afterwards; it does
    // not give the session budget back, per RecordedBody.bytes.
    this.keptBodyBytes += size;
    this.evictUntilUnderTotalCap();
  }

  /** Oldest kept body first, until the session total is back under the cap.
   * An evicted body keeps saying what it cost — a gap a caller can see. */
  private evictUntilUnderTotalCap(): void {
    for (
      let index = 0;
      index < this.requests.length &&
      this.keptBodyBytes > RECORDING_TOTAL_BODY_CAP_BYTES;
      index += 1
    ) {
      const request = this.requests[index];
      if (request === undefined || !request.body.kept) continue;
      const { bytes } = request.body;
      this.keptBodyBytes -= bytes;
      this.requests[index] = {
        ...request,
        body: { kept: false, reason: 'evicted', bytes },
      };
    }
  }

  private track(task: Promise<void>): void {
    const tracked = task
      .catch(() => undefined)
      .then(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }
}

/** `responseEnd` is relative to `startTime` and is -1 when the browser never
 * measured it. */
function durationOf(request: RecordableRequest): number | null {
  try {
    const { responseEnd } = request.timing();
    return Number.isFinite(responseEnd) && responseEnd >= 0
      ? Math.round(responseEnd)
      : null;
  } catch {
    return null;
  }
}

/**
 * Arms observation on a page. Must be called *before* navigation: a recording
 * cannot be added to a load that already happened, which is why `--record`
 * forces a fresh browser session rather than upgrading one.
 */
export function attachNetworkRecorder(
  page: RecordablePage,
  opts: { redact: boolean },
): NetworkRecorder {
  const recorder = new NetworkRecorder(opts.redact);
  page.on('response', (response) => recorder.onResponse(response));
  page.on('requestfailed', (request) => recorder.onRequestFailed(request));
  return recorder;
}

// ---------------------------------------------------------------------------
// Performance observation
//
// Armed by the same `--record` flag as the network recorder, deliberately not
// a flag of its own: CLS and INP cannot be sampled once. They accumulate, so
// they need a PerformanceObserver installed *before* navigation — which is
// exactly the arming moment `--record` already defines. Reusing it also keeps
// "not recorded" meaning one single thing across all three observed domains
// (network, stack, vitals); a second flag would make an absence ambiguous
// about which observation was missing.
//
// Installed via `addInitScript` rather than `addScriptTag`: a script tag can
// only be added to a page that already exists, by which time first paint and
// every layout shift up to it have already happened unwatched.
// ---------------------------------------------------------------------------

/**
 * The page global the init script accumulates into and the read-back reads out
 * of. A property name on the page's global object rather than a closure or a
 * symbol, because `addInitScript` and `evaluate` are two separate injections
 * with no shared scope — the global is the only place they can meet.
 */
export const PERF_OBSERVATIONS_GLOBAL = '__quickCapsPerfObservations';

/**
 * What the observer accumulated over the page's lifetime.
 *
 * Every metric is `number | null`, and `null` means *nobody observed it* — it
 * is never a stand-in for zero. `extract/vitals.ts` is built entirely on that
 * distinction, so this shape has to preserve it all the way from the page.
 */
export type PerfObservations = {
  /** Unitless ratio, unrounded at every step (`Math.round(0.1) === 0` would
   * flatten a needs-improvement page into a perfect one). 0 here is a real
   * measurement: the observer watched and nothing shifted. */
  cumulativeLayoutShift: number | null;
  /** Null when nothing was interacted with. Absence, not an instant
   * response — a headless load with no input has no INP at all. */
  interactionToNextPaintMs: number | null;
  largestContentfulPaintMs: number | null;
  /** Entry types this browser would not observe, named so an absence above can
   * be explained to the user instead of merely reported. Per the design's
   * error contract: an unsupported entry type is named, not thrown. */
  unsupportedEntryTypes: string[];
};

/**
 * Installs the observer in the page, before any of the page's own script runs.
 *
 * Deliberately self-contained: `addInitScript` serializes this function's
 * source and evaluates it in the page, so nothing it closes over travels with
 * it — hence the inlined entry-type names and the global name arriving as an
 * argument. Exported so its accumulation rules (CLS excludes input-driven
 * shifts, an unsupported type is recorded rather than thrown) are provable in
 * Node against a fake `PerformanceObserver`, with no browser involved.
 */
export function installPerfObserver(globalName: string): void {
  const store: PerfObservations = {
    cumulativeLayoutShift: null,
    interactionToNextPaintMs: null,
    largestContentfulPaintMs: null,
    unsupportedEntryTypes: [],
  };
  (globalThis as unknown as Record<string, unknown>)[globalName] = store;

  const Observer = (
    globalThis as unknown as {
      PerformanceObserver?: typeof PerformanceObserver;
    }
  ).PerformanceObserver;
  if (typeof Observer !== 'function') {
    // No observer at all: every over-time metric is absent, and each one says
    // why rather than leaving the extractor with four unexplained nulls.
    store.unsupportedEntryTypes.push(
      'layout-shift',
      'event',
      'first-input',
      'largest-contentful-paint',
    );
    return;
  }

  /** True iff the browser accepted the subscription. Both ways a browser can
   * decline — a type missing from `supportedEntryTypes`, and an `observe` that
   * throws — end in the same recorded name. */
  const observe = (
    type: string,
    options: { durationThreshold?: number },
    onEntry: (entry: PerformanceEntry) => void,
  ): boolean => {
    const supported = Observer.supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes(type)) {
      store.unsupportedEntryTypes.push(type);
      return false;
    }
    try {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          try {
            onEntry(entry);
          } catch {
            // One malformed entry must not stop the rest of the buffer.
          }
        }
      });
      observer.observe({ type, buffered: true, ...options });
      return true;
    } catch {
      store.unsupportedEntryTypes.push(type);
      return false;
    }
  };

  const clsWatched = observe('layout-shift', {}, (entry) => {
    const shift = entry as PerformanceEntry & {
      value?: number;
      hadRecentInput?: boolean;
    };
    // The standard definition: shifts within 500ms of user input are the
    // user's own doing and are excluded from the score.
    if (shift.hadRecentInput === true) return;
    if (typeof shift.value !== 'number' || !Number.isFinite(shift.value))
      return;
    // Accumulated, never rounded.
    store.cumulativeLayoutShift =
      (store.cumulativeLayoutShift ?? 0) + shift.value;
  });
  if (clsWatched) {
    // The one metric that starts at zero, and only once the browser has
    // accepted the subscription: from here on "nothing shifted" is a
    // measurement that was actually made, which is a different fact from
    // "nobody watched". Written with `??` so it cannot clobber a shift that
    // already arrived.
    store.cumulativeLayoutShift = store.cumulativeLayoutShift ?? 0;
  }

  const onInteraction = (entry: PerformanceEntry): void => {
    const interaction = entry as PerformanceEntry & { interactionId?: number };
    // An `event` entry without an interactionId is not an interaction — it is
    // a stray event, and counting it would invent an INP for a page nobody
    // touched. `first-input` entries carry no interactionId and are always
    // real interactions.
    if (
      entry.entryType === 'event' &&
      !(
        typeof interaction.interactionId === 'number' &&
        interaction.interactionId > 0
      )
    ) {
      return;
    }
    if (!Number.isFinite(entry.duration)) return;
    // The worst interaction on the page, which is what INP reports. Left null
    // until one actually happens.
    store.interactionToNextPaintMs = Math.max(
      store.interactionToNextPaintMs ?? 0,
      entry.duration,
    );
  };
  // `durationThreshold: 16` because the default (104ms) hides most real
  // interactions on a fast page, and an INP that only exists when the page is
  // slow is worse than useless.
  observe('event', { durationThreshold: 16 }, onInteraction);
  observe('first-input', {}, onInteraction);

  observe('largest-contentful-paint', {}, (entry) => {
    // Reports repeatedly as bigger content loads in, each candidate later and
    // larger than the last, so last-wins is the final value — the same rule
    // the extension's readPerfMetrics applies to the buffered entries.
    if (Number.isFinite(entry.startTime)) {
      store.largestContentfulPaintMs = entry.startTime;
    }
  });
}

/** The slice of Playwright's `Page` arming needs — the same narrow-seam habit
 * as RecordablePage, so open.ts's arming path is testable without a browser. */
export type PerfArmablePage = {
  /** `Promise<unknown>`, not `Promise<void>`: Playwright resolves this with a
   * handle for removing the script again, which this never needs. */
  addInitScript(
    script: (globalName: string) => void,
    arg: string,
  ): Promise<unknown>;
};

/**
 * Arms performance observation on a page. Must be called *before* navigation,
 * for the reason in the section comment above. Errors are left to the caller
 * to turn into a warning: a perf snapshot is never worth failing an `open`
 * over.
 */
export async function armPerfObserver(page: PerfArmablePage): Promise<void> {
  await page.addInitScript(installPerfObserver, PERF_OBSERVATIONS_GLOBAL);
}

/** The raw observations, gathered in the page and normalized by core. Kept as
 * plain numbers for the same reason `perf.ts` does: it makes the whole path
 * assertable against fabricated data. */
export type PerfReadout = {
  navigation: RawNavigationTiming | null;
  paint: RawPaintEntry[];
  resources: RawResourceTiming[];
  /** Null when the page was never armed — nothing installed the global. */
  observations: PerfObservations | null;
};

/** The slice of Playwright's `Page` the read-back needs. */
export type PerfReadablePage = {
  evaluate<R>(fn: (globalName: string) => R, arg: string): Promise<R>;
};

/**
 * Reads the one-shot timing entries and the observer's accumulated totals out
 * of the page. Self-contained for the same reason as installPerfObserver: this
 * runs inside the page, serialized by `evaluate`.
 */
export function readPerfSnapshot(globalName: string): PerfReadout {
  const [navigation] = performance.getEntriesByType(
    'navigation',
  ) as PerformanceNavigationTiming[];
  return {
    navigation: navigation
      ? {
          requestStart: navigation.requestStart,
          responseStart: navigation.responseStart,
          domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
          loadEventEnd: navigation.loadEventEnd,
          transferSize: navigation.transferSize,
        }
      : null,
    paint: performance
      .getEntriesByType('paint')
      .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
    resources: (
      performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    ).map((resource) => ({
      initiatorType: resource.initiatorType,
      transferSize: resource.transferSize,
    })),
    observations:
      (globalThis as unknown as Record<string, PerfObservations | undefined>)[
        globalName
      ] ?? null,
  };
}

/** A metric survived the page and a JSON round trip as a real number, or it is
 * absent. A NaN, a string from a hand-edited file, or an undefined is absence
 * — never a zero. */
function observedOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Hands the readout to core's normalizer. Nothing is derived here that
 * `buildPerfReport` already derives.
 *
 * Every over-time field is spread only when it was genuinely observed, because
 * `buildPerfReport` omits from the report exactly what it is not given — so a
 * field this function declines to pass reaches `extract/vitals.ts` as absent
 * rather than as a value nobody measured. The tests are `=== null`, never
 * truthiness: a CLS of 0 is a measurement and must be written as 0.
 */
export function perfReportFrom(readout: PerfReadout): PerfReport {
  const observations = readout.observations;
  const cls = observedOrNull(observations?.cumulativeLayoutShift);
  const inp = observedOrNull(observations?.interactionToNextPaintMs);
  const lcp = observedOrNull(observations?.largestContentfulPaintMs);
  const unsupported = observations?.unsupportedEntryTypes;
  return buildPerfReport({
    ...(readout.navigation === null ? {} : { navigation: readout.navigation }),
    paint: readout.paint,
    resources: readout.resources,
    ...(lcp === null ? {} : { largestContentfulPaintMs: lcp }),
    ...(cls === null ? {} : { cumulativeLayoutShift: cls }),
    ...(inp === null ? {} : { interactionToNextPaintMs: inp }),
    ...(Array.isArray(unsupported)
      ? { unsupportedEntryTypes: unsupported }
      : {}),
  });
}

/** The whole read-after-load half, in one call for open.ts. */
export async function readPerfReport(
  page: PerfReadablePage,
): Promise<PerfReport> {
  return perfReportFrom(
    await page.evaluate(readPerfSnapshot, PERF_OBSERVATIONS_GLOBAL),
  );
}
