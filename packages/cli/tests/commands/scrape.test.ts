import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOpen } from '../../src/commands/open.js';
import { runScrape, splitSelectorAttr } from '../../src/commands/scrape.js';
import { CliError } from '../../src/errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, '../fixtures/static-article.html'),
  'utf8',
);

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-scrape-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('splitSelectorAttr', () => {
  it('splits a trailing @attr suffix', () => {
    expect(splitSelectorAttr('a.buy@href')).toEqual({
      selector: 'a.buy',
      attr: 'href',
    });
  });

  it('leaves a selector with no top-level @ untouched', () => {
    expect(splitSelectorAttr('a[href^="mailto:"]')).toEqual({
      selector: 'a[href^="mailto:"]',
    });
  });

  it('does not mistake an @ inside brackets/quotes for the suffix marker', () => {
    expect(splitSelectorAttr('[data-at="x"]@href')).toEqual({
      selector: '[data-at="x"]',
      attr: 'href',
    });
  });
});

describe('runScrape', () => {
  it('extracts text and attribute fields, offline, against a real (now-dead) fixture server', async () => {
    // A real HTTP server, opened only long enough for `open` to fetch the
    // page and then closed *before* scrape ever runs — proving scrape
    // itself makes no network call.
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixtureHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    await runOpen({ url: baseUrl }, cwd);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const output = await runScrape(
      JSON.stringify({ title: 'h1', link: 'nav a@href' }),
      cwd,
    );
    const result = JSON.parse(output);
    expect(result.title).toBe('A Real Article');
    expect(result.link).toBe('/');
  });

  it('returns null for a selector matching nothing, not an error', async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixtureHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    await runOpen({ url: baseUrl }, cwd);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const output = await runScrape(
      JSON.stringify({ missing: '.does-not-exist' }),
      cwd,
    );
    expect(JSON.parse(output)).toEqual({ missing: null });
  });

  it('rejects a malformed shape with a clear error', async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixtureHtml);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}/`;
    await runOpen({ url: baseUrl }, cwd);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(runScrape('not json', cwd)).rejects.toThrow(CliError);
    await expect(runScrape('["an", "array"]', cwd)).rejects.toThrow(CliError);
    await expect(runScrape(JSON.stringify({ x: 42 }), cwd)).rejects.toThrow(
      CliError,
    );
  });
});
