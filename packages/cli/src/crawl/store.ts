import { createReadStream } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Warning } from 'quick-caps-core';
import type { DataReport, ExtractDomain } from 'quick-caps-core/extract';
import type { FrontierState } from './frontier.js';
import { CliError } from '../errors.js';

/**
 * The only unit in the crawler that touches disk.
 *
 * Append-oriented, one record per page as JSON Lines rather than one JSON
 * document: a crawl is long and interruptible, and an interruption at page
 * 180 of 200 must leave 180 *valid* records rather than one truncated
 * document that parses to nothing. It also means `pc crawl --report` streams
 * a summary instead of loading a 200-page dataset into memory.
 *
 * Layout, mirroring the session's (see session.ts) so a crawl store is the
 * same kind of thing in the same place:
 *
 *   .quick-caps/
 *     .gitignore        '*' — written on first use, as session.ts does
 *     crawls/<name>/
 *       records.jsonl   append-only, one JSON object per page
 *       state.json      the frontier, the seen set, and the counters
 */

/**
 * The frontier's own state, persisted verbatim. The frontier unit owns what is
 * in it — the seen set is keyed by its normalization, and a resume that
 * re-derived the shape here would drift from a live crawl's rules — so the
 * store persists it and interprets nothing but the queue's length.
 */
export type CrawlFrontierSnapshot = FrontierState;

export type CrawlOutcome =
  | { kind: 'fetched'; driver: 'static' | 'playwright' }
  /** A page that 404s, times out, or fails to parse. Recorded, never
   * omitted: a gap a caller can see is a fact, a gap it cannot see is a
   * lie. */
  | { kind: 'error'; reason: string; detail?: string }
  /** Not fetched at all, and why — robots, a stop condition, a scheme. */
  | { kind: 'skipped'; reason: string };

export type CrawlRecord = {
  url: string;
  depth: number;
  /** ISO timestamp of the fetch attempt, not of the write. */
  at: string;
  outcome: CrawlOutcome;
  /** The requested domains' reports, and only those. Absent on a page that
   * was never fetched. */
  data?: Partial<DataReport>;
  /** Extract-phase warnings for this page, kept beside the page they belong
   * to rather than aggregated: a domain that failed on one page of 200 is a
   * fact about that page. */
  warnings?: Warning[];
};

export type CrawlCounters = {
  /** Records written — fetched, errored, and skipped together. */
  pages: number;
  fetched: number;
  errors: number;
  skipped: number;
};

export type CrawlState = {
  name: string;
  seed: string;
  domains: ExtractDomain[];
  limit: number;
  maxDepth: number;
  /** Requests per second per host, 0 for "as fast as it goes". */
  rate: number;
  concurrency: number;
  ignoreRobots: boolean;
  startedAt: string;
  updatedAt: string;
  frontier: CrawlFrontierSnapshot;
  counters: CrawlCounters;
  /** Hrefs the frontier refused, tallied by reason. Counted rather than
   * recorded per href: 'already-seen' fires for every chrome link on every
   * page, so a record each would bury the dataset under its own bookkeeping,
   * while the tally still makes a thin crawl explicable. */
  discoverySkips?: Record<string, number>;
  /** Why the crawl stopped. A crawl that ends without one has not ended. */
  stopReason?: string;
};

const RECORDS_FILE = 'records.jsonl';
const STATE_FILE = 'state.json';

export type CreateCrawlStateInput = {
  name: string;
  seed: string;
  domains: ExtractDomain[];
  limit: number;
  maxDepth: number;
  rate: number;
  concurrency: number;
  ignoreRobots: boolean;
  now?: () => Date;
};

/** A fresh crawl's state. The frontier starts empty here rather than seeded:
 * the frontier unit owns seeding, and the runner writes its snapshot in. */
export function createCrawlState(input: CreateCrawlStateInput): CrawlState {
  const at = (input.now?.() ?? new Date()).toISOString();
  return {
    name: input.name,
    seed: input.seed,
    domains: [...input.domains],
    limit: input.limit,
    maxDepth: input.maxDepth,
    rate: input.rate,
    concurrency: input.concurrency,
    ignoreRobots: input.ignoreRobots,
    startedAt: at,
    updatedAt: at,
    frontier: { seedUrl: input.seed, seen: [], queue: [] },
    counters: { pages: 0, fetched: 0, errors: 0, skipped: 0 },
  };
}

