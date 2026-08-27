# Page Capture v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chrome Web Store publishable extension that captures a page's full front-end — HTML, CSS, JS, images, fonts — to the user's disk, configurable by checkbox, built on a host-agnostic core.

**Architecture:** A pnpm workspace with two packages. `packages/core` holds all extraction and transformation logic as pure functions over a single typed representation (`PageIR`), touches no host API, and is tested in Node with `linkedom`. `apps/extension` is one implementation of the `PageDriver` interface, over `chrome.scripting`/`chrome.tabs`/an offscreen document. Large payloads never cross a `sendMessage` boundary: the in-page collector returns a plan, and the service worker fetches bytes itself.

**Tech Stack:** TypeScript (strict), pnpm workspaces, Vite + `@crxjs/vite-plugin`, React 19, Tailwind CSS v4, `zod`, `fflate`, Vitest + `linkedom`, Playwright, ESLint + Prettier, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-27-page-capture-design.md`

## Global Constraints

- **Node 22+, pnpm 9+.** Package manager is pinned via `packageManager` in the root `package.json`.
- **TypeScript `strict: true`** everywhere. No `any` in committed code; `unknown` plus a narrowing check instead.
- **`packages/core` may not reference `chrome`, `window`, `document`, `globalThis`, or any Node built-in.** Enforced by ESLint (Task 1), CI fails on violation. Core receives a DOM or a driver as a parameter, never reaches for a global.
- **Core tests use no `chrome.*` mock.** A core test needing one is a design failure — fix the design, not the test.
- **Runtime dependencies are limited to:** `react`, `react-dom`, `zod`, `fflate`, `geist`. Dev-only: `linkedom`, Vitest, Playwright, Vite, `@crxjs/vite-plugin`, Tailwind, ESLint, Prettier, TypeScript. Any addition beyond this list needs justification in the PR description.
- **No remote resource loading, ever.** Fonts are self-hosted from the `geist` npm package; the extension CSP forbids remote loads and a store reviewer will check.
- **No telemetry, analytics, or network request** except fetching the assets of the page the user is capturing.
- **Install-time permissions are exactly:** `activeTab`, `scripting`, `storage`, `downloads`, `offscreen`. `<all_urls>` is an `optional_host_permission` requested at capture time.
- **Size and concurrency defaults:** 6 concurrent asset fetches, 10 s per-asset timeout, 1 retry, 5 MB per-asset cap, 50 MB total cap, 500-entry log ring buffer. All configurable through settings.
- **A capture degrades, it never collapses.** Any single asset failure is a structured `Warning`, never a thrown error that aborts the capture.
- **Commit style:** Conventional Commits with a scope — `feat(core): …`, `fix(extension): …`. Imperative subject, no trailing period.

---

## File Structure

**`packages/core`** — no host APIs, unit-tested in Node:

| File | Responsibility |
| --- | --- |
| `src/ir.ts` | `PageIR`, `Region`, `AssetRef`, `StyleSource`, `Warning`, `LogEntry` types. Types only, no logic |
| `src/driver.ts` | `PageDriver` interface and its parameter/return types |
| `src/settings.ts` | `zod` schemas for capture settings, defaults, parse helpers |
| `src/collect.ts` | The standalone injectable collector. Zero imports at runtime |
| `src/regions.ts` | Region tree construction: roles, boxes, text density, numbered handles |
| `src/assets.ts` | Asset fetching policy: concurrency, timeout, retry, caps |
| `src/inline.ts` | URL absolutization, stylesheet and asset inlining, inert-mode transforms |
| `src/bundle.ts` | Single-file HTML and zip assembly, filename sanitization |
| `src/tokens.ts` | `styleTally` to `tokens.json`: normalization and frequency ranking |
| `src/theme.ts` | The Geist token table plus contrast math. Consumed by the extension's CSS build |
| `src/index.ts` | Public surface. The extension imports only from here |
| `tests/fake-driver.ts` | A `PageDriver` implementation over fixtures. Proof the seam is real |
| `tests/fixtures/` | Three fixture pages: static, SPA-shaped, image-heavy |

**`apps/extension`** — one `PageDriver` implementation plus UI:

| File | Responsibility |
| --- | --- |
| `manifest.config.ts` | MV3 manifest as typed config for `@crxjs/vite-plugin` |
| `src/background/index.ts` | Service worker entry, message routing, capture orchestration |
| `src/background/chrome-driver.ts` | `PageDriver` over `chrome.scripting`, `chrome.tabs`, offscreen |
| `src/background/permissions.ts` | Optional host permission check and request flow |
| `src/background/restricted.ts` | Restricted-URL detection with specific reasons |
| `src/background/session.ts` | Phase checkpointing to `chrome.storage.session` for worker-death resume |
| `src/content/recorder.ts` | `document_start` MAIN-world console/network ring buffer |
| `src/offscreen/index.ts` | Screenshot stitching, zip assembly, object URL creation |
| `src/popup/App.tsx` | The capture screen: toggles, output mode, progress, warnings |
| `src/popup/components/` | `Checkbox`, `RadioGroup`, `Progress`, `WarningList`, `ThemeToggle` |
| `src/popup/use-capture.ts` | Port lifecycle and progress state hook |
| `src/lib/messages.ts` | Typed port contracts between popup, worker, offscreen |
| `src/styles/tokens.css` | CSS custom properties generated from `core/theme.ts` |
| `e2e/` | Playwright specs and locally served fixture pages |

Phases: **1** = Tasks 1–3 (foundation), **2** = Tasks 4–10 (core, fully tested with no browser), **3** = Tasks 11–16 (extension), **4** = Task 17 (release readiness). At the end of Phase 2 you have a tested library; at the end of Phase 3 a working extension.

---

## Phase 1 — Foundation

### Task 1: Workspace, tooling, and the core boundary rule

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `.github/workflows/ci.yml`
- Test: `packages/core/tests/boundary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `pnpm -w test`, `pnpm -w lint`, `pnpm -w typecheck` script surface used by every later task. Workspace package name `@page-capture/core`.

The boundary rule is the deliverable here, not the scaffold. Without it, "core touches no host API" is a comment that rots within a week. We test it by asserting the ESLint config actually rejects a violating file.

- [ ] **Step 1: Create the workspace root**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

`package.json`:

```json
{
  "name": "page-capture",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.base.json",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.13.0",
    "eslint": "^9.13.0",
    "linkedom": "^0.18.5",
    "prettier": "^3.3.3",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.11.0",
    "vitest": "^2.1.4"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["packages/*/src", "packages/*/tests"]
}
```

**Implementation note (deviation from the first draft of this plan):** an earlier
version set `"types": []` here to keep ambient Node and Chrome types out of core.
That does not work, because this project also compiles `packages/core/tests`,
and those tests legitimately import `node:fs` — the fake driver reads fixtures
from disk. With `types: []` the test files fail to typecheck.

The boundary is enforced by ESLint instead, which is the stronger mechanism
anyway: it distinguishes `src/` from `tests/`, which a tsconfig-wide `types`
setting cannot. Add `"@types/node": "^22.8.0"` to the root devDependencies and
`"type": "module"` to the root `package.json` (the latter silences a Node
warning when ESLint loads the flat config).

- [ ] **Step 2: Create the core package skeleton**

`packages/core/package.json`:

```json
{
  "name": "@page-capture/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "fflate": "^0.8.2",
    "zod": "^3.23.8"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "tests"]
}
```

`packages/core/src/index.ts`:

```ts
export {};
```

- [ ] **Step 3: Write the ESLint config with the core boundary rule**

`eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const forbiddenInCore = [
  'chrome',
  'browser',
  'window',
  'document',
  'globalThis',
  'process',
  'require',
  '__dirname',
];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.js'],
  },
  {
    files: ['packages/core/src/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': ['error', ...forbiddenInCore],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'core must not use Node built-ins' },
          ],
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
```

- [ ] **Step 4: Write the failing test that proves the rule bites**

`packages/core/tests/boundary.test.ts`:

ESLint 9 resolves the flat config from the working directory and applies the
`files` patterns against the `filePath` you pass to `lintText`, so no temporary
file on disk is needed — pass the code as text and claim a path inside
`packages/core/src`.

```ts
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

/**
 * Lints `code` as if it were a file under packages/core/src, so the boundary
 * rules apply to it. This test file itself is exempt from those rules — only
 * src/ is constrained — and it exists to prove the rules actually bite rather
 * than sitting inert in the config.
 */
async function lintAsCoreSource(code: string): Promise<ESLint.LintResult> {
  const eslint = new ESLint();
  const [result] = await eslint.lintText(code, {
    filePath: 'packages/core/src/probe.ts',
  });
  if (!result) throw new Error('eslint returned no result');
  return result;
}

describe('core boundary rule', () => {
  it('rejects a core source file that touches document', async () => {
    const [result] = await lintCoreSource(
      'export const t = () => document.title;',
    );
    const ids = result!.messages.map((m) => m.ruleId);
    expect(ids).toContain('no-restricted-globals');
  });

  it('rejects a core source file importing a Node built-in', async () => {
    const [result] = await lintCoreSource(
      "import { readFile } from 'node:fs/promises';\nexport const t = readFile;",
    );
    const ids = result!.messages.map((m) => m.ruleId);
    expect(ids).toContain('no-restricted-imports');
  });

  it('accepts a core source file that takes its DOM as a parameter', async () => {
    const [result] = await lintCoreSource(
      'export const title = (doc: { title: string }) => doc.title;',
    );
    expect(result!.errorCount).toBe(0);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm install && pnpm vitest run packages/core/tests/boundary.test.ts`
Expected: FAIL — before Step 3's config is in place the assertions find no `no-restricted-globals` message.

If you wrote Step 3 first, do not skip this: comment out the
`no-restricted-globals` line, run the suite, and confirm exactly the two
rejection tests fail while the acceptance test still passes. Then restore it. A
rule test that has never been seen failing is not evidence of anything.

- [ ] **Step 6: Add `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['packages/*/src/**'] },
  },
});
```

- [ ] **Step 7: Run the full gate**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`
Expected: all three pass.

- [ ] **Step 8: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm -w format:check
      - run: pnpm -w lint
      - run: pnpm -w typecheck
      - run: pnpm -w test -- --coverage
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore(repo): scaffold pnpm workspace with enforced core boundary"
```

---

### Task 2: `PageIR` types and settings schemas

**Files:**
- Create: `packages/core/src/ir.ts`, `packages/core/src/settings.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/settings.test.ts`

**Interfaces:**
- Consumes: Task 1's workspace.
- Produces: every type the rest of the plan uses. Exact names below — later tasks import these and no others:
  `PageIR`, `PageMetadata`, `Region`, `ActionRef`, `AssetRef`, `AssetKind`, `StyleSource`, `StyleTally`, `LogEntry`, `Warning`, `WarningPhase`, `CaptureSettings`, `captureSettingsSchema`, `defaultSettings`, `parseSettings`.

- [ ] **Step 1: Write `ir.ts`**

```ts
export type WarningPhase =
  | 'collect'
  | 'permissions'
  | 'assets'
  | 'styles'
  | 'screenshot'
  | 'bundle'
  | 'download';

export type Warning = {
  phase: WarningPhase;
  url?: string;
  reason: string;
  detail?: string;
};

export type PageMetadata = {
  url: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  documentSize: { width: number; height: number };
  devicePixelRatio: number;
  userAgent: string;
  charset: string;
  meta: Record<string, string>;
};

export type AssetKind = 'image' | 'font' | 'script' | 'media' | 'stylesheet';

export type AssetRef = {
  url: string;
  kind: AssetKind;
  /** Where it was referenced from, for warning messages. */
  referencedBy: string;
};

export type StyleSource =
  | { kind: 'inline'; text: string; index: number }
  | { kind: 'same-origin'; text: string; href: string }
  | { kind: 'cross-origin'; href: string };

export type StyleTallyKey =
  | 'color'
  | 'backgroundColor'
  | 'borderColor'
  | 'fontFamily'
  | 'fontSize'
  | 'lineHeight'
  | 'fontWeight'
  | 'spacing'
  | 'borderRadius'
  | 'boxShadow';

/** Normalized value to occurrence count, per property group. */
export type StyleTally = Record<StyleTallyKey, Record<string, number>>;

export type LogEntry =
  | {
      kind: 'console';
      level: 'log' | 'info' | 'warn' | 'error' | 'debug';
      at: number;
      text: string;
    }
  | {
      kind: 'request';
      at: number;
      method: string;
      url: string;
      status: number | null;
      durationMs: number;
      size: number | null;
    }
  | { kind: 'error'; at: number; message: string; stack?: string };

export type ActionRef = {
  id: number;
  type: 'link' | 'button' | 'input';
  label: string;
  href?: string;
};

export type Region = {
  id: number;
  role: string;
  tag: string;
  box: { x: number; y: number; w: number; h: number };
  textLength: number;
  /** Text bytes per 1000 px² of area. Zero when area is zero. */
  textDensity: number;
  actions: ActionRef[];
  children: Region[];
};

export type PageIR = {
  metadata: PageMetadata;
  html: string;
  regions: Region[];
  styles: StyleSource[];
  assets: AssetRef[];
  styleTally: StyleTally;
  logs?: LogEntry[];
  warnings: Warning[];
};
```

- [ ] **Step 2: Write the failing settings test**

`packages/core/tests/settings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  parseSettings,
  captureSettingsSchema,
} from '../src/settings.js';

describe('capture settings', () => {
  it('defaults match the spec', () => {
    expect(defaultSettings.include.html).toBe(true);
    expect(defaultSettings.include.screenshot).toBe(false);
    expect(defaultSettings.inertSnapshot).toBe(true);
    expect(defaultSettings.output).toBe('single-file');
    expect(defaultSettings.limits).toEqual({
      concurrency: 6,
      assetTimeoutMs: 10_000,
      retries: 1,
      maxAssetBytes: 5 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      logRingSize: 500,
    });
  });

  it('fills missing fields from defaults', () => {
    const parsed = parseSettings({ output: 'zip' });
    expect(parsed.output).toBe('zip');
    expect(parsed.limits.concurrency).toBe(6);
  });

  it('rejects an unknown output mode', () => {
    expect(() => parseSettings({ output: 'pdf' })).toThrow();
  });

  it('rejects a non-positive concurrency', () => {
    expect(() => parseSettings({ limits: { concurrency: 0 } })).toThrow();
  });

  it('exposes a schema usable for generating a JSON schema later', () => {
    expect(captureSettingsSchema.safeParse(defaultSettings).success).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/settings.test.ts`
Expected: FAIL — `Cannot find module '../src/settings.js'`.

- [ ] **Step 4: Write `settings.ts`**

```ts
import { z } from 'zod';

export const captureSettingsSchema = z.object({
  include: z
    .object({
      html: z.boolean().default(true),
      styles: z.boolean().default(true),
      scripts: z.boolean().default(true),
      images: z.boolean().default(true),
      fonts: z.boolean().default(true),
      screenshot: z.boolean().default(false),
      tokens: z.boolean().default(false),
      metadata: z.boolean().default(true),
      logs: z.boolean().default(false),
      rawSources: z.boolean().default(false),
    })
    .default({}),
  scrollToLoadLazy: z.boolean().default(true),
  inertSnapshot: z.boolean().default(true),
  output: z.enum(['single-file', 'zip']).default('single-file'),
  limits: z
    .object({
      concurrency: z.number().int().positive().max(32).default(6),
      assetTimeoutMs: z.number().int().positive().default(10_000),
      retries: z.number().int().min(0).max(5).default(1),
      maxAssetBytes: z
        .number()
        .int()
        .positive()
        .default(5 * 1024 * 1024),
      maxTotalBytes: z
        .number()
        .int()
        .positive()
        .default(50 * 1024 * 1024),
      logRingSize: z.number().int().positive().max(5000).default(500),
    })
    .default({}),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});

export type CaptureSettings = z.infer<typeof captureSettingsSchema>;

export const defaultSettings: CaptureSettings = captureSettingsSchema.parse({});

/** Throws a ZodError on invalid input. Callers surface the message. */
export function parseSettings(input: unknown): CaptureSettings {
  return captureSettingsSchema.parse(input);
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/settings.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Export from the package surface**

`packages/core/src/index.ts`:

```ts
export type * from './ir.js';
export {
  captureSettingsSchema,
  defaultSettings,
  parseSettings,
  type CaptureSettings,
} from './settings.js';
```

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(core): add PageIR types and zod capture settings"
```

---

### Task 3: `PageDriver` interface and the fake driver

**Files:**
- Create: `packages/core/src/driver.ts`, `packages/core/tests/fake-driver.ts`
- Create: `packages/core/tests/fixtures/static.html`, `packages/core/tests/fixtures/spa.html`, `packages/core/tests/fixtures/gallery.html`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/fake-driver.test.ts`

**Interfaces:**
- Consumes: `Warning` from `ir.ts`.
- Produces: `PageDriver`, `AssetBytes`, `Viewport`, `FetchOptions`; and for tests, `FakeDriver` with constructor `new FakeDriver(opts: FakeDriverOptions)` and helpers `fixtureDocument(name)`.

The fake driver is not scaffolding — it is the continuously-run proof that the driver seam is real, and Task 6 onward test against it.

- [ ] **Step 1: Write `driver.ts`**

```ts
export type Viewport = {
  width: number;
  height: number;
  documentWidth: number;
  documentHeight: number;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
};

export type AssetBytes = {
  url: string;
  bytes: Uint8Array;
  contentType: string | null;
};

export type FetchOptions = {
  timeoutMs: number;
  maxBytes: number;
};

/**
 * Everything the capture pipeline needs from a browser. The extension
 * implements this over chrome.* APIs; other hosts implement it differently.
 * No implementation detail of any host may leak into these signatures.
 */
export interface PageDriver {
  /**
   * Run a self-contained function in the page's context and return its
   * serializable result. The function may not close over anything.
   */
  evaluate<T>(fn: () => T): Promise<T>;
  /** Fetch with host credentials, bypassing page CORS. Rejects on failure. */
  fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes>;
  /** Full-page PNG bytes. How it is produced is the host's problem. */
  screenshotFullPage(): Promise<Uint8Array>;
  scrollTo(x: number, y: number): Promise<void>;
  viewport(): Promise<Viewport>;
}
```

- [ ] **Step 2: Write the three fixture pages**

`packages/core/tests/fixtures/static.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Static Fixture</title>
    <link rel="stylesheet" href="/styles/site.css" />
    <link rel="stylesheet" href="https://cdn.example.com/vendor.css" />
    <style>
      body { color: #171717; font-family: Inter, sans-serif; }
    </style>
  </head>
  <body>
    <header><h1>Static Fixture</h1></header>
    <main>
      <article>
        <p>First paragraph of body text used for density scoring.</p>
        <img src="/img/hero.png" alt="Hero" />
        <a href="/next">Next page</a>
      </article>
    </main>
    <script src="/js/app.js"></script>
    <script>console.log('inline');</script>
  </body>
</html>
```

`packages/core/tests/fixtures/spa.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>SPA Fixture</title>
  </head>
  <body>
    <div id="root">
      <nav><a href="/a">A</a><a href="/b">B</a></nav>
      <section>
        <h2>Rendered by client JS</h2>
        <button type="button">Load more</button>
      </section>
    </div>
    <script src="/js/bundle.js" type="module"></script>
  </body>
</html>
```

`packages/core/tests/fixtures/gallery.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Gallery Fixture</title>
  </head>
  <body>
    <ul>
      <li><img src="/img/1.jpg" loading="lazy" srcset="/img/1.jpg 1x, /img/1@2x.jpg 2x" alt="1" /></li>
      <li><img src="/img/2.jpg" loading="lazy" alt="2" /></li>
      <li>
        <picture>
          <source srcset="/img/3.avif" type="image/avif" />
          <img src="/img/3.jpg" alt="3" />
        </picture>
      </li>
    </ul>
  </body>
</html>
```

- [ ] **Step 3: Write the failing fake driver test**

`packages/core/tests/fake-driver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeDriver, fixtureDocument } from './fake-driver.js';

