import { describe, expect, it } from 'vitest';
import { collectorBundleSource } from '../src/collector-bundle.js';

describe('collectorBundleSource', () => {
  it('produces a self-contained string with no import/require statements', async () => {
    const source = await collectorBundleSource();
    expect(source.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/\bimport\s/);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it('assigns a callable __quickcapsCollect when evaluated', async () => {
    const source = await collectorBundleSource();
    const globals: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- this is
    // exactly what page.addScriptTag will do in a real browser; testing the
    // string's shape without a browser means evaluating it against a stand-in
    // global object the same way.
    new Function('globalThis', source)(globals);
    expect(typeof globals['__quickcapsCollect']).toBe('function');
  });

  it('caches the build — a second call returns the same string instance', async () => {
    const first = await collectorBundleSource();
    const second = await collectorBundleSource();
    expect(second).toBe(first);
  });
});
