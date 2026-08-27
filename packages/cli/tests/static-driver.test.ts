import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticDriver } from '../src/drivers/static-driver.js';
import { runDriverConformance } from './driver-conformance.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures/static.html'), 'utf8');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

runDriverConformance(
  'StaticDriver',
  async () => ({
    driver: await StaticDriver.fetch(baseUrl),
    teardown: async () => {},
  }),
  { screenshot: false },
);

describe('StaticDriver', () => {
  it('rejects a screenshot request rather than returning empty bytes', async () => {
    const driver = new StaticDriver(fixtureHtml);
    await expect(driver.screenshotFullPage()).rejects.toThrow('no renderer');
  });
});
