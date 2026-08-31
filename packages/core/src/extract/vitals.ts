import type { PerfReport } from '../perf.js';
import type {
  ExtractorMap,
  VitalsRating,
  VitalsRatings,
  VitalsReport,
} from './types.js';

/**
 * The five field metrics, read off `ir.perf` and banded against Google's
 * thresholds.
 *
 * `perf.ts` owns normalization and names every field this reads, including the
 * three that only exist when a host's `PerformanceObserver` outlived first
 * paint. This module's job is the reporting layer over them: absence is
 * preserved as absence, each absence is attributed, and nothing is defaulted —
 * a metric nobody measured must never read as a metric that measured well.
 */

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

// ---------------------------------------------------------------------------
// Rating thresholds
//
// Google's published Core Web Vitals boundaries, in one block because they are
// external policy rather than something this codebase decides — and because
// they *will* drift: Google has moved them before (FID gave way to INP
// entirely) and will again. Changing a band is editing one row here.
//
// Each pair is [good ceiling, needs-improvement ceiling]. Both ceilings are
// INCLUSIVE, matching how web.dev states them ("2.5 seconds or less"), so a
// metric sitting exactly on a boundary lands in the *better* band. CLS is in
// ratio units; every other row is milliseconds.
// ---------------------------------------------------------------------------
const RATING_THRESHOLDS: Record<
  MetricLabel,
  [good: number, needsImprovement: number]
> = {
  LCP: [2500, 4000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1800],
  FCP: [1800, 3000],
};

/** A metric that was never observed has no rating. Null rather than 'good',
 * because "we did not measure it" and "it measured well" are the two answers
 * this whole domain exists to keep apart. */
function rate(label: MetricLabel, value: number | null): VitalsRating | null {
  if (value === null) return null;
  const [good, needsImprovement] = RATING_THRESHOLDS[label];
  if (value <= good) return 'good';
  if (value <= needsImprovement) return 'needs-improvement';
  return 'poor';
}

export const extractVitals: ExtractorMap['vitals'] = (ctx) => {
  // `PerfReport` names the over-time fields, so no local widening is needed —
  // but they are still validated below rather than trusted: this IR is JSON
  // read back off a session file, and a host (or a hand edit) can put a string
  // or a NaN where the type promises a number.
  const perf: PerfReport | undefined = ctx.ir.perf;
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
    // Five nulls, not five 'good's: an unarmed session measured nothing, and
    // the ratings field has to say that as plainly as the metrics do.
    ratings: {
      largestContentfulPaint: null,
      cumulativeLayoutShift: null,
      interactionToNextPaint: null,
      ttfb: null,
      firstContentfulPaint: null,
    },
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

  // The one-shot snapshot, field by field. The three over-time fields
  // `PerfReport` now also names are deliberately not restated here: they are
  // top-level on this report, and carrying them twice would let the two copies
  // disagree after validation rejected one of them.
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
  // Rated off the reported numbers rather than the raw ones, so a rating can
  // never disagree with the value printed beside it.
  const ratings: VitalsRatings = {
    largestContentfulPaint: rate('LCP', observed.LCP),
    cumulativeLayoutShift: rate('CLS', observed.CLS),
    interactionToNextPaint: rate('INP', observed.INP),
    ttfb: rate('TTFB', observed.TTFB),
    firstContentfulPaint: rate('FCP', observed.FCP),
  };
  report.ratings = ratings;

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
