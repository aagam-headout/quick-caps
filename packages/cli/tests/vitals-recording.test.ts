import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { runOpen } from '../src/commands/open.js';
import { runData } from '../src/commands/data.js';
import { readSession } from '../src/session.js';

/**
 * End-to-end evidence for the property the `vitals` domain exists for: what
 * reaches `session.ir.perf`, from a real Chromium loading a real page that
 * really shifts its layout after load.
 *
 * The accumulation rules themselves are proven browserlessly in
 * perf-observer.test.ts; what only a browser can prove is that the observer is
 * installed early enough to see a shift at all, and that the CLI's `--record`
 * arming reaches it.
 */

let server: Server;
let baseUrl: string;
let cwd: string;

/**
 * Shifts after load and paints a large element:
 *  - the 300px banner is inserted *above* existing content once `load` has
 *    fired, which pushes everything down — a layout shift with no user input,
 *    so it counts toward CLS;
 *  - the 600x400 block is the largest contentful paint candidate.
 */
const SHIFTING_PAGE = `<!doctype html>
<html><head><title>Shifting page</title><style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  #hero { width: 600px; height: 400px; background: #2b6cb0; color: #fff; }
  #banner { height: 300px; background: #f6ad55; }
</style></head>
<body>
  <main>
    <div id="hero">Large painted hero element</div>
    <p>${'Real body text that makes this a page rather than a shell. '.repeat(8)}</p>
  </main>
  <script>
    addEventListener('load', () => {
      setTimeout(() => {
        const banner = document.createElement('div');
        banner.id = 'banner';
        banner.textContent = 'Late banner that pushes the page down';
        document.body.insertBefore(banner, document.body.firstChild);
      }, 100);
    });
  </script>
</body></html>`;

/** No late insertion: the observer watches and sees nothing move, which is a
 * genuine CLS of 0 rather than an absence. */
const STABLE_PAGE = `<!doctype html>
<html><head><title>Stable page</title></head>
<body><main><div style="width:600px;height:400px;background:#2b6cb0">Large painted hero element</div>
<p>${'Real body text that makes this a page rather than a shell. '.repeat(8)}</p></main></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/stable' ? STABLE_PAGE : SHIFTING_PAGE);
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
  cwd = await mkdtemp(join(tmpdir(), 'quick-caps-vitals-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('pc open --record — vitals', () => {
  it('leaves ir.perf absent when the load was not armed', async () => {
    await runOpen({ url: baseUrl }, cwd);
    const session = await readSession(cwd);
    // Not an empty PerfReport, not a report of zeros: nobody was watching, and
    // the IR has to say exactly that.
    expect(session.ir.perf).toBeUndefined();
  }, 60_000);

  it('populates ir.perf from a real load when armed', async () => {
    await runOpen({ url: baseUrl, record: true }, cwd);
    const perf = (await readSession(cwd)).ir.perf;
    expect(perf).toBeDefined();
    expect(perf?.ttfbMs).not.toBeNull();
    expect(perf?.loadMs).not.toBeNull();
    expect(perf?.firstContentfulPaintMs).not.toBeNull();
    // LCP comes from the observer, which is the half a one-shot read cannot do.
    expect(perf?.largestContentfulPaintMs).not.toBeNull();
    // Headless Chromium supports all four entry types this observes.
    expect(perf?.unsupportedEntryTypes).toEqual([]);
  }, 60_000);

  it('records the shift a page performs after load as a non-zero CLS', async () => {
    await runOpen({ url: baseUrl, record: true }, cwd);
    const perf = (await readSession(cwd)).ir.perf;
    expect(typeof perf?.cumulativeLayoutShift).toBe('number');
    expect(perf?.cumulativeLayoutShift ?? 0).toBeGreaterThan(0);
    // A ratio, stored as a ratio. Rounding it would make this assertion fail
    // for every page whose CLS is under 0.5 — which is most of them.
    expect(Number.isInteger(perf?.cumulativeLayoutShift)).toBe(false);
  }, 60_000);

  it('records a stable page as a genuine CLS of 0, and INP as absent with no interaction', async () => {
    await runOpen({ url: `${baseUrl}stable`, record: true }, cwd);
    const perf = (await readSession(cwd)).ir.perf;
    expect(perf?.cumulativeLayoutShift).toBe(0);
    // Nothing was clicked, so there is no response latency to report. Absent,
    // never 0 — a 0 would read as an instantly responsive page.
    expect('interactionToNextPaintMs' in (perf ?? {})).toBe(false);
  }, 60_000);
});

describe('pc data --vitals', () => {
  it('reports the observed metrics after an armed open', async () => {
    const out = await runData(
      { url: baseUrl, domains: ['vitals'], record: true },
      cwd,
    );
    expect(out).toMatch(/lcp/);
    expect(out).toMatch(/cls/);
    expect(out).not.toMatch(/not recorded/);
  }, 60_000);

  it('says not-recorded after an unarmed open, rather than reporting zeros', async () => {
    const out = await runData({ url: baseUrl, domains: ['vitals'] }, cwd);
    expect(out).toMatch(/not recorded/);
  }, 60_000);

  it('names vitals as available in the summary only once it was recorded', async () => {
    const unarmed = await runData({ url: baseUrl, domains: [] }, cwd);
    expect(unarmed).toMatch(/available:/);
    await runOpen({ url: baseUrl, record: true }, cwd);
    const armed = await runData({ domains: [] }, cwd);
    expect(armed).toMatch(/vitals/);
  }, 90_000);
});
