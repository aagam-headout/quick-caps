import { afterEach, describe, expect, it } from 'vitest';
import {
  PERF_OBSERVATIONS_GLOBAL,
  armPerfObserver,
  installPerfObserver,
  perfReportFrom,
  readPerfReport,
  readPerfSnapshot,
  type PerfObservations,
  type PerfReadout,
} from '../src/drivers/playwright-driver.js';

/**
 * The observer is driven through the same seam PageDriver/FakeDriver and the
 * network recorder established: `installPerfObserver` is a self-contained
 * function over `globalThis.PerformanceObserver`, so every accumulation rule —
 * CLS excluding input-driven shifts, an unsupported entry type being *named*
 * rather than thrown, INP staying absent until something is interacted with —
 * is provable in Node with no browser. The real-browser assertions (that a
 * shifting page produces a non-zero CLS end to end) live in
 * vitals-recording.test.ts, where a chromium instance already exists.
 *
 * Every assertion here is about the same property: absent is never zero.
 */

type FakeEntry = {
  entryType: string;
  startTime: number;
  duration: number;
  value?: number;
  hadRecentInput?: boolean;
  interactionId?: number;
};

type Subscription = { type: string; emit: (entries: FakeEntry[]) => void };

type Env = {
  subscriptions: Subscription[];
  /** Emits to every observer watching `type`; returns how many got it, so a
   * test cannot silently assert on an entry nobody was subscribed for. */
  emit: (type: string, entries: Partial<FakeEntry>[]) => number;
  store: () => PerfObservations;
};

const GLOBAL_KEY = PERF_OBSERVATIONS_GLOBAL;

