import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectFromDocument } from 'quick-caps-core';
import { defaultSettings } from 'quick-caps-core';
import { flattenRegions } from 'quick-caps-core/distill';
import { parseHTML } from 'linkedom';
import { interact } from '../src/interact.js';

const here = dirname(fileURLToPath(import.meta.url));
const toggleHtml = readFileSync(
  join(here, 'fixtures/toggle-button.html'),
  'utf8',
);
const searchHtml = readFileSync(
  join(here, 'fixtures/search-form.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/results')) {
      const q =
        new URL(req.url, 'http://localhost').searchParams.get('q') ?? '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><html><body><main><h1>Results for: ${q}</h1></main></body></html>`,
      );
      return;
    }
    if (req.url === '/search') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(searchHtml);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(toggleHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Finds a region's domPath by tag, using the same buildRegions pipeline
 * the real collector uses — mirrors how a real session's stored ir.regions
 * would carry this domPath for the button/input in the fixture. */
function domPathFor(html: string, tag: string): number[] {
  const { document } = parseHTML(html);
  const ir = collectFromDocument(document, {
    settings: defaultSettings,
    pageUrl: 'https://example.com/',
    userAgent: 'test',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 800 },
    devicePixelRatio: 1,
  });
  const region = flattenRegions(ir.regions).find(
    (e) => e.region.tag === tag,
  )?.region;
  if (!region) throw new Error(`no ${tag} region found in fixture`);
  return region.domPath;
}

describe('interact', () => {
  it('clicks a button and the resulting page reflects the click', async () => {
    const domPath = domPathFor(toggleHtml, 'button');
    const { ir, driver } = await interact(`${baseUrl}/`, domPath, {
      kind: 'button',
    });
    expect(driver).toBe('playwright');
    expect(ir.html).toContain('Revealed by clicking the button.');
  }, 30_000);

  it('fills an input, submits its form, and the resulting page reflects the query', async () => {
    const domPath = domPathFor(searchHtml, 'input');
    const { ir } = await interact(`${baseUrl}/search`, domPath, {
      kind: 'input',
      value: 'wireless mouse',
    });
    expect(ir.metadata.url).toContain('/results');
    expect(ir.html).toContain('Results for: wireless mouse');
  }, 30_000);

  it('selects an option on a <select>, using selectOption rather than fill', async () => {
    const domPath = domPathFor(searchHtml, 'select');
    // A raw .fill() on a <select> throws ("Element is not an <input>,
    // <textarea> or [contenteditable]") — this proves interact() routes a
    // 'select' tag to .selectOption() instead, without throwing.
    const { ir } = await interact(`${baseUrl}/search`, domPath, {
      kind: 'input',
      value: 'electronics',
    });
    expect(ir.html).toBeDefined();
  }, 30_000);

  it('rejects a private-address URL before launching a browser', async () => {
    await expect(
      interact('http://169.254.169.254/', [0], { kind: 'button' }),
    ).rejects.toThrow(/private|loopback|internal/i);
  });
});
