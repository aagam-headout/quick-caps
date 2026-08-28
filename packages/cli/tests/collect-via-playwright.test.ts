import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { collectViaPlaywright } from '../src/collect-via-playwright.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, 'fixtures/static-article.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('collectViaPlaywright', () => {
  it('produces a PageIR from a real rendered page', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(baseUrl);
      const ir = await collectViaPlaywright(page);
      expect(ir.regions.length).toBeGreaterThan(0);
      const article = ir.regions
        .flatMap(function walk(r): typeof ir.regions {
          return [r, ...r.children.flatMap(walk)];
        })
        .find((r) => r.tag === 'article');
      expect(article).toBeTruthy();
    } finally {
      await page.close();
    }
  });
});

describe('collectViaPlaywright — computed styles', () => {
  it('populates styleTally when the page has real CSS', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<!doctype html><html><body><main style="color: rgb(255, 0, 0);"><p>Styled text</p></main></body></html>',
      );
      const ir = await collectViaPlaywright(page);
      expect(Object.keys(ir.styleTally.color).length).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
});
