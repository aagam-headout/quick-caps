# Agent CLI Phase A — Playwright + Static Drivers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the `PageDriver` seam is real by implementing it twice more — once over Playwright's bundled Chromium, once over a browser-less static fetch — in a new `packages/cli` package, backed by a driver-conformance test suite both new drivers (and the existing `FakeDriver`) run against.

**Architecture:** `PageDriver` (packages/core/src/driver.ts) is already the only thing the capture pipeline depends on for browser access; `FakeDriver` (test-only, linkedom) and `ChromeDriver` (apps/extension) already implement it. This phase adds `PlaywrightDriver` and `StaticDriver` under `packages/cli/src/drivers/`, plus a shared conformance suite (`packages/cli/tests/driver-conformance.ts`) that runs the same assertions against every driver. `fetchAssetBytes`/`fetchAssetText` — currently extension-local — move into `packages/core` first, since every driver from this point on needs the exact same fetch-with-cap logic and it has no host dependency that would violate the core boundary rule.

**Tech Stack:** Playwright (`playwright`, bundled Chromium), `linkedom` (already a root devDependency, becomes a real dependency of `packages/cli`), Vitest, the existing pnpm workspace conventions.

**Spec:** `docs/superpowers/specs/2026-08-27-page-capture-design.md`, §12.3 "Phase A — the Playwright driver". Per that spec, Phase A does not get its own design doc — this plan is the only additional artifact.

**Deviation from the spec's literal wording:** §12.3 states Phase A's acceptance test is "the same `PageIR` goldens, produced through a different driver." That's not achievable yet: `collectFromDocument` (which produces a `PageIR`) is never called *through* `PageDriver` — the extension runs it by injecting a built script into the page (`chrome.scripting.executeScript`), not via `driver.evaluate`, because `evaluate`'s "no closures" constraint can't carry an entire imported function across the page boundary without bundling it first. Building that bundler is Phase C's job (the CLI orchestration layer), not Phase A's. This plan's actual acceptance test — a shared conformance suite every `PageDriver` implementation passes — is the achievable subset of that intent: proof the interface is real across three hosts, which is what "the seam was proven continuously... rather than discovered here" is about. Full `PageIR`-through-a-driver goldens become possible, and worth adding, once Phase C exists.

## Global Constraints

