import { readFile, mkdtemp, rm, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExtractDomain } from 'quick-caps-core/extract';
import {
  CrawlStore,
  createCrawlState,
  deriveCrawlName,
  latestCrawlName,
  listCrawls,
  readCrawlRecords,
  scanCrawlRecords,
  summarizeCrawl,
  type CrawlRecord,
} from '../../src/crawl/store.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-crawl-store-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function record(
  url: string,
  overrides: Partial<CrawlRecord> = {},
): CrawlRecord {
  return {
    url,
    depth: 0,
    at: '2026-08-31T00:00:00.000Z',
    outcome: { kind: 'fetched', driver: 'static' },
    ...overrides,
  };
}

describe('deriveCrawlName', () => {
  it('derives the name from the seed host', () => {
    expect(deriveCrawlName('https://Example.COM/products?page=2')).toBe(
      'example.com',
    );
  });

  it('keeps a port, which is part of which site this is', () => {
    expect(deriveCrawlName('http://127.0.0.1:8080/')).toBe('127.0.0.1-8080');
  });

  it('never produces a path separator from a hostile host', () => {
    expect(deriveCrawlName('http://a..b/x')).not.toContain('/');
  });
});

describe('CrawlStore', () => {
  it('writes under .quick-caps/crawls/<name>/ and self-gitignores', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');

    expect(store.dir).toBe(join(cwd, '.quick-caps', 'crawls', 'example.com'));
    expect(await readFile(join(cwd, '.quick-caps', '.gitignore'), 'utf8')).toBe(
      '*\n',
    );
  });

  it('appends one JSON line per page', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    await store.append(record('https://example.com/a'));
    await store.append(record('https://example.com/b'));

    const raw = await readFile(join(store.dir, 'records.jsonl'), 'utf8');
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
    const { records, unreadable } = await readCrawlRecords(store.dir);
    expect(records.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(unreadable).toBe(0);
  });

  it('keeps a failed page as a record with its error', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    await store.append(
      record('https://example.com/gone', {
        outcome: { kind: 'error', reason: 'fetch failed', detail: '404' },
      }),
    );

    const { records } = await readCrawlRecords(store.dir);
    expect(records[0]?.outcome).toEqual({
      kind: 'error',
      reason: 'fetch failed',
      detail: '404',
    });
  });

  // The case that matters: a killed process leaves a half-written last line.
  // Read what parses, report the rest — one truncated line must not cost the
  // caller the 180 records before it.
  it('reads every valid record when a killed process left a truncated last line', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    for (const url of ['/a', '/b', '/c']) {
      await store.append(record(`https://example.com${url}`));
    }
    const path = join(store.dir, 'records.jsonl');
    const size = (await readFile(path, 'utf8')).length;
    // Cut mid-way through the final record, newline included.
    await truncate(path, size - 12);

    const { records, unreadable } = await readCrawlRecords(store.dir);
    expect(records.map((entry) => entry.url)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(unreadable).toBe(1);
  });

  it('reports a corrupt line in the middle without stopping the scan', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    await store.append(record('https://example.com/a'));
    await writeFile(join(store.dir, 'records.jsonl'), '', { flag: 'a' });
    const path = join(store.dir, 'records.jsonl');
    const raw = await readFile(path, 'utf8');
    await writeFile(
      path,
      `${raw}{"url": "broken"\n${JSON.stringify(record('https://example.com/c'))}\n`,
    );

    const scanned: string[] = [];
    for await (const entry of scanCrawlRecords(path)) {
      scanned.push(entry.ok ? entry.record.url : `bad:${entry.line}`);
    }
    expect(scanned).toEqual([
      'https://example.com/a',
      'bad:2',
      'https://example.com/c',
    ]);
  });

  it('treats an absent record file as an empty crawl, not an error', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');

    const { records, unreadable } = await readCrawlRecords(store.dir);
    expect(records).toEqual([]);
    expect(unreadable).toBe(0);
  });

  it('round-trips state so a resume continues rather than restarts', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    const state = createCrawlState({
      name: 'example.com',
      seed: 'https://example.com/',
      domains: ['links'],
      limit: 10,
      maxDepth: 2,
      rate: 1,
      concurrency: 1,
      ignoreRobots: false,
    });
    state.frontier = {
      seedUrl: 'https://example.com/',
      seen: ['https://example.com/'],
      queue: [
        { url: 'https://example.com/a', depth: 1, reason: 'content-link' },
      ],
    };
    state.counters = { pages: 1, fetched: 1, errors: 0, skipped: 0 };
    await store.saveState(state);

    const reopened = await CrawlStore.open(cwd, 'example.com');
    const resumed = await reopened.readState();
    expect(resumed?.frontier.queue).toEqual([
      { url: 'https://example.com/a', depth: 1, reason: 'content-link' },
    ]);
    expect(resumed?.counters.pages).toBe(1);
  });

  it('leaves no partial state file behind (atomic write)', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    await store.saveState(
      createCrawlState({
        name: 'example.com',
        seed: 'https://example.com/',
        domains: [],
        limit: 1,
        maxDepth: 1,
        rate: 1,
        concurrency: 1,
        ignoreRobots: false,
      }),
    );

    const files = await listCrawls(cwd);
    expect(files).toEqual(['example.com']);
    await expect(
      readFile(join(store.dir, 'state.json.tmp'), 'utf8'),
    ).rejects.toThrow();
  });

  it('returns no state for a crawl that was never written', async () => {
    const store = await CrawlStore.open(cwd, 'never-run');
    expect(await store.readState()).toBeUndefined();
  });

  it('names the most recently updated crawl for a report without one', async () => {
    const older = await CrawlStore.open(cwd, 'older.example');
    const newer = await CrawlStore.open(cwd, 'newer.example');
    const base = {
      seed: 'https://example.com/',
      domains: [] as ExtractDomain[],
      limit: 1,
      maxDepth: 1,
      rate: 1,
      concurrency: 1,
      ignoreRobots: false,
    } as const;
    await older.saveState({
      ...createCrawlState({ ...base, name: 'older.example' }),
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await newer.saveState({
      ...createCrawlState({ ...base, name: 'newer.example' }),
      updatedAt: '2026-06-01T00:00:00.000Z',
    });

    expect(await latestCrawlName(cwd)).toBe('newer.example');
  });
});

