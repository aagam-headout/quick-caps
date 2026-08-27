import { parseSettings, type CaptureSettings } from '@quickcaps/core';
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
import type { PageIR } from '@quickcaps/core';

const SETTINGS_KEY_STORAGE = 'settings';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;
const DOWNLOAD_FOLDER = 'QuickCaps';

/**
 * The capture in flight, if any.
 *
 * Two captures cannot overlap: they share one offscreen document, so whichever
 * finished first would tear it down underneath the other. It also scopes the
 * resource proxy — without it the worker would fetch any url any content script
 * asked for, for as long as the extension was installed.
 */
let activeCapture: { tabId: number; settings: CaptureSettings } | null = null;

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
  downloadId: number;
}): Promise<void> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const existing = stored[HISTORY_KEY];
  // Anything but an array is corrupt; spreading it would throw and lose the
  // capture the user just made over a bookkeeping detail.
  const previous = Array.isArray(existing) ? (existing as unknown[]) : [];
  await chrome.storage.local.set({
    [HISTORY_KEY]: [entry, ...previous].slice(0, HISTORY_LIMIT),
  });
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
  // The injected script parks its status synchronously, but a navigation or a
  // slow frame can mean the first read lands before it ran. Missing once is not
  // a failure; missing repeatedly is.
  let missedReads = 0;
  for (;;) {
    const outcome = await readGlobal<CollectorOutcome>(IR_KEY);
    if (outcome?.status === 'done') {
      if (!outcome.html) {
        throw new Error('the page produced an empty capture');
      }
      return { ir: outcome.ir, html: outcome.html };
    }
    if (outcome?.status === 'failed') throw new Error(outcome.error);
    if (!outcome && ++missedReads > 8) {
      throw new Error(
        'the page did not start a capture - it may have navigated away',
      );
    }
    if (Date.now() > deadline) {
      throw new Error('the page did not finish capturing in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Materializes lazy content, then restores the user's scroll position. */
async function scrollToLoadLazyContent(
  driver: ChromeDriver,
  maxSteps = 40,
): Promise<void> {
  const view = await driver.viewport();
  const origin = { x: view.scrollX, y: view.scrollY };
  // A zero viewport height would make this loop never advance; a very tall or
  // infinite-scrolling page would make it run for minutes. Both are bounded.
  const step = view.height > 0 ? view.height : 200;
  try {
    for (let index = 0; index < maxSteps; index++) {
      const offsetY = index * step;
      if (offsetY >= view.documentHeight) break;
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
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  const request = message as { type?: string; url?: string } | null;
  if (request?.type !== FETCH_RESOURCE || !request.url) return undefined;

  const capture = activeCapture;
  if (!capture || sender.tab?.id !== capture.tabId) {
    respond({ ok: false, error: 'no capture is running for this tab' });
    return true;
  }

  void fetchResourceForPage(request.url, {
    timeoutMs: capture.settings.limits.assetTimeoutMs,
    maxBytes: capture.settings.limits.maxAssetBytes,
  }).then(respond, (error: unknown) => {
    // respond throws if the page navigated away and closed the channel.
    try {
      respond({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      /* nothing left to answer */
    }
  });
  return true; // keep the channel open for the async respond
});

/**
 * The capture pipeline itself, shared by every trigger — the popup's port,
 * the keyboard shortcut, and the context-menu entry. `post` is how each
 * trigger surfaces progress and the outcome: a port message for the popup,
 * a notification for the two that run with no UI open at all.
 */
async function runCapture(params: {
  tabId: number;
  hasHostPermission: boolean;
  hasPageAccess: boolean;
  post: (message: WorkerToPopup) => void;
}): Promise<void> {
  const { tabId, hasPageAccess, post } = params;
  const offscreen = new OffscreenClient();
  const session = new CaptureSession();
  const startedAt = Date.now();
  try {
    // A missing or invalid tab id otherwise surfaces Chrome's own wording:
    // "Error at parameter 'tabId': Value must be at least 0."
    const tab =
      typeof tabId === 'number' && tabId >= 0
        ? await chrome.tabs.get(tabId).catch(() => null)
        : null;
    if (!tab) {
      post({
        type: 'capture:failed',
        reason: 'That tab is no longer open. Try capturing again.',
        recoverable: true,
      });
      return;
    }
    const restriction = tab.url
      ? restrictionFor(tab.url)
      : 'No page is open to capture.';
    if (restriction) {
      post({ type: 'capture:failed', reason: restriction, recoverable: false });
      return;
    }

    const settings = await loadSettings();
    // Published before any injection: the resource proxy will not serve a
    // page that is not the one being captured.
    activeCapture = { tabId, settings };
    const driver = new ChromeDriver(tabId);

    await session.save({ phase: 'collecting', tabId, startedAt });
    // The caller already asked, during its own gesture. Re-checking here
    // catches a grant revoked in between.
    const hasHostPermission =
      params.hasHostPermission && (await checkHostPermission());

    if (!hasPageAccess) {
      post({
        type: 'capture:failed',
        reason:
          'QuickCaps needs permission to read this page. Click Capture again and choose Allow.',
        recoverable: true,
      });
      return;
    }

    if (settings.scrollToLoadLazy) {
      await scrollToLoadLazyContent(driver);
    }

    post({
      type: 'capture:progress',
      progress: { phase: 'collecting', done: 0, total: 0, warningCount: 0 },
    });
    const { ir, html } = await collect(tabId, settings);
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

    await session.save({ phase: 'bundling', tabId, startedAt });
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
    const downloadId = await chrome.downloads.download({
      url: result.objectUrl,
      // A forward slash here is a subfolder under the platform's default
      // Downloads directory on Mac, Windows, and Linux alike — Chrome
      // normalizes the separator itself, so this needs no per-OS branch.
      // The bare filename (shown in the UI and in history) is unchanged.
      filename: `${DOWNLOAD_FOLDER}/${result.filename}`,
    });
    await offscreen.revoke(result.objectUrl);

    await recordHistory({
      url: tab.url ?? '',
      filename: result.filename,
      byteLength: result.byteLength,
      warningCount: result.warnings.length,
      at: Date.now(),
      downloadId,
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
      ? 'QuickCaps could not read this page. Click Capture again and choose Allow, or reload the page and retry.'
      : raw;
    post({ type: 'capture:failed', reason, recoverable: true });
  } finally {
    activeCapture = null;
    await session.clear();
    await offscreen.close();
  }
}

/** The single-capture guard, shared by every trigger. */
function startCapture(params: {
  tabId: number;
  hasHostPermission: boolean;
  hasPageAccess: boolean;
  post: (message: WorkerToPopup) => void;
}): void {
  if (activeCapture) {
    params.post({
      type: 'capture:failed',
      reason: 'A capture is already running. Wait for it to finish.',
      recoverable: true,
    });
    return;
  }
  void runCapture(params);
}

const CONTEXT_MENU_ID = 'quickcaps-capture';

function notify(title: string, message: string): void {
  void chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title,
    message,
  });
}

/**
 * Entry point for triggers with no popup open — the keyboard shortcut and the
 * context-menu item. Both grant activeTab on the invoking tab the same way
 * the toolbar button does, so the page itself is always readable; only the
 * optional <all_urls> grant (cross-origin assets) can be missing, and that
 * degrades the same way an unchecked popup capture already does.
 */
function triggerCapture(tabId: number | undefined): void {
  if (typeof tabId !== 'number') return;
  void (async () => {
    const hasHostPermission = await checkHostPermission();
    startCapture({
      tabId,
      hasHostPermission,
      hasPageAccess: true,
      post: (message) => {
        if (message.type === 'capture:done') {
          notify('Page captured', `${message.filename} saved to Downloads`);
        } else if (message.type === 'capture:failed') {
          notify('Capture failed', message.reason);
        }
        // Progress has nowhere to show without a popup open.
      },
    });
  })();
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'capture-page') return;
  void (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    triggerCapture(tab?.id);
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Capture page with QuickCaps',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  triggerCapture(tab?.id);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CAPTURE_PORT) return;

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
    startCapture({
      tabId: message.tabId,
      hasHostPermission: message.hasHostPermission,
      hasPageAccess: message.hasPageAccess,
      post,
    });
  });
});

// A checkpoint surviving a worker restart means the previous capture died.
chrome.runtime.onStartup.addListener(() => {
  void new CaptureSession().clear();
});
