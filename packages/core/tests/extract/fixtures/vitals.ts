import { parseHTML } from 'linkedom';
import { collectFromDocument } from '../../../src/collect.js';
import { defaultSettings } from '../../../src/settings.js';
import type { PerfReport } from '../../../src/perf.js';
import type { Recording } from '../../../src/observe/types.js';
import type { ExtractContext } from '../../../src/extract/types.js';

/** The document is irrelevant to this domain — vitals reads `ir.perf` and
 * `ir.recording` only — so it stays as small as a collectable page can be.
 * Anything richer would suggest the DOM feeds the report, which it must not. */
const PAGE_HTML = `<!doctype html>
<html lang="en"><head><title>Vitals</title></head><body><main><p>x</p></main></body></html>`;

/**
 * A one-shot snapshot in the shape `buildPerfReport` returns it. Only the
 * three metrics that survive a single sample are populated by default; the
 * over-time pair is layered on per fixture, because the whole point of this
 * domain is that those two arrive separately or not at all.
 */
export const FULL_PERF: PerfReport = {
  ttfbMs: 120,
  domContentLoadedMs: 850,
  loadMs: 1400,
  firstPaintMs: 700,
  firstContentfulPaintMs: 900,
  largestContentfulPaintMs: 2100,
  transferSizeBytes: 512_000,
  resourceCount: 3,
  resourceCountByKind: { script: 2, img: 1 },
};

/**
 * The metrics that only exist once something observed the page past first
 * paint. Written as a partial widening over `PerfReport` rather than as fields
 * on it: `perf.ts` normalizes the one-shot snapshot and is not this domain's
 * to change, and the IR these fixtures stand in for is JSON read back off
 * disk, which can carry more than core's own type spells out.
 */
export type OverTimePerf = PerfReport & {
  cumulativeLayoutShift?: number | null;
  interactionToNextPaintMs?: number | null;
  unsupportedEntryTypes?: string[];
};

/** Every metric present, all five in the good band. */
export const EVERY_METRIC_PERF: OverTimePerf = {
  ...FULL_PERF,
  cumulativeLayoutShift: 0.04,
  interactionToNextPaintMs: 140,
};

/**
 * The distinction that matters most in this whole domain: a layout shift
 * observer that ran and saw a perfectly stable page. Zero is an excellent
 * score, not missing data.
 */
export const CLS_ZERO_PERF: OverTimePerf = {
  ...FULL_PERF,
  cumulativeLayoutShift: 0,
  interactionToNextPaintMs: 90,
};

/** Armed, INP settled, but the browser never supported `layout-shift`, so CLS
 * is absent with a reason rather than absent silently. */
export const CLS_ABSENT_PERF: OverTimePerf = {
  ...FULL_PERF,
  interactionToNextPaintMs: 90,
  unsupportedEntryTypes: ['layout-shift'],
};

/**
 * Values sitting exactly on Google's published good/needs-improvement and
 * needs-improvement/poor boundaries. Ratings are not modelled by
 * `VitalsReport`, so these exist to pin that a boundary value round-trips
 * untouched — in particular that a CLS of 0.1 is not rounded to 0.
 */
export const GOOD_BOUNDARY_PERF: OverTimePerf = {
  ...FULL_PERF,
  ttfbMs: 800,
  firstContentfulPaintMs: 1800,
  largestContentfulPaintMs: 2500,
  cumulativeLayoutShift: 0.1,
  interactionToNextPaintMs: 200,
};

export const POOR_BOUNDARY_PERF: OverTimePerf = {
  ...FULL_PERF,
  ttfbMs: 1800,
  firstContentfulPaintMs: 3000,
  largestContentfulPaintMs: 4000,
  cumulativeLayoutShift: 0.25,
  interactionToNextPaintMs: 500,
};

/**
 * A page closed before anyone touched it. The layout-shift observer reported
 * a real total; INP has no value because there was no interaction to measure —
 * which is not an INP of zero, and reporting it as one would claim the page
 * responded instantly.
 */
export const NO_INTERACTION_PERF: OverTimePerf = {
  ...FULL_PERF,
  cumulativeLayoutShift: 0.02,
};

/** A host that wrote nonsense into a metric slot — NaN out of an arithmetic
 * mishap, a string out of a hand-edited session file. Neither is a value. */
export const MALFORMED_PERF: OverTimePerf = {
  ...FULL_PERF,
  cumulativeLayoutShift: Number.NaN,
  interactionToNextPaintMs: 'fast' as unknown as number,
};

export const RECORDING: Recording = {
  startedAt: '2026-08-31T10:00:00.000Z',
  requests: [],
  redacted: true,
  bodyBytes: 0,
};

/** A context with the observation fields set exactly as asked, so a test can
 * express "armed by recording alone" and "never armed" as literally as it
 * expresses a full report. */
export function vitalsContext(observed: {
  perf?: OverTimePerf;
  recording?: Recording;
}): ExtractContext {
  const { document } = parseHTML(PAGE_HTML);
  // linkedom has no layout engine and buildRegions measures every element, so
  // the rect is faked the way tests/fake-driver.ts fakes it.
  for (const el of document.querySelectorAll('*')) {
    Object.defineProperty(el, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        width: 800,
        height: 40,
        top: 0,
        left: 0,
        right: 800,
        bottom: 40,
      }),
    });
  }
  const doc = document as unknown as Document;
  const ir = collectFromDocument(doc, {
    settings: defaultSettings,
    pageUrl: 'https://example.test/',
    userAgent: 'test-agent',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1,
    now: () => new Date('2026-08-31T10:00:00.000Z'),
  });
  // Spread conditionally rather than assigning undefined: under
  // exactOptionalPropertyTypes an absent field and a field set to undefined are
  // different types, and "never armed" is exactly the absent case.
  return {
    doc,
    ir: {
      ...ir,
      ...(observed.perf ? { perf: observed.perf } : {}),
      ...(observed.recording ? { recording: observed.recording } : {}),
    },
  };
}