describe('summarizeCrawl', () => {
  it('counts pages, per-domain coverage, and error and skip reasons', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    await store.append(
      record('https://example.com/a', {
        data: {
          links: { links: [], internalCount: 0, externalCount: 0, byHost: {} },
        },
      }),
    );
    await store.append(
      record('https://example.com/b', {
        outcome: { kind: 'error', reason: 'fetch failed', detail: '404' },
      }),
    );
    await store.append(
      record('https://example.com/c', {
        outcome: { kind: 'error', reason: 'fetch failed', detail: '404' },
      }),
    );
    await store.append(
      record('https://example.com/private', {
        outcome: { kind: 'skipped', reason: 'disallowed by robots.txt' },
      }),
    );

    const summary = await summarizeCrawl(store.dir, 'example.com');
    expect(summary.pages).toBe(4);
    expect(summary.fetched).toBe(1);
    expect(summary.errors).toBe(2);
    expect(summary.skipped).toBe(1);
    expect(summary.byDomain['links']).toBe(1);
    expect(summary.errorReasons['fetch failed']).toBe(2);
    expect(summary.skipReasons['disallowed by robots.txt']).toBe(1);
    expect(summary.unreadable).toBe(0);
  });

  it('reports a truncated tail as unreadable rather than failing', async () => {
    const store = await CrawlStore.open(cwd, 'example.com');
    await store.append(record('https://example.com/a'));
    const path = join(store.dir, 'records.jsonl');
    await writeFile(path, `${await readFile(path, 'utf8')}{"url":"cut`);

    const summary = await summarizeCrawl(store.dir, 'example.com');
    expect(summary.pages).toBe(1);
    expect(summary.unreadable).toBe(1);
  });
});
