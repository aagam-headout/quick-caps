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
    /** `VitalsReport` does not model a rating, so these assert the numbers a
     * rating layer would read are reported exactly as observed. The CLS cases
     * are the ones that would break first: it is a unitless ratio, and the
     * millisecond rounding the other four get would flatten 0.1 to 0. */
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
