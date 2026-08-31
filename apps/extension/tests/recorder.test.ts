import { describe, expect, it, vi } from 'vitest';
import { installRecorder } from '../src/content/recorder.js';
import {
  FLUSH_EVENT,
  LOGS_ATTRIBUTE,
  OBSERVATIONS_ATTRIBUTE,
} from '../src/content/protocol.js';
import type { RecorderObservations } from '../src/content/recorder.js';

type Target = Record<string, unknown>;

function makeTarget(): {
  target: Target;
  listeners: Map<string, (event: unknown) => void>;
  attributes: Map<string, string>;
} {
  const listeners = new Map<string, (event: unknown) => void>();
  const attributes = new Map<string, string>();
  const documentElement = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    removeAttribute: (name: string) => attributes.delete(name),
    hasAttribute: (name: string) => attributes.has(name),
  };
  const target: Target = {
    console: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    fetch: vi
      .fn()
      .mockResolvedValue(
        new Response('ok', { status: 200, headers: { 'content-length': '2' } }),
      ),
    addEventListener: vi.fn(),
    document: {
      documentElement,
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        listeners.set(name, handler),
    },
  };
  return { target, listeners, attributes };
}

describe('installRecorder', () => {
  it('keeps its buffer off the enumerable surface of the page global', () => {
    const { target } = makeTarget();
    installRecorder(target as never, { size: 10 });
    expect(Object.keys(target)).not.toContain('__pageCaptureRecorder');
  });

  it('records a console call and still calls through to the original', () => {
    const { target, listeners, attributes } = makeTarget();
    const original = (target.console as { warn: ReturnType<typeof vi.fn> })
      .warn;
    installRecorder(target as never, { size: 10 });

    (target.console as { warn: (m: string) => void }).warn('careful');
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));

    expect(original).toHaveBeenCalledWith('careful');
    const flushed = JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as {
      kind: string;
      level: string;
      text: string;
    }[];
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({
      kind: 'console',
      level: 'warn',
      text: 'careful',
    });
  });

  it('passes the original fetch return value through untouched', async () => {
    const { target } = makeTarget();
    installRecorder(target as never, { size: 10 });
    const response = await (target.fetch as typeof fetch)(
      'https://example.com/a',
    );
    expect(await response.text()).toBe('ok');
  });

  it('records a fetch with method, status, and size', async () => {
    const { target, listeners, attributes } = makeTarget();
    installRecorder(target as never, { size: 10 });

    await (target.fetch as typeof fetch)('https://example.com/a', {
      method: 'POST',
    });
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));

    const flushed = JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as {
      kind: string;
      method?: string;
      status?: number;
      size?: number;
    }[];
    expect(flushed.find((e) => e.kind === 'request')).toMatchObject({
      method: 'POST',
      status: 200,
      size: 2,
    });
  });

  it('records a rejected fetch with a null status and rethrows', async () => {
    const { target, listeners, attributes } = makeTarget();
    target.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    installRecorder(target as never, { size: 10 });

    await expect(
      (target.fetch as typeof fetch)('https://example.com/a'),
    ).rejects.toThrow('offline');
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));

    const flushed = JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as {
      status: number | null;
    }[];
    expect(flushed.at(-1)).toMatchObject({ status: null });
  });

  it('never records a request body', async () => {
    const { target, listeners, attributes } = makeTarget();
    installRecorder(target as never, { size: 10 });

    await (target.fetch as typeof fetch)('https://example.com/a', {
      method: 'POST',
      body: 'secret-token=abc123',
    });
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));

    expect(attributes.get(LOGS_ATTRIBUTE)).not.toContain('secret-token');
  });

  it('drops the oldest entry when the ring is full', () => {
    const { target, listeners, attributes } = makeTarget();
    installRecorder(target as never, { size: 3 });

    const console_ = target.console as { log: (m: string) => void };
    for (const message of ['a', 'b', 'c', 'd']) console_.log(message);
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));

    const flushed = JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as {
      text: string;
    }[];
    expect(flushed.map((e) => e.text)).toEqual(['b', 'c', 'd']);
  });

  it('swallows its own errors rather than breaking the page', () => {
    const { target } = makeTarget();
    installRecorder(target as never, {
      size: 10,
      serialize: () => {
        throw new Error('recorder bug');
      },
    });
    expect(() =>
      (target.console as { log: (m: string) => void }).log('x'),
    ).not.toThrow();
  });

  it('is idempotent — installing twice does not double-record', () => {
    const { target, listeners, attributes } = makeTarget();
    installRecorder(target as never, { size: 10 });
    installRecorder(target as never, { size: 10 });

    (target.console as { log: (m: string) => void }).log('once');
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));

    expect(
      JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as unknown[],
    ).toHaveLength(1);
  });

  it('flushes an empty buffer as an empty array, not a missing attribute', () => {
    const { target, listeners, attributes } = makeTarget();
    installRecorder(target as never, { size: 10 });
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));
    expect(attributes.get(LOGS_ATTRIBUTE)).toBe('[]');
  });
});

