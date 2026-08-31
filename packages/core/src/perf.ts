/**
 * Derives a lightweight performance snapshot from the browser's own
 * Navigation/Paint/Resource Timing entries — not a Lighthouse audit (no
 * scoring, no simulated network/CPU throttling), just the numbers the page
 * already recorded about its own load.
 */

export type PerfReport = {
  ttfbMs: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  largestContentfulPaintMs: number | null;
  transferSizeBytes: number | null;
  resourceCount: number;
  resourceCountByKind: Record<string, number>;
  // -------------------------------------------------------------------------
  // Observed over time. The three below cannot be sampled once: they
  // accumulate, so they only exist when a host's PerformanceObserver outlived
  // first paint. Optional rather than nullable, and never defaulted — absent
  // means nobody watched long enough, which is a different fact from a value
  // of zero, and `extract/vitals.ts` is built entirely on that distinction.
  // -------------------------------------------------------------------------
  /**
   * Cumulative Layout Shift. A unitless ratio whose whole useful range is
   * under 1, so it is *never* rounded anywhere in this codebase:
   * `Math.round(0.1) === 0` conflates the good/needs-improvement boundary
   * with a perfectly stable page.
   */
  cumulativeLayoutShift?: number | null;
  /** Interaction to Next Paint, in milliseconds. Absent when nothing was
   * interacted with — which is not an INP of zero, and must never be reported
   * as an instant response. */
  interactionToNextPaintMs?: number | null;
  /** PerformanceObserver entry types the browser did not support, so an
   * absence above can be explained instead of merely reported. This is how a
   * degradation reaches the user: the design's contract is that an
   * unsupported entry type is named, not thrown. */
  unsupportedEntryTypes?: string[];
};

/** The subset of PerformanceNavigationTiming this cares about, as plain
 * numbers so this module has no DOM lib dependency and stays testable with
 * fabricated data. */
export type RawNavigationTiming = {
  requestStart: number;
  responseStart: number;
  domContentLoadedEventEnd: number;
  loadEventEnd: number;
  transferSize?: number;
};

export type RawPaintEntry = { name: string; startTime: number };

export type RawResourceTiming = {
  initiatorType: string;
  transferSize?: number;
};

export type BuildPerfReportInput = {
  navigation?: RawNavigationTiming;
  paint?: RawPaintEntry[];
  /** Read separately from `paint` — Chrome exposes it as its own entry type,
   * `largest-contentful-paint`, and it can fire more than once as bigger
   * content loads in; the caller passes the last value observed. */
  largestContentfulPaintMs?: number;
  resources?: RawResourceTiming[];
  /** The over-time observations, passed straight through. A host that only
   * sampled once omits them, and the report then omits them too — see
   * `buildPerfReport`. */
  cumulativeLayoutShift?: number;
  interactionToNextPaintMs?: number;
  unsupportedEntryTypes?: string[];
};

function roundOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : null;
}

export function buildPerfReport(input: BuildPerfReportInput): PerfReport {
  const navigation = input.navigation;
  const paint = input.paint ?? [];
  const resources = input.resources ?? [];

  const firstPaint = paint.find(
    (entry) => entry.name === 'first-paint',
  )?.startTime;
  const firstContentfulPaint = paint.find(
    (entry) => entry.name === 'first-contentful-paint',
  )?.startTime;

  const resourceCountByKind: Record<string, number> = {};
  let transferSizeBytes = 0;
  let hasTransferSize = false;
  for (const resource of resources) {
    const kind = resource.initiatorType || 'other';
    resourceCountByKind[kind] = (resourceCountByKind[kind] ?? 0) + 1;
    if (typeof resource.transferSize === 'number') {
      transferSizeBytes += resource.transferSize;
      hasTransferSize = true;
    }
  }
  if (typeof navigation?.transferSize === 'number') {
    transferSizeBytes += navigation.transferSize;
    hasTransferSize = true;
  }

  return {
    ttfbMs: navigation
      ? roundOrNull(navigation.responseStart - navigation.requestStart)
      : null,
    domContentLoadedMs: navigation
      ? roundOrNull(navigation.domContentLoadedEventEnd)
      : null,
    loadMs: navigation ? roundOrNull(navigation.loadEventEnd) : null,
    firstPaintMs: roundOrNull(firstPaint),
    firstContentfulPaintMs: roundOrNull(firstContentfulPaint),
    largestContentfulPaintMs: roundOrNull(input.largestContentfulPaintMs),
    transferSizeBytes: hasTransferSize ? Math.round(transferSizeBytes) : null,
    resourceCount: resources.length,
    resourceCountByKind,
    // Spread conditionally rather than assigned: a caller that observed
    // nothing over time gets a report with these keys absent, byte-identical
    // to what this function returned before they existed. Assigning
    // `undefined` would also fail exactOptionalPropertyTypes, and defaulting
    // to 0 would assert a measurement nobody made. CLS is passed through
    // unrounded on purpose — see PerfReport.
    ...(input.cumulativeLayoutShift === undefined
      ? {}
      : { cumulativeLayoutShift: input.cumulativeLayoutShift }),
    ...(input.interactionToNextPaintMs === undefined
      ? {}
      : {
          interactionToNextPaintMs: roundOrNull(input.interactionToNextPaintMs),
        }),
    ...(input.unsupportedEntryTypes === undefined
      ? {}
      : { unsupportedEntryTypes: input.unsupportedEntryTypes }),
  };
}