function host(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/** Installs a fake `PerformanceObserver`, runs the real init script against
 * it, and hands back the subscriptions it made. */
function install(
  opts: { supported?: string[]; throwOn?: string[]; missing?: boolean } = {},
): Env {
  const subscriptions: Subscription[] = [];
  const throwOn = opts.throwOn ?? [];

  if (opts.missing === true) {
    delete host()['PerformanceObserver'];
  } else {
    class FakeObserver {
      static supportedEntryTypes =
        opts.supported ??
        ([
          'layout-shift',
          'event',
          'first-input',
          'largest-contentful-paint',
          'paint',
        ] as string[]);

      constructor(
        private readonly callback: (list: {
          getEntries: () => FakeEntry[];
        }) => void,
      ) {}

      observe(init: { type: string }): void {
        if (throwOn.includes(init.type)) {
          throw new TypeError(`cannot observe ${init.type}`);
        }
        subscriptions.push({
          type: init.type,
          emit: (entries) => this.callback({ getEntries: () => entries }),
        });
      }

      disconnect(): void {}
    }
    host()['PerformanceObserver'] = FakeObserver;
  }

  installPerfObserver(GLOBAL_KEY);

  return {
    subscriptions,
    emit: (type, entries) => {
      const filled: FakeEntry[] = entries.map((entry) => ({
        entryType: type,
        startTime: 0,
        duration: 0,
        ...entry,
      }));
      const targets = subscriptions.filter((sub) => sub.type === type);
      for (const target of targets) target.emit(filled);
      return targets.length;
    },
    store: () => host()[GLOBAL_KEY] as PerfObservations,
  };
}

const savedObserver = host()['PerformanceObserver'];

afterEach(() => {
  delete host()[GLOBAL_KEY];
  if (savedObserver === undefined) {
    delete host()['PerformanceObserver'];
  } else {
    host()['PerformanceObserver'] = savedObserver;
  }
});

describe('installPerfObserver', () => {
  it('subscribes before anything happens, and starts with nothing but a watched CLS', () => {
    const env = install();
    expect(env.subscriptions.map((sub) => sub.type)).toEqual([
      'layout-shift',
      'event',
      'first-input',
      'largest-contentful-paint',
    ]);
    // CLS is the one field that starts at a real 0: the browser accepted the
    // subscription, so "nothing shifted" is a measurement that was made.
    expect(env.store().cumulativeLayoutShift).toBe(0);
    // The rest are absent, and that is the whole point — a page nobody
    // interacted with has no INP, and no paint has happened yet.
    expect(env.store().interactionToNextPaintMs).toBeNull();
    expect(env.store().largestContentfulPaintMs).toBeNull();
    expect(env.store().unsupportedEntryTypes).toEqual([]);
  });

  it('accumulates layout-shift values and never rounds them', () => {
    const env = install();
    expect(env.emit('layout-shift', [{ value: 0.05 }, { value: 0.02 }])).toBe(
      1,
    );
    env.emit('layout-shift', [{ value: 0.01 }]);
    // 0.08, not 0 — `Math.round` anywhere on this path would report a
    // needs-improvement page as perfectly stable.
    expect(env.store().cumulativeLayoutShift).toBeCloseTo(0.08, 10);
  });

  it('excludes shifts that followed user input, per the standard definition', () => {
    const env = install();
    env.emit('layout-shift', [
      { value: 0.4, hadRecentInput: true },
      { value: 0.03, hadRecentInput: false },
    ]);
    expect(env.store().cumulativeLayoutShift).toBeCloseTo(0.03, 10);
  });

  it('ignores a layout-shift entry with no usable value rather than counting it as zero', () => {
    const env = install();
    env.emit('layout-shift', [{ value: Number.NaN }, {}]);
    expect(env.store().cumulativeLayoutShift).toBe(0);
  });

  it('names an entry type the browser does not support instead of throwing', () => {
    const env = install({
      supported: ['event', 'first-input', 'largest-contentful-paint'],
    });
    expect(env.store().unsupportedEntryTypes).toEqual(['layout-shift']);
    // Unsupported is absent, not zero: nobody watched, so there is no score.
    expect(env.store().cumulativeLayoutShift).toBeNull();
  });

  it('names a type whose observe() throws, which is the other way a browser declines', () => {
    const env = install({ throwOn: ['layout-shift', 'event'] });
    expect(env.store().unsupportedEntryTypes).toEqual([
      'layout-shift',
      'event',
    ]);
    expect(env.store().cumulativeLayoutShift).toBeNull();
    expect(env.store().interactionToNextPaintMs).toBeNull();
  });

  it('names every entry type when the browser has no PerformanceObserver at all', () => {
    const env = install({ missing: true });
    expect(env.store().unsupportedEntryTypes).toEqual([
      'layout-shift',
      'event',
      'first-input',
      'largest-contentful-paint',
    ]);
    expect(env.store().cumulativeLayoutShift).toBeNull();
    expect(env.store().largestContentfulPaintMs).toBeNull();
  });

  it('takes the worst interaction latency as INP, and only from real interactions', () => {
    const env = install();
    env.emit('event', [
      // No interactionId: a stray event, not an interaction. Counting it would
      // invent an INP for a page nobody touched.
      { duration: 900, interactionId: 0 },
    ]);
    expect(env.store().interactionToNextPaintMs).toBeNull();

    env.emit('event', [
      { duration: 40, interactionId: 7 },
      { duration: 120, interactionId: 8 },
    ]);
    expect(env.store().interactionToNextPaintMs).toBe(120);

    // `first-input` carries no interactionId and is always a real interaction.
    env.emit('first-input', [{ duration: 200 }]);
    expect(env.store().interactionToNextPaintMs).toBe(200);
  });

  it('takes the last largest-contentful-paint candidate as the final LCP', () => {
    const env = install();
    env.emit('largest-contentful-paint', [{ startTime: 120 }]);
    env.emit('largest-contentful-paint', [{ startTime: 480 }]);
    expect(env.store().largestContentfulPaintMs).toBe(480);
  });

  it('survives an entry that makes the accumulator throw', () => {
    const env = install();
    const hostile = {
      entryType: 'layout-shift',
      startTime: 0,
      duration: 0,
      get hadRecentInput(): boolean {
        throw new Error('hostile entry');
      },
    };
    const subscription = env.subscriptions.find(
      (sub) => sub.type === 'layout-shift',
    );
    expect(subscription).toBeDefined();
    const healthy: FakeEntry = {
      entryType: 'layout-shift',
      startTime: 0,
      duration: 0,
      hadRecentInput: false,
      value: 0.2,
    };
    subscription?.emit([hostile as unknown as FakeEntry, healthy]);
    expect(env.store().cumulativeLayoutShift).toBeCloseTo(0.2, 10);
  });
});

describe('armPerfObserver', () => {
  it('installs the script before navigation, with the global name as its argument', async () => {
    const calls: { script: unknown; arg: string }[] = [];
    await armPerfObserver({
      addInitScript: async (script, arg) => {
        calls.push({ script, arg });
        return undefined;
      },
    });
    expect(calls).toHaveLength(1);
    // addInitScript, not addScriptTag: a script tag can only be added to a
    // page that already exists, by which time first paint and every shift up
    // to it happened unwatched.
    expect(calls[0]?.script).toBe(installPerfObserver);
    expect(calls[0]?.arg).toBe(PERF_OBSERVATIONS_GLOBAL);
  });
});

describe('readPerfSnapshot', () => {
  it('reports observations as absent when the page was never armed', () => {
    delete host()[GLOBAL_KEY];
    expect(readPerfSnapshot(GLOBAL_KEY).observations).toBeNull();
  });

  it('reads back exactly what the observer accumulated', () => {
    const env = install();
    env.emit('layout-shift', [{ value: 0.25 }]);
    expect(readPerfSnapshot(GLOBAL_KEY).observations).toEqual(env.store());
  });
});

// ---------------------------------------------------------------------------
// The write site: what reaches `ir.perf`
// ---------------------------------------------------------------------------

function readout(observations: PerfObservations | null): PerfReadout {
  return {
    navigation: {
      requestStart: 10,
      responseStart: 60,
      domContentLoadedEventEnd: 300,
      loadEventEnd: 500,
      transferSize: 2_048,
    },
    paint: [{ name: 'first-contentful-paint', startTime: 210 }],
    resources: [{ initiatorType: 'script', transferSize: 1_024 }],
    observations,
  };
}

function observed(partial: Partial<PerfObservations>): PerfObservations {
  return {
    cumulativeLayoutShift: null,
    interactionToNextPaintMs: null,
    largestContentfulPaintMs: null,
    unsupportedEntryTypes: [],
    ...partial,
  };
}

describe('perfReportFrom', () => {
  it('omits every over-time field when nothing was observed, rather than defaulting it', () => {
    const report = perfReportFrom(readout(null));
    // `in`, not a value comparison: `extract/vitals.ts` distinguishes an
    // absent key from a null one, and a 0 here would be the exact
    // absent-vs-zero conflation the domain exists to prevent.
    expect('cumulativeLayoutShift' in report).toBe(false);
    expect('interactionToNextPaintMs' in report).toBe(false);
    expect('unsupportedEntryTypes' in report).toBe(false);
    expect(report.largestContentfulPaintMs).toBeNull();
    // The one-shot half still lands, because it was genuinely sampled.
    expect(report.ttfbMs).toBe(50);
    expect(report.firstContentfulPaintMs).toBe(210);
  });

  it('writes a genuine CLS of 0 as 0, unrounded, while an unobserved CLS stays absent', () => {
    const watched = perfReportFrom(
      readout(observed({ cumulativeLayoutShift: 0 })),
    );
    expect('cumulativeLayoutShift' in watched).toBe(true);
    expect(watched.cumulativeLayoutShift).toBe(0);

    const unwatched = perfReportFrom(
      readout(observed({ cumulativeLayoutShift: null })),
    );
    expect('cumulativeLayoutShift' in unwatched).toBe(false);
  });

  it('never rounds CLS on the way to the report', () => {
    const report = perfReportFrom(
      readout(observed({ cumulativeLayoutShift: 0.1 })),
    );
    // Math.round(0.1) === 0 — the value that separates "good" from
    // "needs improvement" would become a perfect score.
    expect(report.cumulativeLayoutShift).toBe(0.1);
  });

  it('leaves INP absent when no interaction happened, and carries it when one did', () => {
    expect(
      'interactionToNextPaintMs' in perfReportFrom(readout(observed({}))),
    ).toBe(false);
    const interacted = perfReportFrom(
      readout(observed({ interactionToNextPaintMs: 137.4 })),
    );
    expect(interacted.interactionToNextPaintMs).toBe(137);
  });

  it('treats a NaN or a non-number as absent, never as zero', () => {
    const report = perfReportFrom(
      readout(
        observed({
          cumulativeLayoutShift: Number.NaN,
          interactionToNextPaintMs: 'fast' as unknown as number,
          largestContentfulPaintMs: Number.POSITIVE_INFINITY,
        }),
      ),
    );
    expect('cumulativeLayoutShift' in report).toBe(false);
    expect('interactionToNextPaintMs' in report).toBe(false);
    expect(report.largestContentfulPaintMs).toBeNull();
  });

  it('carries the unsupported entry types through, so an absence can be explained', () => {
    const report = perfReportFrom(
      readout(observed({ unsupportedEntryTypes: ['layout-shift'] })),
    );
    expect(report.unsupportedEntryTypes).toEqual(['layout-shift']);
  });

  it('passes navigation, paint and resource timing to core unchanged', () => {
    const report = perfReportFrom(readout(observed({})));
    expect(report.loadMs).toBe(500);
    expect(report.domContentLoadedMs).toBe(300);
    expect(report.resourceCount).toBe(1);
    expect(report.resourceCountByKind).toEqual({ script: 1 });
    expect(report.transferSizeBytes).toBe(3_072);
  });

  it('reports a page that ended before navigation timing existed as absent, not zero', () => {
    const report = perfReportFrom({
      navigation: null,
      paint: [],
      resources: [],
      observations: null,
    });
    expect(report.ttfbMs).toBeNull();
    expect(report.loadMs).toBeNull();
    expect(report.transferSizeBytes).toBeNull();
  });
});

describe('readPerfReport', () => {
  it('reads the page once and normalizes through core', async () => {
    const snapshot = readout(observed({ cumulativeLayoutShift: 0.03 }));
    const args: string[] = [];
    const report = await readPerfReport({
      evaluate: async <R>(fn: (globalName: string) => R, arg: string) => {
        args.push(arg);
        expect(fn).toBe(readPerfSnapshot);
        return snapshot as unknown as R;
      },
    });
    expect(args).toEqual([PERF_OBSERVATIONS_GLOBAL]);
    expect(report.cumulativeLayoutShift).toBe(0.03);
  });
});
