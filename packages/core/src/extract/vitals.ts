import type { ExtractorMap, VitalsReport } from './types.js';

/**
 * The field metrics, over the snapshot `buildPerfReport` already normalizes.
 * Reads `ir.perf` rather than `ctx.doc`: LCP, CLS, and INP only arrive after
 * load, so they need a collector that stayed alive past first paint — and a
 * session collected without one has no honest answer, only a null.
 *
 * TODO(vitals): implemented separately per spec. The shape below is final;
 * what is missing is the widened observation `ir.perf` will carry.
 */
export const extractVitals: ExtractorMap['vitals'] = (ctx) => {
  const perf = ctx.ir.perf;
  const empty: VitalsReport = {
    // `perf` is the observation this domain derives from, so its absence is
    // this domain's "nobody was watching" — the same distinction network
    // draws from `recording`.
    recorded: perf !== undefined,
    largestContentfulPaintMs: null,
    cumulativeLayoutShift: null,
    interactionToNextPaintMs: null,
    ttfbMs: null,
    firstContentfulPaintMs: null,
    perf: null,
    unsupportedEntryTypes: [],
  };
  return empty;
};
