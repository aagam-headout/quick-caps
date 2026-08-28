import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectViaStatic } from '../src/collect-via-static.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, 'fixtures/static-article.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;

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
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('collectViaStatic', () => {
  it('produces a PageIR with real regions, no browser involved', async () => {
    const ir = await collectViaStatic(baseUrl);
    expect(ir.regions.length).toBeGreaterThan(0);
    const article = ir.regions
      .flatMap(function walk(r): typeof ir.regions {
        return [r, ...r.children.flatMap(walk)];
      })
      .find((r) => r.tag === 'article');
    expect(article).toBeTruthy();
    expect(article!.textLength).toBeGreaterThan(0);
  });
});
