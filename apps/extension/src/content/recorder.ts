import type { LogEntry } from 'quick-caps-core';
// Type-only, so nothing from the './observe' subpath reaches this bundle.
import type { RecordedRequest } from 'quick-caps-core/observe';
import {
  FLUSH_EVENT,
  LOGS_ATTRIBUTE,
  OBSERVATIONS_ATTRIBUTE,
} from './protocol.js';

export const RECORDER_KEY = '__pageCaptureRecorder';

export type RecorderTarget = Window & typeof globalThis;

export type RecorderOptions = {
  size: number;
  serialize?: (args: unknown[]) => string;
};

/**
 * The metrics that accumulate, so a single sample at capture time cannot see
 * them - only an observer that was already running can.
 *
 * Every field is optional and none is ever defaulted: absent means nobody
 * observed it, which is a different fact from a measurement of zero. `perf.ts`
 * and `extract/vitals.ts` are built on that distinction, so writing 0 as a
 * placeholder here would report a page nobody measured as a fast one.
 */
export type VitalsObservation = {
  /** Unitless ratio, passed on unrounded: Math.round(0.1) is 0, which is
   * exactly the conflation this field exists to avoid. */
  cumulativeLayoutShift?: number;
  interactionToNextPaintMs?: number;
  largestContentfulPaintMs?: number;
  /** Entry types this browser would not observe, so an absence above can be
   * explained instead of merely reported. */
  unsupportedEntryTypes: string[];
};

/** What the collector reads back across the world boundary, beyond the log
 * ring: everything that needed an observer alive before first paint. */
export type RecorderObservations = {
  /** When observation was armed - document_start, which is as early as a
   * content script can run. */
  startedAt: string;
  requests: RecordedRequest[];
  vitals: VitalsObservation;
};

type Buffer = {
  entries: LogEntry[];
  observations: RecorderObservations;
  installed: true;
};

const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * The entry types worth observing, in the order they are reported. All three
 * only arrive after first paint, which is why they are observed rather than
 * sampled: `layout-shift` and `event` accumulate for the page's whole life,
 * and `largest-contentful-paint` is not returned by getEntriesByType at all in
 * Chrome - a PerformanceObserver is the only way to see it.
 */
const LAYOUT_SHIFT = 'layout-shift';
const EVENT_TIMING = 'event';
const LARGEST_CONTENTFUL_PAINT = 'largest-contentful-paint';
const OBSERVED_ENTRY_TYPES = [
  LAYOUT_SHIFT,
  EVENT_TIMING,
  LARGEST_CONTENTFUL_PAINT,
] as const;

/** Neither entry type is in TypeScript's DOM lib. Every field is optional
 * because these are the browser's objects, not ours. */
type LayoutShiftEntry = { value?: number; hadRecentInput?: boolean };
type EventTimingEntry = { duration?: number; interactionId?: number };
type ObservedEntryList = { getEntries: () => unknown[] };

/** PerformanceObserverInit plus `durationThreshold`, which the event-timing
 * spec defines for the `event` type and TypeScript's DOM lib does not carry. */
type ObserveOptions = PerformanceObserverInit & { durationThreshold?: number };

/** One observed request, in the two shapes the IR wants it: the log ring the
 * "Console + network log" output renders, and the `Recording` the stack and
 * network reports read. */
type ObservedRequest = {
  at: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  size: number | null;
  /** The recorder's own classification, passed through rather than guessed
   * from the URL later - only the patch site knows which API was used. */
  resourceType: 'fetch' | 'xhr';
};

