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
