import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { defaultSettings, type CaptureSettings } from '@page-capture/core';
import {
  FLUSH_EVENT,
  IR_KEY,
  LOGS_ATTRIBUTE,
  SETTINGS_KEY,
} from '../src/content/protocol.js';

type Entry = typeof import('../src/content/collector.js');

function installPage(html: string, settings?: CaptureSettings): void {
  const { window, document } = parseHTML(html);
  Object.assign(window, {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
  });
  Object.assign(globalThis, {
    window,
    document,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Event: window.Event,
  });
  // navigator and location are getter-only globals in Node, so they cannot be
  // assigned over — they have to be redefined.
  for (const [name, value] of [
    ['navigator', { userAgent: 'test-agent' }],
    ['location', { href: 'https://example.com/page' }],
  ] as const) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    });
  }
  if (settings) {
    (window as unknown as Record<string, unknown>)['__pageCaptureSettings'] =
      settings;
  }
}

async function loadEntry(): Promise<Entry> {
  vi.resetModules();
  return (await import('../src/content/collector.js')) as Entry;
}

beforeEach(() => {
  vi.resetModules();
});

describe('runCollector', () => {
  it('reads the environment and returns a PageIR', async () => {
    installPage(
      '<html><head><title>T</title></head><body><h1>Hi</h1></body></html>',
    );
    const { runCollector } = await loadEntry();
    const ir = runCollector(defaultSettings);
    expect(ir.metadata.url).toBe('https://example.com/page');
    expect(ir.metadata.userAgent).toBe('test-agent');
    expect(ir.metadata.viewport).toEqual({ width: 1280, height: 800 });
    expect(ir.html).toContain('<h1>Hi</h1>');
  });

  it('omits logs when the setting is off', async () => {
    installPage('<html><body></body></html>');
    const { runCollector } = await loadEntry();
    expect(runCollector(defaultSettings).logs).toBeUndefined();
  });

  it('omits logs when no recorder answered the flush', async () => {
    installPage('<html><body></body></html>');
    const { runCollector } = await loadEntry();
    const ir = runCollector({
      ...defaultSettings,
      include: { ...defaultSettings.include, logs: true },
    });
    expect(ir.logs).toBeUndefined();
  });

  it('reads logs the recorder flushed into the shared attribute', async () => {
    installPage('<html><body></body></html>');
    const { runCollector } = await loadEntry();
    // Stand in for the MAIN-world recorder: answer the flush synchronously.
    document.addEventListener(FLUSH_EVENT, () => {
      document.documentElement.setAttribute(
        LOGS_ATTRIBUTE,
        JSON.stringify([
          { kind: 'console', level: 'warn', at: 1, text: 'careful' },
        ]),
      );
    });
    const ir = runCollector({
      ...defaultSettings,
      include: { ...defaultSettings.include, logs: true },
    });
    expect(ir.logs).toHaveLength(1);
    expect(document.documentElement.hasAttribute(LOGS_ATTRIBUTE)).toBe(false);
  });

  it('survives a recorder that writes unparseable output', async () => {
    installPage('<html><body></body></html>');
    const { runCollector } = await loadEntry();
    document.addEventListener(FLUSH_EVENT, () => {
      document.documentElement.setAttribute(LOGS_ATTRIBUTE, 'not json');
    });
    const ir = runCollector({
      ...defaultSettings,
      include: { ...defaultSettings.include, logs: true },
    });
    expect(ir.logs).toBeUndefined();
    expect(ir.metadata.url).toBe('https://example.com/page');
  });

  it('parks the result under IR_KEY when settings are present', async () => {
    installPage('<html><head><title>Live</title></head><body></body></html>');
    const { parkCollectorResult } = await loadEntry();
    const globals: Record<string, unknown> = {
      [SETTINGS_KEY]: defaultSettings,
    };

    await parkCollectorResult(globals, {
      serialize: async () => ({
        html: '<html>serialized</html>',
        title: 'Live',
      }),
    });

    const outcome = globals[IR_KEY] as {
      status: string;
      html: string;
      ir: { metadata: { title: string } };
    };
    expect(outcome.status).toBe('done');
    expect(outcome.html).toBe('<html>serialized</html>');
    expect(outcome.ir.metadata.title).toBe('Live');
  });

  it('parks nothing when no settings were handed in', async () => {
    installPage('<html><body></body></html>');
    const { parkCollectorResult } = await loadEntry();
    const globals: Record<string, unknown> = {};

    await parkCollectorResult(globals, {
      serialize: async () => ({ html: '', title: '' }),
    });

    expect(globals[IR_KEY]).toBeUndefined();
  });

  it('parks a failure rather than throwing when serialization fails', async () => {
    installPage('<html><body></body></html>');
    const { parkCollectorResult } = await loadEntry();
    const globals: Record<string, unknown> = {
      [SETTINGS_KEY]: defaultSettings,
    };

    await parkCollectorResult(globals, {
      serialize: () => Promise.reject(new Error('serialization timed out')),
    });

    expect(globals[IR_KEY]).toMatchObject({
      status: 'failed',
      error: 'serialization timed out',
    });
  });
});