- `packages/core/src/**` may not touch `chrome`, `browser`, `window`, `document`, `globalThis`, `process`, `require`, `__dirname`, or import a `node:*` built-in (enforced by `eslint.config.js`'s `no-restricted-globals`/`no-restricted-imports`, proven live by `packages/core/tests/boundary.test.ts`). `fetch`, `AbortController`, `setTimeout`, `TextDecoder` are not on that list and are available in both a browser and Node ≥18, so `http.ts` is allowed to live there.
- Workspace conventions: every package is `"type": "module"`, `"private": true`, `"main"`/`"exports"` both point at `./src/index.ts` (no build step for library packages — only the extension has one), `tsconfig.json` extends `../../tsconfig.base.json`.
- Root `tsconfig.base.json` already includes `packages/*/src` and `packages/*/tests` by glob — a new package needs no tsconfig include change.
- Root `vitest.config.ts` already includes `packages/*/tests/**/*.test.ts` by glob — a new package's tests run under the existing `pnpm test` with no config change, and default to the `node` environment (correct for this phase — nothing here needs jsdom).
- `pnpm-workspace.yaml` already globs `packages/*` — no change needed to register the new package, only `pnpm install` to link it.
- Never commit without running `pnpm typecheck`, `pnpm lint`, and `pnpm test` clean first (matches this repo's existing pattern; see recent commits `76404f3`, `e112679`).

---

### Task 1: Move `fetchAssetBytes`/`fetchAssetText` into `packages/core`

**Files:**
- Create: `packages/core/src/http.ts`
- Create: `packages/core/tests/http.test.ts`
- Modify: `packages/core/src/index.ts` (export the two functions)
- Modify: `apps/extension/src/background/chrome-driver.ts:7` (import path)
- Modify: `apps/extension/src/background/resource-proxy.ts:2` (import path)
- Modify: `apps/extension/src/offscreen/index.ts:2` (import path)
- Delete: `apps/extension/src/lib/http.ts`

**Interfaces:**
- Consumes: `AssetBytes`, `FetchOptions` (already exported from `packages/core/src/driver.ts`, already re-exported from `packages/core/src/index.ts`)
- Produces: `fetchAssetBytes(url: string, options: FetchOptions, fetchImpl?: typeof fetch): Promise<AssetBytes>` and `fetchAssetText(url: string, options: FetchOptions, fetchImpl?: typeof fetch): Promise<string>`, both exported from `@page-capture/core`. Task 3 (PlaywrightDriver) and Task 4 (StaticDriver) both call `fetchAssetBytes`.

- [ ] **Step 1: Create `packages/core/src/http.ts` with the moved, unchanged logic**

```typescript
import type { AssetBytes, FetchOptions } from './driver.js';

/**
 * A credentialed-but-cookieless asset fetch with a hard size cap.
 *
 * Shared by every PageDriver implementation — the extension's ChromeDriver
 * and offscreen document, the CLI's PlaywrightDriver and StaticDriver — so
 * the cap and credential policy live in exactly one place. `fetch`,
 * `AbortController`, and `setTimeout` are web-standard globals available in
 * both a browser and Node 18+, so this needs no host-specific branch.
 */
export async function fetchAssetBytes(
  url: string,
  options: FetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<AssetBytes> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // A capture must not carry the user's session anywhere.
      credentials: 'omit',
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    // Refuse on the declared length before downloading: reading the body
    // first would defeat the purpose of a cap.
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > options.maxBytes) {
      throw new Error(`exceeds per-asset cap: declared ${declared} bytes`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > options.maxBytes) {
      throw new Error(`exceeds per-asset cap: ${buffer.byteLength} bytes`);
    }
    return {
      url,
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type'),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAssetText(
  url: string,
  options: FetchOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const asset = await fetchAssetBytes(url, options, fetchImpl);
  return new TextDecoder().decode(asset.bytes);
}
```

- [ ] **Step 2: Write `packages/core/tests/http.test.ts`**

This function had no dedicated test file before the move (it was only exercised indirectly through extension tests) — give it direct coverage now that it lives somewhere with a stated host-agnostic contract.

```typescript
import { describe, expect, it, vi } from 'vitest';
import { fetchAssetBytes, fetchAssetText } from '../src/http.js';

function fakeFetch(
  init: Partial<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: Uint8Array;
  }>,
): typeof fetch {
  const body = init.body ?? new Uint8Array([1, 2, 3]);
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: {
      get: (name: string) => (init.headers ?? {})[name.toLowerCase()] ?? null,
    },
    arrayBuffer: async () => body.buffer.slice(0, body.byteLength),
  })) as unknown as typeof fetch;
}

describe('fetchAssetBytes', () => {
  it('returns bytes and content type on success', async () => {
    const impl = fakeFetch({ headers: { 'content-type': 'image/png' } });
    const result = await fetchAssetBytes(
      'https://x.test/a.png',
      { timeoutMs: 100, maxBytes: 1000 },
      impl,
    );
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.contentType).toBe('image/png');
  });

  it('rejects a non-ok response', async () => {
    const impl = fakeFetch({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 100, maxBytes: 1000 }, impl),
    ).rejects.toThrow('404 Not Found');
  });

  it('rejects on a declared content-length over the cap, before downloading', async () => {
    const impl = fakeFetch({ headers: { 'content-length': '99999' } });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 100, maxBytes: 10 }, impl),
    ).rejects.toThrow('exceeds per-asset cap');
  });

  it('rejects when the actual body exceeds the cap despite no declared length', async () => {
    const impl = fakeFetch({ body: new Uint8Array(20) });
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 100, maxBytes: 10 }, impl),
    ).rejects.toThrow('exceeds per-asset cap');
  });

  it('aborts after the timeout', async () => {
    const hanging: typeof fetch = () => new Promise(() => {});
    await expect(
      fetchAssetBytes('https://x.test/a.png', { timeoutMs: 20, maxBytes: 1000 }, hanging),
    ).rejects.toThrow();
  });
});

describe('fetchAssetText', () => {
  it('decodes the fetched bytes as UTF-8', async () => {
    const impl = fakeFetch({ body: new TextEncoder().encode('hello') });
    const text = await fetchAssetText(
      'https://x.test/a.css',
      { timeoutMs: 100, maxBytes: 1000 },
      impl,
    );
    expect(text).toBe('hello');
  });
});
```

- [ ] **Step 3: Run the new test to verify it passes**

Run: `npx vitest run packages/core/tests/http.test.ts`
Expected: 6 tests pass.

- [ ] **Step 4: Export from `packages/core/src/index.ts`**

Add near the other named exports:

```typescript
export { fetchAssetBytes, fetchAssetText } from './http.js';
```

- [ ] **Step 5: Repoint the three extension importers and delete the old file**

`apps/extension/src/background/chrome-driver.ts:7` — change:
```typescript
import { fetchAssetBytes } from '../lib/http.js';
```
to:
```typescript
import { fetchAssetBytes } from '@page-capture/core';
```

`apps/extension/src/background/resource-proxy.ts:2` — same change (`fetchAssetBytes` from `@page-capture/core`).

`apps/extension/src/offscreen/index.ts:2` — same change, but for `fetchAssetText`.

Then delete `apps/extension/src/lib/http.ts`.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx vitest run` then `pnpm typecheck`
Expected: all existing tests still pass (nothing in the extension tested `lib/http.ts` directly — it was only exercised through `chrome-driver.test.ts`, `resource-proxy` tests, and `offscreen-handler.test.ts`, all of which mock `fetchImpl` and don't care where the function lives); typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(core): move fetchAssetBytes/fetchAssetText into core

Every PageDriver from here on (PlaywrightDriver, StaticDriver, in addition
to the existing ChromeDriver) needs the same credentialed, capped fetch.
Nothing in it touches a host global fetch/AbortController/setTimeout
don't have, so it belongs in core, not duplicated per host."
```

---

### Task 2: Scaffold `packages/cli`

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/index.ts`
- Modify: root `package.json` (no change needed — `pnpm typecheck` already runs `tsc --noEmit -p tsconfig.base.json`, which globs `packages/*/src`; nothing package-specific to add)

**Interfaces:**
- Produces: an installable, empty `@page-capture/cli` workspace package that `packages/cli/src/drivers/*` (Tasks 3–4) and `packages/cli/tests/*` (Task 3 onward) live under.

- [ ] **Step 1: Write `packages/cli/package.json`**

```json
{
  "name": "@page-capture/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@page-capture/core": "workspace:*",
    "linkedom": "^0.18.5",
    "playwright": "^1.48.0"
  }
}
```

`linkedom` moves from a root-only devDependency (test fixtures) to a real dependency here — `StaticDriver` (Task 4) ships it as runtime DOM parsing, not test scaffolding.

- [ ] **Step 2: Write `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

(Identical in shape to `packages/core/tsconfig.json` — same convention.)

- [ ] **Step 3: Write a placeholder `packages/cli/src/index.ts`**

```typescript
export {};
```

(Tasks 3 and 4 replace this with real driver exports.)

- [ ] **Step 4: Install, linking the new workspace package**

Run: `pnpm install`
Expected: `playwright`'s own npm package downloads (small — a few MB); this does **not** yet download the Chromium binary. `pnpm-lock.yaml` updates; no error.

- [ ] **Step 5: Confirm the browser binary download with the user before running it**

`npx playwright install chromium` downloads Chromium (~150–300 MB depending on platform) into `~/Library/Caches/ms-playwright` (macOS) or the platform equivalent. This is a real, sizeable network action outside the repo — stop here and ask before running it, per the standing rule on confirming outward-facing or heavy actions. Task 3's tests cannot run without it.

- [ ] **Step 6: Commit the scaffold**

```bash
git add -A
git commit -m "feat(cli): scaffold packages/cli for the Playwright and static drivers"
```

---

### Task 3: `PlaywrightDriver`

**Files:**
- Create: `packages/cli/src/drivers/playwright-driver.ts`
- Create: `packages/cli/tests/fixtures/static.html`
- Create: `packages/cli/tests/driver-conformance.ts`
- Create: `packages/cli/tests/playwright-driver.test.ts`
- Modify: `packages/cli/src/index.ts` (export `PlaywrightDriver`)

**Interfaces:**
- Consumes: `PageDriver`, `AssetBytes`, `FetchOptions`, `Viewport` (`@page-capture/core`); `fetchAssetBytes` (`@page-capture/core`, from Task 1)
- Produces: `class PlaywrightDriver implements PageDriver`, constructed as `new PlaywrightDriver(page: import('playwright').Page)`; `runDriverConformance(name: string, factory: () => Promise<{ driver: PageDriver; teardown: () => Promise<void> }>, capabilities?: { screenshot?: boolean }): void` — a Vitest `describe` block Task 4 also calls.

- [ ] **Step 1: Write the fixture page**

`packages/cli/tests/fixtures/static.html`:

```html
<!doctype html>
<html>
  <head>
    <title>CLI Driver Fixture</title>
  </head>
  <body>
    <h1 id="heading">Driver Fixture</h1>
    <img src="/pixel.png" width="1" height="1" alt="" />
  </body>
</html>
```

- [ ] **Step 2: Write the shared conformance suite**

`packages/cli/tests/driver-conformance.ts` — the same assertions run against every `PageDriver` implementation, so a new driver proves itself by passing this file rather than by a bespoke test:

```typescript
import { describe, expect, it } from 'vitest';
import type { PageDriver } from '@page-capture/core';

export type ConformanceFactory = () => Promise<{
  driver: PageDriver;
  teardown: () => Promise<void>;
}>;

export type ConformanceCapabilities = {
  /** StaticDriver has no renderer, so full-page screenshots are N/A, not a bug. */
  screenshot?: boolean;
};

/**
 * Runs the same behavioral assertions against any PageDriver. Existence of
 * this file, and every driver passing it, is the proof that the driver seam
 * (packages/core/src/driver.ts) is real: the capture pipeline can run against
 * any of them unchanged.
 */
export function runDriverConformance(
  name: string,
  factory: ConformanceFactory,
  capabilities: ConformanceCapabilities = {},
): void {
  describe(`${name} (driver conformance)`, () => {
    it('evaluates a self-contained function against the page', async () => {
      const { driver, teardown } = await factory();
      try {
        const title = await driver.evaluate(
          () => document.querySelector('h1')?.textContent ?? '',
        );
        expect(title).toBe('Driver Fixture');
      } finally {
        await teardown();
      }
    });

    it('reports a viewport with numeric width and height', async () => {
      const { driver, teardown } = await factory();
      try {
        const viewport = await driver.viewport();
        expect(typeof viewport.width).toBe('number');
        expect(typeof viewport.height).toBe('number');
      } finally {
        await teardown();
      }
    });

    it('records a scroll position it was moved to', async () => {
      const { driver, teardown } = await factory();
      try {
        await driver.scrollTo(0, 40);
        const viewport = await driver.viewport();
        expect(viewport.scrollY).toBe(40);
      } finally {
        await teardown();
      }
    });

    if (capabilities.screenshot !== false) {
      it('captures a non-empty full-page screenshot', async () => {
        const { driver, teardown } = await factory();
        try {
          const png = await driver.screenshotFullPage();
          expect(png.byteLength).toBeGreaterThan(0);
          // PNG magic number.
          expect(Array.from(png.slice(0, 4))).toEqual([137, 80, 78, 71]);
        } finally {
          await teardown();
        }
      });
    }
  });
}
```

- [ ] **Step 3: Write `PlaywrightDriver`**

```typescript
import type { Page } from 'playwright';
import {
  fetchAssetBytes,
  type AssetBytes,
  type FetchOptions,
  type PageDriver,
  type Viewport,
} from '@page-capture/core';

/**
 * PageDriver over a live Playwright page. Every core function already proven
 * against FakeDriver runs against this one unchanged — see
 * packages/cli/tests/driver-conformance.ts.
 */
export class PlaywrightDriver implements PageDriver {
  constructor(private readonly page: Page) {}

  async evaluate<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn);
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    // Playwright's browser-context request API shares the page's cookies and
    // auth state but is not subject to the page's own CORS policy — the same
    // "credentialed, cross-origin-capable" property ChromeDriver gets from
    // the extension's host permissions.
    //
    // fetchAssetBytes enforces its timeout by aborting an AbortSignal, which
    // this adapter has no way to forward into Playwright's request API — so
    // `timeout` is passed straight through to Playwright itself instead,
    // which enforces it independently. fetchAssetBytes's own timer still
    // runs and still cleans up; whichever of the two fires first is the one
    // that rejects, which is fine, since both are set to the same duration.
    return fetchAssetBytes(
      url,
      options,
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = typeof input === 'string' ? input : input.toString();
        const response = await this.page.context().request.fetch(target, {
          headers: init?.headers as Record<string, string> | undefined,
          timeout: options.timeoutMs,
        });
        return new Response(await response.body(), {
          status: response.status(),
          headers: response.headers(),
        });
      }) as typeof fetch,
    );
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    return this.page.screenshot({ fullPage: true, type: 'png' });
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.page.evaluate(([px, py]) => window.scrollTo(px, py), [x, y]);
  }

  async viewport(): Promise<Viewport> {
    const size = this.page.viewportSize() ?? { width: 0, height: 0 };
    const metrics = await this.page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
    return { width: size.width, height: size.height, ...metrics };
  }
}
```

- [ ] **Step 4: Write `packages/cli/tests/playwright-driver.test.ts`**

```typescript
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { PlaywrightDriver } from '../src/drivers/playwright-driver.js';
import { runDriverConformance } from './driver-conformance.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(join(here, 'fixtures/static.html'), 'utf8');

