import { describe, expect, it } from 'vitest';
import { extractVitals } from '../../src/extract/vitals.js';
import type { Warning } from '../../src/ir.js';
import type {
  ExtractorContext,
  VitalsReport,
} from '../../src/extract/types.js';
import type { OverTimePerf } from './fixtures/vitals.js';
import {
  CLS_ABSENT_PERF,
  CLS_ZERO_PERF,
  EVERY_METRIC_PERF,
  FULL_PERF,
  GOOD_BOUNDARY_PERF,
  MALFORMED_PERF,
  NO_INTERACTION_PERF,
  POOR_BOUNDARY_PERF,
  RECORDING,
  vitalsContext,
} from './fixtures/vitals.js';

type Observed = Parameters<typeof vitalsContext>[0];

function run(observed: Observed): {
  report: VitalsReport;
  warnings: Array<Omit<Warning, 'phase'>>;
} {
  const warnings: Array<Omit<Warning, 'phase'>> = [];
  const ctx: ExtractorContext = {
    ...vitalsContext(observed),
    warn: (warning) => warnings.push(warning),
  };
  return { report: extractVitals(ctx), warnings };
}

/** Warnings are matched on the metric name they carry, because the name is
 * the whole contract: an absence nobody can attribute is the gap the warning
 * exists to close. */
function reasons(warnings: Array<Omit<Warning, 'phase'>>): string {
  return warnings.map((w) => `${w.reason} | ${w.detail ?? ''}`).join('\n');
}