// ---------------------------------------------------------------------------
// The widened observation surface: XMLHttpRequest, and the paint/layout
// metrics that only exist because an observer outlived first paint.
// ---------------------------------------------------------------------------

/** Stands in for the page's XMLHttpRequest. The recorder subclasses whatever
 * it finds, so anything with the four members it touches is enough. */
class FakeXhr {
  status = 0;
  readonly handlers = new Map<string, () => void>();
  opened: { method: string; url: string } | undefined;
  sentBody: unknown;
  open(method: string, url: string): void {
    this.opened = { method, url };
  }
  send(body?: unknown): void {
    this.sentBody = body;
  }
  addEventListener(type: string, handler: () => void): void {
    this.handlers.set(type, handler);
  }
  getResponseHeader(): string | null {
    return '11';
  }
  /** What the browser does when the request settles, however it settled. */
  settle(status: number): void {
    this.status = status;
    this.handlers.get('loadend')?.();
  }
}

type FakeEntryList = { getEntries: () => unknown[] };

/** Stands in for PerformanceObserver. `supported` is the browser's own
 * `supportedEntryTypes`, which is how an unsupported type is discovered
 * without waiting for entries that will never come. */
function makeObserverClass(supported: string[]) {
  const instances: { type: string; emit: (entries: unknown[]) => void }[] = [];
  class FakeObserver {
    static supportedEntryTypes = supported;
    type = '';
    constructor(private readonly callback: (list: FakeEntryList) => void) {}
    observe(init: { type: string }): void {
      this.type = init.type;
      instances.push({
        type: init.type,
        emit: (entries) => this.callback({ getEntries: () => entries }),
      });
    }
    disconnect(): void {}
  }
  return { FakeObserver, instances };
}

const ALL_TYPES = ['layout-shift', 'event', 'largest-contentful-paint'];

function flushObservations(
  listeners: Map<string, (event: unknown) => void>,
  attributes: Map<string, string>,
): RecorderObservations {
  listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));
  return JSON.parse(
    attributes.get(OBSERVATIONS_ATTRIBUTE)!,
  ) as RecorderObservations;
}

describe('installRecorder: XMLHttpRequest', () => {
  function install(supported = ALL_TYPES) {
    const made = makeTarget();
    made.target.XMLHttpRequest = FakeXhr;
    made.target.PerformanceObserver = makeObserverClass(supported).FakeObserver;
    installRecorder(made.target as never, { size: 10 });
    const Xhr = made.target.XMLHttpRequest as unknown as new () => FakeXhr;
    return { ...made, Xhr };
  }

  it('records an XHR the page sent, which fetch patching alone never saw', () => {
    const { Xhr, listeners, attributes } = install();
    const xhr = new Xhr();
    xhr.open('POST', 'https://example.com/api/cart');
    xhr.send();
    xhr.settle(201);

    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));
    const flushed = JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as {
      kind: string;
      method: string;
      url: string;
      status: number | null;
      size: number | null;
    }[];
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({
      kind: 'request',
      method: 'POST',
      url: 'https://example.com/api/cart',
      status: 201,
      size: 11,
    });
  });

  it('calls through to the original open and send', () => {
    const { Xhr } = install();
    const xhr = new Xhr();
    xhr.open('GET', 'https://example.com/a');
    xhr.send('payload');
    expect(xhr.opened).toEqual({
      method: 'GET',
      url: 'https://example.com/a',
    });
    expect(xhr.sentBody).toBe('payload');
  });

  it('records an aborted XHR with a null status rather than a zero one', () => {
    const { Xhr, listeners, attributes } = install();
    const xhr = new Xhr();
    xhr.open('GET', 'https://example.com/a');
    xhr.send();
    xhr.settle(0);

    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));
    const flushed = JSON.parse(attributes.get(LOGS_ATTRIBUTE)!) as {
      status: number | null;
    }[];
    expect(flushed[0]).toMatchObject({ status: null });
  });

  it('never records an XHR request body', () => {
    const { Xhr, listeners, attributes } = install();
    const xhr = new Xhr();
    xhr.open('POST', 'https://example.com/a');
    xhr.send('secret-token=abc123');
    xhr.settle(200);
    listeners.get(FLUSH_EVENT)!(new Event(FLUSH_EVENT));
    expect(attributes.get(LOGS_ATTRIBUTE)).not.toContain('secret-token');
    expect(attributes.get(OBSERVATIONS_ATTRIBUTE)).not.toContain(
      'secret-token',
    );
  });

  it('classifies an XHR as xhr and a fetch as fetch in the recording', async () => {
    const { target, Xhr, listeners, attributes } = install();
    const xhr = new Xhr();
    xhr.open('GET', 'https://example.com/x');
    xhr.send();
    xhr.settle(200);
    await (target.fetch as typeof fetch)('https://example.com/f');

    const observations = flushObservations(listeners, attributes);
    expect(observations.requests.map((r) => r.resourceType)).toEqual([
      'xhr',
      'fetch',
    ]);
    // Metadata only, per the design: no body is ever kept on this surface.
    expect(observations.requests.every((r) => r.body.kept === false)).toBe(
      true,
    );
  });

  it('leaves the page global alone when there is no XMLHttpRequest', () => {
    const { target } = makeTarget();
    expect(() => installRecorder(target as never, { size: 10 })).not.toThrow();
    expect(target.XMLHttpRequest).toBeUndefined();
  });
});