describe('FakeDriver', () => {
  it('evaluates a self-contained function against a fixture document', async () => {
    const driver = new FakeDriver({ fixture: 'static' });
    const title = await driver.evaluate(() => globalThis.document.title);
    expect(title).toBe('Static Fixture');
  });

  it('serves configured asset bytes', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/img/hero.png': new Uint8Array([1, 2, 3]) },
    });
    const asset = await driver.fetchAsset('/img/hero.png', {
      timeoutMs: 100,
      maxBytes: 1000,
    });
    expect(asset.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects for an asset configured to fail', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      failures: { '/img/hero.png': 'network error' },
    });
    await expect(
      driver.fetchAsset('/img/hero.png', { timeoutMs: 100, maxBytes: 1000 }),
    ).rejects.toThrow('network error');
  });

  it('never resolves before the timeout for an asset configured to hang', async () => {
    const driver = new FakeDriver({ fixture: 'static', hangs: ['/slow.css'] });
    const race = await Promise.race([
      driver
        .fetchAsset('/slow.css', { timeoutMs: 20, maxBytes: 1000 })
        .then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('still-pending'), 50)),
    ]);
    expect(race).toBe('still-pending');
  });

  it('parses a fixture into a document with layout boxes', () => {
    const doc = fixtureDocument('gallery');
    expect(doc.querySelectorAll('img').length).toBe(4);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/fake-driver.test.ts`
Expected: FAIL — `Cannot find module './fake-driver.js'`.

- [ ] **Step 5: Write the fake driver**

`packages/core/tests/fake-driver.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import type {
  AssetBytes,
  FetchOptions,
  PageDriver,
  Viewport,
} from '../src/driver.js';

const here = dirname(fileURLToPath(import.meta.url));

export type FixtureName = 'static' | 'spa' | 'gallery';

export function fixtureHtml(name: FixtureName): string {
  return readFileSync(join(here, 'fixtures', `${name}.html`), 'utf8');
}

export function fixtureDocument(name: FixtureName): Document {
  const { document } = parseHTML(fixtureHtml(name));
  return document as unknown as Document;
}

export type FakeDriverOptions = {
  fixture: FixtureName;
  assets?: Record<string, Uint8Array>;
  failures?: Record<string, string>;
  hangs?: string[];
  viewport?: Partial<Viewport>;
  screenshot?: Uint8Array;
};

/**
 * A PageDriver over a linkedom-parsed fixture. Layout is faked: getBoundingClientRect
 * returns deterministic boxes derived from element order, which is enough for
 * density ranking tests and keeps them independent of a real layout engine.
 */
export class FakeDriver implements PageDriver {
  readonly fetches: string[] = [];
  private readonly window: Window & typeof globalThis;
  private scroll = { x: 0, y: 0 };

  constructor(private readonly options: FakeDriverOptions) {
    const parsed = parseHTML(fixtureHtml(options.fixture));
    this.window = parsed.window as unknown as Window & typeof globalThis;
    let index = 0;
    for (const el of parsed.document.querySelectorAll('*')) {
      const i = index++;
      Object.defineProperty(el, 'getBoundingClientRect', {
        value: () => ({
          x: 0,
          y: i * 40,
          width: 800,
          height: 40,
          top: i * 40,
          left: 0,
          right: 800,
          bottom: i * 40 + 40,
        }),
      });
    }
  }

  async evaluate<T>(fn: () => T): Promise<T> {
    const previous = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = this.window.document;
    (globalThis as Record<string, unknown>).window = this.window;
    try {
      return fn();
    } finally {
      (globalThis as Record<string, unknown>).document = previous;
    }
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    this.fetches.push(url);
    if (this.options.hangs?.includes(url)) {
      return new Promise<AssetBytes>(() => {});
    }
    const failure = this.options.failures?.[url];
    if (failure) throw new Error(failure);
    const bytes = this.options.assets?.[url];
    if (!bytes) throw new Error(`404 ${url}`);
    if (bytes.byteLength > options.maxBytes) {
      throw new Error(`too large: ${url}`);
    }
    return { url, bytes, contentType: null };
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    return this.options.screenshot ?? new Uint8Array([137, 80, 78, 71]);
  }

  async scrollTo(x: number, y: number): Promise<void> {
    this.scroll = { x, y };
  }

  async viewport(): Promise<Viewport> {
    return {
      width: 1280,
      height: 800,
      documentWidth: 1280,
      documentHeight: 2400,
      scrollX: this.scroll.x,
      scrollY: this.scroll.y,
      devicePixelRatio: 2,
      ...this.options.viewport,
    };
  }
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/fake-driver.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Export the driver types and run the full gate**

Add to `packages/core/src/index.ts`:

```ts
export type {
  PageDriver,
  AssetBytes,
  FetchOptions,
  Viewport,
} from './driver.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`
Expected: all pass. Confirm lint does not flag `tests/fake-driver.ts` for its Node imports — the boundary rule applies to `src/` only, by design.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): add PageDriver interface and fixture-backed fake driver"
```

---

## Phase 2 — Core (no browser involved)

### Task 4: `collectFromDocument` — DOM to `PageIR`

**Files:**
- Create: `packages/core/src/collect.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/collect.test.ts`

**Interfaces:**
- Consumes: `PageIR`, `PageMetadata`, `StyleSource`, `AssetRef`, `Warning` from `ir.ts`; `CaptureSettings` from `settings.ts`.
- Produces: `collectFromDocument(doc: Document, options: CollectOptions): PageIR` and `type CollectOptions`.

A design note that matters for §12 and is easy to get wrong: the spec calls the collector "a zero-import standalone function". That property belongs to the *built artifact*, not the source. Core keeps a pure, parameter-taking `collectFromDocument`; the extension's content-script entry (Task 13) is a three-line file that calls it with the real `document`, and Vite inlines core into that entry. The zero-import assertion is therefore a build test in Task 13, not a source constraint here. Written the other way — with the source reaching for the `document` global — core would need an exemption from its own boundary rule, and the rule would start eroding on day one.

Style and asset collection only records *references*; nothing is fetched here. Fetching is Task 6, and it happens on the host side of the driver.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/collect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { collectFromDocument } from '../src/collect.js';
import { fixtureDocument } from './fake-driver.js';
import { defaultSettings } from '../src/settings.js';

const options = {
  settings: defaultSettings,
  pageUrl: 'https://example.com/page',
  userAgent: 'test-agent',
  viewport: { width: 1280, height: 800 },
  documentSize: { width: 1280, height: 2400 },
  devicePixelRatio: 2,
  now: () => new Date('2026-08-27T10:00:00.000Z'),
};

describe('collectFromDocument', () => {
  it('captures metadata from the document and the host', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.metadata.title).toBe('Static Fixture');
    expect(ir.metadata.url).toBe('https://example.com/page');
    expect(ir.metadata.capturedAt).toBe('2026-08-27T10:00:00.000Z');
    expect(ir.metadata.charset).toBe('utf-8');
    expect(ir.metadata.devicePixelRatio).toBe(2);
  });

  it('serializes the live DOM into html', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.html).toContain('<h1>Static Fixture</h1>');
    expect(ir.html.startsWith('<html')).toBe(true);
  });

  it('records inline styles as text and cross-origin sheets as href only', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    const inline = ir.styles.filter((s) => s.kind === 'inline');
    expect(inline).toHaveLength(1);
    expect(inline[0]!.kind === 'inline' && inline[0]!.text).toContain('#171717');

    const cross = ir.styles.filter((s) => s.kind === 'cross-origin');
    expect(cross.map((s) => s.href)).toEqual([
      'https://cdn.example.com/vendor.css',
    ]);
  });

  it('classifies a same-origin stylesheet link as an asset to fetch', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    const sheets = ir.assets.filter((a) => a.kind === 'stylesheet');
    expect(sheets.map((a) => a.url)).toEqual([
      'https://example.com/styles/site.css',
    ]);
  });

  it('absolutizes asset urls against the page url', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    const images = ir.assets.filter((a) => a.kind === 'image');
    expect(images.map((a) => a.url)).toEqual([
      'https://example.com/img/hero.png',
    ]);
    const scripts = ir.assets.filter((a) => a.kind === 'script');
    expect(scripts.map((a) => a.url)).toEqual(['https://example.com/js/app.js']);
  });

  it('collects every srcset candidate and picture source', () => {
    const ir = collectFromDocument(fixtureDocument('gallery'), options);
    const urls = ir.assets.filter((a) => a.kind === 'image').map((a) => a.url);
    expect(urls).toContain('https://example.com/img/1@2x.jpg');
    expect(urls).toContain('https://example.com/img/3.avif');
    expect(urls).toContain('https://example.com/img/3.jpg');
  });

  it('deduplicates repeated asset references', () => {
    const doc = fixtureDocument('gallery');
    const ir = collectFromDocument(doc, options);
    const urls = ir.assets.map((a) => a.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('omits asset kinds the settings exclude', () => {
    const ir = collectFromDocument(fixtureDocument('static'), {
      ...options,
      settings: {
        ...defaultSettings,
        include: { ...defaultSettings.include, images: false, scripts: false },
      },
    });
    expect(ir.assets.some((a) => a.kind === 'image')).toBe(false);
    expect(ir.assets.some((a) => a.kind === 'script')).toBe(false);
    expect(ir.assets.some((a) => a.kind === 'stylesheet')).toBe(true);
  });

  it('warns rather than throwing on a malformed url', () => {
    const doc = fixtureDocument('static');
    const img = doc.createElement('img');
    img.setAttribute('src', 'http://[bad');
    doc.body.append(img);
    const ir = collectFromDocument(doc, options);
    expect(ir.warnings.some((w) => w.phase === 'collect')).toBe(true);
    expect(ir.assets.some((a) => a.url.includes('[bad'))).toBe(false);
  });

  it('returns an empty tally when no computedStyle reader is supplied', () => {
    const ir = collectFromDocument(fixtureDocument('static'), options);
    expect(ir.styleTally.color).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/collect.test.ts`
Expected: FAIL — `Cannot find module '../src/collect.js'`.

- [ ] **Step 3: Write `collect.ts`**

```ts
import type {
  AssetKind,
  AssetRef,
  PageIR,
  PageMetadata,
  StyleSource,
  StyleTally,
  Warning,
} from './ir.js';
import type { CaptureSettings } from './settings.js';

export type CollectOptions = {
  settings: CaptureSettings;
  pageUrl: string;
  userAgent: string;
  viewport: { width: number; height: number };
  documentSize: { width: number; height: number };
  devicePixelRatio: number;
  now?: () => Date;
  /** Injected because the global is unavailable to core by design. */
  computedStyle?: (el: Element) => Record<string, string>;
  logs?: PageIR['logs'];
};

export const emptyTally = (): StyleTally => ({
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
});

function absolutize(
  raw: string,
  base: string,
  warnings: Warning[],
  referencedBy: string,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) {
    return null;
  }
  try {
    return new URL(trimmed, base).href;
  } catch {
    warnings.push({
      phase: 'collect',
      url: trimmed,
      reason: 'unparseable url',
      detail: referencedBy,
    });
    return null;
  }
}

function srcsetUrls(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter(Boolean);
}

export function collectFromDocument(
  doc: Document,
  options: CollectOptions,
): PageIR {
  const warnings: Warning[] = [];
  const { settings, pageUrl } = options;
  const base = doc.querySelector('base')?.getAttribute('href') ?? pageUrl;

  const assets = new Map<string, AssetRef>();
  const addAsset = (
    raw: string | null,
    kind: AssetKind,
    referencedBy: string,
  ) => {
    if (!raw) return;
    const url = absolutize(raw, base, warnings, referencedBy);
    if (!url || assets.has(url)) return;
    assets.set(url, { url, kind, referencedBy });
  };

  const styles: StyleSource[] = [];
  let inlineIndex = 0;
  for (const el of doc.querySelectorAll('style')) {
    styles.push({
      kind: 'inline',
      text: el.textContent ?? '',
      index: inlineIndex++,
    });
  }

  if (settings.include.styles) {
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
      const href = link.getAttribute('href');
      const url = absolutize(href ?? '', base, warnings, 'link[rel=stylesheet]');
      if (!url) continue;
      if (new URL(url).origin === new URL(pageUrl).origin) {
        addAsset(url, 'stylesheet', 'link[rel=stylesheet]');
      } else {
        styles.push({ kind: 'cross-origin', href: url });
      }
    }
  }

  if (settings.include.images) {
    for (const img of doc.querySelectorAll('img')) {
      addAsset(img.getAttribute('src'), 'image', 'img[src]');
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        for (const url of srcsetUrls(srcset)) {
          addAsset(url, 'image', 'img[srcset]');
        }
      }
    }
    for (const source of doc.querySelectorAll('picture source[srcset]')) {
      for (const url of srcsetUrls(source.getAttribute('srcset') ?? '')) {
        addAsset(url, 'image', 'source[srcset]');
      }
    }
  }

  if (settings.include.scripts) {
    for (const script of doc.querySelectorAll('script[src]')) {
      addAsset(script.getAttribute('src'), 'script', 'script[src]');
    }
  }

  if (settings.include.images || settings.include.fonts) {
    for (const el of doc.querySelectorAll('video[src], audio[src], source[src]')) {
      addAsset(el.getAttribute('src'), 'media', el.tagName.toLowerCase());
    }
  }

  const meta: Record<string, string> = {};
  for (const tag of doc.querySelectorAll('meta[name][content]')) {
    const name = tag.getAttribute('name');
    const content = tag.getAttribute('content');
    if (name && content) meta[name] = content;
  }

  const metadata: PageMetadata = {
    url: pageUrl,
    title: doc.title,
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    viewport: options.viewport,
    documentSize: options.documentSize,
    devicePixelRatio: options.devicePixelRatio,
    userAgent: options.userAgent,
    charset: doc.characterSet?.toLowerCase() || 'utf-8',
    meta,
  };

  return {
    metadata,
    html: doc.documentElement.outerHTML,
    regions: [],
    styles,
    assets: [...assets.values()],
    styleTally: emptyTally(),
    ...(options.logs ? { logs: options.logs } : {}),
    warnings,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/collect.test.ts`
Expected: PASS, 10 tests. `characterSet` may be undefined under linkedom; the `|| 'utf-8'` fallback is why the charset assertion holds.

- [ ] **Step 5: Export and gate**

Add to `packages/core/src/index.ts`:

```ts
export { collectFromDocument, emptyTally, type CollectOptions } from './collect.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`
Expected: all pass. In particular lint must show zero `no-restricted-globals` errors for `collect.ts` — it annotates `Document` as a type but never touches the global.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): collect a PageIR from a document without touching globals"
```

---

### Task 5: Region tree, roles, and text density

**Files:**
- Create: `packages/core/src/regions.ts`
- Modify: `packages/core/src/collect.ts`, `packages/core/src/index.ts`
- Test: `packages/core/tests/regions.test.ts`

**Interfaces:**
- Consumes: `Region`, `ActionRef` from `ir.ts`.
- Produces: `buildRegions(doc: Document, options: RegionOptions): Region[]` and `type RegionOptions`. Called from `collectFromDocument`, which after this task populates `ir.regions`.

This is the part that looks skippable in v1 and is not: it is the representation §12's distillation scores over. v1 uses it lightly — the popup reports a region count — but building it later would mean a second traversal written against a different model.

Wrapper collapsing rule: an element with exactly one element child, no text of its own, and no role of its own is not a region; its child takes its place. That single rule removes most `<div><div><div>` nesting without any heuristic tuning.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/regions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildRegions } from '../src/regions.js';
import { fixtureDocument } from './fake-driver.js';

const options = { maxDepth: 12 };

describe('buildRegions', () => {
  it('assigns stable sequential ids in document order', () => {
    const regions = buildRegions(fixtureDocument('static'), options);
    const ids: number[] = [];
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        ids.push(r.id);
        walk(r.children);
      }
    };
    walk(regions);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids[0]).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('infers landmark roles from tag names', () => {
    const regions = buildRegions(fixtureDocument('static'), options);
    const roles = new Set<string>();
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        roles.add(r.role);
        walk(r.children);
      }
    };
    walk(regions);
    expect(roles).toContain('banner');
    expect(roles).toContain('main');
    expect(roles).toContain('article');
  });

  it('prefers an explicit role attribute over the inferred one', () => {
    const doc = fixtureDocument('static');
    doc.querySelector('main')!.setAttribute('role', 'search');
    const regions = buildRegions(doc, options);
    const main = regions.find((r) => r.tag === 'main');
    expect(main!.role).toBe('search');
  });

  it('collapses single-child wrapper elements', () => {
    const doc = fixtureDocument('spa');
    const regions = buildRegions(doc, options);
    // body > div#root > nav|section — the #root wrapper has two element
    // children so it survives; a single-child wrapper would not.
    const tags: string[] = [];
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        tags.push(r.tag);
        walk(r.children);
      }
    };
    walk(regions);
    expect(tags).toContain('nav');
    expect(tags).toContain('section');
  });

  it('numbers links and buttons as actions', () => {
    const regions = buildRegions(fixtureDocument('spa'), options);
    const actions: { id: number; type: string; label: string }[] = [];
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        actions.push(...r.actions);
        walk(r.children);
      }
    };
    walk(regions);
    expect(actions.map((a) => a.type)).toContain('link');
    expect(actions.map((a) => a.type)).toContain('button');
    expect(actions.find((a) => a.type === 'button')!.label).toBe('Load more');
    expect(new Set(actions.map((a) => a.id)).size).toBe(actions.length);
  });

  it('computes text density as text length per 1000 square pixels', () => {
    const doc = fixtureDocument('static');
    const regions = buildRegions(doc, options);
    const withText = [] as { textLength: number; textDensity: number }[];
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        if (r.textLength > 0) withText.push(r);
        walk(r.children);
      }
    };
    walk(regions);
    expect(withText.length).toBeGreaterThan(0);
    for (const r of withText) expect(r.textDensity).toBeGreaterThan(0);
  });

  it('reports zero density rather than Infinity for a zero-area region', () => {
    const doc = fixtureDocument('static');
    const el = doc.querySelector('h1')!;
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    });
    const regions = buildRegions(doc, options);
    const flat: { tag: string; textDensity: number }[] = [];
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        flat.push(r);
        walk(r.children);
      }
    };
    walk(regions);
    const h1 = flat.find((r) => r.tag === 'h1');
    expect(h1?.textDensity).toBe(0);
  });

  it('stops at maxDepth instead of recursing without bound', () => {
    const doc = fixtureDocument('static');
    let node = doc.body;
    for (let i = 0; i < 50; i++) {
      const div = doc.createElement('div');
      div.textContent = 'x';
      const spacer = doc.createElement('span');
      div.append(spacer);
      node.append(div);
      node = div;
    }
    const regions = buildRegions(doc, { maxDepth: 5 });
    const depth = (rs: typeof regions): number =>
      rs.length === 0 ? 0 : 1 + Math.max(...rs.map((r) => depth(r.children)));
    expect(depth(regions)).toBeLessThanOrEqual(5);
  });

  it('skips script, style, and head content entirely', () => {
    const regions = buildRegions(fixtureDocument('static'), options);
    const tags: string[] = [];
    const walk = (rs: typeof regions) => {
      for (const r of rs) {
        tags.push(r.tag);
        walk(r.children);
      }
    };
    walk(regions);
    expect(tags).not.toContain('script');
    expect(tags).not.toContain('style');
    expect(tags).not.toContain('head');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/regions.test.ts`
Expected: FAIL — `Cannot find module '../src/regions.js'`.

- [ ] **Step 3: Write `regions.ts`**

```ts
import type { ActionRef, Region } from './ir.js';

export type RegionOptions = {
  /** Hard recursion cap. Deeply nested pages are common; unbounded is not an option. */
  maxDepth: number;
};

const SKIP_TAGS = new Set([
  'script',
  'style',
  'link',
  'meta',
  'head',
  'title',
  'noscript',
  'template',
]);

const ROLE_BY_TAG: Record<string, string> = {
  header: 'banner',
  footer: 'contentinfo',
  nav: 'navigation',
  main: 'main',
  aside: 'complementary',
  form: 'form',
  section: 'region',
  article: 'article',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

function ownTextLength(el: Element): number {
  let total = 0;
  for (const node of el.childNodes) {
    if (node.nodeType === 3) total += (node.textContent ?? '').trim().length;
  }
  return total;
}

function box(el: Element) {
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
}

function labelFor(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Structural tree of the page. One collapsing rule keeps it shallow: an element
 * with exactly one element child, no own text, and no explicit role is a
 * wrapper, and its child takes its place.
 */
export function buildRegions(doc: Document, options: RegionOptions): Region[] {
  let nextRegionId = 1;
  let nextActionId = 1;

  const actionsIn = (el: Element): ActionRef[] => {
    const actions: ActionRef[] = [];
    for (const node of el.children) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'a' && node.hasAttribute('href')) {
        actions.push({
          id: nextActionId++,
          type: 'link',
          label: labelFor(node),
          href: node.getAttribute('href') ?? '',
        });
      } else if (tag === 'button') {
        actions.push({
          id: nextActionId++,
          type: 'button',
          label: labelFor(node),
        });
      } else if (tag === 'input' || tag === 'select' || tag === 'textarea') {
        actions.push({
          id: nextActionId++,
          type: 'input',
          label: node.getAttribute('name') ?? labelFor(node),
        });
      }
    }
    return actions;
  };

  const isWrapper = (el: Element): boolean =>
    el.children.length === 1 &&
    ownTextLength(el) === 0 &&
    !el.hasAttribute('role');

  const build = (el: Element, depth: number): Region[] => {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return [];
    if (depth > options.maxDepth) return [];

    if (isWrapper(el)) {
      const only = el.children[0];
      return only ? build(only, depth) : [];
    }

    const children: Region[] = [];
    for (const child of el.children) {
      children.push(...build(child, depth + 1));
    }

    const b = box(el);
    const area = b.w * b.h;
    const textLength = (el.textContent ?? '').trim().length;

    return [
      {
        id: nextRegionId++,
        role: el.getAttribute('role') ?? ROLE_BY_TAG[tag] ?? 'generic',
        tag,
        box: b,
        textLength,
        textDensity: area > 0 ? Number(((textLength * 1000) / area).toFixed(3)) : 0,
        actions: actionsIn(el),
        children,
      },
    ];
  };

  const roots: Region[] = [];
  for (const child of doc.body?.children ?? []) {
    roots.push(...build(child, 1));
  }
  return roots;
}
```

Ids are assigned after children are built, so they are not strictly document order for parents. The first test only asserts monotonic uniqueness of the flattened walk, which post-order satisfies — if you want parent-before-child numbering, assign the id before recursing and update the test's expectation of `ids[0]`.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/regions.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire regions into `collectFromDocument`**

In `packages/core/src/collect.ts`, add the import and populate the field:

```ts
import { buildRegions } from './regions.js';
```

Replace `regions: [],` with:

```ts
    regions: buildRegions(doc, { maxDepth: options.maxRegionDepth ?? 12 }),
```

And add to `CollectOptions`:

```ts
  maxRegionDepth?: number;
```

- [ ] **Step 6: Add the wiring test**

Append to `packages/core/tests/collect.test.ts`:

```ts
it('populates regions from the document', () => {
  const ir = collectFromDocument(fixtureDocument('static'), options);
  expect(ir.regions.length).toBeGreaterThan(0);
  expect(ir.regions.some((r) => r.role === 'banner')).toBe(true);
});
```

- [ ] **Step 7: Run the suite and gate**

Run: `pnpm -w test && pnpm -w typecheck && pnpm -w lint`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): build a collapsed region tree with roles and text density"
```

---

### Task 6: Asset fetching policy

**Files:**
- Create: `packages/core/src/assets.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/assets.test.ts`

**Interfaces:**
- Consumes: `PageDriver`, `FetchOptions` from `driver.ts`; `AssetRef`, `Warning` from `ir.ts`; `CaptureSettings` from `settings.ts`.
- Produces: `fetchAssets(driver: PageDriver, refs: AssetRef[], options: FetchAssetsOptions): Promise<FetchAssetsResult>`, `type FetchAssetsOptions`, `type FetchAssetsResult`, `type FetchedAsset`.

Every policy in the spec's §3.3 lives here and nowhere else: concurrency 6, 10 s timeout, one retry, 5 MB per asset, 50 MB total. Tested against `FakeDriver`, so there is no network and no flake.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/assets.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { fetchAssets } from '../src/assets.js';
import { FakeDriver } from './fake-driver.js';
import type { AssetRef } from '../src/ir.js';
import type { PageDriver } from '../src/driver.js';

const ref = (url: string): AssetRef => ({
  url,
  kind: 'image',
  referencedBy: 'img[src]',
});

const limits = {
  concurrency: 2,
  assetTimeoutMs: 50,
  retries: 1,
  maxAssetBytes: 10,
  maxTotalBytes: 25,
  logRingSize: 500,
};

describe('fetchAssets', () => {
  it('returns bytes keyed by url', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/a.png': new Uint8Array([1]), '/b.png': new Uint8Array([2]) },
    });
    const result = await fetchAssets(driver, [ref('/a.png'), ref('/b.png')], {
      limits,
    });
    expect([...result.assets.keys()].sort()).toEqual(['/a.png', '/b.png']);
    expect(result.warnings).toEqual([]);
    expect(result.totalBytes).toBe(2);
  });

  it('warns and continues when one asset fails', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/ok.png': new Uint8Array([1]) },
      failures: { '/bad.png': 'network error' },
    });
    const result = await fetchAssets(driver, [ref('/ok.png'), ref('/bad.png')], {
      limits,
    });
    expect(result.assets.has('/ok.png')).toBe(true);
    expect(result.assets.has('/bad.png')).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      phase: 'assets',
      url: '/bad.png',
    });
  });

  it('retries a failing asset exactly `retries` times', async () => {
    let calls = 0;
    const driver: PageDriver = {
      ...new FakeDriver({ fixture: 'static' }),
      fetchAsset: async (url) => {
        calls++;
        throw new Error(`boom ${url}`);
      },
    };
    await fetchAssets(driver, [ref('/x.png')], { limits });
    expect(calls).toBe(2); // initial attempt + 1 retry
  });

  it('times out a hanging asset and warns', async () => {
    const driver = new FakeDriver({ fixture: 'static', hangs: ['/slow.png'] });
    const result = await fetchAssets(driver, [ref('/slow.png')], { limits });
    expect(result.assets.size).toBe(0);
    expect(result.warnings[0]!.reason).toContain('timed out');
  });

  it('skips an asset over the per-asset cap', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/big.png': new Uint8Array(20) },
    });
    const result = await fetchAssets(driver, [ref('/big.png')], { limits });
    expect(result.assets.size).toBe(0);
    expect(result.warnings[0]!.reason).toContain('exceeds');
  });

  it('stops fetching once the total cap is reached and warns once with a count', async () => {
    const driver = new FakeDriver({
      fixture: 'static',
      assets: {
        '/1.png': new Uint8Array(10),
        '/2.png': new Uint8Array(10),
        '/3.png': new Uint8Array(10),
        '/4.png': new Uint8Array(10),
      },
    });
    const result = await fetchAssets(
      driver,
      [ref('/1.png'), ref('/2.png'), ref('/3.png'), ref('/4.png')],
      { limits: { ...limits, concurrency: 1 } },
    );
    expect(result.totalBytes).toBeLessThanOrEqual(limits.maxTotalBytes);
    const capWarning = result.warnings.find((w) =>
      w.reason.includes('total size cap'),
    );
    expect(capWarning).toBeDefined();
    expect(capWarning!.detail).toMatch(/\d+ asset/);
  });

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const driver: PageDriver = {
      ...new FakeDriver({ fixture: 'static' }),
      fetchAsset: async (url) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { url, bytes: new Uint8Array([1]), contentType: null };
      },
    };
    const refs = Array.from({ length: 10 }, (_, i) => ref(`/${i}.png`));
    await fetchAssets(driver, refs, { limits: { ...limits, concurrency: 3 } });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports progress as assets settle', async () => {
    const onProgress = vi.fn();
    const driver = new FakeDriver({
      fixture: 'static',
      assets: { '/a.png': new Uint8Array([1]), '/b.png': new Uint8Array([2]) },
    });
    await fetchAssets(driver, [ref('/a.png'), ref('/b.png')], {
      limits,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith({ done: 2, total: 2 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/assets.test.ts`
Expected: FAIL — `Cannot find module '../src/assets.js'`.

- [ ] **Step 3: Write `assets.ts`**

