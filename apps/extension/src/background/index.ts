import { parseSettings, type CaptureSettings } from '@page-capture/core';
import { ChromeDriver } from './chrome-driver.js';
import { OffscreenClient } from './offscreen-client.js';
import { CaptureSession } from './session.js';
import { hasHostPermission as checkHostPermission } from './permissions.js';
import { restrictionFor } from './restricted.js';
import {
  FETCH_RESOURCE,
  IR_KEY,
  SERIALIZE_PROGRESS,
  SETTINGS_KEY,
} from '../content/protocol.js';
import { fetchResourceForPage } from './resource-proxy.js';
import type { CollectorOutcome } from '../content/collector.js';
import {
  CAPTURE_PORT,
  type OffscreenProgress,
  type PopupToWorker,
  type WorkerToPopup,
} from '../lib/messages.js';
import type { PageIR } from '@page-capture/core';

const SETTINGS_KEY_STORAGE = 'settings';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;

async function loadSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY_STORAGE);
  try {
    return parseSettings(stored[SETTINGS_KEY_STORAGE] ?? {});
  } catch {
    // Corrupt stored settings must not make the extension unusable.
    return parseSettings({});
  }
}

async function recordHistory(entry: {
  url: string;
  filename: string;
  byteLength: number;
  warningCount: number;
  at: number;
}): Promise<void> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = [
    entry,
    ...((stored[HISTORY_KEY] as unknown[] | undefined) ?? []),
  ].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

/**
 * Injects the built collector and waits for the outcome it parks on the
 * ISOLATED-world global.
 *
 * Polled rather than returned for two reasons: an injected file's completion
 * value is not its result, and serializing a page is asynchronous — SingleFile
 * has to fetch every asset before it can finish.
 */
async function collect(
  tabId: number,
  settings: CaptureSettings,
  timeoutMs = 150_000,
): Promise<{ ir: PageIR; html: string }> {
  const readGlobal = async <T>(key: string): Promise<T | undefined> => {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (name: string) =>
        (window as unknown as Record<string, unknown>)[name] as unknown,
      args: [key],
    });
    return frame?.result as T | undefined;
  };

  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (key: string, value: CaptureSettings) => {
      (window as unknown as Record<string, unknown>)[key] = value;
    },
    args: [SETTINGS_KEY, settings],
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['collector.js'],
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await readGlobal<CollectorOutcome>(IR_KEY);
    if (outcome?.status === 'done') {
      return { ir: outcome.ir, html: outcome.html };
    }
    if (outcome?.status === 'failed') throw new Error(outcome.error);
    if (!outcome) throw new Error('the page did not start a capture');
    if (Date.now() > deadline) {
      throw new Error('the page did not finish capturing in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Materializes lazy content, then restores the user's scroll position. */
async function scrollToLoadLazyContent(driver: ChromeDriver): Promise<void> {
  const view = await driver.viewport();
  const origin = { x: view.scrollX, y: view.scrollY };
  try {
    for (
      let offsetY = 0;
      offsetY < view.documentHeight;
      offsetY += view.height
    ) {
      await driver.scrollTo(0, offsetY);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  } finally {
    await driver.scrollTo(origin.x, origin.y);
  }
}

/**
 * Resource fetching on behalf of the page-context serializer. SingleFile runs
 * in the page and is bound by its CORS policy; the worker fetches under the
 * extension's host permissions instead.
 */
chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  const request = message as { type?: string; url?: string };
  if (request?.type !== FETCH_RESOURCE || !request.url) return undefined;
  void fetchResourceForPage(request.url, {
    timeoutMs: 20_000,
    maxBytes: 25 * 1024 * 1024,
  }).then(respond);
  return true; // keep the channel open for the async respond
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CAPTURE_PORT) return;

  const offscreen = new OffscreenClient();
  const session = new CaptureSession();
  const post = (message: WorkerToPopup): void => {
    try {
      port.postMessage(message);
    } catch {
      /* the popup closed; the capture still finishes and still downloads */
    }
  };

  // Progress originates in two places that have no port of their own: the
  // offscreen document, and the serializer running in the page.
  const relay = (message: unknown): undefined => {
    const candidate = message as
      | OffscreenProgress
      | { type: typeof SERIALIZE_PROGRESS; done?: number; total?: number }
      | undefined;
    if (candidate?.type === 'offscreen:progress') {
      post({ type: 'capture:progress', progress: candidate.progress });
    } else if (candidate?.type === SERIALIZE_PROGRESS) {
      post({
        type: 'capture:progress',
        progress: {
          phase: 'collecting',
          done: candidate.done ?? 0,
          total: candidate.total ?? 0,
          warningCount: 0,
        },
      });
    }
    return undefined;
  };
  chrome.runtime.onMessage.addListener(relay);
  port.onDisconnect.addListener(() =>
    chrome.runtime.onMessage.removeListener(relay),
  );

  port.onMessage.addListener((message: PopupToWorker) => {
    if (message.type !== 'capture:start') return;

    void (async () => {
      const startedAt = Date.now();
      try {
        const tab = await chrome.tabs.get(message.tabId);
        const restriction = tab.url
          ? restrictionFor(tab.url)
          : 'No page is open to capture.';
        if (restriction) {
          post({
            type: 'capture:failed',
            reason: restriction,
            recoverable: false,
          });
          return;
        }

        const settings = await loadSettings();
        const driver = new ChromeDriver(message.tabId);

        await session.save({
          phase: 'collecting',
          tabId: message.tabId,
          startedAt,
        });
        // The popup already asked, during its click. Re-checking here catches
        // a grant revoked between the click and now.
        const hasHostPermission =
          message.hasHostPermission && (await checkHostPermission());

        if (!message.hasPageAccess) {
          post({
            type: 'capture:failed',
            reason:
              'Page Capture needs permission to read this page. Click Capture again and choose Allow.',
            recoverable: true,
          });
          return;
        }

        if (settings.scrollToLoadLazy) {
          await scrollToLoadLazyContent(driver);
        }

        post({
          type: 'capture:progress',
          progress: {
            phase: 'collecting',
            done: 0,
            total: 0,
            warningCount: 0,
          },
        });
        const { ir, html } = await collect(message.tabId, settings);
        if (!hasHostPermission) {
          ir.warnings.push({
            phase: 'permissions',
            reason:
              'host permission declined - cross-origin assets could not be fetched',
          });
        }

        const frames = settings.include.screenshot
          ? (await driver.captureFrames()).frames
          : undefined;

        await session.save({
          phase: 'bundling',
          tabId: message.tabId,
          startedAt,
        });
        const result = await offscreen.capture({
          ir,
          html,
          settings,
          ...(frames ? { frames } : {}),
        });

        post({
          type: 'capture:progress',
          progress: {
            phase: 'downloading',
            done: 0,
            total: 0,
            warningCount: result.warnings.length,
          },
        });
        await chrome.downloads.download({
          url: result.objectUrl,
          filename: result.filename,
        });
        await offscreen.revoke(result.objectUrl);

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
        const raw = error instanceof Error ? error.message : String(error);
        // Chrome's wording here names the manifest, which is useless to a user
        // who just needs to accept the prompt.
        const reason = raw.includes('Cannot access contents')
          ? 'Page Capture could not read this page. Click Capture again and choose Allow, or reload the page and retry.'
          : raw;
        post({ type: 'capture:failed', reason, recoverable: true });
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