function defaultSerialize(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Patches console, fetch and XMLHttpRequest on `target` to record into a ring
 * buffer, and starts observing the paint/layout metrics that only exist if
 * something was watching before first paint.
 *
 * This must run in the MAIN world: patching the ISOLATED world's console and
 * fetch would observe nothing the page itself does. That means the ISOLATED
 * collector cannot read the buffer directly, so the buffer is flushed into a
 * DOM attribute - shared between worlds - in response to a synchronous event.
 *
 * Two properties matter more than the feature. Every wrapper calls through to
 * the original and returns its value unchanged, and a throw inside the recorder
 * is swallowed. A capture tool that breaks the page it is capturing is worse
 * than one without logs.
 */
export function installRecorder(
  target: RecorderTarget,
  options: RecorderOptions,
): void {
  const holder = target as unknown as Record<string, Buffer | undefined>;
  if (holder[RECORDER_KEY]?.installed) return;

  const buffer: Buffer = {
    entries: [],
    observations: {
      startedAt: new Date().toISOString(),
      requests: [],
      vitals: { unsupportedEntryTypes: [] },
    },
    installed: true,
  };
  Object.defineProperty(target, RECORDER_KEY, {
    value: buffer,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  const serialize = options.serialize ?? defaultSerialize;
  const record = (entry: LogEntry): void => {
    buffer.entries.push(entry);
    if (buffer.entries.length > options.size) buffer.entries.shift();
  };
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* a recorder failure must never reach page code */
    }
  };

  const { observations } = buffer;
  const { vitals } = observations;

  /**
   * Records one request twice: as a `LogEntry` in the ring the log output
   * renders, and as a `RecordedRequest` for the reports that read a
   * `Recording`. Two shapes rather than one derived from the other because the
   * log ring interleaves console and error entries chronologically, and only
   * this call site knows the resource type.
   *
   * Headers are empty maps, not observed ones. `Set-Cookie` is never exposed
   * to page JavaScript, and reading what is exposed would buy the reports
   * almost nothing for a real widening of what this recorder touches. No body
   * is ever read: bodies are CLI-only by decision, because reading one here
   * would mean chrome.debugger.
   */
  const recordRequest = (observed: ObservedRequest): void => {
    record({
      kind: 'request',
      at: observed.at,
      method: observed.method,
      url: observed.url,
      status: observed.status,
      durationMs: observed.durationMs,
      // Method, url, status, timing, size. Never a body: a capture tool
      // has no business recording what the page posted.
      size: observed.size,
    });
    observations.requests.push({
      at: observed.at,
      method: observed.method,
      url: observed.url,
      status: observed.status,
      resourceType: observed.resourceType,
      requestHeaders: {},
      responseHeaders: {},
      // Null for a request that never completed, per RecordedRequest: a
      // duration measured up to a failure is not a response time.
      durationMs: observed.status === null ? null : observed.durationMs,
      transferSizeBytes: observed.size,
      body: { kept: false, reason: 'unreadable' },
    });
    if (observations.requests.length > options.size) {
      observations.requests.shift();
    }
  };

  // Installed before anything else is patched, and from a content script that
  // the manifest runs at document_start in the MAIN world - the earliest point
  // available to an extension, before any page script has run. It has to be:
  // an observer created after first paint silently misses every entry that
  // arrived before it, and `buffered: true` only backfills what the browser
  // kept. Everything below can wait; this cannot.
  observeVitals(target, vitals, safely);

  const console_ = target.console as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  for (const level of CONSOLE_LEVELS) {
    const original = console_[level];
    if (typeof original !== 'function') continue;
    console_[level] = (...args: unknown[]) => {
      safely(() =>
        record({
          kind: 'console',
          level,
          at: Date.now(),
          text: serialize(args),
        }),
      );
      return original.apply(target.console, args);
    };
  }

  const originalFetch = target.fetch;
  if (typeof originalFetch === 'function') {
    target.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const started = Date.now();
      const url = typeof input === 'string' ? input : String(input);
      const method = init?.method ?? 'GET';
      try {
        const response = await originalFetch.call(target, input, init);
        safely(() =>
          recordRequest({
            at: started,
            method,
            url,
            status: response.status,
            durationMs: Date.now() - started,
            size: Number(response.headers.get('content-length')) || null,
            resourceType: 'fetch',
          }),
        );
        return response;
      } catch (error) {
        safely(() =>
          recordRequest({
            at: started,
            method,
            url,
            status: null,
            durationMs: Date.now() - started,
            size: null,
            resourceType: 'fetch',
          }),
        );
        throw error;
      }
    };
  }

  const OriginalXhr = target.XMLHttpRequest;
  if (typeof OriginalXhr === 'function') {
    /**
     * XMLHttpRequest, which fetch patching alone never saw - still how most
     * older analytics and plenty of frameworks talk to a backend, so an
     * XHR-only page had an empty network log until now.
     *
     * A subclass rather than a prototype patch: page code holding
     * XMLHttpRequest.prototype.send still gets the untouched original, and
     * `super` keeps every unobserved member (upload, responseType, timeouts)
     * working without enumerating it.
     */
    class RecordingXhr extends OriginalXhr {
      private pcMethod = 'GET';
      private pcUrl = '';
      private pcStartedAt = 0;

      constructor() {
        super();
        // 'loadend' is the one event that fires for load, error, abort and
        // timeout alike, so a single listener covers every outcome. Attached
        // in the constructor, not in send(), so a reused object that sends
        // twice records twice rather than accumulating listeners.
        this.addEventListener('loadend', () => {
          safely(() =>
            recordRequest({
              at: this.pcStartedAt,
              method: this.pcMethod,
              url: this.pcUrl,
              // status is 0 for an abort, a timeout, and a network error.
              // Recorded as null: absent is not a status of zero.
              status: this.status === 0 ? null : this.status,
              durationMs: Date.now() - this.pcStartedAt,
              size: Number(this.getResponseHeader('content-length')) || null,
              resourceType: 'xhr',
            }),
          );
        });
      }

      override open(
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ): void {
        safely(() => {
          this.pcMethod = method;
          this.pcUrl = String(url);
        });
        // Spread through untouched: the async/user/password tail is optional
        // and its absence is meaningful (open with 2 args is synchronous).
        (super.open as (...args: unknown[]) => void)(method, url, ...rest);
      }

      override send(body?: Document | XMLHttpRequestBodyInit | null): void {
        safely(() => {
          this.pcStartedAt = Date.now();
        });
        super.send(body);
      }
    }
    target.XMLHttpRequest = RecordingXhr;
  }

  if (typeof target.addEventListener === 'function') {
    target.addEventListener('error', (event: ErrorEvent) => {
      safely(() =>
        record({
          kind: 'error',
          at: Date.now(),
          message: event.message,
          ...(event.error instanceof Error && event.error.stack
            ? { stack: event.error.stack }
            : {}),
        }),
      );
    });
    target.addEventListener(
      'unhandledrejection',
      (event: PromiseRejectionEvent) => {
        safely(() =>
          record({
            kind: 'error',
            at: Date.now(),
            message: String(event.reason),
          }),
        );
      },
    );
  }

  // The cross-world handoff. Synchronous, so the collector can dispatch and
  // read in the same turn.
  target.document.addEventListener(FLUSH_EVENT, () => {
    safely(() => {
      target.document.documentElement.setAttribute(
        LOGS_ATTRIBUTE,
        JSON.stringify(buffer.entries),
      );
      target.document.documentElement.setAttribute(
        OBSERVATIONS_ATTRIBUTE,
        JSON.stringify(observations),
      );
    });
  });
}