let server: Server;
let baseUrl: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/pixel.png') {
      // A 1x1 transparent PNG, so screenshotFullPage and asset-fetch tests
      // hit a real (tiny) binary response rather than a 404.
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixtureHtml);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected the test server to bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

runDriverConformance('PlaywrightDriver', async () => {
  const page = await browser.newPage();
  await page.goto(baseUrl);
  return {
    driver: new PlaywrightDriver(page),
    teardown: () => page.close(),
  };
});
```

- [ ] **Step 5: Export from `packages/cli/src/index.ts`**

```typescript
export { PlaywrightDriver } from './drivers/playwright-driver.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run packages/cli/tests/playwright-driver.test.ts`
Expected: 4 tests pass (`PlaywrightDriver (driver conformance)`, all four assertions). Requires the Chromium binary from Task 2 Step 5 — if it's missing, the error names `playwright install` as the fix.

- [ ] **Step 7: Run the full suite, typecheck, and lint**

Run: `npx vitest run && pnpm typecheck && pnpm lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): implement PlaywrightDriver, proven by a shared driver-conformance suite"
```

---

### Task 4: `StaticDriver`

**Files:**
- Create: `packages/cli/src/drivers/static-driver.ts`
- Create: `packages/cli/tests/static-driver.test.ts`
- Modify: `packages/cli/src/index.ts` (export `StaticDriver`)

