import { createServer, type Server } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import { RECORDING_TOTAL_BODY_CAP_BYTES } from 'quick-caps-core/observe';
import { runOpen } from '../src/commands/open.js';
import { runCapture } from '../src/commands/capture.js';
import { runData } from '../src/commands/data.js';
import { readSession } from '../src/session.js';

/**
 * End-to-end evidence for the property the whole feature exists for: what
 * reaches `.quick-caps/session.json`. A real browser loads a real page that
 * puts a credential in both a header and a query parameter, and the
 * assertions read the written file as bytes — not the in-memory recording —
 * because "the secret never reaches disk" is a claim about the file.
 */

const SECRET = 'super-secret-token-abc123';
/** 250 kB each: under the per-body cap, so only the total cap can bound the
 * session file when the page issues twelve of them. */
const BIG_BODY_BYTES = 250 * 1024;
const BIG_BODY_COUNT = 12;

let server: Server;
let baseUrl: string;
let cwd: string;

function page(body: string): string {
  return `<!doctype html><html><head><title>Recorded</title></head><body><main><h1>Recorded page</h1><p>${'text '.repeat(60)}</p></main><script>${body}</script></body></html>`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/config') {
      // The secret is handed to the page rather than written into its markup:
      // `session.ir.html` stores the page verbatim by design, so a fixture
      // that inlined the token could never prove anything about redaction.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: SECRET }));
      return;
    }
    if (url.pathname === '/api/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'ada', access_token: SECRET }));
      return;
    }
    if (url.pathname === '/api/bulk') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ blob: 'x'.repeat(BIG_BODY_BYTES) }));
      return;
    }
    if (url.pathname === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      return;
    }
    if (url.pathname === '/bulk') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        page(
          `for (let i = 0; i < ${BIG_BODY_COUNT}; i++) { fetch('/api/bulk?i=' + i); }`,
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      page(
        `fetch('/api/config')
           .then((r) => r.json())
           .then((c) => fetch('/api/me?token=' + c.access_token + '&page=2', {
             headers: { authorization: 'Bearer ' + c.access_token },
           }));
         fetch('/logo.png');`,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}/`;
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-record-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function sessionPath(dir: string): string {
  return join(dir, '.quick-caps', 'session.json');
}

describe('pc open --record', () => {
  it('arms a browser session and records the traffic the page issued', async () => {
    await runOpen({ url: baseUrl, record: true }, cwd);
    const session = await readSession(cwd);

    expect(session.driver).toBe('playwright');
    const recording = session.ir.recording;
    expect(recording).toBeDefined();
    expect(recording?.redacted).toBe(true);
    const api = recording?.requests.find((r) => r.url.includes('/api/me'));
    expect(api).toBeDefined();
    expect(api?.status).toBe(200);
    expect(api?.body.kept).toBe(true);
    // Metadata for everything, bodies only for the text-ish types.
    const logo = recording?.requests.find((r) => r.url.includes('/logo.png'));
    expect(logo?.body).toMatchObject({ kept: false, reason: 'binary-type' });
  }, 60_000);

  it('never writes an Authorization header or a query-parameter token to disk', async () => {
    await runOpen({ url: baseUrl, record: true }, cwd);
    const raw = await readFile(sessionPath(cwd), 'utf8');
    expect(raw).not.toContain(SECRET);
    // Proof the requests really were recorded, so the assertion above is not
    // passing because nothing was captured at all. /api/config carried the
    // same secret in a kept JSON body, which is redacted by field name.
    expect(raw).toContain('/api/me');
    expect(raw).toContain('/api/config');
    expect(raw).toContain('[redacted]');
  }, 60_000);

  it('round-trips the credential with --no-redact', async () => {
    await runOpen({ url: baseUrl, record: true, noRedact: true }, cwd);
    const raw = await readFile(sessionPath(cwd), 'utf8');
    expect(raw).toContain(SECRET);
    const session = await readSession(cwd);
    expect(session.ir.recording?.redacted).toBe(false);
    const api = session.ir.recording?.requests.find((r) =>
      r.url.includes('/api/me'),
    );
    expect(api?.url).toContain(`token=${SECRET}`);
    expect(api?.requestHeaders['authorization']).toBe(`Bearer ${SECRET}`);
  }, 60_000);

  it('refuses --no-redact without --record, rather than accepting a flag that does nothing', async () => {
    await expect(
      runOpen({ url: baseUrl, noRedact: true }, cwd),
    ).rejects.toThrow(/--no-redact/);
  });

  it('refuses --record with --static', async () => {
    await expect(
      runOpen({ url: baseUrl, record: true, static: true }, cwd),
    ).rejects.toThrow(/--static/);
  });

  it('leaves the session unrecorded when not armed, rather than recording an empty one', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const session = await readSession(cwd);
    expect(session.ir.recording).toBeUndefined();
  }, 60_000);

  it('keeps the session file bounded when the page issues far more body bytes than the cap', async () => {
    await runOpen({ url: `${baseUrl}bulk`, record: true }, cwd);
    const session = await readSession(cwd);
    const recording = session.ir.recording;
    expect(recording).toBeDefined();
    expect(recording?.bodyBytes ?? 0).toBeLessThanOrEqual(
      RECORDING_TOTAL_BODY_CAP_BYTES,
    );

    const { size } = await stat(sessionPath(cwd));
    // The page offered ~3 MB of recordable bodies; the file has to stay near
    // the 2 MB cap plus the page's own html, not grow with the traffic.
    expect(size).toBeLessThan(RECORDING_TOTAL_BODY_CAP_BYTES + 512 * 1024);
  }, 60_000);
});

describe('pc capture --record', () => {
  it('arms the re-collection so the session ends up with a recording', async () => {
    await runOpen({ url: baseUrl }, cwd);
    await runCapture({ record: true }, cwd);
    const session = await readSession(cwd);
    expect(session.driver).toBe('playwright');
    expect(session.ir.recording).toBeDefined();
    // capture has no --no-redact: an archive-adjacent path always redacts.
    expect(session.ir.recording?.redacted).toBe(true);
    const raw = await readFile(sessionPath(cwd), 'utf8');
    expect(raw).not.toContain(SECRET);
  }, 90_000);
});

describe('pc data <url> --record', () => {
  it('arms the open it performs for the caller', async () => {
    await runData({ url: baseUrl, domains: [], record: true }, cwd);
    const session = await readSession(cwd);
    expect(session.ir.recording).toBeDefined();
    const raw = await readFile(sessionPath(cwd), 'utf8');
    expect(raw).not.toContain(SECRET);
  }, 60_000);
});
