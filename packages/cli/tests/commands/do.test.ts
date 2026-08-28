import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { runOpen } from '../../src/commands/open.js';
import { CliError, runDo } from '../../src/commands/do.js';
import { readSession, writeSession, type Session } from '../../src/session.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(
  join(here, '../fixtures/static-article.html'),
  'utf8',
);

let server: Server;
let baseUrl: string;
let cwd: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/about') {
      res.end(
        '<!doctype html><html><body><main><h1>About Page</h1><p>Long enough body text to clear the empty-shell heuristic comfortably on this small fixture page too.</p></main></body></html>',
      );
      return;
    }
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quickcaps-do-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('runDo', () => {
  it('errors clearly on an unknown handle', async () => {
    await runOpen({ url: baseUrl }, cwd);
    await expect(runDo(99_999, cwd)).rejects.toThrow(CliError);
  });

  it('errors on a region handle, suggesting read instead', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const session = await readSession(cwd);
    const regionId = Object.values(session.handles).find(
      (h) => h.kind === 'region',
    )!.id;
    await expect(runDo(regionId, cwd)).rejects.toThrow(/read/);
  });

  it('navigates a link handle and overwrites the session at page 0', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const session = await readSession(cwd);
    const linkHandle = Object.values(session.handles).find(
      (h) => h.kind === 'link' && h.href === '/about',
    )!;
    const text = await runDo(linkHandle.id, cwd);
    expect(text).toContain('About Page');

    const updated = await readSession(cwd);
    expect(updated.url).toBe(`${baseUrl}about`);
    expect(updated.page).toBe(0);
  });

  it('returns a not-yet-supported message for a button handle without touching the session', async () => {
    const session: Session = {
      url: baseUrl,
      driver: 'static',
      ir: {
        metadata: {
          url: baseUrl,
          title: '',
          capturedAt: '2026-08-28T00:00:00.000Z',
          viewport: { width: 0, height: 0 },
          documentSize: { width: 0, height: 0 },
          devicePixelRatio: 1,
          userAgent: 'test',
          charset: 'utf-8',
          meta: {},
        },
        html: '<html></html>',
        regions: [],
        styles: [],
        assets: [],
        styleTally: {
          color: {},
          backgroundColor: {},
          borderColor: {},
          fontFamily: {},
          fontSize: {},
          lineHeight: {},
          fontWeight: {},
          spacing: {},
          borderRadius: {},
          boxShadow: {},
        },
        warnings: [],
      },
      page: 0,
      hasMore: false,
      handles: {
        1: { id: 1, kind: 'button', label: 'Submit' },
      },
    };
    await writeSession(cwd, session);

    const text = await runDo(1, cwd);
    expect(text).toBe(
      'not yet supported in this version — coming in a later phase',
    );

    const after = await readSession(cwd);
    expect(after.url).toBe(baseUrl);
  });
});
