import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  attachNetworkRecorder,
  PlaywrightDriver,
} from '../src/drivers/playwright-driver.js';
import { runDriverConformance } from './driver-conformance.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures/static.html'), 'utf8');

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/pixel.png') {
      // A 1x1 transparent PNG, so screenshotFullPage and asset-fetch tests
      // hit a real (tiny) binary response rather than a 404.
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      return;
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixtureHtml);
      return;
    }
    res.writeHead(404);
    res.end();
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

runDriverConformance(
  'PlaywrightDriver',
  async () => {
    const page = await browser.newPage();
    await page.goto(baseUrl);
    return {
      driver: new PlaywrightDriver(page),
      teardown: () => page.close(),
    };
  },
  () => baseUrl,
);

/**
 * The one thing the fake page in network-recorder.test.ts cannot prove: that a
 * real Playwright page emits `response` for the traffic a load issues, so
 * recording needs no `route` interception (which would have to fulfil each
 * request itself, and would break streaming and long-polling).
 */
describe('attachNetworkRecorder on a real page', () => {
  it('records a navigation and its subresources from response events alone', async () => {
    const page = await browser.newPage();
    try {
      const recorder = attachNetworkRecorder(page, { redact: true });
      await page.goto(`${baseUrl}/pixel.png`);
      const recording = await recorder.finish();

      expect(recording.redacted).toBe(true);
      const pixel = recording.requests.find((r) =>
        r.url.endsWith('/pixel.png'),
      );
      expect(pixel?.status).toBe(200);
      expect(pixel?.resourceType).toBeTruthy();
      // A png is metadata-only by policy, with the reason on the record.
      expect(pixel?.body).toMatchObject({
        kept: false,
        reason: 'binary-type',
      });
    } finally {
      await page.close();
    }
  }, 30_000);
});
