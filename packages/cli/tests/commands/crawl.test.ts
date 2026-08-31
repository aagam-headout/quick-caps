import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { dispatch } from '../../src/cli.js';
import { runCrawl } from '../../src/commands/crawl.js';
import { readCrawlRecords, CrawlStore } from '../../src/crawl/store.js';

let server: Server;
let baseUrl: string;
let host: string;
let cwd: string;

function page(body: string): string {
  return `<!doctype html><html><head><title>fixture</title></head><body><main>${body}</main></body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    if (url.pathname === '/private') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page('<p>secret</p>'));
      return;
    }
    if (url.pathname === '/catalogue') {
      const number = Number(url.searchParams.get('page') ?? '1');
      const next =
        number < 3
          ? `<a rel="next" href="/catalogue?page=${number + 1}">Next</a>`
          : '';
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page(`<h1>Page ${number}</h1>${next}`));
      return;
    }
    // The seed, and the cycle: /a and /b link to each other and back here.
    const links =
      url.pathname === '/'
        ? '<a href="/a">A</a><a href="/catalogue?page=1">Catalogue</a><a href="/private">Private</a>'
        : '<a href="/">Home</a><a href="/a">A</a><a href="/b">B</a>';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(links));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  host = `127.0.0.1-${address.port}`;
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-crawl-cmd-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runCrawl', () => {
  it('crawls the seed host into a store named after it, and prints where', async () => {
    const output = await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 3,
      },
      cwd,
    );

    expect(output).toContain(join('.quick-caps', 'crawls', host));
    expect(output).toMatch(/pages\s+3/);
    const entries = await readdir(join(cwd, '.quick-caps', 'crawls', host));
    expect(entries.sort()).toEqual(['records.jsonl', 'state.json']);
  }, 60_000);

  it('honours robots.txt by default, recording the skip with its reason', async () => {
    await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 10,
      },
      cwd,
    );

    const { records } = await readCrawlRecords(CrawlStore.dirFor(cwd, host));
    const skipped = records.find((record) => record.url.endsWith('/private'));
    expect(skipped?.outcome.kind).toBe('skipped');
    expect(JSON.stringify(skipped?.outcome)).toMatch(/robots/);
  }, 60_000);

  it('fetches a robots-disallowed path only when --ignore-robots is typed', async () => {
    await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 10,
        ignoreRobots: true,
      },
      cwd,
    );

    const { records } = await readCrawlRecords(CrawlStore.dirFor(cwd, host));
    const forced = records.find((record) => record.url.endsWith('/private'));
    expect(forced?.outcome.kind).toBe('fetched');
  }, 60_000);

  it('terminates on the cyclic fixture without a limit saving it', async () => {
    const output = await runCrawl(
      { url: baseUrl, domains: ['links'], onProgress: () => undefined },
      cwd,
    );

    expect(output).toMatch(/frontier exhausted/);
  }, 60_000);

  it('names the store with --name', async () => {
    await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 1,
        name: 'my-crawl',
      },
      cwd,
    );

    const entries = await readdir(join(cwd, '.quick-caps', 'crawls'));
    expect(entries).toEqual(['my-crawl']);
  }, 60_000);

  it('resumes an interrupted crawl from its state file', async () => {
    await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 1,
      },
      cwd,
    );
    const first = await readCrawlRecords(CrawlStore.dirFor(cwd, host));
    expect(first.records).toHaveLength(1);

    const output = await runCrawl(
      { resume: host, rate: 0, onProgress: () => undefined },
      cwd,
    );

    const after = await readCrawlRecords(CrawlStore.dirFor(cwd, host));
    expect(after.records.length).toBeGreaterThan(first.records.length);
    // A resume continues: the first page is not re-fetched.
    const urls = after.records.map((record) => record.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(output).toContain(host);
  }, 60_000);

  it('refuses to resume a crawl that has no state', async () => {
    await expect(runCrawl({ resume: 'nope' }, cwd)).rejects.toThrow(/nope/);
  });

  it('reports over the store without loading the dataset', async () => {
    await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 3,
      },
      cwd,
    );

    const report = await runCrawl({ report: true }, cwd);

    expect(report).toContain(host);
    expect(report).toMatch(/pages\s+3/);
    expect(report).toMatch(/links\s+\d/);
  }, 60_000);

  it('reports as one line of JSON with --json', async () => {
    await runCrawl(
      {
        url: baseUrl,
        domains: ['links'],
        rate: 0,
        onProgress: () => undefined,
        limit: 2,
      },
      cwd,
    );

    const report = await runCrawl({ report: true, json: true }, cwd);

    expect(report.trim().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(report) as {
      name: string;
      pages: number;
      storePath: string;
    };
    expect(parsed.name).toBe(host);
    expect(parsed.pages).toBe(2);
    expect(parsed.storePath).toContain(host);
    // The contract pc_crawl depends on: a summary and a path to the store,
    // never the dataset. A 200-page dataset is not a tool result.
    expect(report).not.toContain('records');
    expect(report.length).toBeLessThan(2_000);
  }, 60_000);

  it('errors clearly when there is nothing to report on', async () => {
    await expect(runCrawl({ report: true }, cwd)).rejects.toThrow(/no crawl/i);
  });
});

describe('pc crawl dispatch', () => {
  it('needs a url', async () => {
    await expect(dispatch(['crawl'], cwd)).rejects.toThrow(/Usage: pc crawl/);
  });

  it('parses the domain, budget, and politeness flags', async () => {
    const output = await dispatch(
      [
        'crawl',
        baseUrl,
        '--links',
        '--limit',
        '2',
        '--depth',
        '1',
        '--rate',
        '0',
      ],
      cwd,
    );

    expect(output).toMatch(/pages\s+2/);
  }, 60_000);

  it('rejects a non-numeric budget rather than crawling forever', async () => {
    await expect(
      dispatch(['crawl', baseUrl, '--limit', 'lots'], cwd),
    ).rejects.toThrow(/--limit/);
  });

  it('routes --report to the report', async () => {
    await dispatch(
      ['crawl', baseUrl, '--links', '--limit', '1', '--rate', '0'],
      cwd,
    );

    const report = await dispatch(['crawl', '--report', '--json'], cwd);
    expect(JSON.parse(report).pages).toBe(1);
  }, 60_000);
});