describe('installRecorder: paint and layout observation', () => {
  function install(supported = ALL_TYPES) {
    const made = makeTarget();
    const { FakeObserver, instances } = makeObserverClass(supported);
    made.target.PerformanceObserver = FakeObserver;
    installRecorder(made.target as never, { size: 10 });
    const emit = (type: string, entries: unknown[]): void => {
      for (const instance of instances) {
        if (instance.type === type) instance.emit(entries);
      }
    };
    return { ...made, emit };
  }

  it('leaves every over-time metric absent when nothing was observed', () => {
    const { listeners, attributes } = install();
    const { vitals } = flushObservations(listeners, attributes);
    expect('cumulativeLayoutShift' in vitals).toBe(false);
    expect('interactionToNextPaintMs' in vitals).toBe(false);
    expect('largestContentfulPaintMs' in vitals).toBe(false);
    expect(vitals.unsupportedEntryTypes).toEqual([]);
  });

  it('sums layout shifts, excluding those with recent input', () => {
    const { emit, listeners, attributes } = install();
    emit('layout-shift', [
      { value: 0.05, hadRecentInput: false },
      { value: 0.5, hadRecentInput: true },
      { value: 0.07, hadRecentInput: false },
    ]);
    const { vitals } = flushObservations(listeners, attributes);
    // Unrounded on purpose: Math.round would report this stable-ish page as 0.
    expect(vitals.cumulativeLayoutShift).toBeCloseTo(0.12, 10);
  });

  it('records an observed CLS of zero as zero, not as an absence', () => {
    const { emit, listeners, attributes } = install();
    // Entries arrived; every one of them followed an interaction, so the
    // score really is 0. That is a measurement, not a missing one.
    emit('layout-shift', [{ value: 0.4, hadRecentInput: true }]);
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.cumulativeLayoutShift).toBe(0);
  });

  it('never rounds a small CLS away', () => {
    const { emit, listeners, attributes } = install();
    emit('layout-shift', [{ value: 0.1, hadRecentInput: false }]);
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.cumulativeLayoutShift).toBeCloseTo(0.1, 10);
    expect(vitals.cumulativeLayoutShift).not.toBe(0);
  });

  it('leaves INP absent when nothing was interacted with', () => {
    const { emit, listeners, attributes } = install();
    // An event entry with no interactionId is not an interaction.
    emit('event', [{ duration: 240, interactionId: 0 }]);
    const { vitals } = flushObservations(listeners, attributes);
    expect('interactionToNextPaintMs' in vitals).toBe(false);
  });

  it('reports the worst interaction latency as INP', () => {
    const { emit, listeners, attributes } = install();
    emit('event', [
      { duration: 40, interactionId: 1 },
      { duration: 120, interactionId: 2 },
      { duration: 88, interactionId: 2 },
    ]);
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.interactionToNextPaintMs).toBe(120);
  });

  it('keeps the last largest-contentful-paint entry', () => {
    const { emit, listeners, attributes } = install();
    emit('largest-contentful-paint', [{ startTime: 300 }]);
    emit('largest-contentful-paint', [{ startTime: 920 }]);
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.largestContentfulPaintMs).toBe(920);
  });

  it('names an entry type the browser does not support', () => {
    const { listeners, attributes } = install([
      'event',
      'largest-contentful-paint',
    ]);
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.unsupportedEntryTypes).toEqual(['layout-shift']);
    expect('cumulativeLayoutShift' in vitals).toBe(false);
  });

  it('names every type when there is no PerformanceObserver at all', () => {
    const { target, listeners, attributes } = makeTarget();
    installRecorder(target as never, { size: 10 });
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.unsupportedEntryTypes).toEqual(ALL_TYPES);
  });

  it('names a type whose observe() throws', () => {
    const { target, listeners, attributes } = makeTarget();
    class ThrowingObserver {
      static supportedEntryTypes = ALL_TYPES;
      constructor(readonly callback: unknown) {}
      observe(init: { type: string }): void {
        if (init.type === 'event') throw new TypeError('bad options');
      }
      disconnect(): void {}
    }
    target.PerformanceObserver = ThrowingObserver;
    installRecorder(target as never, { size: 10 });
    const { vitals } = flushObservations(listeners, attributes);
    expect(vitals.unsupportedEntryTypes).toEqual(['event']);
  });

  it('swallows an observer callback that throws', () => {
    const { emit, listeners, attributes } = install();
    expect(() => emit('layout-shift', [null])).not.toThrow();
    const { vitals } = flushObservations(listeners, attributes);
    expect('cumulativeLayoutShift' in vitals).toBe(false);
  });

  it('stamps the moment observation was armed', () => {
    const { listeners, attributes } = install();
    const { startedAt } = flushObservations(listeners, attributes);
    expect(Number.isNaN(Date.parse(startedAt))).toBe(false);
  });
});