/**
 * The default crawl name: the seed's host, which is what a person calls the
 * thing they crawled. The port is kept — `localhost:3000` and
 * `localhost:8080` are different sites — and anything that is not a
 * host character becomes a dash, so a hostile URL can never walk out of
 * `crawls/` via a path separator.
 */
export function deriveCrawlName(seed: string): string {
  let host: string;
  try {
    host = new URL(seed).host.toLowerCase();
  } catch {
    throw new CliError(`Not a URL: ${seed}`);
  }
  const name = host.replace(/[^a-z0-9.-]/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return name === '' ? 'crawl' : name;
}

function crawlsRoot(cwd: string): string {
  return join(cwd, '.quick-caps', 'crawls');
}

/** Same self-gitignore as session.ts writes, and the same file: a crawl
 * store is build output living beside the session, not a tracked artifact.
 * Written here too because a crawl can be the first thing a directory ever
 * does — `pc crawl` need not follow a `pc open`. */
async function ensureGitignore(cwd: string): Promise<void> {
  const path = join(cwd, '.quick-caps', '.gitignore');
  try {
    await access(path);
  } catch {
    await writeFile(path, '*\n', 'utf8');
  }
}

export class CrawlStore {
  private constructor(
    readonly dir: string,
    readonly name: string,
  ) {}

  /** Where a named crawl lives, without creating anything — for a report
   * or a resume that has to look before it writes. */
  static dirFor(cwd: string, name: string): string {
    return join(crawlsRoot(cwd), name);
  }

  static async open(cwd: string, name: string): Promise<CrawlStore> {
    const dir = CrawlStore.dirFor(cwd, name);
    await mkdir(dir, { recursive: true });
    await ensureGitignore(cwd);
    return new CrawlStore(dir, name);
  }

  get recordsPath(): string {
    return join(this.dir, RECORDS_FILE);
  }

  get statePath(): string {
    return join(this.dir, STATE_FILE);
  }

  /** One line, one page. `appendFile` rather than a held-open stream so a
   * killed process can only ever truncate the line it was writing. */
  async append(record: CrawlRecord): Promise<void> {
    await appendFile(this.recordsPath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** Atomic, exactly as writeSession is: a state file half-written by a
   * kill would make the crawl unresumable, which is the one thing the state
   * file exists to prevent. */
  async saveState(state: CrawlState): Promise<void> {
    const tmpPath = `${this.statePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state), 'utf8');
    await rename(tmpPath, this.statePath);
  }

  async readState(): Promise<CrawlState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      return JSON.parse(raw) as CrawlState;
    } catch (error) {
      throw new CliError(
        `Crawl state at ${this.statePath} is unreadable (corrupt or truncated) — the records beside it are still readable with 'pc crawl --report ${this.name}'.`,
        { cause: error },
      );
    }
  }
}

export type ScannedRecord =
  | { ok: true; record: CrawlRecord }
  /** A line that did not parse, with its 1-based number so a report can say
   * where. The scan continues past it. */
  | { ok: false; line: number; reason: string };

/**
 * Streams the record file line by line. A line that does not parse — the
 * half-written last line a killed process leaves — is yielded as unreadable
 * and the scan continues, because 199 good records must not be lost to the
 * 200th. An absent file is an empty crawl, not an error: a crawl killed
 * before its first page wrote nothing.
 */
export async function* scanCrawlRecords(
  recordsPath: string,
): AsyncGenerator<ScannedRecord> {
  let stream;
  try {
    await access(recordsPath);
    stream = createReadStream(recordsPath, { encoding: 'utf8' });
  } catch {
    return;
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const line of lines) {
      number += 1;
      if (line.trim() === '') continue;
      try {
        yield { ok: true, record: JSON.parse(line) as CrawlRecord };
      } catch (error) {
        yield {
          ok: false,
          line: number,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The whole dataset in memory. For tests and small crawls only — the
 * report path streams instead, which is the reason the store is JSON Lines. */
export async function readCrawlRecords(
  dir: string,
): Promise<{ records: CrawlRecord[]; unreadable: number }> {
  const records: CrawlRecord[] = [];
  let unreadable = 0;
  for await (const scanned of scanCrawlRecords(join(dir, RECORDS_FILE))) {
    if (scanned.ok) records.push(scanned.record);
    else unreadable += 1;
  }
  return { records, unreadable };
}

export type CrawlSummary = {
  name: string;
  storePath: string;
  pages: number;
  fetched: number;
  errors: number;
  skipped: number;
  /** Pages carrying each requested domain's report. A domain that reported
   * on 3 of 40 pages is the number worth seeing. */
  byDomain: Partial<Record<ExtractDomain, number>>;
  errorReasons: Record<string, number>;
  skipReasons: Record<string, number>;
  /** Lines that did not parse — a truncated tail is one, and saying so is
   * how the store stays honest about what it could not read. */
  unreadable: number;
  warnings: number;
  seed?: string;
  startedAt?: string;
  updatedAt?: string;
  stopReason?: string;
  /** URLs still queued: what a `--resume` would pick up. */
  queued?: number;
  /** Hrefs the frontier refused, by reason — why a crawl is as short as it
   * is, without a record per refused link. */
  discoverySkips?: Record<string, number>;
};

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** State as a fact rather than a requirement: a store with records and an
 * unreadable or absent state file is still worth reporting on, so this
 * swallows both rather than failing the report. */
async function readStateAt(dir: string): Promise<CrawlState | undefined> {
  try {
    return JSON.parse(
      await readFile(join(dir, STATE_FILE), 'utf8'),
    ) as CrawlState;
  } catch {
    return undefined;
  }
}

/**
 * Summarizes a crawl store by streaming it: one record in memory at a time,
 * whatever the dataset's size. The state file is read for the crawl's own
 * facts (seed, stop reason, what is still queued), and its absence is not
 * fatal — a store with records and no state is still reportable.
 */
export async function summarizeCrawl(
  dir: string,
  name: string,
): Promise<CrawlSummary> {
  const summary: CrawlSummary = {
    name,
    storePath: dir,
    pages: 0,
    fetched: 0,
    errors: 0,
    skipped: 0,
    byDomain: {},
    errorReasons: {},
    skipReasons: {},
    unreadable: 0,
    warnings: 0,
  };

  for await (const scanned of scanCrawlRecords(join(dir, RECORDS_FILE))) {
    if (!scanned.ok) {
      summary.unreadable += 1;
      continue;
    }
    const { record } = scanned;
    summary.pages += 1;
    summary.warnings += record.warnings?.length ?? 0;
    switch (record.outcome.kind) {
      case 'fetched':
        summary.fetched += 1;
        break;
      case 'error':
        summary.errors += 1;
        bump(summary.errorReasons, record.outcome.reason);
        break;
      case 'skipped':
        summary.skipped += 1;
        bump(summary.skipReasons, record.outcome.reason);
        break;
    }
    for (const [domain, report] of Object.entries(record.data ?? {})) {
      if (domain === 'warnings' || report === undefined) continue;
      const key = domain as ExtractDomain;
      summary.byDomain[key] = (summary.byDomain[key] ?? 0) + 1;
    }
  }

  const state = await readStateAt(dir);
  if (state !== undefined) {
    summary.seed = state.seed;
    summary.startedAt = state.startedAt;
    summary.updatedAt = state.updatedAt;
    summary.queued = state.frontier.queue.length;
    if (state.stopReason !== undefined) summary.stopReason = state.stopReason;
    if (state.discoverySkips !== undefined) {
      summary.discoverySkips = state.discoverySkips;
    }
  }
  return summary;
}

/** Every crawl in this directory, by name. */
export async function listCrawls(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(crawlsRoot(cwd), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * The crawl `pc crawl --report` means when no name is given: the most
 * recently updated one. Chosen over "the only one" so the common case — a
 * crawl, then a report on it — needs no name even in a directory that has
 * crawled twice.
 */
export async function latestCrawlName(
  cwd: string,
): Promise<string | undefined> {
  let best: { name: string; updatedAt: string } | undefined;
  for (const name of await listCrawls(cwd)) {
    const state = await readStateAt(CrawlStore.dirFor(cwd, name));
    const updatedAt = state?.updatedAt ?? '';
    if (best === undefined || updatedAt > best.updatedAt) {
      best = { name, updatedAt };
    }
  }
  return best?.name;
}