```ts
import type { PageDriver } from './driver.js';
import type { AssetRef, Warning } from './ir.js';
import type { CaptureSettings } from './settings.js';

export type FetchedAsset = {
  ref: AssetRef;
  bytes: Uint8Array;
  contentType: string | null;
};

export type FetchAssetsOptions = {
  limits: CaptureSettings['limits'];
  onProgress?: (progress: { done: number; total: number }) => void;
};

export type FetchAssetsResult = {
  assets: Map<string, FetchedAsset>;
  warnings: Warning[];
  totalBytes: number;
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  url: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Fetches every reference through the driver under the configured policy.
 * Never rejects: a failure becomes a Warning so the capture can continue.
 */
export async function fetchAssets(
  driver: PageDriver,
  refs: AssetRef[],
  options: FetchAssetsOptions,
): Promise<FetchAssetsResult> {
  const { limits } = options;
  const assets = new Map<string, FetchedAsset>();
  const warnings: Warning[] = [];
  let totalBytes = 0;
  let done = 0;
  let skippedForCap = 0;
  let cursor = 0;

  const attempt = async (ref: AssetRef): Promise<void> => {
    for (let tries = 0; tries <= limits.retries; tries++) {
      try {
        const asset = await withTimeout(
          driver.fetchAsset(ref.url, {
            timeoutMs: limits.assetTimeoutMs,
            maxBytes: limits.maxAssetBytes,
          }),
          limits.assetTimeoutMs,
          ref.url,
        );
        if (asset.bytes.byteLength > limits.maxAssetBytes) {
          warnings.push({
            phase: 'assets',
            url: ref.url,
            reason: `exceeds per-asset cap of ${limits.maxAssetBytes} bytes`,
            detail: `${asset.bytes.byteLength} bytes`,
          });
          return;
        }
        if (totalBytes + asset.bytes.byteLength > limits.maxTotalBytes) {
          skippedForCap++;
          return;
        }
        totalBytes += asset.bytes.byteLength;
        assets.set(ref.url, {
          ref,
          bytes: asset.bytes,
          contentType: asset.contentType,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (tries === limits.retries) {
          warnings.push({
            phase: 'assets',
            url: ref.url,
            reason: message,
            detail: ref.referencedBy,
          });
        }
      }
    }
  };

  const worker = async (): Promise<void> => {
    while (cursor < refs.length) {
      const ref = refs[cursor++];
      if (!ref) return;
      if (totalBytes >= limits.maxTotalBytes) {
        skippedForCap++;
        continue;
      }
      await attempt(ref);
      done++;
      options.onProgress?.({ done, total: refs.length });
    }
  };

  const workers = Array.from(
    { length: Math.max(1, Math.min(limits.concurrency, refs.length)) },
    worker,
  );
  await Promise.all(workers);

  if (skippedForCap > 0) {
    warnings.push({
      phase: 'assets',
      reason: `total size cap of ${limits.maxTotalBytes} bytes reached`,
      detail: `${skippedForCap} asset(s) skipped`,
    });
  }

  return { assets, warnings, totalBytes };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/assets.test.ts`
Expected: PASS, 8 tests. The hang test relies on `withTimeout` rejecting even though `FakeDriver` never settles — that is the behavior under test.

- [ ] **Step 5: Export and gate**

Add to `packages/core/src/index.ts`:

```ts
export {
  fetchAssets,
  type FetchAssetsOptions,
  type FetchAssetsResult,
  type FetchedAsset,
} from './assets.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add asset fetch policy with caps, retry, and concurrency"
```

---

### Task 7: Inlining and inert-mode transforms

**Files:**
- Create: `packages/core/src/inline.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/inline.test.ts`

**Interfaces:**
- Consumes: `PageIR`, `Warning` from `ir.ts`; `FetchedAsset` from `assets.ts`; `CaptureSettings` from `settings.ts`.
- Produces: `inlineDocument(doc: Document, input: InlineInput): InlineResult`, `resolveImports(css, resolver, depth)`, `rewriteCssUrls(css, mapUrl)`, `toDataUri(bytes, contentType)`, `type InlineInput`, `type InlineResult`.

`InlineResult` is `{ warnings: Warning[] }` — the document is mutated in place, which is what the callers want and what keeps memory flat on large pages. Every function here is pure with respect to its inputs other than that one documented mutation.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/inline.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  inlineDocument,
  resolveImports,
  rewriteCssUrls,
  toDataUri,
} from '../src/inline.js';
import { fixtureDocument } from './fake-driver.js';
import { defaultSettings } from '../src/settings.js';
import type { FetchedAsset } from '../src/assets.js';

const asset = (url: string, bytes: number[], type: string): FetchedAsset => ({
  ref: { url, kind: 'image', referencedBy: 'test' },
  bytes: new Uint8Array(bytes),
  contentType: type,
});

const baseInput = {
  pageUrl: 'https://example.com/page',
  settings: defaultSettings,
  assets: new Map<string, FetchedAsset>(),
  styleTexts: new Map<string, string>(),
  assetPath: undefined,
};

describe('toDataUri', () => {
  it('base64-encodes bytes with the given content type', () => {
    expect(toDataUri(new Uint8Array([104, 105]), 'text/plain')).toBe(
      'data:text/plain;base64,aGk=',
    );
  });

  it('falls back to application/octet-stream when type is null', () => {
    expect(toDataUri(new Uint8Array([1]), null)).toContain(
      'data:application/octet-stream;base64,',
    );
  });
});

describe('rewriteCssUrls', () => {
  it('rewrites quoted and unquoted url() references', () => {
    const css = "a{background:url('/a.png')}b{background:url(/b.png)}";
    const out = rewriteCssUrls(css, (u) => `X${u}X`);
    expect(out).toContain('X/a.pngX');
    expect(out).toContain('X/b.pngX');
  });

  it('leaves data: uris untouched', () => {
    const css = 'a{background:url(data:image/png;base64,AAA)}';
    expect(rewriteCssUrls(css, () => 'REPLACED')).toBe(css);
  });
});

