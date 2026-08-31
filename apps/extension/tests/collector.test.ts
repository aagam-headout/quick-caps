import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { defaultSettings, type CaptureSettings } from 'quick-caps-core';
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

  it('omits perf when the setting is off', async () => {
    installPage('<html><body></body></html>');
    const { runCollector } = await loadEntry();
    expect(runCollector(defaultSettings).perf).toBeUndefined();
  });

  it('derives a perf report from performance entries when the setting is on', async () => {
    installPage('<html><body></body></html>');
    Object.assign(globalThis, {
      performance: {
        getEntriesByType: (type: string) =>
          ({
            navigation: [
              {
                requestStart: 10,
                responseStart: 35,
                domContentLoadedEventEnd: 220,
                loadEventEnd: 480,
                transferSize: 1500,
              },
            ],
            paint: [{ name: 'first-contentful-paint', startTime: 150 }],
            'largest-contentful-paint': [{ startTime: 300 }],
            resource: [{ initiatorType: 'img', transferSize: 4000 }],
          })[type] ?? [],
      },
    });
    const { runCollector } = await loadEntry();
    const ir = runCollector({
      ...defaultSettings,
      include: { ...defaultSettings.include, perf: true },
    });
    expect(ir.perf?.ttfbMs).toBe(25);
    expect(ir.perf?.firstContentfulPaintMs).toBe(150);
    expect(ir.perf?.largestContentfulPaintMs).toBe(300);
    expect(ir.perf?.transferSizeBytes).toBe(5500);
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

  it('removes elements matching excludeSelector before capture and restores them after', async () => {
    installPage(
      '<html><body><div id="keep">Keep</div><div class="banner">Cookie banner</div></body></html>',
    );
    const { applyExclusions } = await loadEntry();
    const restore = applyExclusions('.banner');
    expect(document.querySelector('.banner')).toBeNull();
    expect(document.getElementById('keep')).not.toBeNull();
    restore();
    expect(document.querySelector('.banner')?.textContent).toBe(
      'Cookie banner',
    );
  });

  it('treats an empty or invalid exclude selector as a no-op', async () => {
    installPage(
      '<html><body><div class="banner">Cookie banner</div></body></html>',
    );
    const { applyExclusions } = await loadEntry();
    expect(applyExclusions('')).toBeInstanceOf(Function);
    expect(document.querySelector('.banner')).not.toBeNull();
    // An invalid selector must not throw the whole capture.
    expect(() => applyExclusions(':::not-a-selector')()).not.toThrow();
    expect(document.querySelector('.banner')).not.toBeNull();
  });

  it('prunes everything outside the selection root, keeping its ancestor chain', async () => {
    installPage(
      '<html><body><nav>Nav</nav><main><aside>Aside</aside><section id="card">Card</section></main><footer>Footer</footer></body></html>',
    );
    const { applySelectionRoot } = await loadEntry();
    const restore = applySelectionRoot('#card');
    expect(document.querySelector('nav')).toBeNull();
    expect(document.querySelector('footer')).toBeNull();
    expect(document.querySelector('aside')).toBeNull();
    expect(document.getElementById('card')?.textContent).toBe('Card');
    // the ancestor is kept, just pruned of its other children
    expect(document.querySelector('main')).not.toBeNull();
    restore();
    expect(document.querySelector('nav')?.textContent).toBe('Nav');
    expect(document.querySelector('footer')?.textContent).toBe('Footer');
    expect(document.querySelector('aside')?.textContent).toBe('Aside');
  });

  it('treats an empty or invalid selection selector as a no-op', async () => {
    installPage('<html><body><div class="x">X</div></body></html>');
    const { applySelectionRoot } = await loadEntry();
    expect(applySelectionRoot('')).toBeInstanceOf(Function);
    expect(document.querySelector('.x')).not.toBeNull();
    expect(() => applySelectionRoot(':::bad')()).not.toThrow();
    expect(document.querySelector('.x')).not.toBeNull();
  });

  it('treats a selector matching nothing as a no-op', async () => {
    installPage('<html><body><div class="x">X</div></body></html>');
    const { applySelectionRoot } = await loadEntry();
    applySelectionRoot('.missing')();
    expect(document.querySelector('.x')).not.toBeNull();
  });

  it('excludes matching elements from the region tree parked by parkCollectorResult', async () => {
    installPage(
      '<html><body><div class="banner">Cookie banner</div><h1>Page title</h1></body></html>',
    );
    const { parkCollectorResult } = await loadEntry();
    const globals: Record<string, unknown> = {
      [SETTINGS_KEY]: { ...defaultSettings, excludeSelector: '.banner' },
    };

    await parkCollectorResult(globals, {
      serialize: async () => {
        // The exclusion must still be in effect while serialization runs.
        expect(document.querySelector('.banner')).toBeNull();
        return { html: '<html>serialized</html>', title: 'T' };
      },
    });

    expect(document.querySelector('.banner')?.textContent).toBe(
      'Cookie banner',
    );
    const outcome = globals[IR_KEY] as { status: string; ir: { html: string } };
    expect(outcome.status).toBe('done');
    expect(outcome.ir.html).not.toContain('banner');
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
