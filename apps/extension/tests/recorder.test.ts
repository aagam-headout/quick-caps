import { describe, expect, it, vi } from 'vitest';
import { installRecorder } from '../src/content/recorder.js';
import { FLUSH_EVENT, LOGS_ATTRIBUTE } from '../src/content/protocol.js';

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