/**
 * Registers one PerformanceObserver per over-time entry type.
 *
 * Absence is the default in every branch: a field is written only once an
 * entry for it actually arrived, so an unobserved metric stays missing rather
 * than reading as zero. A type the browser will not observe - no
 * PerformanceObserver at all, a type outside `supportedEntryTypes`, or an
 * observe() that throws - is named in `unsupportedEntryTypes` instead, which is
 * how `extract/vitals.ts` tells "the browser cannot measure this" apart from
 * "nothing happened".
 */
function observeVitals(
  target: RecorderTarget,
  vitals: VitalsObservation,
  safely: (fn: () => void) => void,
): void {
  const Observer = target.PerformanceObserver;
  if (typeof Observer !== 'function') {
    vitals.unsupportedEntryTypes.push(...OBSERVED_ENTRY_TYPES);
    return;
  }

  const supported = Observer.supportedEntryTypes as string[] | undefined;
  const observe = (
    type: string,
    init: ObserveOptions,
    handle: (entries: unknown[]) => void,
  ): void => {
    // Asked before observing, because observe() with an unsupported `type` is
    // a no-op in the spec rather than a throw - the browser would simply never
    // call back, and the absence would look like a quiet page.
    if (supported !== undefined && !supported.includes(type)) {
      vitals.unsupportedEntryTypes.push(type);
      return;
    }
    try {
      const observer = new Observer((list: ObservedEntryList) =>
        safely(() => handle(list.getEntries())),
      );
      // buffered: true backfills the entries the browser kept from before this
      // ran. It is a safety net, not the plan - the plan is running at
      // document_start.
      observer.observe({
        type,
        buffered: true,
        ...init,
      } as PerformanceObserverInit);
    } catch {
      vitals.unsupportedEntryTypes.push(type);
    }
  };

  // CLS: the sum of layout shifts *excluding* those following a recent input,
  // per the standard definition - a shift the user caused by tapping is not
  // instability. Assigned after each batch rather than initialized to 0, so a
  // page whose every shift had recent input reports a genuine 0 while a page
  // nobody observed reports nothing at all.
  let layoutShiftTotal = 0;
  observe(LAYOUT_SHIFT, {}, (entries) => {
    for (const entry of entries as LayoutShiftEntry[]) {
      if (entry.hadRecentInput === true) continue;
      if (typeof entry.value !== 'number') continue;
      layoutShiftTotal += entry.value;
    }
    vitals.cumulativeLayoutShift = layoutShiftTotal;
  });

  // INP: the latency of the worst interaction. web-vitals takes a high
  // percentile once there are dozens of interactions; the worst one is that
  // same number for the handful a capture ever sees, and erring towards the
  // slower interaction is the safe direction for a diagnostic.
  //
  // An entry without an interactionId is not an interaction, so a page nobody
  // touched leaves this absent - which is the common case for a popup-driven
  // capture, and is not an INP of zero.
  observe(EVENT_TIMING, { durationThreshold: 16 }, (entries) => {
    let worst = -1;
    for (const entry of entries as EventTimingEntry[]) {
      if (typeof entry.interactionId !== 'number') continue;
      if (entry.interactionId === 0) continue;
      if (typeof entry.duration !== 'number') continue;
      if (entry.duration > worst) worst = entry.duration;
    }
    if (worst >= 0) vitals.interactionToNextPaintMs = worst;
  });

  // LCP reports again every time a bigger element paints, so the last entry
  // observed is the final value.
  observe(LARGEST_CONTENTFUL_PAINT, {}, (entries) => {
    const last = entries[entries.length - 1] as
      { startTime?: number } | undefined;
    if (typeof last?.startTime === 'number') {
      vitals.largestContentfulPaintMs = last.startTime;
    }
  });
}
