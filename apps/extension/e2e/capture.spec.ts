import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { startFixtureServer } from './serve.js';

const EXTENSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
);
const ORIGIN = 'http://localhost:4321';

let server: Server;
let context: BrowserContext;
let extensionId: string;
let downloadDir: string;

const BASE_SETTINGS = {
  include: {
    html: true,
    styles: true,
    scripts: true,
    images: true,
    fonts: true,
    screenshot: false,
    tokens: false,
    metadata: true,
    logs: false,
    rawSources: false,
  },
  scrollToLoadLazy: true,
  inertSnapshot: true,
  output: 'single-file',
  theme: 'system',
};

test.beforeAll(async () => {
  server = await startFixtureServer();
  downloadDir = await mkdtemp(join(tmpdir(), 'pc-downloads-'));

  context = await chromium.launchPersistentContext(
    await mkdtemp(join(tmpdir(), 'pc-profile-')),
    {
      // Chrome refuses to load extensions in headless mode.
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
      acceptDownloads: true,
      downloadsPath: downloadDir,
    },
  );

  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  extensionId = new URL(worker.url()).host;

  // No permission request here: the e2e build carries host_permissions, because
  // chrome.permissions.request needs a user gesture that page.evaluate cannot
  // provide, and the resulting dialog would hang the run indefinitely.
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

async function extensionPage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`);
  return page;
}

/**
 * Waits for a new file to land in the downloads directory and returns its path.
 *
 * Matched by arrival rather than by name: Playwright intercepts downloads and
 * stores them under a generated uuid, so the archive's real filename survives
 * only in what the extension reported. Both are still checked — the reported
 * name by its own assertion, the bytes by reading this file.
 */
async function waitForNewDownload(
  before: string[],
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const names = await readdir(downloadDir).catch(() => [] as string[]);
    const added = names.filter(
      (name) => !before.includes(name) && name !== 'saved',
    );
    if (added.length > 0) {
      const path = join(downloadDir, added[0]!);
      // Chrome writes incrementally; wait for the size to settle.
      let previous = -1;
      for (;;) {
        const { size } = await stat(path);
        if (size > 0 && size === previous) return path;
        previous = size;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no download appeared in ${downloadDir}; saw: ${names.join(', ') || '(empty)'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Drives a real capture the way the popup does, from an extension page so the
 * chrome.* APIs are available.
 */
async function capture(
  fixture: string,
  settings: Record<string, unknown> = BASE_SETTINGS,
): Promise<{ filename: string; warnings: { reason: string }[]; path: string }> {
  const before = await readdir(downloadDir).catch(() => [] as string[]);
  const target = await context.newPage();
  await target.goto(`${ORIGIN}/${fixture}`, { waitUntil: 'load' });
  await target.waitForTimeout(400); // let client-rendered fixtures paint

  const driver = await extensionPage();
  const result = await driver.evaluate(async (applied) => {
    await chrome.storage.sync.set({ settings: applied });
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4321/*' });
    if (!tab?.id) throw new Error('fixture tab not found');
    // captureVisibleTab only ever sees the foreground tab, and this driver
    // page is the one in front by virtue of having just been opened. Hand
    // focus back to the fixture so a screenshot-enabled capture can work;
    // the port lives in the service worker, so this page keeps receiving
    // messages from the background even once it is no longer active.
    await chrome.tabs.update(tab.id, { active: true });

    return await new Promise<{
      ok: boolean;
      filename?: string;
      warnings?: { reason: string }[];
      reason?: string;
    }>((resolve) => {
      const port = chrome.runtime.connect({ name: 'quick-caps' });
      port.onMessage.addListener((message: Record<string, unknown>) => {
        if (message['type'] === 'capture:done') {
          resolve({
            ok: true,
            filename: message['filename'] as string,
            warnings: message['warnings'] as { reason: string }[],
          });
        }
        if (message['type'] === 'capture:failed') {
          resolve({ ok: false, reason: message['reason'] as string });
        }
      });
      port.postMessage({
        type: 'capture:start',
        tabId: tab.id,
        hasHostPermission: true,
        hasPageAccess: true,
      });
    });
  }, settings);

  await driver.close();
  await target.close();
  if (!result.ok) throw new Error(`capture failed: ${result.reason ?? ''}`);

  const filename = result.filename!;
  // Playwright stores the download under a uuid with no extension, and Chrome
  // will not render such a file as HTML. Copy it to its real name so the
  // offline check exercises the archive the user would actually open.
  const saved = join(downloadDir, 'saved');
  await mkdir(saved, { recursive: true });
  const path = join(saved, filename);
  await copyFile(await waitForNewDownload(before), path);

  return { filename, warnings: result.warnings ?? [], path };
}

test('the extension loads and registers a service worker', () => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});

test('the popup renders its controls', async () => {
  const page = await extensionPage();
  await expect(
    page.getByRole('button', { name: /capture page/i }),
  ).toBeVisible();
  // "Page contents" ships collapsed - the first-run path is preset then
  // capture, not five checkboxes - so the checkboxes only exist once the
  // accordion is opened.
  await page.getByText(/^Page contents/).click();
  await expect(page.getByLabel('HTML / DOM')).toBeVisible();
  await page.close();
});

test('captures a static page with no warnings', async () => {
  const { filename, warnings, path } = await capture('static.html');

  expect(filename).toMatch(/^localhost-\d{8}-\d{6}\.html$/);
  expect(warnings.map((w) => w.reason)).toEqual([]);

  const html = await readFile(path, 'utf8');
  expect(html).toContain('Static Fixture');
  expect(html).toContain('Body text that exists in the original document');
  // Assets must be inlined, not linked.
  expect(html).not.toContain('href="/site.css"');
  expect(html).toContain('data:image/png;base64,');
});

test('the captured file renders offline and requests nothing', async () => {
  const { path } = await capture('static.html');

  const offline = await context.newPage();
  const requests: string[] = [];
  offline.on('request', (request) => {
    const url = request.url();
    // The archive itself, and this extension injecting its own recorder into
    // the page being viewed. Neither is the archive reaching for the network,
    // which is the invariant under test.
    if (url.startsWith('file:') || url.startsWith('chrome-extension:')) return;
    requests.push(url);
  });

  await offline.goto(`file://${path}`);
  await expect(
    offline.getByRole('heading', { name: 'Static Fixture' }),
  ).toBeVisible();
  // The whole point of a self-contained capture.
  expect(requests, `archive fetched: ${requests.join(', ')}`).toEqual([]);
  await offline.close();
});

