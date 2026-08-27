import { parseSettings, type CaptureSettings } from '@page-capture/core';
import { ChromeDriver } from './chrome-driver.js';
import { OffscreenClient } from './offscreen-client.js';
import { CaptureSession } from './session.js';
import { ensureHostPermission } from './permissions.js';
import { restrictionFor } from './restricted.js';
import { IR_KEY, SETTINGS_KEY } from '../content/protocol.js';
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
 * Injects the built collector and reads back the IR it parks on the
 * ISOLATED-world global. Two calls, because an injected file's completion value
 * is not its result — see src/content/collector-inject.ts.
 */
async function collect(
  tabId: number,
  settings: CaptureSettings,
): Promise<PageIR> {
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

  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: (key: string) =>
      (window as unknown as Record<string, unknown>)[key] as unknown,
    args: [IR_KEY],
  });
  if (!frame?.result) throw new Error('the page did not return a capture');
  return frame.result as PageIR;
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

  // Progress originates in the offscreen document, which has no port of its own.
  const relay = (message: unknown): undefined => {
    const candidate = message as OffscreenProgress;
    if (candidate?.type === 'offscreen:progress') {
      post({ type: 'capture:progress', progress: candidate.progress });
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
        post({
          type: 'capture:progress',
          progress: {
            phase: 'permissions',
            done: 0,
            total: 0,
            warningCount: 0,
          },
        });
        const hasHostPermission = await ensureHostPermission();

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
        const ir = await collect(message.tabId, settings);

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
          settings,
          hasHostPermission,
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
