import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFileSync as readFileSyncForInteraction } from 'node:fs';
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
import { flattenRegions } from 'quickcaps-core/distill';
import { runOpen } from '../../src/commands/open.js';
import { CliError, runDo } from '../../src/commands/do.js';
import { readSession, writeSession } from '../../src/session.js';

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
});

const toggleHtml = readFileSyncForInteraction(
  join(here, '../fixtures/toggle-button.html'),
  'utf8',
);
const searchHtml = readFileSyncForInteraction(
  join(here, '../fixtures/search-form.html'),
  'utf8',
);

describe('runDo — button/input interaction', () => {
  it('clicks a button handle and the resulting distillation reflects the click', async () => {
    const toggleServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(toggleHtml);
    });
    await new Promise<void>((resolve) => toggleServer.listen(0, resolve));
    const address = toggleServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const toggleUrl = `http://127.0.0.1:${address.port}/`;

    try {
      await runOpen({ url: toggleUrl }, cwd);
      const session = await readSession(cwd);
      const buttonHandle = Object.values(session.handles).find(
        (h) => h.kind === 'button',
      )!;

      const text = await runDo(buttonHandle.id, cwd);
      expect(text).toContain('Revealed by clicking the button.');
    } finally {
      await new Promise((resolve) => toggleServer.close(resolve));
    }
  }, 30_000);

  it('fills an input handle with a value, submits, and navigates to the result', async () => {
    const searchServer = createServer((req, res) => {
      if (req.url?.startsWith('/results')) {
        const q =
          new URL(req.url, 'http://localhost').searchParams.get('q') ?? '';
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          `<!doctype html><html><body><main><h1>Results for: ${q}</h1></main></body></html>`,
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(searchHtml);
    });
    await new Promise<void>((resolve) => searchServer.listen(0, resolve));
    const address = searchServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const searchUrl = `http://127.0.0.1:${address.port}/`;

    try {
      await runOpen({ url: searchUrl }, cwd);
      const session = await readSession(cwd);
      const inputHandle = Object.values(session.handles).find(
        (h) => h.kind === 'input',
      )!;

      const text = await runDo(inputHandle.id, cwd, 'wireless mouse');
      expect(text).toContain('Results for: wireless mouse');

      const updated = await readSession(cwd);
      expect(updated.url).toContain('/results');
    } finally {
      await new Promise((resolve) => searchServer.close(resolve));
    }
  }, 30_000);

  it('clicks a wrapper-collapsed button (label inside a <span>) and the resulting distillation reflects the click', async () => {
    // <button><span>Show More</span></button> — the button has no own text
    // and exactly one child, so it's wrapper-collapsed away as a *Region*
    // (regions.ts's isWrapper()); the button action itself must still carry
    // a domPath that resolves to the real <button>, not silently fall back
    // to clicking its container.
    const wrappedToggleHtml =
      '<!doctype html><html><body><main>' +
      '<button id="reveal" onclick="document.getElementById(\'revealed\').textContent = \'Revealed by clicking the button.\'">' +
      '<span>Show More</span></button>' +
      '<div id="revealed"></div></main></body></html>';
    const wrappedToggleServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(wrappedToggleHtml);
    });
    await new Promise<void>((resolve) =>
      wrappedToggleServer.listen(0, resolve),
    );
    const address = wrappedToggleServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const wrappedToggleUrl = `http://127.0.0.1:${address.port}/`;

    try {
      await runOpen({ url: wrappedToggleUrl }, cwd);
      const session = await readSession(cwd);
      const buttonHandle = Object.values(session.handles).find(
        (h) => h.kind === 'button',
      )!;

      const text = await runDo(buttonHandle.id, cwd);
      expect(text).toContain('Revealed by clicking the button.');
    } finally {
      await new Promise((resolve) => wrappedToggleServer.close(resolve));
    }
  }, 30_000);

  it('errors clearly on a button/input action whose domPath is missing (a stale pre-domPath session)', async () => {
    const toggleServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(toggleHtml);
    });
    await new Promise<void>((resolve) => toggleServer.listen(0, resolve));
    const address = toggleServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('expected the test server to bind a port');
    }
    const toggleUrl = `http://127.0.0.1:${address.port}/`;

    try {
      await runOpen({ url: toggleUrl }, cwd);
      const session = await readSession(cwd);
      const buttonHandle = Object.values(session.handles).find(
        (h) => h.kind === 'button',
      )!;

      // Simulate a .quickcaps/session.json written before
      // ActionRef.domPath existed (or any other cause of a missing
      // domPath): strip the owning action's domPath before writing back.
      for (const { region } of flattenRegions(session.ir.regions)) {
        for (const action of region.actions) {
          if (action.id === buttonHandle.id) {
            // @ts-expect-error simulating a stale session missing domPath
            delete action.domPath;
          }
        }
      }
      await writeSession(cwd, session);

      await expect(runDo(buttonHandle.id, cwd)).rejects.toThrow(
        /location is missing from this session/,
      );
    } finally {
      await new Promise((resolve) => toggleServer.close(resolve));
    }
  }, 30_000);
});