**Interfaces:**
- Consumes: `PageDriver`, `fetchAssetBytes` (`@page-capture/core`); `runDriverConformance` (Task 3, `packages/cli/tests/driver-conformance.ts`); `linkedom`'s `parseHTML`
- Produces: `class StaticDriver implements PageDriver`, constructed as `new StaticDriver(html: string)`; a static async factory `StaticDriver.fetch(url: string): Promise<StaticDriver>` that fetches `url` and parses the response (this is the actual no-browser fast path the spec's `--static` flag will call in Phase C — this task builds the driver, not the flag).

- [ ] **Step 1: Write `StaticDriver`**

```typescript
import { parseHTML } from 'linkedom';
import {
  fetchAssetBytes,
  type AssetBytes,
  type FetchOptions,
  type PageDriver,
  type Viewport,
} from '@page-capture/core';

/**
 * PageDriver over a linkedom-parsed document with no browser and no layout
 * engine — the fast path for pages that don't need rendering (spec §12.1:
 * only-cli's ergonomics for the cases that don't need rendered-DOM fidelity).
 *
 * `screenshotFullPage` throws rather than returning empty bytes: there is
 * nothing to screenshot, and a caller that asked for one has a real bug to
 * fix (falling back to PlaywrightDriver), not a value to silently accept.
 */
export class StaticDriver implements PageDriver {
  private readonly window: Window & typeof globalThis;
  private readonly document: Document;
  private scroll = { x: 0, y: 0 };

  constructor(html: string) {
    const parsed = parseHTML(html);
    this.window = parsed.window as unknown as Window & typeof globalThis;
    this.document = parsed.document as unknown as Document;
  }

  static async fetch(url: string): Promise<StaticDriver> {
    const asset = await fetchAssetBytes(url, {
      timeoutMs: 15_000,
      maxBytes: 20 * 1024 * 1024,
    });
    return new StaticDriver(new TextDecoder().decode(asset.bytes));
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousDocument = globals['document'];
    const previousWindow = globals['window'];
    globals['document'] = this.document;
    globals['window'] = this.window;
    try {
      return fn();
    } finally {
      globals['document'] = previousDocument;
      globals['window'] = previousWindow;
    }
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    return fetchAssetBytes(url, options);
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    throw new Error(
      'StaticDriver has no renderer — use PlaywrightDriver for a screenshot',
    );
  }

  async scrollTo(x: number, y: number): Promise<void> {
    this.scroll = { x, y };
  }

  async viewport(): Promise<Viewport> {
    return {
      // linkedom has no layout engine — these are the only two dimensions it
      // can answer honestly, and both are 0 for a page with no styled boxes.
      width: 0,
      height: 0,
      documentWidth: this.document.documentElement.scrollWidth,
      documentHeight: this.document.documentElement.scrollHeight,
      scrollX: this.scroll.x,
      scrollY: this.scroll.y,
      devicePixelRatio: 1,
    };
  }
}
```

- [ ] **Step 2: Write `packages/cli/tests/static-driver.test.ts`**

```typescript
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
```

- [ ] **Step 3: Export from `packages/cli/src/index.ts`**

```typescript
export { PlaywrightDriver } from './drivers/playwright-driver.js';
export { StaticDriver } from './drivers/static-driver.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/cli/tests/static-driver.test.ts`
Expected: 4 tests pass (3 conformance — evaluate, viewport, scrollTo, screenshot skipped by the `capabilities.screenshot: false` guard — plus the explicit screenshot-rejection test).

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `npx vitest run && pnpm typecheck && pnpm lint`
Expected: all clean, including `FakeDriver`'s existing tests (untouched) — three drivers now exist, all satisfying the same interface.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): implement StaticDriver, the no-browser fast path"
```

---

## What Phase A deliberately does not cover

- **No CLI commands** (`open`/`do`/`read`/…). That's Phase C, gets its own plan, depends on Phase B (distillation) existing first.
- **No `collectFromDocument` run through a driver.** Core's actual DOM-collection is invoked by running code *inside* the page (the extension does this via `chrome.scripting.executeScript`, injecting a built `collector.js`; Playwright's equivalent is `page.addScriptTag`/`page.evaluate` with a bundled script, not a driver method). That orchestration belongs to Phase C, which is the thing that actually calls `open <url>`. Phase A's job is narrower and now done: prove `PageDriver` is real across three hosts.
- **No `pc mcp` / MCP adapter.** Phase D, thin wrapper over Phase C, explicitly stated in the spec as needing no separate plan either — comes after C.
