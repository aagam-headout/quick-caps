import type { LogEntry } from 'quick-caps-core';
import { FLUSH_EVENT, LOGS_ATTRIBUTE } from './protocol.js';

export const RECORDER_KEY = '__pageCaptureRecorder';

export type RecorderTarget = Window & typeof globalThis;

export type RecorderOptions = {
  size: number;
  serialize?: (args: unknown[]) => string;
};

type Buffer = { entries: LogEntry[]; installed: true };

const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function defaultSerialize(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Patches console and fetch on `target` to record into a ring buffer.
 *
 * This must run in the MAIN world: patching the ISOLATED world's console and
 * fetch would observe nothing the page itself does. That means the ISOLATED
 * collector cannot read the buffer directly, so the buffer is flushed into a
 * DOM attribute - shared between worlds - in response to a synchronous event.
 *
 * Two properties matter more than the feature. Every wrapper calls through to
 * the original and returns its value unchanged, and a throw inside the recorder
 * is swallowed. A capture tool that breaks the page it is capturing is worse
 * than one without logs.
 */
export function installRecorder(
  target: RecorderTarget,
  options: RecorderOptions,
): void {
  const holder = target as unknown as Record<string, Buffer | undefined>;
  if (holder[RECORDER_KEY]?.installed) return;

  const buffer: Buffer = { entries: [], installed: true };
  Object.defineProperty(target, RECORDER_KEY, {
    value: buffer,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  const serialize = options.serialize ?? defaultSerialize;
  const record = (entry: LogEntry): void => {
    buffer.entries.push(entry);
    if (buffer.entries.length > options.size) buffer.entries.shift();
  };
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* a recorder failure must never reach page code */
    }
  };

  const console_ = target.console as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  for (const level of CONSOLE_LEVELS) {
    const original = console_[level];
    if (typeof original !== 'function') continue;
    console_[level] = (...args: unknown[]) => {
      safely(() =>
        record({
          kind: 'console',
          level,
          at: Date.now(),
          text: serialize(args),
        }),
      );
      return original.apply(target.console, args);
    };
  }

  const originalFetch = target.fetch;
  if (typeof originalFetch === 'function') {
    target.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const started = Date.now();
      const url = typeof input === 'string' ? input : String(input);
      const method = init?.method ?? 'GET';
      try {
        const response = await originalFetch.call(target, input, init);
        safely(() =>
          record({
            kind: 'request',
            at: started,
            method,
            url,
            status: response.status,
            durationMs: Date.now() - started,
            // Method, url, status, timing, size. Never a body: a capture tool
            // has no business recording what the page posted.
            size: Number(response.headers.get('content-length')) || null,
          }),
        );
        return response;
      } catch (error) {
        safely(() =>
          record({
            kind: 'request',
            at: started,
            method,
            url,
            status: null,
            durationMs: Date.now() - started,
            size: null,
          }),
        );
        throw error;
      }
    };
  }

  if (typeof target.addEventListener === 'function') {
    target.addEventListener('error', (event: ErrorEvent) => {
      safely(() =>
        record({
          kind: 'error',
          at: Date.now(),
          message: event.message,
          ...(event.error instanceof Error && event.error.stack
            ? { stack: event.error.stack }
            : {}),
        }),
      );
    });
    target.addEventListener(
      'unhandledrejection',
      (event: PromiseRejectionEvent) => {
        safely(() =>
          record({
            kind: 'error',
            at: Date.now(),
            message: String(event.reason),
          }),
        );
      },
    );
  }

  // The cross-world handoff. Synchronous, so the collector can dispatch and
  // read in the same turn.
  target.document.addEventListener(FLUSH_EVENT, () => {
    safely(() => {
      target.document.documentElement.setAttribute(
        LOGS_ATTRIBUTE,
        JSON.stringify(buffer.entries),
      );
    });
  });
}