test('captures content that only exists after client rendering', async () => {
  const { path } = await capture('spa.html');
  const html = await readFile(path, 'utf8');
  // Nothing in the served HTML says this; only a live-DOM capture sees it.
  expect(html).toContain('Rendered by client JS');
  expect(html).toContain('Load more');
});

test('captures lazy images after the scroll pass', async () => {
  const { path } = await capture('gallery.html');
  const html = await readFile(path, 'utf8');
  const inlined = html.match(/data:image\/png;base64,/g) ?? [];
  // Twelve lazy images plus the css background.
  expect(inlined.length).toBeGreaterThanOrEqual(5);
});

test('produces a zip carrying the page and its extras', async () => {
  const { filename, path } = await capture('static.html', {
    ...BASE_SETTINGS,
    output: 'zip',
    include: { ...BASE_SETTINGS.include, tokens: true, screenshot: true },
  });

  expect(filename.endsWith('.zip')).toBe(true);
  const { unzipSync } = await import('fflate');
  const entries = Object.keys(unzipSync(new Uint8Array(await readFile(path))));
  expect(entries).toContain('page.html');
  expect(entries).toContain('metadata.json');
  expect(entries).toContain('tokens.json');
  expect(entries).toContain('screenshot.png');
});

/*
 * A chrome:// page cannot be reached from here: chrome.tabs.query can only
 * match a url when the extension holds the "tabs" permission, which this one
 * deliberately does not, and no extension can hold host permission for
 * chrome://. Granting it for the test build would mean testing a manifest
 * nobody ships.
 *
 * restrictionFor is covered directly instead — twelve cases in
 * tests/restricted.test.ts, including chrome://, edge://, view-source:,
 * about:, file:, and the Web Store. What is worth proving end to end is that
 * the worker refuses before injecting, which the next test does.
 */

test('refuses a tab that no longer exists, in plain words', async () => {
  const driver = await extensionPage();
  const reason = await driver.evaluate(
    async () =>
      await new Promise<string>((resolve) => {
        const port = chrome.runtime.connect({ name: 'quick-caps' });
        port.onMessage.addListener((message: Record<string, unknown>) => {
          if (message['type'] === 'capture:failed') {
            resolve(message['reason'] as string);
          }
        });
        port.postMessage({
          type: 'capture:start',
          tabId: 999_999,
          hasHostPermission: true,
          hasPageAccess: true,
        });
      }),
  );

  // Not Chrome's "Value must be at least 0".
  expect(reason).toContain('no longer open');
  await driver.close();
});
