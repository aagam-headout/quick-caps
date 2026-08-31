import type { PerfReport } from '../perf.js';
import type { ExtractorMap, VitalsReport } from './types.js';

/**
 * The over-time half of the field metrics, read as a widening over
 * `PerfReport` rather than as fields on it. `perf.ts` normalizes the one-shot
 * snapshot — navigation, paint, LCP, transfer size, resources — and stays
 * that: CLS and INP cannot be sampled once, they accumulate, so they reach
 * core only from a host whose `PerformanceObserver` outlived first paint. The
 * IR this reads is JSON off a session file, which can carry fields core's own
 * type does not yet spell out, so every one of them is validated below rather
 * than trusted.
 */
type ObservedOverTime = {
  cumulativeLayoutShift?: unknown;
  interactionToNextPaintMs?: unknown;
  unsupportedEntryTypes?: unknown;
};

/**
 * Which `PerformanceObserver` entry type each metric depends on, so an absence
 * the browser explained can be reported as explained. Names are the spec's own
 * entry-type strings, which is what a host puts in `unsupportedEntryTypes`.
 */
const ENTRY_TYPE_BY_METRIC = {
  LCP: 'largest-contentful-paint',
  CLS: 'layout-shift',
  INP: 'event',
  TTFB: 'navigation',
  FCP: 'paint',
} as const;

type MetricLabel = keyof typeof ENTRY_TYPE_BY_METRIC;

/** Why a metric is missing when the browser did support its entry type. Static
 * per metric because the cause is a property of the metric: three of these
 * settle at load and two need something to happen first. */
const ABSENCE_DETAIL: Record<MetricLabel, string> = {
  LCP: 'no largest-contentful-paint entry was reported before the page ended',
  CLS: 'no layout-shift total was reported — absence, not a shift score of 0',
  INP: 'no interaction was measured, so there is no response latency to report — absence, not an instant response',
  TTFB: 'no navigation timing entry reached the report',
  FCP: 'no first-contentful-paint entry was reported',
};

/** A metric is a number or it is nothing. NaN survives a JSON round trip as
 * null but not an arithmetic mishap in a host, and a hand-edited session file
 * can put a string here; both are absence, never a zero. */
function metricOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Milliseconds are rounded; CLS deliberately is not — it is a unitless ratio
 * whose entire useful range is under 1, and rounding would flatten every
 * score to 0. */
function msOrNull(value: unknown): number | null {
  const metric = metricOrNull(value);
  return metric === null ? null : Math.round(metric);
}

export const extractVitals: ExtractorMap['vitals'] = (ctx) => {
  const perf: (PerfReport & ObservedOverTime) | undefined = ctx.ir.perf;
  const armed = perf !== undefined || ctx.ir.recording !== undefined;

  const report: VitalsReport = {
    // `perf` and `recording` are the observations this domain derives from, so
    // both being absent is its "nobody was watching". Either one present means
    // the host was armed, and a missing metric is then a fact about the page
    // rather than a fact about the session.
    recorded: armed,
    largestContentfulPaintMs: null,
    cumulativeLayoutShift: null,
    interactionToNextPaintMs: null,
    ttfbMs: null,
    firstContentfulPaintMs: null,
    perf: null,
    unsupportedEntryTypes: [],
  };
  if (!armed) return report;

  if (perf === undefined) {
    // Armed to watch the network but no timing snapshot arrived — one cause,
    // so one warning, still naming each metric it accounts for rather than
    // leaving five nulls unexplained.
    ctx.warn({
      reason: 'no timing observed: LCP, CLS, INP, TTFB, FCP all absent',
      detail:
        'the session was armed but carries no performance snapshot, so none of the five metrics has a value',
    });
    return report;
  }

  const unsupported = Array.isArray(perf.unsupportedEntryTypes)
    ? perf.unsupportedEntryTypes.filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];

  report.perf = {
    ttfbMs: perf.ttfbMs,
    domContentLoadedMs: perf.domContentLoadedMs,
    loadMs: perf.loadMs,
    firstPaintMs: perf.firstPaintMs,
    firstContentfulPaintMs: perf.firstContentfulPaintMs,
    largestContentfulPaintMs: perf.largestContentfulPaintMs,
    transferSizeBytes: perf.transferSizeBytes,
    resourceCount: perf.resourceCount,
    resourceCountByKind: perf.resourceCountByKind,
  };
  report.unsupportedEntryTypes = unsupported;
  report.largestContentfulPaintMs = msOrNull(perf.largestContentfulPaintMs);
  report.cumulativeLayoutShift = metricOrNull(perf.cumulativeLayoutShift);
  report.interactionToNextPaintMs = msOrNull(perf.interactionToNextPaintMs);
  report.ttfbMs = msOrNull(perf.ttfbMs);
  report.firstContentfulPaintMs = msOrNull(perf.firstContentfulPaintMs);

  const observed: Record<MetricLabel, number | null> = {
    LCP: report.largestContentfulPaintMs,
    CLS: report.cumulativeLayoutShift,
    INP: report.interactionToNextPaintMs,
    TTFB: report.ttfbMs,
    FCP: report.firstContentfulPaintMs,
  };
  for (const [label, value] of Object.entries(observed) as Array<
    [MetricLabel, number | null]
  >) {
    if (value !== null) continue;
    const entryType = ENTRY_TYPE_BY_METRIC[label];
    ctx.warn({
      reason: `no ${label} observed`,
      detail: unsupported.includes(entryType)
        ? `the browser does not support the ${entryType} entry type`
        : ABSENCE_DETAIL[label],
    });
  }

  return report;
};
