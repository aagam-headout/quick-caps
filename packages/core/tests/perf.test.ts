import { describe, expect, it } from 'vitest';
import { buildPerfReport } from '../src/perf.js';

describe('buildPerfReport', () => {
  it('derives TTFB and load timings from navigation timing', () => {
    const report = buildPerfReport({
      navigation: {
        requestStart: 10,
        responseStart: 35,
        domContentLoadedEventEnd: 220,
        loadEventEnd: 480,
      },
    });
    expect(report.ttfbMs).toBe(25);
    expect(report.domContentLoadedMs).toBe(220);
    expect(report.loadMs).toBe(480);
  });

  it('picks first-paint and first-contentful-paint out of the paint entries', () => {
    const report = buildPerfReport({
      paint: [
        { name: 'first-paint', startTime: 120.4 },
        { name: 'first-contentful-paint', startTime: 150.6 },
      ],
    });
    expect(report.firstPaintMs).toBe(120);
    expect(report.firstContentfulPaintMs).toBe(151);
  });

  it('passes largest-contentful-paint through, rounded', () => {
    expect(
      buildPerfReport({ largestContentfulPaintMs: 899.9 })
        .largestContentfulPaintMs,
    ).toBe(900);
  });

  it('sums transfer size and counts resources by initiator type', () => {
    const report = buildPerfReport({
      resources: [
        { initiatorType: 'img', transferSize: 4000 },
        { initiatorType: 'img', transferSize: 6000 },
        { initiatorType: 'script', transferSize: 2000 },
      ],
    });
    expect(report.resourceCount).toBe(3);
    expect(report.resourceCountByKind).toEqual({ img: 2, script: 1 });
    expect(report.transferSizeBytes).toBe(12_000);
  });

  it('includes the navigation entry itself in the transfer size total', () => {
    const report = buildPerfReport({
      navigation: {
        requestStart: 0,
        responseStart: 0,
        domContentLoadedEventEnd: 0,
        loadEventEnd: 0,
        transferSize: 1500,
      },
      resources: [{ initiatorType: 'script', transferSize: 500 }],
    });
    expect(report.transferSizeBytes).toBe(2000);
  });

  describe('the over-time metrics', () => {
    /** CLS, INP, and unsupportedEntryTypes only exist when a host's
     * PerformanceObserver outlived first paint. `PerfReport` names them so
     * `extract/vitals.ts` does not have to widen the type behind its back, and
     * this function's job is to pass them through without inventing any. */
    it('omits all three when the host observed nothing over time', () => {
      const report = buildPerfReport({ largestContentfulPaintMs: 900 });

      // Absent keys, not zeroes and not nulls: a report from a host that only
      // sampled once has to be byte-identical to what it was before these
      // fields existed. Zero would assert a measurement nobody made.
      expect('cumulativeLayoutShift' in report).toBe(false);
      expect('interactionToNextPaintMs' in report).toBe(false);
      expect('unsupportedEntryTypes' in report).toBe(false);
    });

    it('passes CLS through without rounding it', () => {
      // Math.round(0.1) === 0 would conflate the good/needs-improvement
      // boundary with a perfectly stable page. CLS is a unitless ratio whose
      // whole useful range is under 1 and is never rounded.
      expect(
        buildPerfReport({ cumulativeLayoutShift: 0.1 }).cumulativeLayoutShift,
      ).toBe(0.1);
      expect(
        buildPerfReport({ cumulativeLayoutShift: 0.043 }).cumulativeLayoutShift,
      ).toBe(0.043);
    });

    it('keeps an observed CLS of 0, which is the best score not a missing one', () => {
      const report = buildPerfReport({ cumulativeLayoutShift: 0 });

      expect(report.cumulativeLayoutShift).toBe(0);
      expect('cumulativeLayoutShift' in report).toBe(true);
    });

    it('rounds INP, which is milliseconds', () => {
      expect(
        buildPerfReport({ interactionToNextPaintMs: 143.7 })
          .interactionToNextPaintMs,
      ).toBe(144);
    });

    it('carries unsupported entry types through so an absence can be explained', () => {
      expect(
        buildPerfReport({ unsupportedEntryTypes: ['layout-shift', 'event'] })
          .unsupportedEntryTypes,
      ).toEqual(['layout-shift', 'event']);
      // An empty list is a real answer — the browser supported everything —
      // and is different from the field being absent.
      expect(
        buildPerfReport({ unsupportedEntryTypes: [] }).unsupportedEntryTypes,
      ).toEqual([]);
    });
  });

  it('returns nulls rather than NaN or throwing when given nothing', () => {
    const report = buildPerfReport({});
    expect(report.ttfbMs).toBeNull();
    expect(report.domContentLoadedMs).toBeNull();
    expect(report.loadMs).toBeNull();
    expect(report.firstPaintMs).toBeNull();
    expect(report.firstContentfulPaintMs).toBeNull();
    expect(report.largestContentfulPaintMs).toBeNull();
    expect(report.transferSizeBytes).toBeNull();
    expect(report.resourceCount).toBe(0);
    expect(report.resourceCountByKind).toEqual({});
  });
});
