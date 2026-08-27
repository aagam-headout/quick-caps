import { describe, expect, it } from 'vitest';
import { FakeDriver, fixtureDocument } from './fake-driver.js';

describe('FakeDriver', () => {
  it('evaluates a self-contained function against a fixture document', async () => {
    const driver = new FakeDriver({ fixture: 'static' });
    const title = await driver.evaluate(() => globalThis.document.title);
    expect(title).toBe('Static Fixture');
  });

  it('serves configured asset bytes', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/img/hero.png': new Uint8Array([1, 2, 3]) },
    });
    const asset = await driver.fetchAsset('/img/hero.png', {
      timeoutMs: 100,
      maxBytes: 1000,
    });
    expect(asset.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects for an asset configured to fail', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      failures: { '/img/hero.png': 'network error' },
    });
    await expect(
      driver.fetchAsset('/img/hero.png', { timeoutMs: 100, maxBytes: 1000 }),
    ).rejects.toThrow('network error');
  });

  it('never resolves before the timeout for an asset configured to hang', async () => {
    const driver = new FakeDriver({ fixture: 'static', hangs: ['/slow.css'] });
    const race = await Promise.race([
      driver
        .fetchAsset('/slow.css', { timeoutMs: 20, maxBytes: 1000 })
        .then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 50)),
    ]);
    expect(race).toBe('still-pending');
  });

  it('parses a fixture into a queryable document', () => {
    const doc = fixtureDocument('gallery');
    expect(doc.querySelectorAll('img').length).toBe(3);
    expect(doc.querySelectorAll('picture source').length).toBe(1);
  });

  it('gives every element a deterministic layout box', () => {
    const driver = new FakeDriver({ fixture: 'static' });
    const boxes = [...driver.document.querySelectorAll('h1, p')].map(
      (el) => el.getBoundingClientRect().height,
    );
    expect(boxes.every((height) => height === 40)).toBe(true);
  });

  it('reports the viewport with overrides applied', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      viewport: { documentHeight: 9000 },
    });
    const viewport = await driver.viewport();
    expect(viewport.documentHeight).toBe(9000);
    expect(viewport.width).toBe(1280);
  });

  it('records the scroll position it was moved to', async () => {
    const driver = new FakeDriver({ fixture: 'static' });
    await driver.scrollTo(0, 400);
    expect((await driver.viewport()).scrollY).toBe(400);
  });
});