describe('resolveImports', () => {
  it('inlines a nested @import', () => {
    const sheets = new Map([
      ['/a.css', "@import url('/b.css'); a{color:red}"],
      ['/b.css', 'b{color:blue}'],
    ]);
    const out = resolveImports(sheets.get('/a.css')!, (u) => sheets.get(u) ?? null, 5);
    expect(out).toContain('b{color:blue}');
    expect(out).toContain('a{color:red}');
    expect(out).not.toContain('@import');
  });

  it('stops at the depth cap instead of looping on a cycle', () => {
    const sheets = new Map([
      ['/a.css', "@import url('/b.css');"],
      ['/b.css', "@import url('/a.css');"],
    ]);
    const out = resolveImports(sheets.get('/a.css')!, (u) => sheets.get(u) ?? null, 3);
    expect(out).toBeTypeOf('string');
    expect((out.match(/@import/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('leaves an unresolvable import in place', () => {
    const out = resolveImports("@import url('/missing.css');", () => null, 5);
    expect(out).toContain('@import');
  });
});

describe('inlineDocument', () => {
  it('strips the base element after absolutizing', () => {
    const doc = fixtureDocument('static');
    const base = doc.createElement('base');
    base.setAttribute('href', 'https://example.com/');
    doc.head.prepend(base);
    inlineDocument(doc, baseInput);
    expect(doc.querySelector('base')).toBeNull();
  });

  it('absolutizes a relative anchor href', () => {
    const doc = fixtureDocument('static');
    inlineDocument(doc, baseInput);
    expect(doc.querySelector('a')!.getAttribute('href')).toBe(
      'https://example.com/next',
    );
  });

  it('replaces an image src with a data uri in single-file mode', () => {
    const doc = fixtureDocument('static');
    const assets = new Map([
      [
        'https://example.com/img/hero.png',
        asset('https://example.com/img/hero.png', [104, 105], 'image/png'),
      ],
    ]);
    inlineDocument(doc, { ...baseInput, assets });
    expect(doc.querySelector('img')!.getAttribute('src')).toBe(
      'data:image/png;base64,aGk=',
    );
  });

  it('rewrites an image src to a relative path in zip mode', () => {
    const doc = fixtureDocument('static');
    const url = 'https://example.com/img/hero.png';
    const assets = new Map([[url, asset(url, [104, 105], 'image/png')]]);
    inlineDocument(doc, {
      ...baseInput,
      assets,
      assetPath: () => 'images/hero.png',
    });
    expect(doc.querySelector('img')!.getAttribute('src')).toBe(
      'images/hero.png',
    );
  });

  it('rewrites every srcset candidate', () => {
    const doc = fixtureDocument('gallery');
    const one = 'https://example.com/img/1.jpg';
    const two = 'https://example.com/img/1@2x.jpg';
    const assets = new Map([
      [one, asset(one, [1], 'image/jpeg')],
      [two, asset(two, [2], 'image/jpeg')],
    ]);
    inlineDocument(doc, { ...baseInput, assets });
    const srcset = doc.querySelector('img[srcset]')!.getAttribute('srcset')!;
    expect(srcset).toContain('data:image/jpeg;base64,');
    expect(srcset).toContain('1x');
    expect(srcset).toContain('2x');
  });

  it('warns for a referenced asset that was never fetched', () => {
    const doc = fixtureDocument('static');
    const result = inlineDocument(doc, baseInput);
    expect(
      result.warnings.some(
        (w) => w.phase === 'assets' && w.reason === 'asset not available',
      ),
    ).toBe(true);
  });

  it('inlines a fetched stylesheet as a style element recording its origin', () => {
    const doc = fixtureDocument('static');
    const styleTexts = new Map([
      ['https://example.com/styles/site.css', 'h1{color:#000}'],
    ]);
    inlineDocument(doc, { ...baseInput, styleTexts });
    const injected = [...doc.querySelectorAll('style')].find((s) =>
      (s.textContent ?? '').includes('h1{color:#000}'),
    );
    expect(injected).toBeDefined();
    expect(injected!.getAttribute('data-capture-src')).toBe(
      'https://example.com/styles/site.css',
    );
    expect(doc.querySelector('link[rel~="stylesheet"]')).toBeNull();
  });

  it('neutralizes scripts in inert mode while preserving the original type', () => {
    const doc = fixtureDocument('spa');
    inlineDocument(doc, baseInput);
    const script = doc.querySelector('script')!;
    expect(script.getAttribute('type')).toBe('text/plain');
    expect(script.getAttribute('data-capture-type')).toBe('module');
  });

  it('moves inline event handlers to data attributes in inert mode', () => {
    const doc = fixtureDocument('static');
    doc.querySelector('h1')!.setAttribute('onclick', 'alert(1)');
    inlineDocument(doc, baseInput);
    const h1 = doc.querySelector('h1')!;
    expect(h1.hasAttribute('onclick')).toBe(false);
    expect(h1.getAttribute('data-capture-onclick')).toBe('alert(1)');
  });

  it('leaves scripts executable when inert mode is off', () => {
    const doc = fixtureDocument('spa');
    inlineDocument(doc, {
      ...baseInput,
      settings: { ...defaultSettings, inertSnapshot: false },
    });
    expect(doc.querySelector('script')!.getAttribute('type')).toBe('module');
  });

  it('removes script elements entirely when scripts are excluded', () => {
    const doc = fixtureDocument('spa');
    inlineDocument(doc, {
      ...baseInput,
      settings: {
        ...defaultSettings,
        include: { ...defaultSettings.include, scripts: false },
      },
    });
    expect(doc.querySelectorAll('script')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/inline.test.ts`
Expected: FAIL — `Cannot find module '../src/inline.js'`.

- [ ] **Step 3: Write `inline.ts`**

```ts
import type { FetchedAsset } from './assets.js';
import type { Warning } from './ir.js';
import type { CaptureSettings } from './settings.js';

export type InlineInput = {
  pageUrl: string;
  settings: CaptureSettings;
  assets: Map<string, FetchedAsset>;
  /** Stylesheet text fetched by the host, keyed by absolute url. */
  styleTexts: Map<string, string>;
  /** Zip mode supplies this to get relative paths instead of data uris. */
  assetPath?: ((url: string) => string) | undefined;
};

export type InlineResult = { warnings: Warning[] };

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without Node's Buffer or the browser's btoa, both banned in core. */
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64[b0 >> 2];
    out += BASE64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64[b2 & 63];
  }
  return out;
}

export function toDataUri(bytes: Uint8Array, contentType: string | null): string {
  return `data:${contentType ?? 'application/octet-stream'};base64,${base64(bytes)}`;
}

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

export function rewriteCssUrls(css: string, mapUrl: (url: string) => string): string {
  return css.replace(URL_PATTERN, (match, quote: string, url: string) => {
    if (url.startsWith('data:')) return match;
    return `url(${quote}${mapUrl(url)}${quote})`;
  });
}

const IMPORT_PATTERN = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*;/g;

export function resolveImports(
  css: string,
  resolve: (url: string) => string | null,
  depth: number,
): string {
  if (depth <= 0) return css;
  return css.replace(IMPORT_PATTERN, (match, _q1, u1: string, _q2, u2: string) => {
    const url = u1 ?? u2;
    const text = resolve(url);
    if (text === null) return match;
    return resolveImports(text, resolve, depth - 1);
  });
}

function absolutize(raw: string | null, base: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('#')) {
    return null;
  }
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

/**
 * Rewrites the document in place so it renders standalone. Mutation is
 * deliberate: on a large page, cloning the tree twice is the difference
 * between working and running out of memory.
 */
export function inlineDocument(doc: Document, input: InlineInput): InlineResult {
  const warnings: Warning[] = [];
  const { pageUrl, settings, assets, styleTexts, assetPath } = input;
  const baseHref =
    doc.querySelector('base')?.getAttribute('href') ?? pageUrl;

  const referenceFor = (url: string, referencedBy: string): string | null => {
    if (assetPath) return assetPath(url);
    const fetched = assets.get(url);
    if (!fetched) {
      warnings.push({
        phase: 'assets',
        url,
        reason: 'asset not available',
        detail: referencedBy,
      });
      return null;
    }
    return toDataUri(fetched.bytes, fetched.contentType);
  };

  for (const anchor of doc.querySelectorAll('a[href]')) {
    const abs = absolutize(anchor.getAttribute('href'), baseHref);
    if (abs) anchor.setAttribute('href', abs);
  }
  doc.querySelector('base')?.remove();

  for (const img of doc.querySelectorAll('img')) {
    const abs = absolutize(img.getAttribute('src'), baseHref);
    if (abs) {
      const replacement = referenceFor(abs, 'img[src]');
      if (replacement) img.setAttribute('src', replacement);
    }
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const rewritten = srcset
        .split(',')
        .map((candidate) => {
          const parts = candidate.trim().split(/\s+/);
          const url = absolutize(parts[0] ?? '', baseHref);
          if (!url) return candidate.trim();
          const replacement = referenceFor(url, 'img[srcset]');
          if (!replacement) return candidate.trim();
          return [replacement, ...parts.slice(1)].join(' ');
        })
        .join(', ');
      img.setAttribute('srcset', rewritten);
    }
  }

  for (const source of doc.querySelectorAll('picture source[srcset]')) {
    const rewritten = (source.getAttribute('srcset') ?? '')
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/);
        const url = absolutize(parts[0] ?? '', baseHref);
        if (!url) return candidate.trim();
        const replacement = referenceFor(url, 'source[srcset]');
        if (!replacement) return candidate.trim();
        return [replacement, ...parts.slice(1)].join(' ');
      })
      .join(', ');
    source.setAttribute('srcset', rewritten);
  }

  for (const link of doc.querySelectorAll('link[rel~="stylesheet"][href]')) {
    const abs = absolutize(link.getAttribute('href'), baseHref);
    const text = abs ? styleTexts.get(abs) : undefined;
    if (abs && text !== undefined) {
      const style = doc.createElement('style');
      style.setAttribute('data-capture-src', abs);
      style.textContent = rewriteCssUrls(text, (url) => {
        const assetUrl = absolutize(url, abs);
        if (!assetUrl) return url;
        return referenceFor(assetUrl, 'css url()') ?? url;
      });
      link.replaceWith(style);
    } else {
      if (abs) {
        warnings.push({
          phase: 'styles',
          url: abs,
          reason: 'stylesheet not available',
          detail: 'link removed from snapshot',
        });
      }
      link.remove();
    }
  }

  for (const style of doc.querySelectorAll('style')) {
    if (style.hasAttribute('data-capture-src')) continue;
    style.textContent = rewriteCssUrls(style.textContent ?? '', (url) => {
      const assetUrl = absolutize(url, baseHref);
      if (!assetUrl) return url;
      return referenceFor(assetUrl, 'inline css url()') ?? url;
    });
  }

  for (const script of doc.querySelectorAll('script')) {
    if (!settings.include.scripts) {
      script.remove();
      continue;
    }
    const src = absolutize(script.getAttribute('src'), baseHref);
    if (src) {
      const replacement = referenceFor(src, 'script[src]');
      if (replacement) script.setAttribute('src', replacement);
    }
    if (settings.inertSnapshot) {
      const original = script.getAttribute('type');
      if (original) script.setAttribute('data-capture-type', original);
      script.setAttribute('type', 'text/plain');
    }
  }

  if (settings.inertSnapshot) {
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on')) {
          el.setAttribute(`data-capture-${attr.name}`, attr.value);
          el.removeAttribute(attr.name);
        }
      }
    }
  }

  return { warnings };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/inline.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Export and gate**

Add to `packages/core/src/index.ts`:

```ts
export {
  inlineDocument,
  resolveImports,
  rewriteCssUrls,
  toDataUri,
  type InlineInput,
  type InlineResult,
} from './inline.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): inline assets and stylesheets with inert-mode transforms"
```

---

### Task 8: Bundle assembly and filename safety

**Files:**
- Create: `packages/core/src/bundle.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/bundle.test.ts`

**Interfaces:**
- Consumes: `PageIR` from `ir.ts`; `FetchedAsset` from `assets.ts`; `CaptureSettings` from `settings.ts`; `fflate`.
- Produces: `buildSingleFile(input: BundleInput): BundleOutput`, `buildZip(input: BundleInput): BundleOutput`, `captureFilename(url, capturedAt, extension): string`, `assetPathFor(url, kind): string`, `type BundleInput`, `type BundleOutput`.

`BundleOutput` is `{ filename: string; bytes: Uint8Array; mimeType: string }` — bytes and a name, never a write. Where output lands is the host's decision: the extension hands it to `chrome.downloads`, and §12's CLI would write it to an artifact root.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/bundle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  assetPathFor,
  buildSingleFile,
  buildZip,
  captureFilename,
} from '../src/bundle.js';
import { defaultSettings } from '../src/settings.js';
import type { PageIR } from '../src/ir.js';
import { emptyTally } from '../src/collect.js';

const ir: PageIR = {
  metadata: {
    url: 'https://example.com/a/page?q=1',
    title: 'Example',
    capturedAt: '2026-08-27T10:00:00.000Z',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 2,
    userAgent: 'test',
    charset: 'utf-8',
    meta: {},
  },
  html: '<html><head></head><body><h1>Hi</h1></body></html>',
  regions: [],
  styles: [],
  assets: [],
  styleTally: emptyTally(),
  warnings: [{ phase: 'assets', url: '/x.png', reason: 'boom' }],
};

const input = {
  ir,
  settings: defaultSettings,
  html: '<html><head></head><body><h1>Hi</h1></body></html>',
  assets: new Map(),
  styleTexts: new Map(),
  tokens: { color: { '#000000': 3 } },
  screenshot: undefined,
  rawSources: new Map([['https://example.com/a/page?q=1', 'raw html']]),
};

describe('captureFilename', () => {
  it('uses hostname and a sortable timestamp', () => {
    expect(
      captureFilename('https://example.com/a/page', '2026-08-27T10:00:00.000Z', 'html'),
    ).toBe('example.com-20260827-100000.html');
  });

  it('strips characters that are illegal on any platform', () => {
    const name = captureFilename(
      'https://ex:am*ple.com/p',
      '2026-08-27T10:00:00.000Z',
      'zip',
    );
    expect(name).not.toMatch(/[:*?"<>|]/);
  });

  it('caps the length', () => {
    const long = `https://${'a'.repeat(300)}.com/p`;
    expect(
      captureFilename(long, '2026-08-27T10:00:00.000Z', 'html').length,
    ).toBeLessThanOrEqual(120);
  });
});

describe('assetPathFor', () => {
  it('groups by kind and keeps the basename', () => {
    expect(assetPathFor('https://example.com/img/hero.png', 'image')).toMatch(
      /^images\/hero-[0-9a-f]{8}\.png$/,
    );
  });

  it('rejects path traversal from the url', () => {
    const path = assetPathFor('https://example.com/../../etc/passwd', 'image');
    expect(path).not.toContain('..');
    expect(path.startsWith('images/')).toBe(true);
  });

  it('gives distinct paths to same-named files from different urls', () => {
    const a = assetPathFor('https://example.com/one/logo.svg', 'image');
    const b = assetPathFor('https://example.com/two/logo.svg', 'image');
    expect(a).not.toBe(b);
  });
});

describe('buildSingleFile', () => {
  it('produces one html file with the right name and mime type', () => {
    const out = buildSingleFile(input);
    expect(out.filename).toBe('example.com-20260827-100000.html');
    expect(out.mimeType).toBe('text/html');
  });

  it('embeds metadata, tokens, and warnings as inert json blocks', () => {
    const text = new TextDecoder().decode(buildSingleFile(input).bytes);
    expect(text).toContain('<script type="application/json" data-capture="metadata">');
    expect(text).toContain('<script type="application/json" data-capture="tokens">');
    expect(text).toContain('"reason":"boom"');
  });

  it('embeds raw sources when the setting is on', () => {
    const text = new TextDecoder().decode(
      buildSingleFile({
        ...input,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, rawSources: true },
        },
      }).bytes,
    );
    expect(text).toContain('data-capture="raw"');
    expect(text).toContain('raw html');
  });

  it('omits the tokens block when tokens are excluded', () => {
    const text = new TextDecoder().decode(
      buildSingleFile({ ...input, tokens: undefined }).bytes,
    );
    expect(text).not.toContain('data-capture="tokens"');
  });
});

describe('buildZip', () => {
  it('produces a zip containing page.html and metadata.json', () => {
    const out = buildZip(input);
    expect(out.filename).toBe('example.com-20260827-100000.zip');
    expect(out.mimeType).toBe('application/zip');
    const files = unzipSync(out.bytes);
    expect(Object.keys(files)).toContain('page.html');
    expect(Object.keys(files)).toContain('metadata.json');
    expect(strFromU8(files['page.html']!)).toContain('<h1>Hi</h1>');
  });

  it('writes warnings into metadata.json', () => {
    const files = unzipSync(buildZip(input).bytes);
    const metadata = JSON.parse(strFromU8(files['metadata.json']!));
    expect(metadata.warnings).toHaveLength(1);
    expect(metadata.warnings[0].reason).toBe('boom');
  });

  it('writes each stylesheet under styles/', () => {
    const files = unzipSync(
      buildZip({
        ...input,
        styleTexts: new Map([['https://example.com/s/site.css', 'a{color:red}']]),
      }).bytes,
    );
    const styleFiles = Object.keys(files).filter((f) => f.startsWith('styles/'));
    expect(styleFiles).toHaveLength(1);
    expect(strFromU8(files[styleFiles[0]!]!)).toBe('a{color:red}');
  });

  it('includes screenshot.png only when a screenshot was captured', () => {
    const without = unzipSync(buildZip(input).bytes);
    expect(Object.keys(without)).not.toContain('screenshot.png');
    const with_ = unzipSync(
      buildZip({ ...input, screenshot: new Uint8Array([137, 80]) }).bytes,
    );
    expect(Object.keys(with_)).toContain('screenshot.png');
  });

  it('never writes an entry outside the archive root', () => {
    const files = unzipSync(
      buildZip({
        ...input,
        styleTexts: new Map([['https://example.com/../../evil.css', 'a{}']]),
      }).bytes,
    );
    for (const name of Object.keys(files)) {
      expect(name).not.toContain('..');
      expect(name.startsWith('/')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/bundle.test.ts`
Expected: FAIL — `Cannot find module '../src/bundle.js'`.

- [ ] **Step 3: Write `bundle.ts`**

```ts
import { zipSync, strToU8 } from 'fflate';
import type { AssetKind, PageIR } from './ir.js';
import type { FetchedAsset } from './assets.js';
import type { CaptureSettings } from './settings.js';

export type BundleInput = {
  ir: PageIR;
  settings: CaptureSettings;
  /** The rewritten document, serialized by the caller. */
  html: string;
  assets: Map<string, FetchedAsset>;
  styleTexts: Map<string, string>;
  tokens?: Record<string, Record<string, number>> | undefined;
  screenshot?: Uint8Array | undefined;
  rawSources?: Map<string, string> | undefined;
};

export type BundleOutput = {
  filename: string;
  bytes: Uint8Array;
  mimeType: string;
};

const ILLEGAL = /[^a-zA-Z0-9._-]/g;

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(ILLEGAL, '-').replace(/^[.-]+/, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/** 32-bit FNV-1a. Short, stable, and not used for anything security-bearing. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function captureFilename(
  url: string,
  capturedAt: string,
  extension: string,
): string {
  let host = 'capture';
  try {
    host = new URL(url).hostname || host;
  } catch {
    /* keep the fallback */
  }
  const stamp = capturedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${safeSegment(host, 'capture')}-${stamp}`;
  const capped = name.slice(0, 120 - extension.length - 1);
  return `${capped}.${extension}`;
}

const DIRECTORY_BY_KIND: Record<AssetKind, string> = {
  image: 'images',
  font: 'fonts',
  script: 'scripts',
  media: 'media',
  stylesheet: 'styles',
};

export function assetPathFor(url: string, kind: AssetKind): string {
  const directory = DIRECTORY_BY_KIND[kind];
  let basename = 'asset';
  let extension = '';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? 'asset';
    const dot = last.lastIndexOf('.');
    basename = dot > 0 ? last.slice(0, dot) : last;
    extension = dot > 0 ? last.slice(dot) : '';
  } catch {
    /* keep the fallbacks */
  }
  const safeBase = safeSegment(basename, 'asset');
  const safeExt = safeSegment(extension.replace('.', ''), '');
  const suffix = safeExt ? `.${safeExt}` : '';
  return `${directory}/${safeBase}-${shortHash(url)}${suffix}`;
}

function jsonBlock(name: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/<\//g, '<\\/');
  return `\n<script type="application/json" data-capture="${name}">${json}</script>`;
}

function metadataDocument(input: BundleInput) {
  return {
    ...input.ir.metadata,
    warnings: input.ir.warnings,
    regionCount: input.ir.regions.length,
    settings: input.settings,
  };
}

export function buildSingleFile(input: BundleInput): BundleOutput {
  const parts = [input.html];
  if (input.settings.include.metadata) {
    parts.push(jsonBlock('metadata', metadataDocument(input)));
  }
  if (input.tokens) parts.push(jsonBlock('tokens', input.tokens));
  if (input.settings.include.logs && input.ir.logs) {
    parts.push(jsonBlock('logs', input.ir.logs));
  }
  if (input.settings.include.rawSources && input.rawSources) {
    parts.push(jsonBlock('raw', Object.fromEntries(input.rawSources)));
  }
  return {
    filename: captureFilename(
      input.ir.metadata.url,
      input.ir.metadata.capturedAt,
      'html',
    ),
    bytes: strToU8(parts.join('')),
    mimeType: 'text/html',
  };
}

export function buildZip(input: BundleInput): BundleOutput {
  const entries: Record<string, Uint8Array> = {
    'page.html': strToU8(input.html),
  };

  if (input.settings.include.metadata) {
    entries['metadata.json'] = strToU8(
      JSON.stringify(metadataDocument(input), null, 2),
    );
  }
  if (input.tokens) {
    entries['tokens.json'] = strToU8(JSON.stringify(input.tokens, null, 2));
  }
  if (input.settings.include.logs && input.ir.logs) {
    entries['logs.json'] = strToU8(JSON.stringify(input.ir.logs, null, 2));
  }
  if (input.screenshot) entries['screenshot.png'] = input.screenshot;

  for (const [url, text] of input.styleTexts) {
    entries[assetPathFor(url, 'stylesheet')] = strToU8(text);
  }
  for (const [url, asset] of input.assets) {
    entries[assetPathFor(url, asset.ref.kind)] = asset.bytes;
  }
  if (input.settings.include.rawSources && input.rawSources) {
    for (const [url, text] of input.rawSources) {
      entries[`raw/${assetPathFor(url, 'script').split('/').pop()}`] =
        strToU8(text);
    }
  }

  return {
    filename: captureFilename(
      input.ir.metadata.url,
      input.ir.metadata.capturedAt,
      'zip',
    ),
    bytes: zipSync(entries, { level: 6 }),
    mimeType: 'application/zip',
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/bundle.test.ts`
Expected: PASS, 14 tests. Note the traversal tests pass structurally: `assetPathFor` builds its path from a sanitized basename plus a hash, so a `..` in the url cannot reach the output path.

- [ ] **Step 5: Export and gate**

Add to `packages/core/src/index.ts`:

```ts
export {
  assetPathFor,
  buildSingleFile,
  buildZip,
  captureFilename,
  type BundleInput,
  type BundleOutput,
} from './bundle.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): assemble single-file and zip bundles with safe paths"
```

---

### Task 9: Design token extraction

**Files:**
- Create: `packages/core/src/tokens.ts`
- Modify: `packages/core/src/collect.ts`, `packages/core/src/index.ts`
- Test: `packages/core/tests/tokens.test.ts`

**Interfaces:**
- Consumes: `StyleTally`, `StyleTallyKey` from `ir.ts`.
- Produces: `normalizeColor(value): string | null`, `normalizeLength(value): string | null`, `tallyComputedStyles(elements, read, tally): StyleTally`, `buildTokens(tally, options): TokenReport`, `type TokenReport`, `type BuildTokensOptions`.

Normalization is the whole value here. Without it `#FFF`, `#ffffff`, and `rgb(255, 255, 255)` are three tokens instead of one, and a frequency ranking over three spellings of white is noise rather than a design system.

- [ ] **Step 1: Write the failing test**

`packages/core/tests/tokens.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildTokens,
  normalizeColor,
  normalizeLength,
  tallyComputedStyles,
} from '../src/tokens.js';
import { emptyTally } from '../src/collect.js';
import { fixtureDocument } from './fake-driver.js';

describe('normalizeColor', () => {
  it('expands three-digit hex to six and lowercases', () => {
    expect(normalizeColor('#FFF')).toBe('#ffffff');
  });

  it('converts opaque rgb to hex', () => {
    expect(normalizeColor('rgb(255, 255, 255)')).toBe('#ffffff');
    expect(normalizeColor('rgb(23,23,23)')).toBe('#171717');
  });

  it('keeps alpha as rgba with a normalized alpha', () => {
    expect(normalizeColor('rgba(0, 0, 0, 0.50)')).toBe('rgba(0,0,0,0.5)');
  });

  it('treats fully transparent as a single token', () => {
    expect(normalizeColor('rgba(0, 0, 0, 0)')).toBe('transparent');
    expect(normalizeColor('transparent')).toBe('transparent');
  });

  it('returns null for something that is not a color', () => {
    expect(normalizeColor('none')).toBeNull();
    expect(normalizeColor('')).toBeNull();
  });
});

describe('normalizeLength', () => {
  it('drops a trailing zero decimal', () => {
    expect(normalizeLength('16.00px')).toBe('16px');
  });

  it('rounds to two decimals', () => {
    expect(normalizeLength('16.666px')).toBe('16.67px');
  });

  it('normalizes zero regardless of unit', () => {
    expect(normalizeLength('0px')).toBe('0');
    expect(normalizeLength('0em')).toBe('0');
  });

  it('returns null for auto and normal', () => {
    expect(normalizeLength('auto')).toBeNull();
    expect(normalizeLength('normal')).toBeNull();
  });
});

describe('tallyComputedStyles', () => {
  it('counts normalized values per property group', () => {
    const doc = fixtureDocument('static');
    const elements = [...doc.querySelectorAll('h1, p')];
    const tally = tallyComputedStyles(
      elements,
      () => ({
        color: 'rgb(23, 23, 23)',
        'background-color': 'rgba(0, 0, 0, 0)',
        'font-family': 'Inter, sans-serif',
        'font-size': '16.00px',
        'line-height': '24px',
        'font-weight': '400',
        'border-radius': '6px',
        'box-shadow': 'none',
        'padding-top': '8px',
        'margin-bottom': '16px',
      }),
      emptyTally(),
    );
    expect(tally.color['#171717']).toBe(elements.length);
    expect(tally.fontSize['16px']).toBe(elements.length);
    expect(tally.backgroundColor['transparent']).toBe(elements.length);
    expect(tally.spacing['8px']).toBe(elements.length);
    expect(tally.spacing['16px']).toBe(elements.length);
    expect(tally.boxShadow).toEqual({});
  });
});

describe('buildTokens', () => {
  it('sorts each group by descending count', () => {
    const report = buildTokens(
      {
        ...emptyTally(),
        color: { '#111111': 2, '#000000': 9, '#222222': 5 },
      },
      { minCount: 1, maxPerGroup: 10 },
    );
    expect(Object.keys(report.color)).toEqual([
      '#000000',
      '#222222',
      '#111111',
    ]);
  });

  it('drops values below minCount', () => {
    const report = buildTokens(
      { ...emptyTally(), color: { '#000000': 9, '#ffffff': 1 } },
      { minCount: 2, maxPerGroup: 10 },
    );
    expect(Object.keys(report.color)).toEqual(['#000000']);
  });

  it('caps each group at maxPerGroup', () => {
    const color = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`#${i.toString(16).padStart(6, '0')}`, 40 - i]),
    );
    const report = buildTokens({ ...emptyTally(), color }, { minCount: 1, maxPerGroup: 12 });
    expect(Object.keys(report.color)).toHaveLength(12);
  });

  it('omits empty groups entirely', () => {
    const report = buildTokens(emptyTally(), { minCount: 1, maxPerGroup: 10 });
    expect(report.color).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/tokens.test.ts`
Expected: FAIL — `Cannot find module '../src/tokens.js'`.

- [ ] **Step 3: Write `tokens.ts`**

```ts
import type { StyleTally, StyleTallyKey } from './ir.js';

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i;

function hex2(value: number): string {
  return Math.round(value).toString(16).padStart(2, '0');
}

export function normalizeColor(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'none' || value === 'currentcolor') return null;
  if (value === 'transparent') return 'transparent';

  const short = HEX_SHORT.exec(value);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (HEX_LONG.test(value)) return value;

  const rgb = RGB.exec(value);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
    if (alpha === 0) return 'transparent';
    if (alpha === 1) return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Number(alpha.toFixed(3))})`;
  }
  return null;
}

export function normalizeLength(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value || value === 'auto' || value === 'normal' || value === 'none') {
    return null;
  }
  const match = /^(-?[\d.]+)([a-z%]*)$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (Number.isNaN(amount)) return null;
  if (amount === 0) return '0';
  const rounded = Number(amount.toFixed(2));
  return `${rounded}${match[2] ?? ''}`;
}

const SPACING_PROPERTIES = [
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
];

function bump(bucket: Record<string, number>, key: string | null): void {
  if (key === null) return;
  bucket[key] = (bucket[key] ?? 0) + 1;
}

/**
 * Reads computed styles through an injected reader — core cannot call
 * getComputedStyle itself, and that is what makes this testable.
 */
export function tallyComputedStyles(
  elements: Iterable<Element>,
  read: (el: Element) => Record<string, string>,
  tally: StyleTally,
): StyleTally {
  for (const el of elements) {
    const style = read(el);
    bump(tally.color, normalizeColor(style['color'] ?? ''));
    bump(tally.backgroundColor, normalizeColor(style['background-color'] ?? ''));
    bump(tally.borderColor, normalizeColor(style['border-top-color'] ?? ''));
    const family = (style['font-family'] ?? '').trim().toLowerCase();
    if (family) bump(tally.fontFamily, family);
    bump(tally.fontSize, normalizeLength(style['font-size'] ?? ''));
    bump(tally.lineHeight, normalizeLength(style['line-height'] ?? ''));
    const weight = (style['font-weight'] ?? '').trim();
    if (weight) bump(tally.fontWeight, weight);
    bump(tally.borderRadius, normalizeLength(style['border-radius'] ?? ''));
    const shadow = (style['box-shadow'] ?? '').trim().toLowerCase();
    if (shadow && shadow !== 'none') bump(tally.boxShadow, shadow);
    for (const property of SPACING_PROPERTIES) {
      const normalized = normalizeLength(style[property] ?? '');
      if (normalized && normalized !== '0') bump(tally.spacing, normalized);
    }
  }
  return tally;
}

export type BuildTokensOptions = {
  /** Values seen fewer times than this are noise, not tokens. */
  minCount: number;
  maxPerGroup: number;
};

export type TokenReport = Partial<Record<StyleTallyKey, Record<string, number>>>;

export function buildTokens(
  tally: StyleTally,
  options: BuildTokensOptions,
): TokenReport {
  const report: TokenReport = {};
  for (const [group, values] of Object.entries(tally) as [
    StyleTallyKey,
    Record<string, number>,
  ][]) {
    const ranked = Object.entries(values)
      .filter(([, count]) => count >= options.minCount)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, options.maxPerGroup);
    if (ranked.length > 0) report[group] = Object.fromEntries(ranked);
  }
  return report;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/tokens.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Wire the tally into `collectFromDocument`**

In `packages/core/src/collect.ts`, import and use the injected reader:

```ts
import { tallyComputedStyles } from './tokens.js';
```

Replace `styleTally: emptyTally(),` with:

```ts
    styleTally: options.computedStyle
      ? tallyComputedStyles(
          doc.querySelectorAll('body *'),
          options.computedStyle,
          emptyTally(),
        )
      : emptyTally(),
```

- [ ] **Step 6: Add the wiring test**

Append to `packages/core/tests/collect.test.ts`:

```ts
it('tallies computed styles when a reader is supplied', () => {
  const ir = collectFromDocument(fixtureDocument('static'), {
    ...options,
    computedStyle: () => ({ color: 'rgb(23, 23, 23)', 'font-size': '16px' }),
  });
  expect(ir.styleTally.color['#171717']).toBeGreaterThan(0);
  expect(ir.styleTally.fontSize['16px']).toBeGreaterThan(0);
});
```

- [ ] **Step 7: Export and gate**

Add to `packages/core/src/index.ts`:

```ts
export {
  buildTokens,
  normalizeColor,
  normalizeLength,
  tallyComputedStyles,
  type BuildTokensOptions,
  type TokenReport,
} from './tokens.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(core): extract design tokens with value normalization"
```

---

### Task 10: Geist theme tokens and the contrast gate

**Files:**
- Create: `packages/core/src/theme.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/theme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `lightTheme`, `darkTheme`, `semanticPairs`, `contrastRatio(a, b): number`, `relativeLuminance(hex): number`, `themeToCss(theme, selector): string`, `type ThemeTokens`, `type SemanticPair`.

The palette lives in core rather than in a stylesheet for one reason: the contrast check is then a unit test, and a palette regression fails CI instead of shipping. The extension generates its CSS custom properties from `themeToCss`.

- [ ] **Step 1: Verify the hex values against the current Geist documentation**

The table in the spec's §7 is provisional — it was written from memory, and the contrast test in this task gates CI, so wrong values mean a red build on day one. Before writing code, check the published Geist color scales and correct any divergence.

Check `https://vercel.com/geist/colors` for the gray, blue, red, amber, and green scales in both light and dark. For each token in the spec's table, either confirm the value or replace it with the documented one. Then update **both** the spec's §7 table and this task's Step 3 so they agree — a plan that disagrees with its spec sends the next reader in two directions.

If a documented value fails the WCAG AA check in Step 4, that is not a licence to invent a hex: pick a different *documented* step on the same scale (for example gray-700 instead of gray-600 for secondary text) and note the substitution in a comment.

- [ ] **Step 2: Write the failing test**

`packages/core/tests/theme.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  darkTheme,
  lightTheme,
  relativeLuminance,
  semanticPairs,
  themeToCss,
} from '../src/theme.js';

describe('contrast math', () => {
  it('computes luminance of the extremes', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('gives 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is order independent', () => {
    expect(contrastRatio('#171717', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#171717'),
      5,
    );
  });
});

describe('theme completeness', () => {
  it('defines the same token names in both themes', () => {
    expect(Object.keys(lightTheme).sort()).toEqual(Object.keys(darkTheme).sort());
  });

  it('has no token left as an empty string', () => {
    for (const [name, value] of Object.entries({ ...lightTheme, ...darkTheme })) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('WCAG AA gate', () => {
  it.each(semanticPairs)(
    '$name meets its minimum in the light theme',
    ({ foreground, background, minimum, name }) => {
      const ratio = contrastRatio(lightTheme[foreground], lightTheme[background]);
      expect(ratio, `${name} light: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        minimum,
      );
    },
  );

  it.each(semanticPairs)(
    '$name meets its minimum in the dark theme',
    ({ foreground, background, minimum, name }) => {
      const ratio = contrastRatio(darkTheme[foreground], darkTheme[background]);
      expect(ratio, `${name} dark: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        minimum,
      );
    },
  );
});

describe('themeToCss', () => {
  it('emits custom properties under the given selector', () => {
    const css = themeToCss(lightTheme, ':root');
    expect(css).toContain(':root {');
    expect(css).toContain('--gray-1000:');
    expect(css.trimEnd().endsWith('}')).toBe(true);
  });

  it('emits every token', () => {
    const css = themeToCss(darkTheme, ':root[data-theme="dark"]');
    for (const name of Object.keys(darkTheme)) {
      expect(css).toContain(`--${name}:`);
    }
  });
});
```

- [ ] **Step 3: Write `theme.ts`**

Values below are the spec's §7 table. Replace any that Step 1 found to diverge from the Geist documentation.

```ts
export type ThemeTokens = Record<string, string>;

export const lightTheme: ThemeTokens = {
  'background-100': '#ffffff',
  'background-200': '#fafafa',
  'gray-100': '#f2f2f2',
  'gray-200': '#ebebeb',
  'gray-300': '#e5e5e5',
  'gray-400': '#d4d4d4',
  'gray-500': '#a3a3a3',
  'gray-600': '#8f8f8f',
  'gray-700': '#737373',
  'gray-800': '#525252',
  'gray-900': '#404040',
  'gray-1000': '#171717',
  'blue-600': '#0072f5',
  'blue-700': '#0761d1',
  'red-600': '#e5484d',
  'amber-600': '#f5a623',
  'green-600': '#45a557',
};

export const darkTheme: ThemeTokens = {
  'background-100': '#0a0a0a',
  'background-200': '#000000',
  'gray-100': '#1a1a1a',
  'gray-200': '#1f1f1f',
  'gray-300': '#292929',
  'gray-400': '#2e2e2e',
  'gray-500': '#454545',
  'gray-600': '#878787',
  'gray-700': '#8f8f8f',
  'gray-800': '#a1a1a1',
  'gray-900': '#c9c9c9',
  'gray-1000': '#ededed',
  'blue-600': '#0072f5',
  'blue-700': '#3291ff',
  'red-600': '#ff6166',
  'amber-600': '#f5b849',
  'green-600': '#62c073',
};

export type SemanticPair = {
  name: string;
  foreground: string;
  background: string;
  /** 4.5 for body text, 3 for large text and UI boundaries. */
  minimum: number;
};

/**
 * Every foreground/background combination the popup actually renders. If a
 * component introduces a new pair, add it here — the gate is only as good as
 * this list.
 */
export const semanticPairs: SemanticPair[] = [
  { name: 'primary text on surface', foreground: 'gray-1000', background: 'background-100', minimum: 4.5 },
  { name: 'primary text on raised surface', foreground: 'gray-1000', background: 'gray-100', minimum: 4.5 },
  { name: 'secondary text on surface', foreground: 'gray-800', background: 'background-100', minimum: 4.5 },
  { name: 'accent text on surface', foreground: 'blue-700', background: 'background-100', minimum: 4.5 },
  { name: 'error text on surface', foreground: 'red-600', background: 'background-100', minimum: 4.5 },
  { name: 'success text on surface', foreground: 'green-600', background: 'background-100', minimum: 3 },
  { name: 'warning text on surface', foreground: 'amber-600', background: 'background-100', minimum: 3 },
  { name: 'border against surface', foreground: 'gray-400', background: 'background-100', minimum: 1.2 },
];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`not a six-digit hex color: ${hex}`);
  const int = Number.parseInt(match[1]!, 16);
  const r = channel((int >> 16) & 0xff);
  const g = channel((int >> 8) & 0xff);
  const b = channel(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function themeToCss(theme: ThemeTokens, selector: string): string {
  const lines = Object.entries(theme).map(
    ([name, value]) => `  --${name}: ${value};`,
  );
  return `${selector} {\n${lines.join('\n')}\n}\n`;
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/core/tests/theme.test.ts`
Expected: PASS. If a pair fails, the failure message prints the actual ratio — fix the palette per Step 1's rule (a different documented step, never an invented hex), and update the spec's §7 table to match.

- [ ] **Step 5: Export and gate**

Add to `packages/core/src/index.ts`:

```ts
export {
  contrastRatio,
  darkTheme,
  lightTheme,
  relativeLuminance,
  semanticPairs,
  themeToCss,
  type SemanticPair,
  type ThemeTokens,
} from './theme.js';
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`
Expected: all pass. This is the end of Phase 2 — a fully tested extraction library with no browser anywhere in the loop.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): add Geist theme tokens with a WCAG contrast gate"
```

---

## Phase 3 — Extension

Phase 3 is where Chrome APIs finally appear. Note the split in test policy: `apps/extension` tests **may** mock `chrome.*`, because that is genuinely the boundary being tested here. Core's prohibition is unchanged.

### Task 11: Extension scaffold, build, and generated theme CSS

**Files:**
- Create: `apps/extension/package.json`, `apps/extension/tsconfig.json`, `apps/extension/vite.config.ts`, `apps/extension/manifest.config.ts`
- Create: `apps/extension/src/popup/index.html`, `apps/extension/src/popup/main.tsx`, `apps/extension/src/popup/App.tsx`
- Create: `apps/extension/src/styles/tailwind.css`, `apps/extension/scripts/generate-theme-css.ts`
- Create: `apps/extension/public/icons/icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png`
- Modify: root `vitest.config.ts`, root `package.json`
- Test: `apps/extension/tests/manifest.test.ts`, `apps/extension/tests/theme-css.test.ts`

**Interfaces:**
- Consumes: `lightTheme`, `darkTheme`, `themeToCss` from `@page-capture/core`.
- Produces: a loadable unpacked build at `apps/extension/dist`, and `generateThemeCss(): string` used by the build.

The manifest is tested rather than eyeballed because the permission list is a store-review commitment, and a stray permission added during debugging is exactly the kind of thing that ships unnoticed.

- [ ] **Step 1: Create the extension package**

`apps/extension/package.json`:

```json
{
  "name": "@page-capture/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "pnpm run theme && vite build",
    "theme": "tsx scripts/generate-theme-css.ts"
  },
  "dependencies": {
    "@page-capture/core": "workspace:*",
    "geist": "^1.3.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.28",
    "@tailwindcss/vite": "^4.0.0",
    "@types/chrome": "^0.0.280",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.3",
    "tailwindcss": "^4.0.0",
    "tsx": "^4.19.2",
    "vite": "^5.4.10"
  }
}
```

`apps/extension/tsconfig.json` — this is where Chrome and DOM types are opted back in:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["chrome", "vite/client"],
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "tests", "scripts", "manifest.config.ts", "vite.config.ts"]
}
```

- [ ] **Step 2: Write the failing manifest test**

`apps/extension/tests/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import manifest from '../manifest.config.js';

describe('manifest', () => {
  it('targets manifest v3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('requests exactly the permissions the spec allows at install time', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'activeTab',
      'downloads',
      'offscreen',
      'scripting',
      'storage',
    ]);
  });

  it('keeps all_urls optional rather than install-time', () => {
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    expect(manifest.host_permissions).toBeUndefined();
  });

  it('declares a service worker as a module', () => {
    expect(manifest.background.type).toBe('module');
    expect(manifest.background.service_worker).toBe('src/background/index.ts');
  });

  it('registers the recorder at document_start in the main world', () => {
    const script = manifest.content_scripts[0]!;
    expect(script.run_at).toBe('document_start');
    expect(script.world).toBe('MAIN');
    expect(script.matches).toEqual(['<all_urls>']);
  });

  it('declares all four icon sizes', () => {
    expect(Object.keys(manifest.icons).sort()).toEqual(['128', '16', '32', '48']);
  });

  it('sets a CSP with no remote sources', () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('http');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/manifest.test.ts`
Expected: FAIL — no `manifest.config.ts`, and the root vitest config does not yet include `apps/*/tests`.

- [ ] **Step 4: Widen the test include**

In root `vitest.config.ts`, change `include` to:

```ts
    include: ['packages/*/tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts'],
```

- [ ] **Step 5: Write the manifest**

`apps/extension/manifest.config.ts`:

```ts
import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

export default defineManifest({
  manifest_version: 3,
  name: 'Page Capture',
  short_name: 'Capture',
  description:
    'Save a page’s full front-end — HTML, CSS, JavaScript, images, fonts — to your own disk. Nothing is uploaded.',
  version: pkg.version,
  minimum_chrome_version: '116',
  action: { default_popup: 'src/popup/index.html', default_title: 'Capture page' },
  permissions: ['activeTab', 'scripting', 'storage', 'downloads', 'offscreen'],
  optional_host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/recorder.ts'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
  ],
  icons: {
    '16': 'icons/icon-16.png',
    '32': 'icons/icon-32.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  content_security_policy: {
    extension_pages: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
  },
});
```

- [ ] **Step 6: Run the manifest test to verify it passes**

Run: `pnpm vitest run apps/extension/tests/manifest.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Write the failing theme CSS test**

`apps/extension/tests/theme-css.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateThemeCss } from '../scripts/generate-theme-css.js';

describe('generateThemeCss', () => {
  const css = generateThemeCss();

  it('defines the light palette on bare :root', () => {
    expect(css).toMatch(/^:root \{/m);
    expect(css).toContain('--background-100: #ffffff;');
  });

  it('overrides under prefers-color-scheme guarded against an explicit light choice', () => {
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it('overrides again under an explicit dark attribute so the toggle wins', () => {
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it('defines semantic aliases so components never reference a raw scale', () => {
    for (const alias of [
      '--surface',
      '--surface-raised',
      '--border',
      '--text-primary',
      '--text-secondary',
      '--accent',
      '--accent-hover',
      '--error',
      '--warning',
      '--success',
    ]) {
      expect(css).toContain(`${alias}:`);
    }
  });

  it('contains no hex literal outside the two palette blocks', () => {
    const aliasSection = css.slice(css.indexOf('--surface:'));
    expect(aliasSection).not.toMatch(/#[0-9a-f]{6}/i);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/theme-css.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9: Write the generator**

`apps/extension/scripts/generate-theme-css.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { darkTheme, lightTheme, themeToCss } from '@page-capture/core';

const ALIASES = `:root {
  --surface: var(--background-100);
  --surface-raised: var(--gray-100);
  --border: var(--gray-400);
  --text-primary: var(--gray-1000);
  --text-secondary: var(--gray-800);
  --accent: var(--blue-600);
  --accent-hover: var(--blue-700);
  --error: var(--red-600);
  --warning: var(--amber-600);
  --success: var(--green-600);
  --radius-control: 6px;
  --radius-card: 8px;
}
`;

/**
 * The palette is generated from core so the WCAG gate in core's theme test is
 * testing the same numbers the UI actually renders.
 */
export function generateThemeCss(): string {
  return [
    '/* Generated by scripts/generate-theme-css.ts. Do not edit by hand. */',
    themeToCss(lightTheme, ':root'),
    `@media (prefers-color-scheme: dark) {\n${themeToCss(darkTheme, ':root:not([data-theme="light"])')
      .split('\n')
      .map((line) => (line ? `  ${line}` : line))
      .join('\n')}}\n`,
    themeToCss(darkTheme, ':root[data-theme="dark"]'),
    ALIASES,
  ].join('\n');
}

const isMain = process.argv[1]?.endsWith('generate-theme-css.ts');
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = join(here, '..', 'src', 'styles', 'tokens.css');
  writeFileSync(target, generateThemeCss(), 'utf8');
  console.log(`wrote ${target}`);
}
```

- [ ] **Step 10: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/theme-css.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 11: Write the Vite config, Tailwind entry, and popup shell**

`apps/extension/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest })],
  build: { target: 'chrome116', emptyOutDir: true },
});
```

`apps/extension/src/styles/tailwind.css`:

```css
@import 'tailwindcss';
@import './tokens.css';
@import 'geist/font/sans.css';
@import 'geist/font/mono.css';

@theme {
  --font-sans: 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, monospace;
}

body {
  background: var(--surface);
  color: var(--text-primary);
  font-family: var(--font-sans);
}
```

`apps/extension/src/popup/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Page Capture</title>
  </head>
  <body class="w-[380px]">
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`apps/extension/src/popup/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '../styles/tailwind.css';

const container = document.getElementById('root');
if (!container) throw new Error('popup root element missing');
createRoot(container).render(<App />);
```

`apps/extension/src/popup/App.tsx` — a shell for now; Task 17 builds the real screen:

```tsx
export function App() {
  return (
    <main className="p-4">
      <h1 className="text-sm font-medium text-[var(--text-primary)]">
        Page Capture
      </h1>
    </main>
  );
}
```

- [ ] **Step 12: Add the four icons**

Create `apps/extension/public/icons/icon-{16,32,48,128}.png`. Any solid placeholder mark is fine for now — Task 18 replaces them with the final artwork. They must exist and be the exact pixel sizes their names claim, because Chrome rejects a mismatched icon at load.

- [ ] **Step 13: Build and load unpacked**

Run: `pnpm --filter @page-capture/extension build`
Expected: `apps/extension/dist` is created with `manifest.json`, the popup HTML, and the icons.

Then in Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `apps/extension/dist`. Click the icon. Expected: a 380 px popup showing "Page Capture", correctly themed, and switching with your OS light/dark setting.

- [ ] **Step 14: Add build to CI and gate**

In root `package.json` scripts, add:

```json
    "build": "pnpm --filter @page-capture/extension build"
```

Append to `.github/workflows/ci.yml`'s `check` job steps:

```yaml
      - run: pnpm -w build
```

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build`

- [ ] **Step 15: Commit**

```bash
git add -A
git commit -m "feat(extension): scaffold MV3 build with generated Geist theme CSS"
```

---

### Task 12: `ChromeDriver` — `PageDriver` over Chrome APIs

**Files:**
- Create: `apps/extension/src/background/chrome-driver.ts`
- Test: `apps/extension/tests/chrome-driver.test.ts`, `apps/extension/tests/chrome-mock.ts`

**Interfaces:**
- Consumes: `PageDriver`, `AssetBytes`, `FetchOptions`, `Viewport` from `@page-capture/core`.
- Produces: `class ChromeDriver implements PageDriver` with constructor `new ChromeDriver(tabId: number, deps?: ChromeDriverDeps)`, and `type ChromeDriverDeps` for injecting `fetch` and the screenshot function in tests.

This is the seam Phase 2 was designed around. When it is done, every core function already proven against `FakeDriver` runs against a real browser with no change.

- [ ] **Step 1: Write the chrome mock**

`apps/extension/tests/chrome-mock.ts`:

```ts
import { vi } from 'vitest';

export type ChromeMock = {
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  tabs: { captureVisibleTab: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  runtime: { lastError: { message: string } | undefined };
};

export function installChromeMock(): ChromeMock {
  const mock: ChromeMock = {
    scripting: { executeScript: vi.fn() },
    tabs: { captureVisibleTab: vi.fn(), get: vi.fn() },
    runtime: { lastError: undefined },
  };
  (globalThis as unknown as { chrome: ChromeMock }).chrome = mock;
  return mock;
}
```

- [ ] **Step 2: Write the failing test**

`apps/extension/tests/chrome-driver.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from './chrome-mock.js';
import { ChromeDriver } from '../src/background/chrome-driver.js';

let chromeMock: ChromeMock;

beforeEach(() => {
  chromeMock = installChromeMock();
});

describe('ChromeDriver.evaluate', () => {
  it('runs the function in the tab and returns its result', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([{ result: 42 }]);
    const driver = new ChromeDriver(7);
    await expect(driver.evaluate(() => 42)).resolves.toBe(42);
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7 } }),
    );
  });

  it('throws with the injection error when no frame result comes back', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([]);
    const driver = new ChromeDriver(7);
    await expect(driver.evaluate(() => 1)).rejects.toThrow(
      'no result from tab 7',
    );
  });
});

describe('ChromeDriver.fetchAsset', () => {
  it('returns bytes and content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    const driver = new ChromeDriver(7, { fetchImpl });
    const asset = await driver.fetchAsset('https://example.com/a.png', {
      timeoutMs: 100,
      maxBytes: 10,
    });
    expect(asset.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(asset.contentType).toBe('image/png');
  });

  it('rejects on a non-ok response with the status in the message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 404 }));
    const driver = new ChromeDriver(7, { fetchImpl });
    await expect(
      driver.fetchAsset('https://example.com/x.png', {
        timeoutMs: 100,
        maxBytes: 10,
      }),
    ).rejects.toThrow('404');
  });

  it('rejects a response whose content-length exceeds maxBytes without reading it', async () => {
    const body = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { headers: { 'content-length': '5000' } }),
    );
    const driver = new ChromeDriver(7, { fetchImpl });
    await expect(
      driver.fetchAsset('https://example.com/big.png', {
        timeoutMs: 100,
        maxBytes: 10,
      }),
    ).rejects.toThrow('exceeds');
    expect(body).not.toHaveBeenCalled();
  });

  it('aborts the request when the timeout elapses', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const driver = new ChromeDriver(7, { fetchImpl });
    await expect(
      driver.fetchAsset('https://example.com/slow.png', {
        timeoutMs: 10,
        maxBytes: 100,
      }),
    ).rejects.toThrow();
  });
});

describe('ChromeDriver.viewport', () => {
  it('reads dimensions from the page', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          width: 1280,
          height: 800,
          documentWidth: 1280,
          documentHeight: 4000,
          scrollX: 0,
          scrollY: 120,
          devicePixelRatio: 2,
        },
      },
    ]);
    const driver = new ChromeDriver(7);
    await expect(driver.viewport()).resolves.toMatchObject({
      documentHeight: 4000,
      scrollY: 120,
    });
  });
});

describe('ChromeDriver.screenshotFullPage', () => {
  it('scrolls the page and delegates stitching', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          width: 1000,
          height: 500,
          documentWidth: 1000,
          documentHeight: 1200,
          scrollX: 0,
          scrollY: 0,
          devicePixelRatio: 1,
        },
      },
    ]);
    chromeMock.tabs.captureVisibleTab.mockResolvedValue(
      'data:image/png;base64,AAAA',
    );
    const stitch = vi.fn().mockResolvedValue(new Uint8Array([9]));
    const driver = new ChromeDriver(7, { stitch, frameDelayMs: 0 });

    const png = await driver.screenshotFullPage();

    expect(png).toEqual(new Uint8Array([9]));
    // 1200px document at 500px viewport = 3 frames.
    expect(chromeMock.tabs.captureVisibleTab).toHaveBeenCalledTimes(3);
    expect(stitch).toHaveBeenCalledWith(
      expect.objectContaining({ frames: expect.any(Array) }),
    );
  });

  it('restores the original scroll position afterwards', async () => {
    chromeMock.scripting.executeScript.mockResolvedValue([
      {
        result: {
          width: 1000,
          height: 500,
          documentWidth: 1000,
          documentHeight: 1000,
          scrollX: 0,
          scrollY: 300,
          devicePixelRatio: 1,
        },
      },
    ]);
    chromeMock.tabs.captureVisibleTab.mockResolvedValue('data:image/png;base64,AAAA');
    const driver = new ChromeDriver(7, {
      stitch: async () => new Uint8Array([1]),
      frameDelayMs: 0,
    });
    await driver.screenshotFullPage();
    const scrollCalls = chromeMock.scripting.executeScript.mock.calls.filter(
      ([arg]) => JSON.stringify(arg).includes('scrollTo'),
    );
    expect(scrollCalls.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/chrome-driver.test.ts`
Expected: FAIL — `Cannot find module '../src/background/chrome-driver.js'`.

- [ ] **Step 4: Write `chrome-driver.ts`**

```ts
import type {
  AssetBytes,
  FetchOptions,
  PageDriver,
  Viewport,
} from '@page-capture/core';

export type StitchRequest = {
  frames: { dataUrl: string; offsetY: number }[];
  width: number;
  height: number;
  devicePixelRatio: number;
};

export type ChromeDriverDeps = {
  fetchImpl?: typeof fetch;
  /** Injected so screenshot logic is testable without an offscreen document. */
  stitch?: (request: StitchRequest) => Promise<Uint8Array>;
  /** Chrome throttles captureVisibleTab to 2/second; 550ms stays under it. */
  frameDelayMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ChromeDriver implements PageDriver {
  constructor(
    private readonly tabId: number,
    private readonly deps: ChromeDriverDeps = {},
  ) {}

  async evaluate<T>(fn: () => T): Promise<T> {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'ISOLATED',
      func: fn as () => unknown,
    });
    const first = frames[0];
    if (!first) throw new Error(`no result from tab ${this.tabId}`);
    return first.result as T;
  }

  async fetchAsset(url: string, options: FetchOptions): Promise<AssetBytes> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }
      const declared = response.headers.get('content-length');
      if (declared && Number(declared) > options.maxBytes) {
        throw new Error(
          `exceeds per-asset cap: declared ${declared} bytes`,
        );
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

  async viewport(): Promise<Viewport> {
    return this.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio,
    }));
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'ISOLATED',
      func: (px: number, py: number) => {
        window.scrollTo(px, py);
      },
      args: [x, y],
    });
  }

  async screenshotFullPage(): Promise<Uint8Array> {
    const stitch = this.deps.stitch;
    if (!stitch) throw new Error('no stitch implementation supplied');
    const delay = this.deps.frameDelayMs ?? 550;
    const view = await this.viewport();
    const originalScroll = { x: view.scrollX, y: view.scrollY };
    const frames: { dataUrl: string; offsetY: number }[] = [];

    try {
      for (let offsetY = 0; offsetY < view.documentHeight; offsetY += view.height) {
        await this.scrollTo(0, offsetY);
        if (delay > 0) await sleep(delay);
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        frames.push({ dataUrl, offsetY });
      }
    } finally {
      await this.scrollTo(originalScroll.x, originalScroll.y);
    }

    return stitch({
      frames,
      width: view.documentWidth,
      height: view.documentHeight,
      devicePixelRatio: view.devicePixelRatio,
    });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/chrome-driver.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the seam — run a core pipeline test through `ChromeDriver`**

Create `apps/extension/tests/seam.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAssets, defaultSettings } from '@page-capture/core';
import { installChromeMock } from './chrome-mock.js';
import { ChromeDriver } from '../src/background/chrome-driver.js';

beforeEach(() => {
  installChromeMock();
});

describe('core pipeline over ChromeDriver', () => {
  it('fetches assets through the real driver implementation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        headers: { 'content-type': 'image/png' },
      }),
    );
    const driver = new ChromeDriver(1, { fetchImpl });
    const result = await fetchAssets(
      driver,
      [{ url: 'https://example.com/a.png', kind: 'image', referencedBy: 'img' }],
      { limits: defaultSettings.limits },
    );
    expect(result.assets.size).toBe(1);
    expect(result.warnings).toEqual([]);
  });
});
```

Run: `pnpm vitest run apps/extension/tests/seam.test.ts`
Expected: PASS. This is the payoff for Phase 2 — a core function written and tested against a fake now runs against Chrome APIs untouched.

- [ ] **Step 7: Gate and commit**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

```bash
git add -A
git commit -m "feat(extension): implement PageDriver over chrome scripting and tabs"
```

---

### Task 13: Collector content-script entry and the zero-import build gate

**Files:**
- Create: `apps/extension/src/content/collector-entry.ts`
- Create: `apps/extension/tests/collector-bundle.test.ts`
- Modify: `apps/extension/vite.config.ts`
- Test: `apps/extension/tests/collector-entry.test.ts`

**Interfaces:**
- Consumes: `collectFromDocument`, `CollectOptions`, `PageIR`, `CaptureSettings` from `@page-capture/core`.
- Produces: a built artifact at `dist/collector.js` whose last expression is a `PageIR`, injectable via `chrome.scripting.executeScript({ files: ['collector.js'] })`. Exports `runCollector(settings: CaptureSettings): PageIR` for unit testing.

This is where the spec's "zero-import standalone function" requirement is actually enforced, and it is enforced against the **built** artifact. A source-level rule would not catch a bundler config change that starts emitting an import statement; a test over `dist/collector.js` does.

- [ ] **Step 1: Write the entry**

`apps/extension/src/content/collector-entry.ts`:

```ts
import {
  collectFromDocument,
  type CaptureSettings,
  type PageIR,
} from '@page-capture/core';

const RECORDER_KEY = '__pageCaptureRecorder';

type RecorderBuffer = { entries: PageIR['logs'] };

/**
 * Runs in the page. Everything core needs from the environment is read here and
 * passed in, which is why core itself never touches a global.
 */
export function runCollector(settings: CaptureSettings): PageIR {
  const recorder = (window as unknown as Record<string, RecorderBuffer | undefined>)[
    RECORDER_KEY
  ];

  return collectFromDocument(document, {
    settings,
    pageUrl: location.href,
    userAgent: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentSize: {
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    devicePixelRatio: window.devicePixelRatio,
    computedStyle: (el) => {
      const style = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const property of [
        'color',
        'background-color',
        'border-top-color',
        'font-family',
        'font-size',
        'line-height',
        'font-weight',
        'border-radius',
        'box-shadow',
        'padding-top',
        'padding-right',
        'padding-bottom',
        'padding-left',
        'margin-top',
        'margin-right',
        'margin-bottom',
        'margin-left',
        'gap',
      ]) {
        out[property] = style.getPropertyValue(property);
      }
      return out;
    },
    ...(settings.include.logs && recorder?.entries
      ? { logs: recorder.entries }
      : {}),
  });
}

// The last expression is the injected script's return value.
runCollector(
  (window as unknown as { __pageCaptureSettings: CaptureSettings })
    .__pageCaptureSettings,
);
```

- [ ] **Step 2: Add the collector as its own inlined build entry**

In `apps/extension/vite.config.ts`, add a second build input so the collector emits a single self-contained file:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

export default defineConfig({
  plugins: [react(), tailwind(), crx({ manifest })],
  build: {
    target: 'chrome116',
    emptyOutDir: true,
    rollupOptions: {
      input: { collector: 'src/content/collector-entry.ts' },
      output: {
        // The collector must be one file with no imports: it is injected
        // wholesale by chrome.scripting, which cannot resolve module specifiers.
        entryFileNames: (chunk) =>
          chunk.name === 'collector' ? 'collector.js' : 'assets/[name]-[hash].js',
        inlineDynamicImports: false,
        manualChunks: () => undefined,
        format: 'iife',
      },
    },
  },
});
```

- [ ] **Step 3: Write the failing unit test for the entry**

`apps/extension/tests/collector-entry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { defaultSettings } from '@page-capture/core';
import { runCollector } from '../src/content/collector-entry.js';

function installPage(html: string): void {
  const { window, document } = parseHTML(html);
  Object.assign(globalThis, {
    window: Object.assign(window, {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 2,
    }),
    document,
    location: { href: 'https://example.com/page' },
    navigator: { userAgent: 'test-agent' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
}

describe('runCollector', () => {
  it('reads the environment and returns a PageIR', () => {
    installPage('<html><head><title>T</title></head><body><h1>Hi</h1></body></html>');
    const ir = runCollector(defaultSettings);
    expect(ir.metadata.url).toBe('https://example.com/page');
    expect(ir.metadata.userAgent).toBe('test-agent');
    expect(ir.metadata.viewport).toEqual({ width: 1280, height: 800 });
    expect(ir.html).toContain('<h1>Hi</h1>');
  });

  it('omits logs when the recorder buffer is absent', () => {
    installPage('<html><body></body></html>');
    const ir = runCollector({
      ...defaultSettings,
      include: { ...defaultSettings.include, logs: true },
    });
    expect(ir.logs).toBeUndefined();
  });

  it('includes logs when the recorder buffer is present', () => {
    installPage('<html><body></body></html>');
    (globalThis.window as unknown as Record<string, unknown>).__pageCaptureRecorder =
      { entries: [{ kind: 'console', level: 'warn', at: 1, text: 'careful' }] };
    const ir = runCollector({
      ...defaultSettings,
      include: { ...defaultSettings.include, logs: true },
    });
    expect(ir.logs).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run it to verify it fails, then passes**

Run: `pnpm vitest run apps/extension/tests/collector-entry.test.ts`
Expected: initially FAIL on the missing module; after Step 1 is in place, PASS with 3 tests.

- [ ] **Step 5: Write the build-artifact gate**

`apps/extension/tests/collector-bundle.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const artifact = join(import.meta.dirname, '..', 'dist', 'collector.js');

describe('built collector artifact', () => {
  it('exists after a build', () => {
    expect(
      existsSync(artifact),
      'run `pnpm --filter @page-capture/extension build` first',
    ).toBe(true);
  });

  it('contains no import or export statement', () => {
    const code = readFileSync(artifact, 'utf8');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/^\s*export\s/m);
    expect(code).not.toMatch(/\bfrom\s+["'][^"']+["']/);
  });

  it('references no bare module specifier', () => {
    const code = readFileSync(artifact, 'utf8');
    expect(code).not.toContain('@page-capture/core');
  });

  it('is a single self-contained expression, not a module', () => {
    const code = readFileSync(artifact, 'utf8');
    expect(code).not.toContain('import.meta');
  });
});
```

- [ ] **Step 6: Build, then run the gate**

Run: `pnpm --filter @page-capture/extension build && pnpm vitest run apps/extension/tests/collector-bundle.test.ts`
Expected: PASS, 4 tests. If the import assertions fail, the Rollup output config in Step 2 is not producing an IIFE for this entry — fix the config, not the test. This test failing is the exact regression it exists to catch.

- [ ] **Step 7: Make CI run the gate after the build**

The gate reads `dist/`, so it must run after `pnpm -w build`. In `.github/workflows/ci.yml`, ensure the step order is: `test`, then `build`, then a second test run scoped to the artifact gate:

```yaml
      - run: pnpm -w build
      - run: pnpm vitest run apps/extension/tests/collector-bundle.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(extension): add collector entry with a zero-import build gate"
```

---

### Task 14: Console and network recorder

**Files:**
- Create: `apps/extension/src/content/recorder.ts`
- Test: `apps/extension/tests/recorder.test.ts`

**Interfaces:**
- Consumes: `LogEntry` from `@page-capture/core`.
- Produces: `installRecorder(target: RecorderTarget, options: RecorderOptions): void` and `type RecorderTarget`. The module's side effect on import is `installRecorder(window, { size: 500 })`.

Two properties matter more than the feature: the wrappers must be transparent to page code, and a throw inside the recorder must never propagate into the page. A capture tool that breaks the page it is capturing is worse than one without logs.

- [ ] **Step 1: Write the failing test**

`apps/extension/tests/recorder.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { installRecorder, RECORDER_KEY } from '../src/content/recorder.js';

type Target = Record<string, unknown>;

function makeTarget(): Target {
  return {
    console: {
      log: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    fetch: vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
    addEventListener: vi.fn(),
    performance: { now: () => 1000 },
  };
}

describe('installRecorder', () => {
  it('exposes a non-enumerable buffer under a symbol-ish key', () => {
    const target = makeTarget();
    installRecorder(target as never, { size: 10 });
    expect(Object.keys(target)).not.toContain(RECORDER_KEY);
    expect((target as Record<string, unknown>)[RECORDER_KEY]).toBeDefined();
  });

  it('records console calls and still calls through to the original', () => {
    const target = makeTarget();
    const original = (target.console as { warn: ReturnType<typeof vi.fn> }).warn;
    installRecorder(target as never, { size: 10 });
    (target.console as { warn: (m: string) => void }).warn('careful');
    expect(original).toHaveBeenCalledWith('careful');
    const buffer = (target as Record<string, { entries: unknown[] }>)[RECORDER_KEY]!;
    expect(buffer.entries).toHaveLength(1);
    expect(buffer.entries[0]).toMatchObject({
      kind: 'console',
      level: 'warn',
      text: 'careful',
    });
  });

  it('passes the original return value through fetch untouched', async () => {
    const target = makeTarget();
    installRecorder(target as never, { size: 10 });
    const response = await (target.fetch as typeof fetch)('https://example.com/a');
    expect(await response.text()).toBe('ok');
  });

  it('records a fetch with method, status, and duration', async () => {
    const target = makeTarget();
    installRecorder(target as never, { size: 10 });
    await (target.fetch as typeof fetch)('https://example.com/a', { method: 'POST' });
    const buffer = (target as Record<string, { entries: { kind: string }[] }>)[
      RECORDER_KEY
    ]!;
    const request = buffer.entries.find((e) => e.kind === 'request');
    expect(request).toMatchObject({
      method: 'POST',
      url: 'https://example.com/a',
      status: 200,
    });
  });

  it('records a rejected fetch with a null status and rethrows', async () => {
    const target = makeTarget();
    target.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    installRecorder(target as never, { size: 10 });
    await expect(
      (target.fetch as typeof fetch)('https://example.com/a'),
    ).rejects.toThrow('offline');
    const buffer = (target as Record<string, { entries: { status: unknown }[] }>)[
      RECORDER_KEY
    ]!;
    expect(buffer.entries.at(-1)).toMatchObject({ status: null });
  });

  it('never records a request body', async () => {
    const target = makeTarget();
    installRecorder(target as never, { size: 10 });
    await (target.fetch as typeof fetch)('https://example.com/a', {
      method: 'POST',
      body: 'secret-token=abc123',
    });
    const serialized = JSON.stringify(
      (target as Record<string, unknown>)[RECORDER_KEY],
    );
    expect(serialized).not.toContain('secret-token');
  });

  it('drops the oldest entry when the ring is full', () => {
    const target = makeTarget();
    installRecorder(target as never, { size: 3 });
    const console_ = target.console as { log: (m: string) => void };
    for (const message of ['a', 'b', 'c', 'd']) console_.log(message);
    const buffer = (target as Record<string, { entries: { text: string }[] }>)[
      RECORDER_KEY
    ]!;
    expect(buffer.entries).toHaveLength(3);
    expect(buffer.entries.map((e) => e.text)).toEqual(['b', 'c', 'd']);
  });

  it('swallows its own errors rather than breaking the page', () => {
    const target = makeTarget();
    installRecorder(target as never, {
      size: 10,
      serialize: () => {
        throw new Error('recorder bug');
      },
    });
    expect(() =>
      (target.console as { log: (m: string) => void }).log('x'),
    ).not.toThrow();
  });

  it('is idempotent — installing twice does not double-record', () => {
    const target = makeTarget();
    installRecorder(target as never, { size: 10 });
    installRecorder(target as never, { size: 10 });
    (target.console as { log: (m: string) => void }).log('once');
    const buffer = (target as Record<string, { entries: unknown[] }>)[RECORDER_KEY]!;
    expect(buffer.entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/recorder.test.ts`
Expected: FAIL — `Cannot find module '../src/content/recorder.js'`.

- [ ] **Step 3: Write `recorder.ts`**

```ts
import type { LogEntry } from '@page-capture/core';

export const RECORDER_KEY = '__pageCaptureRecorder';

export type RecorderTarget = Window & typeof globalThis;

export type RecorderOptions = {
  size: number;
  serialize?: (args: unknown[]) => string;
};

type Buffer = { entries: LogEntry[]; installed: true };

const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function defaultSerialize(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/**
 * Patches console and fetch on `target` to record into a ring buffer. Every
 * wrapper calls through to the original and returns its value unchanged; a
 * throw inside the recorder is swallowed. Breaking the page under capture is
 * not an acceptable failure mode for a logging feature.
 */
export function installRecorder(
  target: RecorderTarget,
  options: RecorderOptions,
): void {
  const holder = target as unknown as Record<string, Buffer | undefined>;
  if (holder[RECORDER_KEY]?.installed) return;

  const buffer: Buffer = { entries: [], installed: true };
  Object.defineProperty(target, RECORDER_KEY, {
    value: buffer,
    enumerable: false,
    configurable: true,
    writable: false,
  });

  const serialize = options.serialize ?? defaultSerialize;
  const record = (entry: LogEntry): void => {
    buffer.entries.push(entry);
    if (buffer.entries.length > options.size) buffer.entries.shift();
  };
  const safely = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* a recorder failure must never reach page code */
    }
  };

  const console_ = target.console as unknown as Record<
    string,
    (...args: unknown[]) => void
  >;
  for (const level of CONSOLE_LEVELS) {
    const original = console_[level];
    if (typeof original !== 'function') continue;
    console_[level] = (...args: unknown[]) => {
      safely(() =>
        record({
          kind: 'console',
          level,
          at: Date.now(),
          text: serialize(args),
        }),
      );
      return original.apply(target.console, args);
    };
  }

  const originalFetch = target.fetch;
  if (typeof originalFetch === 'function') {
    target.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const started = Date.now();
      const url = typeof input === 'string' ? input : String(input);
      const method = init?.method ?? 'GET';
      try {
        const response = await originalFetch.call(target, input, init);
        safely(() =>
          record({
            kind: 'request',
            at: started,
            method,
            url,
            status: response.status,
            durationMs: Date.now() - started,
            size: Number(response.headers.get('content-length')) || null,
          }),
        );
        return response;
      } catch (error) {
        safely(() =>
          record({
            kind: 'request',
            at: started,
            method,
            url,
            status: null,
            durationMs: Date.now() - started,
            size: null,
          }),
        );
        throw error;
      }
    };
  }

  if (typeof target.addEventListener === 'function') {
    target.addEventListener('error', (event: ErrorEvent) => {
      safely(() =>
        record({
          kind: 'error',
          at: Date.now(),
          message: event.message,
          ...(event.error instanceof Error && event.error.stack
            ? { stack: event.error.stack }
            : {}),
        }),
      );
    });
    target.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      safely(() =>
        record({
          kind: 'error',
          at: Date.now(),
          message: String(event.reason),
        }),
      );
    });
  }
}

installRecorder(window as RecorderTarget, { size: 500 });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/recorder.test.ts`
Expected: PASS, 9 tests. The bottom-of-file `installRecorder(window, …)` call is the content script's side effect; the test imports the named export and passes its own target, so the module-level call is harmless under test only if `window` exists. If the import throws in Node, move the side-effect call into a separate `recorder-entry.ts` referenced by the manifest and keep `recorder.ts` side-effect free — that is the cleaner split and worth doing if it bites.

- [ ] **Step 5: Gate and commit**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

```bash
git add -A
git commit -m "feat(extension): record console and network into a transparent ring buffer"
```

---

### Task 15: Offscreen document — stitching, zipping, object URLs

**Files:**
- Create: `apps/extension/src/offscreen/index.html`, `apps/extension/src/offscreen/index.ts`, `apps/extension/src/offscreen/stitch.ts`
- Create: `apps/extension/src/background/offscreen-client.ts`
- Modify: `apps/extension/src/lib/messages.ts` (created here)
- Test: `apps/extension/tests/stitch.test.ts`, `apps/extension/tests/offscreen-client.test.ts`

**Interfaces:**
- Consumes: `BundleOutput` from `@page-capture/core`.
- Produces: `stitchFrames(request: StitchRequest, deps: StitchDeps): Promise<Uint8Array>`; `class OffscreenClient` with `ensure()`, `stitch(request)`, `toObjectUrl(bytes, mimeType)`, `close()`; and the message types `OffscreenRequest`, `OffscreenResponse` in `messages.ts`.

The offscreen document exists for three things a service worker cannot do: decode and compose images, create an object URL, and stay alive while doing it. `stitchFrames` takes its canvas factory as a dependency so the geometry is unit-testable without a real canvas.

- [ ] **Step 1: Write the message contracts**

`apps/extension/src/lib/messages.ts`:

```ts
import type { StitchRequest } from '../background/chrome-driver.js';

export type OffscreenRequest =
  | { type: 'offscreen:stitch'; request: StitchRequest }
  | { type: 'offscreen:object-url'; bytes: number[]; mimeType: string }
  | { type: 'offscreen:revoke'; url: string };

export type OffscreenResponse =
  | { ok: true; type: 'stitch'; bytes: number[] }
  | { ok: true; type: 'object-url'; url: string }
  | { ok: true; type: 'revoked' }
  | { ok: false; error: string };

export type CapturePhase =
  | 'idle'
  | 'permissions'
  | 'collecting'
  | 'fetching-assets'
  | 'screenshot'
  | 'bundling'
  | 'downloading'
  | 'done'
  | 'failed';

export type CaptureProgress = {
  phase: CapturePhase;
  done: number;
  total: number;
  warningCount: number;
  message?: string;
};

export type PopupToWorker =
  | { type: 'capture:start'; tabId: number }
  | { type: 'capture:cancel' };

export type WorkerToPopup =
  | { type: 'capture:progress'; progress: CaptureProgress }
  | {
      type: 'capture:done';
      filename: string;
      byteLength: number;
      warnings: { phase: string; url?: string; reason: string; detail?: string }[];
    }
  | { type: 'capture:failed'; reason: string; recoverable: boolean };

export const CAPTURE_PORT = 'page-capture';
```

- [ ] **Step 2: Write the failing stitch test**

`apps/extension/tests/stitch.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { stitchFrames } from '../src/offscreen/stitch.js';

function fakeDeps() {
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage }),
    convertToBlob: vi
      .fn()
      .mockResolvedValue({ arrayBuffer: async () => new Uint8Array([1, 2]).buffer }),
  };
  return {
    drawImage,
    canvas,
    deps: {
      createCanvas: (w: number, h: number) => {
        canvas.width = w;
        canvas.height = h;
        return canvas as unknown as OffscreenCanvas;
      },
      decode: vi.fn(async (dataUrl: string) => ({
        width: 100,
        height: 50,
        dataUrl,
      })) as unknown as (dataUrl: string) => Promise<ImageBitmap>,
    },
  };
}

describe('stitchFrames', () => {
  it('sizes the canvas to the full document in device pixels', async () => {
    const { canvas, deps } = fakeDeps();
    await stitchFrames(
      {
        frames: [{ dataUrl: 'a', offsetY: 0 }],
        width: 800,
        height: 1600,
        devicePixelRatio: 2,
      },
      deps,
    );
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(3200);
  });

  it('draws each frame at its scaled offset', async () => {
    const { drawImage, deps } = fakeDeps();
    await stitchFrames(
      {
        frames: [
          { dataUrl: 'a', offsetY: 0 },
          { dataUrl: 'b', offsetY: 800 },
        ],
        width: 800,
        height: 1600,
        devicePixelRatio: 2,
      },
      deps,
    );
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(drawImage.mock.calls[1]![2]).toBe(1600); // 800 * dpr
  });

  it('returns png bytes', async () => {
    const { deps } = fakeDeps();
    const bytes = await stitchFrames(
      { frames: [{ dataUrl: 'a', offsetY: 0 }], width: 10, height: 10, devicePixelRatio: 1 },
      deps,
    );
    expect(bytes).toEqual(new Uint8Array([1, 2]));
  });

  it('throws a clear error when there are no frames', async () => {
    const { deps } = fakeDeps();
    await expect(
      stitchFrames(
        { frames: [], width: 10, height: 10, devicePixelRatio: 1 },
        deps,
      ),
    ).rejects.toThrow('no frames to stitch');
  });

  it('skips a frame that fails to decode and still returns an image', async () => {
    const { deps, drawImage } = fakeDeps();
    deps.decode = vi
      .fn()
      .mockRejectedValueOnce(new Error('bad png'))
      .mockResolvedValue({ width: 100, height: 50 }) as never;
    const bytes = await stitchFrames(
      {
        frames: [
          { dataUrl: 'bad', offsetY: 0 },
          { dataUrl: 'good', offsetY: 800 },
        ],
        width: 800,
        height: 1600,
        devicePixelRatio: 1,
      },
      deps,
    );
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(drawImage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/stitch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `stitch.ts`**

```ts
import type { StitchRequest } from '../background/chrome-driver.js';

export type StitchDeps = {
  createCanvas: (width: number, height: number) => OffscreenCanvas;
  decode: (dataUrl: string) => Promise<ImageBitmap>;
};

export const defaultStitchDeps: StitchDeps = {
  createCanvas: (width, height) => new OffscreenCanvas(width, height),
  decode: async (dataUrl) => {
    const response = await fetch(dataUrl);
    return createImageBitmap(await response.blob());
  },
};

/**
 * Composes viewport frames into one full-page PNG. A frame that fails to decode
 * is skipped rather than failing the capture — a partial screenshot beats none.
 */
export async function stitchFrames(
  request: StitchRequest,
  deps: StitchDeps = defaultStitchDeps,
): Promise<Uint8Array> {
  if (request.frames.length === 0) throw new Error('no frames to stitch');

  const ratio = request.devicePixelRatio || 1;
  const canvas = deps.createCanvas(
    Math.round(request.width * ratio),
    Math.round(request.height * ratio),
  );
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d context unavailable in offscreen canvas');

  for (const frame of request.frames) {
    try {
      const bitmap = await deps.decode(frame.dataUrl);
      context.drawImage(bitmap, 0, Math.round(frame.offsetY * ratio));
    } catch {
      /* skip an undecodable frame; the rest of the image is still useful */
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/stitch.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Write the offscreen document and its host**

`apps/extension/src/offscreen/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Page Capture worker</title>
  </head>
  <body>
    <script type="module" src="./index.ts"></script>
  </body>
</html>
```

`apps/extension/src/offscreen/index.ts`:

```ts
import { stitchFrames } from './stitch.js';
import type { OffscreenRequest, OffscreenResponse } from '../lib/messages.js';

const objectUrls = new Set<string>();

chrome.runtime.onMessage.addListener(
  (
    message: OffscreenRequest,
    _sender,
    respond: (response: OffscreenResponse) => void,
  ) => {
    void (async () => {
      try {
        if (message.type === 'offscreen:stitch') {
          const bytes = await stitchFrames(message.request);
          respond({ ok: true, type: 'stitch', bytes: [...bytes] });
          return;
        }
        if (message.type === 'offscreen:object-url') {
          const blob = new Blob([new Uint8Array(message.bytes)], {
            type: message.mimeType,
          });
          const url = URL.createObjectURL(blob);
          objectUrls.add(url);
          respond({ ok: true, type: 'object-url', url });
          return;
        }
        if (message.type === 'offscreen:revoke') {
          URL.revokeObjectURL(message.url);
          objectUrls.delete(message.url);
          respond({ ok: true, type: 'revoked' });
        }
      } catch (error) {
        respond({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true; // keep the channel open for the async respond
  },
);
```

- [ ] **Step 7: Write the failing client test**

`apps/extension/tests/offscreen-client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OffscreenClient } from '../src/background/offscreen-client.js';

type Mock = {
  offscreen: {
    hasDocument: ReturnType<typeof vi.fn>;
    createDocument: ReturnType<typeof vi.fn>;
    closeDocument: ReturnType<typeof vi.fn>;
  };
  runtime: { sendMessage: ReturnType<typeof vi.fn>; getURL: (p: string) => string };
};

let chromeMock: Mock;

beforeEach(() => {
  chromeMock = {
    offscreen: {
      hasDocument: vi.fn().mockResolvedValue(false),
      createDocument: vi.fn().mockResolvedValue(undefined),
      closeDocument: vi.fn().mockResolvedValue(undefined),
    },
    runtime: {
      sendMessage: vi.fn(),
      getURL: (p: string) => `chrome-extension://id/${p}`,
    },
  };
  (globalThis as unknown as { chrome: Mock }).chrome = chromeMock;
});

describe('OffscreenClient', () => {
  it('creates the document once', async () => {
    const client = new OffscreenClient();
    await client.ensure();
    await client.ensure();
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('does not create a document that already exists', async () => {
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);
    await new OffscreenClient().ensure();
    expect(chromeMock.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('returns stitched bytes as a Uint8Array', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true,
      type: 'stitch',
      bytes: [1, 2, 3],
    });
    const client = new OffscreenClient();
    const bytes = await client.stitch({
      frames: [{ dataUrl: 'a', offsetY: 0 }],
      width: 1,
      height: 1,
      devicePixelRatio: 1,
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('throws the offscreen error message on failure', async () => {
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: false,
      error: 'canvas exploded',
    });
    await expect(
      new OffscreenClient().toObjectUrl(new Uint8Array([1]), 'text/html'),
    ).rejects.toThrow('canvas exploded');
  });

  it('closes the document only if one exists', async () => {
    chromeMock.offscreen.hasDocument.mockResolvedValue(true);
    await new OffscreenClient().close();
    expect(chromeMock.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/offscreen-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 9: Write `offscreen-client.ts`**

```ts
import type { StitchRequest } from './chrome-driver.js';
import type { OffscreenRequest, OffscreenResponse } from '../lib/messages.js';

const DOCUMENT_PATH = 'src/offscreen/index.html';

/**
 * Wraps the offscreen document. Its lifetime also keeps the service worker
 * alive during a capture — but that is a side effect, not a guarantee we rely
 * on; see session.ts for the actual durability story.
 */
export class OffscreenClient {
  private creating: Promise<void> | undefined;

  async ensure(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    this.creating ??= chrome.offscreen.createDocument({
      url: DOCUMENT_PATH,
      reasons: ['BLOBS', 'DOM_PARSER'],
      justification:
        'Compose the full-page screenshot, assemble the archive, and create the download URL.',
    });
    await this.creating;
  }

  private async send(request: OffscreenRequest): Promise<OffscreenResponse> {
    await this.ensure();
    const response = (await chrome.runtime.sendMessage(
      request,
    )) as OffscreenResponse;
    if (!response.ok) throw new Error(response.error);
    return response;
  }

  async stitch(request: StitchRequest): Promise<Uint8Array> {
    const response = await this.send({ type: 'offscreen:stitch', request });
    if (response.ok && response.type === 'stitch') {
      return new Uint8Array(response.bytes);
    }
    throw new Error('unexpected offscreen response for stitch');
  }

  async toObjectUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
    const response = await this.send({
      type: 'offscreen:object-url',
      bytes: [...bytes],
      mimeType,
    });
    if (response.ok && response.type === 'object-url') return response.url;
    throw new Error('unexpected offscreen response for object url');
  }

  async revoke(url: string): Promise<void> {
    await this.send({ type: 'offscreen:revoke', url });
  }

  async close(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
    this.creating = undefined;
  }
}
```

- [ ] **Step 10: Run it to verify it passes, then gate**

Run: `pnpm vitest run apps/extension/tests/offscreen-client.test.ts`
Expected: PASS, 5 tests.

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(extension): add offscreen document for stitching, zipping, and blob urls"
```

---

### Task 16: Background orchestration

**Files:**
- Create: `apps/extension/src/background/restricted.ts`, `apps/extension/src/background/permissions.ts`, `apps/extension/src/background/session.ts`, `apps/extension/src/background/capture.ts`, `apps/extension/src/background/index.ts`
- Test: `apps/extension/tests/restricted.test.ts`, `apps/extension/tests/permissions.test.ts`, `apps/extension/tests/session.test.ts`, `apps/extension/tests/capture.test.ts`

**Interfaces:**
- Consumes: everything built so far — `ChromeDriver`, `OffscreenClient`, and from core: `fetchAssets`, `inlineDocument`, `buildSingleFile`, `buildZip`, `buildTokens`, `parseSettings`.
- Produces: `restrictionFor(url): string | null`; `ensureHostPermission(): Promise<boolean>`; `class CaptureSession` with `save(phase, data)`, `load()`, `clear()`; `runCapture(input: RunCaptureInput): Promise<CaptureResult>`; and the service worker entry wiring the port.

This is the largest task. It is one task rather than four because the pieces have no independent deliverable — a permission helper with no capture to gate is not something a reviewer can meaningfully accept or reject. Each piece still gets its own test file.

- [ ] **Step 1: Write the failing restricted-page test**

`apps/extension/tests/restricted.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { restrictionFor } from '../src/background/restricted.js';

describe('restrictionFor', () => {
  it.each([
    ['chrome://settings', 'Chrome internal pages'],
    ['edge://flags', 'Chrome internal pages'],
    ['chrome-extension://abc/popup.html', 'extension pages'],
    ['https://chromewebstore.google.com/detail/x', 'the Chrome Web Store'],
    ['https://chrome.google.com/webstore/detail/x', 'the Chrome Web Store'],
    ['view-source:https://example.com', 'view-source pages'],
    ['about:blank', 'blank and about: pages'],
    ['file:///Users/me/a.pdf', 'local files'],
  ])('%s is restricted, naming %s', (url, expected) => {
    expect(restrictionFor(url)).toContain(expected);
  });

  it.each(['https://example.com', 'http://localhost:3000/app'])(
    '%s is capturable',
    (url) => {
      expect(restrictionFor(url)).toBeNull();
    },
  );

  it('returns a reason mentioning what the user can do', () => {
    expect(restrictionFor('chrome://settings')).toMatch(/cannot be captured/i);
  });
});
```

- [ ] **Step 2: Write `restricted.ts`**

```ts
const RULES: { test: (url: URL) => boolean; what: string }[] = [
  {
    test: (url) => url.protocol === 'chrome:' || url.protocol === 'edge:',
    what: 'Chrome internal pages',
  },
  { test: (url) => url.protocol === 'chrome-extension:', what: 'extension pages' },
  { test: (url) => url.protocol === 'view-source:', what: 'view-source pages' },
  { test: (url) => url.protocol === 'about:', what: 'blank and about: pages' },
  { test: (url) => url.protocol === 'file:', what: 'local files' },
  {
    test: (url) =>
      url.hostname === 'chromewebstore.google.com' ||
      (url.hostname === 'chrome.google.com' &&
        url.pathname.startsWith('/webstore')),
    what: 'the Chrome Web Store',
  },
];

/**
 * Returns a human-readable reason, or null when the page is capturable. The
 * reason names the category so the popup can say something specific instead of
 * failing generically.
 */
export function restrictionFor(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'This page cannot be captured: its address could not be read.';
  }
  for (const rule of RULES) {
    if (rule.test(url)) {
      return `This page cannot be captured: Chrome does not allow extensions to read ${rule.what}.`;
    }
  }
  return null;
}
```

- [ ] **Step 3: Run the test**

Run: `pnpm vitest run apps/extension/tests/restricted.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 4: Write the failing permissions test**

`apps/extension/tests/permissions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureHostPermission } from '../src/background/permissions.js';

let contains: ReturnType<typeof vi.fn>;
let request: ReturnType<typeof vi.fn>;

beforeEach(() => {
  contains = vi.fn();
  request = vi.fn();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    permissions: { contains, request },
  };
});

describe('ensureHostPermission', () => {
  it('does not prompt when already granted', async () => {
    contains.mockResolvedValue(true);
    await expect(ensureHostPermission()).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('requests all_urls when not granted', async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(true);
    await expect(ensureHostPermission()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ['<all_urls>'] });
  });

  it('returns false when the user declines, without throwing', async () => {
    contains.mockResolvedValue(false);
    request.mockResolvedValue(false);
    await expect(ensureHostPermission()).resolves.toBe(false);
  });

  it('returns false rather than propagating a request error', async () => {
    contains.mockResolvedValue(false);
    request.mockRejectedValue(new Error('no user gesture'));
    await expect(ensureHostPermission()).resolves.toBe(false);
  });
});
```

- [ ] **Step 5: Write `permissions.ts`**

```ts
const ALL_URLS = { origins: ['<all_urls>'] } as const;

/**
 * True when the extension may fetch cross-origin assets. Declining is a
 * supported path: the capture proceeds with same-origin material and warns,
 * so this never throws and never blocks.
 */
export async function ensureHostPermission(): Promise<boolean> {
  try {
    if (await chrome.permissions.contains(ALL_URLS)) return true;
    return await chrome.permissions.request(ALL_URLS);
  } catch {
    return false;
  }
}
```

- [ ] **Step 6: Write the failing session test**

`apps/extension/tests/session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureSession } from '../src/background/session.js';

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete store[key];
        }),
      },
    },
  };
});

describe('CaptureSession', () => {
  it('returns null when nothing is checkpointed', async () => {
    await expect(new CaptureSession().load()).resolves.toBeNull();
  });

  it('round-trips a checkpoint', async () => {
    const session = new CaptureSession();
    await session.save({ phase: 'fetching-assets', tabId: 3, startedAt: 1 });
    await expect(session.load()).resolves.toMatchObject({
      phase: 'fetching-assets',
      tabId: 3,
    });
  });

  it('clears a checkpoint', async () => {
    const session = new CaptureSession();
    await session.save({ phase: 'bundling', tabId: 3, startedAt: 1 });
    await session.clear();
    await expect(session.load()).resolves.toBeNull();
  });

  it('treats a checkpoint older than the staleness window as absent', async () => {
    const session = new CaptureSession({ maxAgeMs: 1000, now: () => 5000 });
    await session.save({ phase: 'bundling', tabId: 3, startedAt: 1000 });
    await expect(session.load()).resolves.toBeNull();
  });
});
```

- [ ] **Step 7: Write `session.ts`**

```ts
import type { CapturePhase } from '../lib/messages.js';

export type Checkpoint = {
  phase: CapturePhase;
  tabId: number;
  startedAt: number;
};

const KEY = 'capture:checkpoint';

export type SessionOptions = {
  /** A checkpoint older than this is assumed dead, not resumable. */
  maxAgeMs?: number;
  now?: () => number;
};

/**
 * Phase checkpointing. The offscreen document usually keeps the worker alive
 * through a capture, but "usually" is not a guarantee — if the worker is killed
 * mid-capture we want to report a specific failure rather than stall silently.
 */
export class CaptureSession {
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: SessionOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await chrome.storage.session.set({ [KEY]: checkpoint });
  }

  async load(): Promise<Checkpoint | null> {
    const stored = (await chrome.storage.session.get(KEY)) as Record<
      string,
      Checkpoint | undefined
    >;
    const checkpoint = stored[KEY];
    if (!checkpoint) return null;
    if (this.now() - checkpoint.startedAt > this.maxAgeMs) return null;
    return checkpoint;
  }

  async clear(): Promise<void> {
    await chrome.storage.session.remove(KEY);
  }
}
```

- [ ] **Step 8: Run both new test files**

Run: `pnpm vitest run apps/extension/tests/permissions.test.ts apps/extension/tests/session.test.ts`
Expected: PASS, 8 tests total.

- [ ] **Step 9: Write the failing orchestration test**

`apps/extension/tests/capture.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { defaultSettings, emptyTally, type PageIR } from '@page-capture/core';
import { runCapture } from '../src/background/capture.js';

const ir: PageIR = {
  metadata: {
    url: 'https://example.com/p',
    title: 'P',
    capturedAt: '2026-08-27T10:00:00.000Z',
    viewport: { width: 1280, height: 800 },
    documentSize: { width: 1280, height: 2400 },
    devicePixelRatio: 1,
    userAgent: 'test',
    charset: 'utf-8',
    meta: {},
  },
  html: '<html><head></head><body><img src="https://example.com/a.png" /></body></html>',
  regions: [],
  styles: [{ kind: 'cross-origin', href: 'https://cdn.example.com/v.css' }],
  assets: [
    { url: 'https://example.com/a.png', kind: 'image', referencedBy: 'img[src]' },
  ],
  styleTally: emptyTally(),
  warnings: [],
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    collect: vi.fn().mockResolvedValue(ir),
    fetchAsset: vi.fn().mockResolvedValue({
      url: 'https://example.com/a.png',
      bytes: new Uint8Array([1]),
      contentType: 'image/png',
    }),
    fetchText: vi.fn().mockResolvedValue('a{color:red}'),
    screenshot: vi.fn().mockResolvedValue(new Uint8Array([137])),
    parseDocument: (html: string) =>
      parseHTML(html).document as unknown as Document,
    serializeDocument: (doc: Document) => doc.documentElement.outerHTML,
    toObjectUrl: vi.fn().mockResolvedValue('blob:fake'),
    download: vi.fn().mockResolvedValue(11),
    ensurePermission: vi.fn().mockResolvedValue(true),
    onProgress: vi.fn(),
    ...overrides,
  };
}

describe('runCapture', () => {
  it('produces a filename and byte length', async () => {
    const d = deps();
    const result = await runCapture({ tabId: 1, settings: defaultSettings }, d as never);
    expect(result.filename).toBe('example.com-20260827-100000.html');
    expect(result.byteLength).toBeGreaterThan(0);
    expect(d.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: result.filename }),
    );
  });

  it('reports every phase in order', async () => {
    const d = deps();
    await runCapture({ tabId: 1, settings: defaultSettings }, d as never);
    const phases = d.onProgress.mock.calls.map(
      ([p]: [{ phase: string }]) => p.phase,
    );
    expect(phases).toEqual([
      'permissions',
      'collecting',
      'fetching-assets',
      'bundling',
      'downloading',
      'done',
    ]);
  });

  it('fetches cross-origin stylesheets listed in the IR', async () => {
    const d = deps();
    await runCapture({ tabId: 1, settings: defaultSettings }, d as never);
    expect(d.fetchText).toHaveBeenCalledWith(
      'https://cdn.example.com/v.css',
      expect.anything(),
    );
  });

  it('warns and continues when the permission is declined', async () => {
    const d = deps({ ensurePermission: vi.fn().mockResolvedValue(false) });
    const result = await runCapture(
      { tabId: 1, settings: defaultSettings },
      d as never,
    );
    expect(d.fetchText).not.toHaveBeenCalled();
    expect(
      result.warnings.some((w) => w.reason.includes('permission')),
    ).toBe(true);
    expect(result.filename).toBeTruthy();
  });

  it('skips the screenshot phase when the toggle is off', async () => {
    const d = deps();
    await runCapture({ tabId: 1, settings: defaultSettings }, d as never);
    expect(d.screenshot).not.toHaveBeenCalled();
  });

  it('includes the screenshot when the toggle is on', async () => {
    const d = deps();
    await runCapture(
      {
        tabId: 1,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
          output: 'zip',
        },
      },
      d as never,
    );
    expect(d.screenshot).toHaveBeenCalledTimes(1);
  });

  it('warns instead of failing when the screenshot throws', async () => {
    const d = deps({
      screenshot: vi.fn().mockRejectedValue(new Error('throttled')),
    });
    const result = await runCapture(
      {
        tabId: 1,
        settings: {
          ...defaultSettings,
          include: { ...defaultSettings.include, screenshot: true },
        },
      },
      d as never,
    );
    expect(result.filename).toBeTruthy();
    expect(result.warnings.some((w) => w.phase === 'screenshot')).toBe(true);
  });

  it('produces a zip when the output mode is zip', async () => {
    const d = deps();
    const result = await runCapture(
      { tabId: 1, settings: { ...defaultSettings, output: 'zip' } },
      d as never,
    );
    expect(result.filename.endsWith('.zip')).toBe(true);
  });

  it('surfaces the download error verbatim when the download fails', async () => {
    const d = deps({
      download: vi.fn().mockRejectedValue(new Error('Download blocked by user')),
    });
    await expect(
      runCapture({ tabId: 1, settings: defaultSettings }, d as never),
    ).rejects.toThrow('Download blocked by user');
  });

  it('aggregates warnings from every phase into the result', async () => {
    const d = deps({
      fetchAsset: vi.fn().mockRejectedValue(new Error('404')),
    });
    const result = await runCapture(
      { tabId: 1, settings: defaultSettings },
      d as never,
    );
    expect(result.warnings.some((w) => w.phase === 'assets')).toBe(true);
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/capture.test.ts`
Expected: FAIL — `Cannot find module '../src/background/capture.js'`.

- [ ] **Step 11: Write `capture.ts`**

```ts
import {
  buildSingleFile,
  buildTokens,
  buildZip,
  fetchAssets,
  inlineDocument,
  assetPathFor,
  type BundleOutput,
  type CaptureSettings,
  type FetchedAsset,
  type PageIR,
  type Warning,
} from '@page-capture/core';
import type { CaptureProgress } from '../lib/messages.js';

export type RunCaptureInput = {
  tabId: number;
  settings: CaptureSettings;
};

export type CaptureDeps = {
  collect: (tabId: number, settings: CaptureSettings) => Promise<PageIR>;
  fetchAsset: (
    url: string,
    options: { timeoutMs: number; maxBytes: number },
  ) => Promise<{ url: string; bytes: Uint8Array; contentType: string | null }>;
  fetchText: (
    url: string,
    options: { timeoutMs: number; maxBytes: number },
  ) => Promise<string>;
  screenshot: (tabId: number) => Promise<Uint8Array>;
  parseDocument: (html: string) => Document;
  serializeDocument: (doc: Document) => string;
  toObjectUrl: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  download: (options: { url: string; filename: string }) => Promise<number>;
  ensurePermission: () => Promise<boolean>;
  onProgress: (progress: CaptureProgress) => void;
};

export type CaptureResult = {
  filename: string;
  byteLength: number;
  warnings: Warning[];
};

/**
 * The whole capture, phase by phase. Every failure that is not fatal to
 * producing a file becomes a warning; only a download failure rejects.
 */
export async function runCapture(
  input: RunCaptureInput,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const { settings } = input;
  const warnings: Warning[] = [];
  const report = (
    phase: CaptureProgress['phase'],
    done = 0,
    total = 0,
  ): void => {
    deps.onProgress({ phase, done, total, warningCount: warnings.length });
  };

  report('permissions');
  const hasHostPermission = await deps.ensurePermission();
  if (!hasHostPermission) {
    warnings.push({
      phase: 'permissions',
      reason:
        'host permission declined — cross-origin stylesheets and assets were skipped',
    });
  }

  report('collecting');
  const ir = await deps.collect(input.tabId, settings);
  warnings.push(...ir.warnings);

  const fetchOptions = {
    timeoutMs: settings.limits.assetTimeoutMs,
    maxBytes: settings.limits.maxAssetBytes,
  };

  report('fetching-assets', 0, ir.assets.length);
  const fetched = await fetchAssets(
    {
      evaluate: async () => {
        throw new Error('not used during asset fetching');
      },
      fetchAsset: deps.fetchAsset,
      screenshotFullPage: async () => deps.screenshot(input.tabId),
      scrollTo: async () => {},
      viewport: async () => ({
        width: ir.metadata.viewport.width,
        height: ir.metadata.viewport.height,
        documentWidth: ir.metadata.documentSize.width,
        documentHeight: ir.metadata.documentSize.height,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: ir.metadata.devicePixelRatio,
      }),
    },
    ir.assets,
    {
      limits: settings.limits,
      onProgress: ({ done, total }) => report('fetching-assets', done, total),
    },
  );
  warnings.push(...fetched.warnings);

  const styleTexts = new Map<string, string>();
  for (const style of ir.styles) {
    if (style.kind === 'cross-origin') {
      if (!hasHostPermission) continue;
      try {
        styleTexts.set(style.href, await deps.fetchText(style.href, fetchOptions));
      } catch (error) {
        warnings.push({
          phase: 'styles',
          url: style.href,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (style.kind === 'same-origin') {
      styleTexts.set(style.href, style.text);
    }
  }
  for (const [url, asset] of fetched.assets) {
    if (asset.ref.kind === 'stylesheet') {
      styleTexts.set(url, new TextDecoder().decode(asset.bytes));
    }
  }

  let screenshot: Uint8Array | undefined;
  if (settings.include.screenshot) {
    report('screenshot');
    try {
      screenshot = await deps.screenshot(input.tabId);
    } catch (error) {
      warnings.push({
        phase: 'screenshot',
        reason: error instanceof Error ? error.message : String(error),
        detail: 'the screenshot was omitted; the rest of the capture is intact',
      });
    }
  }

  report('bundling');
  const doc = deps.parseDocument(ir.html);
  const assetMap: Map<string, FetchedAsset> = fetched.assets;
  const inlineResult = inlineDocument(doc, {
    pageUrl: ir.metadata.url,
    settings,
    assets: assetMap,
    styleTexts,
    assetPath:
      settings.output === 'zip'
        ? (url) => assetPathFor(url, assetMap.get(url)?.ref.kind ?? 'image')
        : undefined,
  });
  warnings.push(...inlineResult.warnings);

  const bundleInput = {
    ir: { ...ir, warnings },
    settings,
    html: deps.serializeDocument(doc),
    assets: assetMap,
    styleTexts,
    tokens: settings.include.tokens
      ? buildTokens(ir.styleTally, { minCount: 2, maxPerGroup: 24 })
      : undefined,
    screenshot,
  };
  const bundle: BundleOutput =
    settings.output === 'zip' ? buildZip(bundleInput) : buildSingleFile(bundleInput);

  report('downloading');
  const url = await deps.toObjectUrl(bundle.bytes, bundle.mimeType);
  await deps.download({ url, filename: bundle.filename });

  report('done');
  return {
    filename: bundle.filename,
    byteLength: bundle.bytes.byteLength,
    warnings,
  };
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/capture.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 13: Write the service worker entry**

`apps/extension/src/background/index.ts`:

```ts
import { parseSettings, type CaptureSettings } from '@page-capture/core';
import { ChromeDriver } from './chrome-driver.js';
import { OffscreenClient } from './offscreen-client.js';
import { CaptureSession } from './session.js';
import { ensureHostPermission } from './permissions.js';
import { restrictionFor } from './restricted.js';
import { runCapture } from './capture.js';
import {
  CAPTURE_PORT,
  type PopupToWorker,
  type WorkerToPopup,
} from '../lib/messages.js';

const SETTINGS_KEY = 'settings';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;

async function loadSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return parseSettings(stored[SETTINGS_KEY] ?? {});
}

async function recordHistory(entry: {
  url: string;
  filename: string;
  byteLength: number;
  warningCount: number;
  at: number;
}): Promise<void> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = [entry, ...((stored[HISTORY_KEY] as unknown[]) ?? [])].slice(
    0,
    HISTORY_LIMIT,
  );
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CAPTURE_PORT) return;
  const offscreen = new OffscreenClient();
  const session = new CaptureSession();
  const post = (message: WorkerToPopup) => {
    try {
      port.postMessage(message);
    } catch {
      /* the popup closed; the capture continues to the download regardless */
    }
  };

  port.onMessage.addListener((message: PopupToWorker) => {
    if (message.type !== 'capture:start') return;
    void (async () => {
      const tab = await chrome.tabs.get(message.tabId);
      const restriction = tab.url ? restrictionFor(tab.url) : 'No page is open.';
      if (restriction) {
        post({ type: 'capture:failed', reason: restriction, recoverable: false });
        return;
      }

      const settings = await loadSettings();
      const driver = new ChromeDriver(message.tabId, {
        stitch: (request) => offscreen.stitch(request),
      });

      try {
        await session.save({
          phase: 'collecting',
          tabId: message.tabId,
          startedAt: Date.now(),
        });

        const result = await runCapture(
          { tabId: message.tabId, settings },
          {
            collect: async (tabId, currentSettings) => {
              await chrome.scripting.executeScript({
                target: { tabId },
                world: 'ISOLATED',
                func: (s: CaptureSettings) => {
                  (window as unknown as Record<string, unknown>).__pageCaptureSettings = s;
                },
                args: [currentSettings],
              });
              const frames = await chrome.scripting.executeScript({
                target: { tabId },
                world: 'ISOLATED',
                files: ['collector.js'],
              });
              const first = frames[0];
              if (!first) throw new Error('the page did not return a capture');
              return first.result as never;
            },
            fetchAsset: (url, options) => driver.fetchAsset(url, options),
            fetchText: async (url, options) => {
              const asset = await driver.fetchAsset(url, options);
              return new TextDecoder().decode(asset.bytes);
            },
            screenshot: () => driver.screenshotFullPage(),
            parseDocument: (html) =>
              new DOMParser().parseFromString(html, 'text/html'),
            serializeDocument: (doc) =>
              `<!doctype html>\n${doc.documentElement.outerHTML}`,
            toObjectUrl: (bytes, mimeType) => offscreen.toObjectUrl(bytes, mimeType),
            download: (options) => chrome.downloads.download(options),
            ensurePermission: ensureHostPermission,
            onProgress: (progress) => post({ type: 'capture:progress', progress }),
          },
        );

        await recordHistory({
          url: tab.url ?? '',
          filename: result.filename,
          byteLength: result.byteLength,
          warningCount: result.warnings.length,
          at: Date.now(),
        });

        post({
          type: 'capture:done',
          filename: result.filename,
          byteLength: result.byteLength,
          warnings: result.warnings,
        });
      } catch (error) {
        post({
          type: 'capture:failed',
          reason: error instanceof Error ? error.message : String(error),
          recoverable: true,
        });
      } finally {
        await session.clear();
        await offscreen.close();
      }
    })();
  });
});

// A checkpoint surviving a worker restart means the previous capture died.
chrome.runtime.onStartup.addListener(() => {
  void new CaptureSession().clear();
});
```

Note the `DOMParser` usage: MV3 service workers do not provide it. If it is unavailable at runtime, move `parseDocument` and `serializeDocument` into the offscreen document — it was created with the `DOM_PARSER` reason precisely for this — and route them through `OffscreenClient`. Verify which path Chrome actually takes during Step 15 rather than assuming.

- [ ] **Step 14: Gate the unit suite**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test`
Expected: all pass.

- [ ] **Step 15: Manual verification against a real page**

Build and reload the unpacked extension, open a content-heavy article page, and trigger a capture from the popup shell (wire a temporary button if Task 17 is not done yet). Confirm: the permission prompt appears once, a file lands in Downloads, and opening it offline renders the page. Confirm `DOMParser` either worked or that you moved parsing to the offscreen document per the Step 13 note.

- [ ] **Step 16: Commit**

```bash
git add -A
git commit -m "feat(extension): orchestrate capture with permissions, phases, and history"
```

---

### Task 17: Popup UI

**Files:**
- Create: `apps/extension/src/popup/use-capture.ts`, `apps/extension/src/popup/use-settings.ts`
- Create: `apps/extension/src/popup/components/Checkbox.tsx`, `RadioGroup.tsx`, `Progress.tsx`, `WarningList.tsx`, `ThemeToggle.tsx`, `RecentList.tsx`
- Modify: `apps/extension/src/popup/App.tsx`
- Test: `apps/extension/tests/use-settings.test.ts`, `apps/extension/tests/popup.test.tsx`

**Interfaces:**
- Consumes: `CaptureSettings`, `defaultSettings`, `parseSettings` from `@page-capture/core`; the message types from `lib/messages.ts`.
- Produces: `useSettings()` returning `{ settings, update, ready }`; `useCapture()` returning `{ start, progress, result, error, running }`; the components above; and the finished `App`.

Accessibility is a gate here, not a polish pass: real labels, keyboard operability in DOM order, `aria-live` on progress, and errors associated by `aria-describedby`. The tests assert those properties because they are the ones that silently regress.

New dev dependencies for this task: `@testing-library/react`, `@testing-library/user-event`, `jsdom`. They are test-only and additive to the Global Constraints list — note the justification in the commit body.

- [ ] **Step 1: Configure a jsdom environment for popup tests only**

In root `vitest.config.ts`, replace the flat `environment` with a per-file override:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [['apps/extension/tests/popup.test.tsx', 'jsdom']],
    include: [
      'packages/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.tsx',
    ],
    coverage: { provider: 'v8', include: ['packages/*/src/**', 'apps/*/src/**'] },
  },
});
```

- [ ] **Step 2: Write the failing settings hook test**

`apps/extension/tests/use-settings.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStoredSettings, storeSettings } from '../src/popup/use-settings.js';

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
    },
  };
});

describe('settings persistence', () => {
  it('returns defaults when nothing is stored', async () => {
    const settings = await loadStoredSettings();
    expect(settings.output).toBe('single-file');
  });

  it('round-trips a change', async () => {
    await storeSettings({ ...(await loadStoredSettings()), output: 'zip' });
    expect((await loadStoredSettings()).output).toBe('zip');
  });

  it('falls back to defaults when stored data is corrupt rather than throwing', async () => {
    store['settings'] = { output: 'nonsense', limits: 'not an object' };
    const settings = await loadStoredSettings();
    expect(settings.output).toBe('single-file');
  });
});
```

- [ ] **Step 3: Write `use-settings.ts`**

```ts
import { useCallback, useEffect, useState } from 'react';
import {
  defaultSettings,
  parseSettings,
  type CaptureSettings,
} from '@page-capture/core';

const KEY = 'settings';

export async function loadStoredSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.sync.get(KEY);
  try {
    return parseSettings(stored[KEY] ?? {});
  } catch {
    // Corrupt stored settings must not brick the popup.
    return defaultSettings;
  }
}

export async function storeSettings(settings: CaptureSettings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: settings });
}

export function useSettings() {
  const [settings, setSettings] = useState<CaptureSettings>(defaultSettings);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadStoredSettings().then((loaded) => {
      setSettings(loaded);
      setReady(true);
    });
  }, []);

  const update = useCallback((patch: Partial<CaptureSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      void storeSettings(next);
      return next;
    });
  }, []);

  return { settings, update, ready };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/use-settings.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `use-capture.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CAPTURE_PORT,
  type CaptureProgress,
  type WorkerToPopup,
} from '../lib/messages.js';

export type CaptureResultView = {
  filename: string;
  byteLength: number;
  warnings: { phase: string; url?: string; reason: string; detail?: string }[];
};

export function useCapture() {
  const port = useRef<chrome.runtime.Port | null>(null);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [result, setResult] = useState<CaptureResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const connection = chrome.runtime.connect({ name: CAPTURE_PORT });
    port.current = connection;
    connection.onMessage.addListener((message: WorkerToPopup) => {
      if (message.type === 'capture:progress') setProgress(message.progress);
      if (message.type === 'capture:done') {
        setResult(message);
        setRunning(false);
      }
      if (message.type === 'capture:failed') {
        setError(message.reason);
        setRunning(false);
      }
    });
    return () => connection.disconnect();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    setRunning(true);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setError('No active tab to capture.');
      setRunning(false);
      return;
    }
    port.current?.postMessage({ type: 'capture:start', tabId: tab.id });
  }, []);

  return { start, progress, result, error, running };
}
```

- [ ] **Step 6: Write the components**

`apps/extension/src/popup/components/Checkbox.tsx`:

```tsx
type Props = {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function Checkbox({ id, label, hint, checked, onChange }: Props) {
  return (
    <div className="flex items-start gap-2 py-1">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-0.5 h-4 w-4 rounded-[4px] border border-[var(--border)] accent-[var(--accent)]"
      />
      <div className="leading-tight">
        <label htmlFor={id} className="text-[13px] text-[var(--text-primary)]">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-[11px] text-[var(--text-secondary)]">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
```

`apps/extension/src/popup/components/RadioGroup.tsx`:

```tsx
type Option = { value: string; label: string; hint?: string };

type Props = {
  name: string;
  legend: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
};

export function RadioGroup({ name, legend, value, options, onChange }: Props) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        {legend}
      </legend>
      {options.map((option) => (
        <div key={option.value} className="flex items-start gap-2 py-1">
          <input
            id={`${name}-${option.value}`}
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
          />
          <label
            htmlFor={`${name}-${option.value}`}
            className="text-[13px] text-[var(--text-primary)]"
          >
            {option.label}
            {option.hint ? (
              <span className="block text-[11px] text-[var(--text-secondary)]">
                {option.hint}
              </span>
            ) : null}
          </label>
        </div>
      ))}
    </fieldset>
  );
}
```

`apps/extension/src/popup/components/Progress.tsx`:

```tsx
import type { CaptureProgress } from '../../lib/messages.js';

const LABELS: Record<CaptureProgress['phase'], string> = {
  idle: 'Ready',
  permissions: 'Checking permissions',
  collecting: 'Reading the page',
  'fetching-assets': 'Fetching assets',
  screenshot: 'Capturing screenshot',
  bundling: 'Building the archive',
  downloading: 'Saving',
  done: 'Done',
  failed: 'Failed',
};

export function Progress({ progress }: { progress: CaptureProgress }) {
  const percent =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;
  return (
    <div aria-live="polite" className="py-2">
      <div className="flex justify-between text-[12px] text-[var(--text-secondary)]">
        <span>{LABELS[progress.phase]}</span>
        {percent === null ? null : (
          <span className="font-mono">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={LABELS[progress.phase]}
        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--surface-raised)]"
      >
        <div
          className="h-full bg-[var(--accent)] transition-[width]"
          style={{ width: `${percent ?? 30}%` }}
        />
      </div>
    </div>
  );
}
```

`apps/extension/src/popup/components/WarningList.tsx`:

```tsx
type Warning = { phase: string; url?: string; reason: string; detail?: string };

export function WarningList({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="mt-2 rounded-[var(--radius-control)] border border-[var(--border)] p-2">
      <summary className="cursor-pointer text-[12px] text-[var(--warning)]">
        {warnings.length} warning{warnings.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-2 space-y-1">
        {warnings.map((warning, index) => (
          <li key={`${warning.phase}-${index}`} className="text-[11px]">
            <span className="font-mono text-[var(--text-secondary)]">
              {warning.phase}
            </span>{' '}
            <span className="text-[var(--text-primary)]">{warning.reason}</span>
            {warning.url ? (
              <span className="block truncate font-mono text-[var(--text-secondary)]">
                {warning.url}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
```

`apps/extension/src/popup/components/ThemeToggle.tsx`:

```tsx
type Theme = 'system' | 'light' | 'dark';

export function ThemeToggle({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (theme: Theme) => void;
}) {
  return (
    <fieldset className="border-0 p-0">
      <legend className="sr-only">Theme</legend>
      <div className="inline-flex rounded-[var(--radius-control)] border border-[var(--border)]">
        {(['system', 'light', 'dark'] as const).map((theme) => (
          <label
            key={theme}
            className={`cursor-pointer px-2 py-1 text-[11px] capitalize ${
              value === theme
                ? 'bg-[var(--surface-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={value === theme}
              onChange={() => onChange(theme)}
              className="sr-only"
            />
            {theme}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 7: Write the failing popup test**

`apps/extension/tests/popup.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/popup/App.js';

type Listener = (message: unknown) => void;

let listeners: Listener[];
let posted: unknown[];
let store: Record<string, unknown>;

beforeEach(() => {
  listeners = [];
  posted = [];
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      connect: () => ({
        postMessage: (message: unknown) => posted.push(message),
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      }),
    },
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 5, url: 'https://example.com' }]),
    },
    storage: {
      sync: {
        get: vi.fn(async (key: string) => ({ [key]: store[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
      local: { get: vi.fn().mockResolvedValue({ history: [] }) },
    },
  };
});

const emit = (message: unknown) => {
  for (const listener of listeners) listener(message);
};

describe('popup', () => {
  it('renders every capture toggle with an associated label', async () => {
    render(<App />);
    for (const label of [
      /html/i,
      /stylesheets/i,
      /scripts/i,
      /images/i,
      /fonts/i,
      /screenshot/i,
      /design tokens/i,
      /metadata/i,
      /console/i,
      /raw network sources/i,
      /lazy/i,
      /inert/i,
    ]) {
      expect(await screen.findByLabelText(label)).toBeDefined();
    }
  });

  it('offers both output modes as radios', async () => {
    render(<App />);
    expect(await screen.findByLabelText(/single self-contained html/i)).toBeDefined();
    expect(screen.getByLabelText(/zip folder/i)).toBeDefined();
  });

  it('persists a toggle change', async () => {
    render(<App />);
    const checkbox = await screen.findByLabelText(/screenshot/i);
    await userEvent.click(checkbox);
    await waitFor(() => {
      expect(
        (store['settings'] as { include: { screenshot: boolean } }).include
          .screenshot,
      ).toBe(true);
    });
  });

  it('sends a capture request naming the active tab', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /capture/i }));
    await waitFor(() => {
      expect(posted).toContainEqual({ type: 'capture:start', tabId: 5 });
    });
  });

  it('announces progress in a live region', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /capture/i }));
    emit({
      type: 'capture:progress',
      progress: {
        phase: 'fetching-assets',
        done: 3,
        total: 10,
        warningCount: 0,
      },
    });
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByText('3/10')).toBeDefined();
  });

  it('shows the filename and warning count when a capture completes', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /capture/i }));
    emit({
      type: 'capture:done',
      filename: 'example.com-20260827-100000.html',
      byteLength: 2048,
      warnings: [{ phase: 'assets', url: '/x.png', reason: '404' }],
    });
    expect(
      await screen.findByText(/example\.com-20260827-100000\.html/),
    ).toBeDefined();
    expect(screen.getByText(/1 warning/)).toBeDefined();
  });

  it('shows a restricted-page failure as an error, not a warning', async () => {
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /capture/i }));
    emit({
      type: 'capture:failed',
      reason: 'This page cannot be captured: Chrome does not allow extensions to read Chrome internal pages.',
      recoverable: false,
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Chrome internal pages');
  });

  it('re-enables the capture button after a failure', async () => {
    render(<App />);
    const button = await screen.findByRole('button', { name: /capture/i });
    await userEvent.click(button);
    emit({ type: 'capture:failed', reason: 'boom', recoverable: true });
    await waitFor(() => {
      expect(button.getAttribute('disabled')).toBeNull();
    });
  });

  it('keeps every control reachable by keyboard in DOM order', async () => {
    render(<App />);
    await screen.findByLabelText(/html/i);
    const focusable = [
      ...document.querySelectorAll<HTMLElement>('input, button, summary'),
    ];
    for (const element of focusable) {
      expect(element.tabIndex).toBeGreaterThanOrEqual(0);
    }
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm vitest run apps/extension/tests/popup.test.tsx`
Expected: FAIL — the App shell has none of these controls yet.

- [ ] **Step 9: Write the real `App.tsx`**

```tsx
import { useEffect } from 'react';
import { Checkbox } from './components/Checkbox.js';
import { RadioGroup } from './components/RadioGroup.js';
import { Progress } from './components/Progress.js';
import { WarningList } from './components/WarningList.js';
import { ThemeToggle } from './components/ThemeToggle.js';
import { useSettings } from './use-settings.js';
import { useCapture } from './use-capture.js';

const TOGGLES = [
  { key: 'html', label: 'HTML / DOM', hint: 'The rendered document' },
  { key: 'styles', label: 'Stylesheets' },
  { key: 'scripts', label: 'Scripts' },
  { key: 'images', label: 'Images' },
  { key: 'fonts', label: 'Fonts' },
  { key: 'screenshot', label: 'Full-page screenshot (PNG)' },
  { key: 'tokens', label: 'Design tokens (JSON)', hint: 'Colors, type scale, spacing' },
  { key: 'metadata', label: 'Metadata' },
  { key: 'logs', label: 'Console + network log', hint: 'Requires the page to have been open' },
  { key: 'rawSources', label: 'Raw network sources', hint: 'What the server sent, before JavaScript' },
] as const;

export function App() {
  const { settings, update } = useSettings();
  const { start, progress, result, error, running } = useCapture();

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  return (
    <main className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-[13px] font-medium text-[var(--text-primary)]">
          Page Capture
        </h1>
        <ThemeToggle
          value={settings.theme}
          onChange={(theme) => update({ theme })}
        />
      </header>

      <section>
        <h2 className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
          What to capture
        </h2>
        {TOGGLES.map(({ key, label, hint }) => (
          <Checkbox
            key={key}
            id={`include-${key}`}
            label={label}
            {...(hint ? { hint } : {})}
            checked={settings.include[key]}
            onChange={(checked) =>
              update({ include: { ...settings.include, [key]: checked } })
            }
          />
        ))}
        <Checkbox
          id="scroll-lazy"
          label="Scroll to load lazy content"
          hint="Materializes lazy images before capturing"
          checked={settings.scrollToLoadLazy}
          onChange={(scrollToLoadLazy) => update({ scrollToLoadLazy })}
        />
        <Checkbox
          id="inert"
          label="Inert snapshot"
          hint="Archive scripts without letting them run when reopened"
          checked={settings.inertSnapshot}
          onChange={(inertSnapshot) => update({ inertSnapshot })}
        />
      </section>

      <RadioGroup
        name="output"
        legend="Output"
        value={settings.output}
        options={[
          { value: 'single-file', label: 'Single self-contained HTML' },
          { value: 'zip', label: 'ZIP folder', hint: 'Separate, editable assets' },
        ]}
        onChange={(output) =>
          update({ output: output as typeof settings.output })
        }
      />

      <button
        type="button"
        onClick={() => void start()}
        disabled={running}
        className="rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-60"
      >
        {running ? 'Capturing…' : 'Capture page'}
      </button>

      {progress && running ? <Progress progress={progress} /> : null}

      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-control)] border border-[var(--error)] p-2 text-[12px] text-[var(--error)]"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <section className="rounded-[var(--radius-card)] border border-[var(--border)] p-2">
          <p className="font-mono text-[12px] text-[var(--text-primary)]">
            {result.filename}
          </p>
          <p className="text-[11px] text-[var(--text-secondary)]">
            {(result.byteLength / 1024).toFixed(1)} KB saved to Downloads
          </p>
          <WarningList warnings={result.warnings} />
        </section>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 10: Run the popup test to verify it passes**

Run: `pnpm vitest run apps/extension/tests/popup.test.tsx`
Expected: PASS, 9 tests. If the "every toggle" test fails on `/fonts/i` matching two elements, tighten the matcher to an exact string rather than loosening the assertion.

- [ ] **Step 11: Verify in the real popup**

Run: `pnpm --filter @page-capture/extension build`, reload the unpacked extension, open the popup. Check: all toggles render and persist across popup closes; Tab reaches every control in visual order; the theme control switches immediately and survives a reopen; a capture on a real page shows progress and then the filename.

- [ ] **Step 12: Gate and commit**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build`

```bash
git add -A
git commit -m "feat(extension): build the accessible Geist-themed capture popup

Adds @testing-library/react, @testing-library/user-event, and jsdom as
test-only dependencies: the accessibility properties this UI must hold —
label association, keyboard order, live regions — are only assertable
against a rendered tree."
```

---

## Phase 4 — Release readiness

### Task 18: End-to-end tests and store assets

**Files:**
- Create: `apps/extension/e2e/fixtures/static.html`, `spa.html`, `gallery.html`, `apps/extension/e2e/serve.ts`
- Create: `apps/extension/e2e/capture.spec.ts`, `apps/extension/playwright.config.ts`
- Create: `README.md`, `CHANGELOG.md`, `LICENSE`, `PRIVACY.md`
- Create: `apps/extension/public/icons/` final artwork, `docs/store/listing.md`
- Create: `scripts/release.sh`
- Modify: `.github/workflows/ci.yml`
- Test: `apps/extension/e2e/capture.spec.ts`

**Interfaces:**
- Consumes: the built extension at `apps/extension/dist`.
- Produces: `pnpm e2e`, a release zip at `release/page-capture-<version>.zip`.

The end-to-end test's real assertion is the one no unit test can make: that a captured archive renders offline **with no network requests attempted**. That is the product working.

- [ ] **Step 1: Write the fixture server**

`apps/extension/e2e/serve.ts`:

```ts
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

export function startFixtureServer(port = 4321): Server {
  const root = join(import.meta.dirname, 'fixtures');
  const server = createServer((request, response) => {
    const path = join(root, (request.url ?? '/').split('?')[0] ?? '/');
    if (!path.startsWith(root) || !existsSync(path)) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(path));
  });
  server.listen(port);
  return server;
}
```

- [ ] **Step 2: Write the fixture pages**

Reuse the three shapes from Task 3 but as real served files, each with a genuinely separate CSS file, script file, and PNG so the capture has real cross-file work to do. `static.html` links `/site.css` and `/app.js` and shows `/hero.png`; `spa.html` ships an empty `#root` plus a `/bundle.js` that renders a heading and a button into it on load; `gallery.html` lists twelve `loading="lazy"` images.

- [ ] **Step 3: Write the Playwright config**

`apps/extension/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { headless: false }, // extensions do not load in headless Chromium
});
```

- [ ] **Step 4: Write the failing e2e spec**

`apps/extension/e2e/capture.spec.ts`:

```ts
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startFixtureServer } from './serve.js';

const EXTENSION_PATH = join(import.meta.dirname, '..', 'dist');
let server: Server;
let context: BrowserContext;
let downloadDir: string;

test.beforeAll(async () => {
  server = startFixtureServer();
  downloadDir = await mkdtemp(join(tmpdir(), 'pc-downloads-'));
  const userDataDir = await mkdtemp(join(tmpdir(), 'pc-profile-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
    acceptDownloads: true,
    downloadsPath: downloadDir,
  });
});

test.afterAll(async () => {
  await context.close();
  server.close();
});

async function openPopup(): Promise<import('@playwright/test').Page> {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  return popup;
}

test('captures a static page into a single self-contained file', async () => {
  const page = await context.newPage();
  await page.goto('http://localhost:4321/static.html');

  const popup = await openPopup();
  await popup.getByLabel(/single self-contained html/i).check();
  const download = popup.waitForEvent('download');
  await popup.getByRole('button', { name: /capture/i }).click();
  const file = await download;

  const saved = join(downloadDir, file.suggestedFilename());
  await file.saveAs(saved);
  const html = await readFile(saved, 'utf8');

  expect(html).toContain('Static Fixture');
  expect(html).toContain('data:image/png;base64,');
  expect(html).not.toContain('href="/site.css"');
});

test('the captured file renders offline and requests nothing', async () => {
  const page = await context.newPage();
  await page.goto('http://localhost:4321/static.html');
  const popup = await openPopup();
  const download = popup.waitForEvent('download');
  await popup.getByRole('button', { name: /capture/i }).click();
  const saved = join(downloadDir, (await download).suggestedFilename());
  await (await download).saveAs(saved);

  const offline = await context.newPage();
  const requests: string[] = [];
  offline.on('request', (request) => {
    if (!request.url().startsWith('file:')) requests.push(request.url());
  });
  await offline.goto(`file://${saved}`);
  await expect(offline.getByRole('heading', { name: 'Static Fixture' })).toBeVisible();
  expect(requests).toEqual([]);
});

test('captures a client-rendered page with its rendered content', async () => {
  const page = await context.newPage();
  await page.goto('http://localhost:4321/spa.html');
  await page.getByRole('button', { name: 'Load more' }).waitFor();

  const popup = await openPopup();
  const download = popup.waitForEvent('download');
  await popup.getByRole('button', { name: /capture/i }).click();
  const saved = join(downloadDir, (await download).suggestedFilename());
  await (await download).saveAs(saved);

  const html = await readFile(saved, 'utf8');
  // The whole point of capturing the live DOM: content that only exists
  // after JavaScript ran is present in the archive.
  expect(html).toContain('Rendered by client JS');
});

test('captures lazy images after the scroll pass', async () => {
  const page = await context.newPage();
  await page.goto('http://localhost:4321/gallery.html');

  const popup = await openPopup();
  await popup.getByLabel(/scroll to load lazy content/i).check();
  const download = popup.waitForEvent('download');
  await popup.getByRole('button', { name: /capture/i }).click();
  const saved = join(downloadDir, (await download).suggestedFilename());
  await (await download).saveAs(saved);

  const html = await readFile(saved, 'utf8');
  const inlined = html.match(/data:image\/(png|jpeg);base64,/g) ?? [];
  expect(inlined.length).toBeGreaterThanOrEqual(10);
});

test('produces a zip containing the expected entries', async () => {
  const page = await context.newPage();
  await page.goto('http://localhost:4321/static.html');

  const popup = await openPopup();
  await popup.getByLabel(/zip folder/i).check();
  await popup.getByLabel(/design tokens/i).check();
  const download = popup.waitForEvent('download');
  await popup.getByRole('button', { name: /capture/i }).click();
  const file = await download;
  expect(file.suggestedFilename().endsWith('.zip')).toBe(true);

  const saved = join(downloadDir, file.suggestedFilename());
  await file.saveAs(saved);
  const { unzipSync } = await import('fflate');
  const entries = Object.keys(unzipSync(new Uint8Array(await readFile(saved))));
  expect(entries).toContain('page.html');
  expect(entries).toContain('metadata.json');
  expect(entries).toContain('tokens.json');
  expect(entries.some((e) => e.startsWith('images/'))).toBe(true);
});

test('refuses a restricted page with a specific reason', async () => {
  const page = await context.newPage();
  await page.goto('chrome://settings');
  const popup = await openPopup();
  await popup.getByRole('button', { name: /capture/i }).click();
  await expect(popup.getByRole('alert')).toContainText(/internal pages/i);
});

test('leaves no capture artifacts in the downloads directory on failure', async () => {
  const before = await readdir(downloadDir);
  const page = await context.newPage();
  await page.goto('chrome://settings');
  const popup = await openPopup();
  await popup.getByRole('button', { name: /capture/i }).click();
  await popup.getByRole('alert').waitFor();
  expect(await readdir(downloadDir)).toEqual(before);
});
```

- [ ] **Step 5: Add the e2e script and run it**

In `apps/extension/package.json` scripts, add:

```json
    "e2e": "playwright test"
```

In root `package.json` scripts, add:

```json
    "e2e": "pnpm -w build && pnpm --filter @page-capture/extension e2e"
```

Run: `pnpm -w e2e`
Expected: 7 tests pass. These drive a real browser, so expect them to be slower and more fragile than the unit suite — if a test flakes on timing, add an explicit `waitFor` on the condition rather than a sleep.

- [ ] **Step 6: Write the documentation**

`README.md` — what it does, install (store link placeholder plus load-unpacked instructions), a table of every toggle and what it means, the two output formats with their directory layout, the privacy statement, and a development section (`pnpm install`, `pnpm -w test`, `pnpm -w build`). State plainly that captures never leave the machine.

`PRIVACY.md` — the extension collects nothing, transmits nothing, and makes no network request other than fetching the assets of the page the user explicitly captures. No analytics, no accounts, no remote logging. This is the text the store listing links to, so it must match the manifest's actual permissions.

`CHANGELOG.md` — start at `## 0.1.0` with the initial feature list.

`LICENSE` — MIT.

`docs/store/listing.md` — the store listing copy: name, short description under 132 characters, full description, the single-purpose statement, and a justification for each permission (`activeTab`, `scripting`, `storage`, `downloads`, `offscreen`, and the optional `<all_urls>`). Chrome requires a justification per permission at submission; writing them here means they are reviewed with the code rather than improvised in the submission form.

- [ ] **Step 7: Replace the placeholder icons**

Produce final artwork at 16, 32, 48, and 128 px, plus a 1280×800 promo tile and at least one screenshot of the popup for the listing, under `docs/store/`. The 16 px mark must be legible at actual size — test it in the toolbar, not zoomed in.

- [ ] **Step 8: Write the release script**

`scripts/release.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

version=$(node -p "require('./apps/extension/package.json').version")
output="release/page-capture-${version}.zip"

rm -rf apps/extension/dist release
mkdir -p release

pnpm install --frozen-lockfile
pnpm -w format:check
pnpm -w lint
pnpm -w typecheck
pnpm -w test
pnpm -w build

cd apps/extension/dist
zip -r "../../../${output}" . -x '*.map'
cd -

echo "built ${output}"
```

Make it executable: `chmod +x scripts/release.sh`.

- [ ] **Step 9: Add e2e to CI as a separate job**

Append to `.github/workflows/ci.yml`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    needs: check
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: xvfb-run --auto-servernum pnpm -w e2e
```

`xvfb-run` is required because Chrome refuses to load extensions in headless mode, so the e2e job needs a display.

- [ ] **Step 10: Full verification**

Run: `./scripts/release.sh`
Expected: every gate passes and `release/page-capture-0.1.0.zip` exists.

Then load `apps/extension/dist` unpacked one final time and run the manual pre-release pass from the spec's §9: real pages across static, SPA, and image-heavy categories; both output modes; permission granted and declined; light and dark themes. Confirm each captured archive opens offline and renders.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "test(e2e): verify offline rendering and add release tooling"
```

---

## Self-review findings

Checked every spec section against the tasks above. Three requirements had no
implementing step; Task 19 closes them. Recording them rather than silently
patching, so the gap and its cause stay visible.

| Spec | Gap | Cause |
| --- | --- | --- |
| §5.3 Raw network sources | `bundle.ts` accepts `rawSources` and the setting exists, but no task ever populates the map | The toggle was threaded through the data structures without anyone fetching the data |
| §5.1 `@import` resolution | `resolveImports` is built and tested in Task 7 but never called by `inlineDocument` | Tested in isolation, unwired — the worst kind of dead code, because coverage hides it |
| §6 Capture history | Task 16 writes history to `chrome.storage.local`; Task 17 lists `RecentList.tsx` in its files but has no step building it | Write path without a read path |

Type consistency and placeholder scans came back clean: every type used in a
later task is defined in an earlier one, and no step defers work with a "handle
errors appropriately" style instruction.

---

### Task 19: Close the self-review gaps

**Files:**
- Modify: `packages/core/src/inline.ts`, `apps/extension/src/background/capture.ts`
- Create: `apps/extension/src/popup/components/RecentList.tsx`, `apps/extension/src/popup/use-history.ts`
- Modify: `apps/extension/src/popup/App.tsx`
- Test: `packages/core/tests/inline.test.ts`, `apps/extension/tests/capture.test.ts`, `apps/extension/tests/popup.test.tsx`

**Interfaces:**
- Consumes: `resolveImports` from `inline.ts`; `CaptureDeps` from `capture.ts`.
- Produces: `InlineInput.importDepth?: number`; `CaptureDeps.fetchRawSources`; `useHistory()` returning `{ entries, ready }`; `RecentList`.

- [ ] **Step 1: Write the failing `@import` wiring test**

Append to `packages/core/tests/inline.test.ts`:

```ts
it('resolves @import inside a fetched stylesheet', () => {
  const doc = fixtureDocument('static');
  const styleTexts = new Map([
    ['https://example.com/styles/site.css', "@import url('./base.css'); h1{color:#000}"],
    ['https://example.com/styles/base.css', 'body{margin:0}'],
  ]);
  inlineDocument(doc, { ...baseInput, styleTexts });
  const injected = [...doc.querySelectorAll('style')].find((s) =>
    (s.textContent ?? '').includes('h1{color:#000}'),
  );
  expect(injected!.textContent).toContain('body{margin:0}');
  expect(injected!.textContent).not.toContain('@import');
});

it('leaves an @import whose target was never fetched in place', () => {
  const doc = fixtureDocument('static');
  const styleTexts = new Map([
    ['https://example.com/styles/site.css', "@import url('./missing.css');"],
  ]);
  const result = inlineDocument(doc, { ...baseInput, styleTexts });
  const injected = [...doc.querySelectorAll('style')].find((s) =>
    (s.textContent ?? '').includes('@import'),
  );
  expect(injected).toBeDefined();
  expect(result.warnings.some((w) => w.phase === 'styles')).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/tests/inline.test.ts`
Expected: FAIL — the injected style still contains `@import`.

- [ ] **Step 3: Wire `resolveImports` into `inlineDocument`**

In `packages/core/src/inline.ts`, add to `InlineInput`:

```ts
  /** @import recursion cap. Cycles are the reason this exists. */
  importDepth?: number | undefined;
```

Then in the stylesheet loop, replace `style.textContent = rewriteCssUrls(text, …)` with a resolve-then-rewrite pass:

```ts
      const resolved = resolveImports(
        text,
        (importUrl) => {
          const absolute = absolutize(importUrl, abs);
          if (!absolute) return null;
          const imported = styleTexts.get(absolute);
          if (imported === undefined) {
            warnings.push({
              phase: 'styles',
              url: absolute,
              reason: 'imported stylesheet not available',
              detail: `left as @import in ${abs}`,
            });
            return null;
          }
          return imported;
        },
        input.importDepth ?? 5,
      );
      style.textContent = rewriteCssUrls(resolved, (url) => {
        const assetUrl = absolutize(url, abs);
        if (!assetUrl) return url;
        return referenceFor(assetUrl, 'css url()') ?? url;
      });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run packages/core/tests/inline.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Write the failing raw-sources test**

Append to `apps/extension/tests/capture.test.ts`:

```ts
it('does not fetch raw sources when the toggle is off', async () => {
  const d = deps();
  await runCapture({ tabId: 1, settings: defaultSettings }, d as never);
  expect(d.fetchRawSources).not.toHaveBeenCalled();
});

it('fetches the document and its linked sources when the toggle is on', async () => {
  const d = deps({
    fetchRawSources: vi
      .fn()
      .mockResolvedValue(new Map([['https://example.com/p', '<html>raw</html>']])),
  });
  await runCapture(
    {
      tabId: 1,
      settings: {
        ...defaultSettings,
        include: { ...defaultSettings.include, rawSources: true },
        output: 'zip',
      },
    },
    d as never,
  );
  expect(d.fetchRawSources).toHaveBeenCalledWith(
    expect.arrayContaining(['https://example.com/p']),
    expect.anything(),
  );
});

it('warns rather than failing when raw source fetching throws', async () => {
  const d = deps({
    fetchRawSources: vi.fn().mockRejectedValue(new Error('blocked')),
  });
  const result = await runCapture(
    {
      tabId: 1,
      settings: {
        ...defaultSettings,
        include: { ...defaultSettings.include, rawSources: true },
      },
    },
    d as never,
  );
  expect(result.filename).toBeTruthy();
  expect(result.warnings.some((w) => w.reason.includes('blocked'))).toBe(true);
});
```

Add `fetchRawSources: vi.fn().mockResolvedValue(new Map())` to the `deps()` factory's defaults.

- [ ] **Step 6: Implement raw source fetching**

In `apps/extension/src/background/capture.ts`, add to `CaptureDeps`:

```ts
  fetchRawSources: (
    urls: string[],
    options: { timeoutMs: number; maxBytes: number },
  ) => Promise<Map<string, string>>;
```

After the styleTexts block, add the phase:

```ts
  let rawSources: Map<string, string> | undefined;
  if (settings.include.rawSources) {
    const urls = [
      ir.metadata.url,
      ...ir.assets
        .filter((a) => a.kind === 'script' || a.kind === 'stylesheet')
        .map((a) => a.url),
    ];
    try {
      rawSources = await deps.fetchRawSources(urls, fetchOptions);
    } catch (error) {
      warnings.push({
        phase: 'assets',
        reason: error instanceof Error ? error.message : String(error),
        detail: 'raw network sources were omitted',
      });
    }
  }
```

And pass `rawSources` into `bundleInput`.

In `apps/extension/src/background/index.ts`, supply the implementation:

```ts
            fetchRawSources: async (urls, options) => {
              const sources = new Map<string, string>();
              for (const url of urls) {
                try {
                  const asset = await driver.fetchAsset(url, options);
                  sources.set(url, new TextDecoder().decode(asset.bytes));
                } catch {
                  /* a missing raw source is not worth failing the capture */
                }
              }
              return sources;
            },
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm vitest run apps/extension/tests/capture.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 8: Write the failing history UI test**

Append to `apps/extension/tests/popup.test.tsx`:

```tsx
it('lists recent captures from local storage', async () => {
  (globalThis as unknown as { chrome: { storage: { local: unknown } } }).chrome.storage.local =
    {
      get: vi.fn().mockResolvedValue({
        history: [
          {
            url: 'https://example.com/a',
            filename: 'example.com-20260827-100000.html',
            byteLength: 2048,
            warningCount: 0,
            at: Date.UTC(2026, 7, 27, 10, 0, 0),
          },
        ],
      }),
    };
  render(<App />);
  await userEvent.click(await screen.findByText(/recent/i));
  expect(
    await screen.findByText('example.com-20260827-100000.html'),
  ).toBeDefined();
});

it('says so when there are no recent captures', async () => {
  render(<App />);
  await userEvent.click(await screen.findByText(/recent/i));
  expect(await screen.findByText(/no captures yet/i)).toBeDefined();
});
```

- [ ] **Step 9: Write the history hook and component**

`apps/extension/src/popup/use-history.ts`:

```ts
import { useEffect, useState } from 'react';

export type HistoryEntry = {
  url: string;
  filename: string;
  byteLength: number;
  warningCount: number;
  at: number;
};

export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('history').then((stored) => {
      setEntries((stored['history'] as HistoryEntry[] | undefined) ?? []);
      setReady(true);
    });
  }, []);

  return { entries, ready };
}
```

`apps/extension/src/popup/components/RecentList.tsx`:

```tsx
import type { HistoryEntry } from '../use-history.js';

export function RecentList({ entries }: { entries: HistoryEntry[] }) {
  return (
    <details className="rounded-[var(--radius-control)] border border-[var(--border)] p-2">
      <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">
        Recent
      </summary>
      {entries.length === 0 ? (
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
          No captures yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {entries.map((entry) => (
            <li key={`${entry.filename}-${entry.at}`} className="text-[11px]">
              <span className="block truncate font-mono text-[var(--text-primary)]">
                {entry.filename}
              </span>
              <span className="text-[var(--text-secondary)]">
                {(entry.byteLength / 1024).toFixed(1)} KB
                {entry.warningCount > 0
                  ? ` · ${entry.warningCount} warning${entry.warningCount === 1 ? '' : 's'}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
```

In `App.tsx`, add `const { entries } = useHistory();` and render `<RecentList entries={entries} />` after the result section.

- [ ] **Step 10: Run the full suite and gate**

Run: `pnpm -w typecheck && pnpm -w lint && pnpm -w test && pnpm -w build`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "fix: wire @import resolution, raw sources, and capture history"
```