describe('extractVitals', () => {
  it('reports not-recorded, with no warning, when nothing was ever armed', () => {
    const { report, warnings } = run({});

    expect(report).toEqual({
      recorded: false,
      largestContentfulPaintMs: null,
      cumulativeLayoutShift: null,
      interactionToNextPaintMs: null,
      ttfbMs: null,
      firstContentfulPaintMs: null,
      // Five nulls, not five 'good's: a session nobody armed measured
      // nothing, and a default-to-the-best-band scheme would report it as a
      // page that measured well.
      ratings: {
        largestContentfulPaint: null,
        cumulativeLayoutShift: null,
        interactionToNextPaint: null,
        ttfb: null,
        firstContentfulPaint: null,
      },
      perf: null,
      unsupportedEntryTypes: [],
    });
    // Nobody was watching is an answer, not a degradation — warning about it
    // would put an entry in every unarmed session's report.
    expect(warnings).toEqual([]);
  });

  it('reports every metric a fully observed page produced', () => {
    const { report, warnings } = run({
      perf: EVERY_METRIC_PERF,
      recording: RECORDING,
    });

    expect(report.recorded).toBe(true);
    expect(report.largestContentfulPaintMs).toBe(2100);
    expect(report.cumulativeLayoutShift).toBe(0.04);
    expect(report.interactionToNextPaintMs).toBe(140);
    expect(report.ttfbMs).toBe(120);
    expect(report.firstContentfulPaintMs).toBe(900);
    expect(report.unsupportedEntryTypes).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('carries the buildPerfReport snapshot whole rather than re-flattening it', () => {
    const { report } = run({ perf: EVERY_METRIC_PERF });

    // The navigation and resource summary is perf.ts's job; this domain adds
    // observation over time and must not restate or diverge from it.
    expect(report.perf).toEqual(FULL_PERF);
    expect(report.perf?.resourceCountByKind).toEqual({ script: 2, img: 1 });
  });

  it('is armed by a recording even when no performance snapshot arrived', () => {
    const { report, warnings } = run({ recording: RECORDING });

    expect(report.recorded).toBe(true);
    expect(report.perf).toBeNull();
    expect(report.largestContentfulPaintMs).toBeNull();
    // One cause, one warning — but it still names each metric it accounts for.
    expect(reasons(warnings)).toMatch(/LCP/);
    expect(reasons(warnings)).toMatch(/CLS/);
    expect(reasons(warnings)).toMatch(/INP/);
  });

  describe('absent is not zero', () => {
    it('reports an observed CLS of 0 as 0, with no warning', () => {
      const { report, warnings } = run({ perf: CLS_ZERO_PERF });

      // A perfectly stable page scores 0. Reporting that as null would throw
      // away the best result the metric can have.
      expect(report.cumulativeLayoutShift).toBe(0);
      expect(report.cumulativeLayoutShift).not.toBeNull();
      expect(warnings).toEqual([]);
    });

    it('reports an unobserved CLS as null, warning with the entry type', () => {
      const { report, warnings } = run({ perf: CLS_ABSENT_PERF });

      expect(report.cumulativeLayoutShift).toBeNull();
      expect(report.cumulativeLayoutShift).not.toBe(0);
      expect(report.unsupportedEntryTypes).toEqual(['layout-shift']);
      expect(warnings).toHaveLength(1);
      expect(reasons(warnings)).toMatch(/CLS/);
      expect(reasons(warnings)).toMatch(/layout-shift/);
    });

    it('reports INP as null when the page ended before an interaction', () => {
      const { report, warnings } = run({ perf: NO_INTERACTION_PERF });

      expect(report.interactionToNextPaintMs).toBeNull();
      expect(report.cumulativeLayoutShift).toBe(0.02);
      expect(warnings).toHaveLength(1);
      expect(reasons(warnings)).toMatch(/INP/);
      // The reader has to be able to tell "nobody clicked" from "responded
      // instantly", so the detail says which this is.
      expect(reasons(warnings)).toMatch(/interaction/i);
    });

    it('treats a NaN or non-numeric metric as absent, not as a value', () => {
      const { report, warnings } = run({ perf: MALFORMED_PERF });

      expect(report.cumulativeLayoutShift).toBeNull();
      expect(report.interactionToNextPaintMs).toBeNull();
      expect(reasons(warnings)).toMatch(/CLS/);
      expect(reasons(warnings)).toMatch(/INP/);
    });
  });

  describe('boundary values round-trip untouched', () => {
    /** The numbers the rating layer reads, asserted separately from the bands
     * it derives: a rating can only be right if the value under it survived
     * untouched. The CLS cases are the ones that would break first — it is a
     * unitless ratio, and the millisecond rounding the other four get would
     * flatten 0.1 to 0 and quietly turn a boundary into a perfect score. */
    const cases: Array<[string, OverTimePerf, number, number]> = [
      ['good/needs-improvement', GOOD_BOUNDARY_PERF, 0.1, 200],
      ['needs-improvement/poor', POOR_BOUNDARY_PERF, 0.25, 500],
    ];

    for (const [name, perf, cls, inp] of cases) {
      it(`keeps a metric sitting on the ${name} boundary`, () => {
        const { report, warnings } = run({ perf });

        expect(report.cumulativeLayoutShift).toBe(cls);
        expect(report.interactionToNextPaintMs).toBe(inp);
        expect(report.largestContentfulPaintMs).toBe(
          perf.largestContentfulPaintMs,
        );
        expect(report.ttfbMs).toBe(perf.ttfbMs);
        expect(report.firstContentfulPaintMs).toBe(perf.firstContentfulPaintMs);
        expect(warnings).toEqual([]);
      });
    }
  });

  it('names every absent metric when the snapshot has none of them', () => {
    const bare: OverTimePerf = {
      ...FULL_PERF,
      ttfbMs: null,
      firstContentfulPaintMs: null,
      largestContentfulPaintMs: null,
    };
    const { report, warnings } = run({ perf: bare });

    expect(report.ttfbMs).toBeNull();
    expect(report.firstContentfulPaintMs).toBeNull();
    expect(report.largestContentfulPaintMs).toBeNull();
    expect(warnings).toHaveLength(5);
    for (const metric of ['LCP', 'CLS', 'INP', 'TTFB', 'FCP']) {
      expect(reasons(warnings)).toMatch(metric);
    }
  });

  describe('ratings', () => {
    it('bands every observed metric', () => {
      const { report } = run({ perf: EVERY_METRIC_PERF });

      // LCP 2100 / CLS 0.04 / INP 140 / TTFB 120 / FCP 900 — all inside the
      // good band on every axis.
      expect(report.ratings).toEqual({
        largestContentfulPaint: 'good',
        cumulativeLayoutShift: 'good',
        interactionToNextPaint: 'good',
        ttfb: 'good',
        firstContentfulPaint: 'good',
      });
    });

    it('rates an unobserved metric null rather than good', () => {
      const { report } = run({ perf: NO_INTERACTION_PERF });

      // The distinction the whole field exists for: nobody interacted, so
      // there is no response latency to score. Calling that 'good' would
      // report an unmeasured page as a fast one.
      expect(report.interactionToNextPaintMs).toBeNull();
      expect(report.ratings?.interactionToNextPaint).toBeNull();
      expect(report.ratings?.interactionToNextPaint).not.toBe('good');
      // A CLS of 0.02 was genuinely observed and does get a band.
      expect(report.ratings?.cumulativeLayoutShift).toBe('good');
    });

    it('rates an observed CLS of 0 good, since 0 is the best score there is', () => {
      const { report } = run({ perf: CLS_ZERO_PERF });

      expect(report.ratings?.cumulativeLayoutShift).toBe('good');
    });

    it('rates a metric the browser could not observe null', () => {
      const { report } = run({ perf: CLS_ABSENT_PERF });

      expect(report.ratings?.cumulativeLayoutShift).toBeNull();
    });

    it('rates a malformed metric null rather than scoring the garbage', () => {
      const { report } = run({ perf: MALFORMED_PERF });

      expect(report.ratings?.cumulativeLayoutShift).toBeNull();
      expect(report.ratings?.interactionToNextPaint).toBeNull();
    });

    it('puts a value exactly on the good boundary in the good band', () => {
      const { report } = run({ perf: GOOD_BOUNDARY_PERF });

      // Both thresholds are inclusive ceilings, matching how web.dev states
      // them ("2.5 seconds or less is good"), so a metric sitting on the
      // boundary lands in the better band. This is the assertion that pins
      // that choice.
      expect(report.ratings).toEqual({
        largestContentfulPaint: 'good',
        cumulativeLayoutShift: 'good',
        interactionToNextPaint: 'good',
        ttfb: 'good',
        firstContentfulPaint: 'good',
      });
    });

    it('puts a value exactly on the poor boundary in needs-improvement', () => {
      const { report } = run({ perf: POOR_BOUNDARY_PERF });

      expect(report.ratings).toEqual({
        largestContentfulPaint: 'needs-improvement',
        cumulativeLayoutShift: 'needs-improvement',
        interactionToNextPaint: 'needs-improvement',
        ttfb: 'needs-improvement',
        firstContentfulPaint: 'needs-improvement',
      });
    });

    it('rates a value past the poor boundary poor', () => {
      const { report } = run({
        perf: {
          ...POOR_BOUNDARY_PERF,
          largestContentfulPaintMs: 4001,
          cumulativeLayoutShift: 0.26,
          interactionToNextPaintMs: 501,
          ttfbMs: 1801,
          firstContentfulPaintMs: 3001,
        },
      });

      expect(report.ratings).toEqual({
        largestContentfulPaint: 'poor',
        cumulativeLayoutShift: 'poor',
        interactionToNextPaint: 'poor',
        ttfb: 'poor',
        firstContentfulPaint: 'poor',
      });
    });
  });

  it('never throws on a hostile observation', () => {
    // The registry's boundary would catch a throw, but it would cost the whole
    // domain — degrading per metric keeps the four good numbers.
    const hostile = { ...FULL_PERF } as unknown as OverTimePerf;
    Object.defineProperty(hostile, 'unsupportedEntryTypes', {
      enumerable: true,
      value: 'layout-shift',
    });
    const { report } = run({ perf: hostile });

    expect(report.recorded).toBe(true);
    expect(report.unsupportedEntryTypes).toEqual([]);
    expect(report.largestContentfulPaintMs).toBe(2100);
  });
});
