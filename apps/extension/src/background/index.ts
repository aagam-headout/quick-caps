// Narrow subpaths, not the root barrel — see background/chrome-driver.ts.
import { captureFilename } from 'quick-caps-core/bundle';
import { parseSettings, type CaptureSettings } from 'quick-caps-core/settings';
import { CaptureLock, type CaptureClaim } from './busy.js';
import { ChromeDriver } from './chrome-driver.js';
import { OffscreenClient } from './offscreen-client.js';
import { CaptureSession } from './session.js';
import { hasHostPermission as checkHostPermission } from './permissions.js';
import { restrictionFor } from './restricted.js';
import { syncRecorderRegistration } from './recorder-registration.js';
import {
  FETCH_RESOURCE,
  IR_KEY,
  PICKER_CAPTURE,
  SERIALIZE_PROGRESS,
  SETTINGS_KEY,
} from '../content/protocol.js';
import { fetchResourceForPage } from './resource-proxy.js';
import type { CollectorOutcome } from '../content/collector.js';
import {
  CAPTURE_PORT,
  PREVIEW_SCREENSHOT,
  type PreviewScreenshotResponse,
  type OffscreenProgress,
  type PopupToWorker,
  type WorkerToPopup,
} from '../lib/messages.js';
import type { PageIR } from 'quick-caps-core';

const SETTINGS_KEY_STORAGE = 'settings';
const HISTORY_KEY = 'history';
const HISTORY_LIMIT = 50;
const DOWNLOAD_FOLDER = 'Quick-Caps';

/**
 * The capture in flight, if any.
 *
 * Two captures cannot overlap: they share one offscreen document, so whichever
 * finished first would tear it down underneath the other. It also scopes the
 * resource proxy - without it the worker would fetch any url any content script
 * asked for, for as long as the extension was installed.
 */
let activeCapture: { tabId: number; settings: CaptureSettings } | null = null;

/**
 * Claimed synchronously, before any await.
 *
 * `activeCapture` cannot serve as the guard on its own: it is only assigned
 * several awaits into runCapture, so two clicks in the same tick both saw it
 * null and both proceeded - two captures sharing one offscreen document, the
 * first to finish closing it under the second. The screenshot preview shares
 * this lock for the same reason: it opens and closes the same document.
 *
 * It expires, so a run that wedges on something that never settles cannot
 * refuse every capture for the life of the worker - see CaptureLock.
 */
const captureLock = new CaptureLock();

/** The refusal both entry points give while a live run holds the lock. */
function busyMessage(): string {
  const heldMs = captureLock.heldForMs() ?? 0;
  return `A capture is already running (${Math.round(heldMs / 1000)}s so far). Wait for it to finish.`;
}

/** A user-facing sentence for anything thrown inside the pipeline. */
function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Chrome's own wording names the manifest, or an internal API, neither of
  // which helps someone who just needs to accept a prompt or reload a page.
  if (raw.includes('Cannot access contents') || raw.includes('host permission'))
    return 'Quick-Caps could not read this page. Click Capture again and choose Allow, or reload the page and retry.';
  if (raw.includes('No tab with id') || raw.includes('No window with id'))
    return 'That tab was closed before the capture finished. Try again.';
  if (raw.includes('Frame with ID') || raw.includes('Frame was removed'))
    return 'The page navigated away mid-capture. Reload it and try again.';
  if (raw.includes('Extension context invalidated'))
    return 'Quick-Caps was reloaded mid-capture. Try again.';
  if (raw.includes('QUOTA') || raw.includes('quota'))
    return 'Chrome limited how fast pages can be screenshotted. Wait a moment and try again.';
  if (raw.includes('Download error') || raw.includes('USER_CANCELED'))
    return 'The download was cancelled or blocked by Chrome.';
  return raw;
}

/**
 * Resolves once a download reaches a terminal state.
 *
 * Necessary because chrome.downloads.download resolves as soon as the download
 * *starts*. Revoking the blob URL - or closing the offscreen document that
 * owns it, which the pipeline does in its `finally` - before the bytes have
 * been written truncates the file, which is exactly how a large zip or
 * screenshot lands on disk unopenable.
 */
function waitForDownload(
  downloadId: number,
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve();
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'complete' || state === 'interrupted') finish();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // A small download can finish before the listener is even attached.
    void chrome.downloads
      .search({ id: downloadId })
      .then((items) => {
        const state = items[0]?.state;
        if (state === 'complete' || state === 'interrupted') finish();
      })
      .catch(() => {
        /* nothing to check against; the timeout still releases us */
      });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Starts a download, translating Chrome's failures into something readable. */
async function startDownload(url: string, filename: string): Promise<number> {
  try {
    return await chrome.downloads.download({ url, filename });
  } catch (error) {
    throw new Error(
      `The capture was built but could not be saved: ${friendlyError(error)}`,
      { cause: error },
    );
  }
}

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
  /** Unset only for entries recorded before this field existed. */
  kind?: 'html' | 'zip' | 'preview';
}): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(HISTORY_KEY);
    const existing = stored[HISTORY_KEY];
    // Anything but an array is corrupt; spreading it would throw and lose the
    // capture the user just made over a bookkeeping detail.
    const previous = Array.isArray(existing) ? (existing as unknown[]) : [];
    await chrome.storage.local.set({
      [HISTORY_KEY]: [entry, ...previous].slice(0, HISTORY_LIMIT),
    });
  } catch {
    // Storage being full or unavailable is not worth failing a capture that
    // already landed on disk; the Recent list is a convenience.
  }
}

/**
 * Injects the built collector and waits for the outcome it parks on the
 * ISOLATED-world global.
 *
 * Polled rather than returned for two reasons: an injected file's completion
 * value is not its result, and serializing a page is asynchronous - SingleFile
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
 * The capture pipeline itself, shared by every trigger - the popup's port,
 * the keyboard shortcut, and the context-menu entry. `post` is how each
 * trigger surfaces progress and the outcome: a port message for the popup,
 * a notification for the two that run with no UI open at all.
 */
async function runCapture(params: {
  tabId: number;
  hasHostPermission: boolean;
  hasPageAccess: boolean;
  post: (message: WorkerToPopup) => void;
  /** Applied over the user's stored settings for this capture only - used by
   * the element picker, which sets `selectionSelector` without touching the
   * saved preference. */
  settingsOverride?: Partial<CaptureSettings>;
  /** The lock this run holds, released in its `finally`. */
  claim: CaptureClaim;
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

    const settings = { ...(await loadSettings()), ...params.settingsOverride };
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
          'Quick-Caps needs permission to read this page. Click Capture again and choose Allow.',
        recoverable: true,
      });
      return;
    }

    if (settings.scrollToLoadLazy) {
      await scrollToLoadLazyContent(driver);
      // viewport() tags the page's scroll container with its own attribute to
      // re-find it between calls. Left in place, the serializer below copies
      // that attribute straight into the captured HTML.
      await driver.clearScrollRootTag();
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

    // captureFrames scrolls and screenshots the whole document, unaware of
    // any DOM pruning a selective capture already did - skip the work
    // entirely rather than throw away a full-page screenshot downstream.
    //
    // Failure here is reported as a warning, never as a failed capture: the
    // screenshot is one optional part, and a throttled captureVisibleTab used
    // to throw away a fully serialized page.
    let stitchRequest;
    if (settings.include.screenshot && !settings.selectionSelector.trim()) {
      post({
        type: 'capture:progress',
        progress: {
          phase: 'screenshot',
          done: 0,
          total: 0,
          warningCount: ir.warnings.length,
        },
      });
      try {
        stitchRequest = await driver.captureFrames();
      } catch (error) {
        ir.warnings.push({
          phase: 'screenshot',
          reason: friendlyError(error),
          detail:
            'the screenshot was omitted; the rest of the capture is intact',
        });
      }
    }

    await session.save({ phase: 'bundling', tabId, startedAt });
    const result = await offscreen.capture({
      ir,
      html,
      settings,
      ...(stitchRequest
        ? {
            frames: stitchRequest.frames,
            // Use chrome-driver's own scroll-root-aware measurement for the
            // canvas, not ir.metadata.documentSize - see capture.ts.
            screenshotGeometry: {
              width: stitchRequest.width,
              height: stitchRequest.height,
              devicePixelRatio: stitchRequest.devicePixelRatio,
            },
          }
        : {}),
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
    // A forward slash here is a subfolder under the platform's default
    // Downloads directory on Mac, Windows, and Linux alike - Chrome
    // normalizes the separator itself, so this needs no per-OS branch.
    // The bare filename (shown in the UI and in history) is unchanged.
    const downloadId = await startDownload(
      result.objectUrl,
      `${DOWNLOAD_FOLDER}/${result.filename}`,
    );
    // download() resolves when the download starts, not when it finishes;
    // revoking (and, in `finally`, closing the document that owns the blob)
    // before then truncates the file.
    await waitForDownload(downloadId);
    await offscreen.revoke(result.objectUrl).catch(() => {
      /* the document may already be gone; the blob went with it */
    });

    await recordHistory({
      url: tab.url ?? '',
      filename: result.filename,
      byteLength: result.byteLength,
      kind: result.mimeType === 'application/zip' ? 'zip' : 'html',
      warningCount: result.warnings.length,
      at: Date.now(),
      downloadId,
    });

    post({
      type: 'capture:done',
      filename: result.filename,
      byteLength: result.byteLength,
      warnings: result.warnings,
      ...(result.dataSummary === undefined
        ? {}
        : { dataSummary: result.dataSummary }),
    });
  } catch (error) {
    post({
      type: 'capture:failed',
      reason: friendlyError(error),
      recoverable: true,
    });
  } finally {
    activeCapture = null;
    captureLock.release(params.claim);
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
  settingsOverride?: Partial<CaptureSettings>;
}): void {
  // Claimed here, in the same tick as the check - see `captureLock`.
  const claim = captureLock.acquire();
  if (!claim) {
    params.post({
      type: 'capture:failed',
      reason: busyMessage(),
      recoverable: true,
    });
    return;
  }
  void runCapture({ ...params, claim });
}

const CONTEXT_MENU_ID = 'quick-caps-capture';

function notify(title: string, message: string): void {
  void chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-192.png'),
    title,
    message,
  });
}

/**
 * Entry point for triggers with no popup open - the keyboard shortcut and the
 * context-menu item. Both grant activeTab on the invoking tab the same way
 * the toolbar button does, so the page itself is always readable; only the
 * optional <all_urls> grant (cross-origin assets) can be missing, and that
 * degrades the same way an unchecked popup capture already does.
 */
function triggerCapture(
  tabId: number | undefined,
  settingsOverride?: Partial<CaptureSettings>,
): void {
  if (typeof tabId !== 'number') return;
  void (async () => {
    const hasHostPermission = await checkHostPermission();
    startCapture({
      tabId,
      hasHostPermission,
      hasPageAccess: true,
      ...(settingsOverride ? { settingsOverride } : {}),
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

/**
 * Resolves once a tab finishes loading (or after timeoutMs) - used so a blob
 * URL's source document isn't torn down before the tab has actually fetched
 * it, without leaving the caller waiting forever if something stalls.
 */
function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (
      updatedTabId: number,
      info: chrome.tabs.OnUpdatedInfo,
    ): void => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Captures and stitches the tab's full page, opens it in a new tab, and
 * saves it to Quick-Caps/previews alongside real captures (recorded in
 * history, so it shows up in Recent too) - a quick look at the screenshot on
 * its own, independent of running (and downloading) a whole capture.
 *
 * Opened as a blob: URL rather than embedding the PNG as a `data:` URL: a
 * data: URL's whole payload lives in the URL string, and Chrome silently
 * fails navigation past ~2MB of URL - a full-page screenshot of any real
 * page crosses that easily, and it just opened about:blank with no error.
 */
async function previewScreenshot(
  tabId: number | undefined,
): Promise<PreviewScreenshotResponse> {
  if (typeof tabId !== 'number' || tabId < 0) {
    return { ok: false, error: 'No active tab to preview.' };
  }
  // Shares the offscreen document with a real capture, so it shares the lock:
  // whichever finished first would otherwise close the document under the
  // other.
  const claim = captureLock.acquire();
  if (!claim) return { ok: false, error: busyMessage() };
  const offscreen = new OffscreenClient();
  try {
    const sourceTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!sourceTab) {
      return { ok: false, error: 'That tab is no longer open. Try again.' };
    }
    // The same pages a capture refuses; without this the user gets Chrome's
    // raw "Cannot access contents of url" instead of a reason.
    const restriction = sourceTab.url
      ? restrictionFor(sourceTab.url)
      : 'No page is open to preview.';
    if (restriction) return { ok: false, error: restriction };

    const driver = new ChromeDriver(tabId);
    const request = await driver.captureFrames();
    // Stitched straight to a blob URL: shipping the PNG bytes out as a
    // number[] and back in again cost two full structured-clone copies of a
    // multi-megabyte image.
    const { url: objectUrl, byteLength } = await offscreen.stitchToUrl(request);
    const tab = await chrome.tabs.create({ url: objectUrl });

    // Also saved to disk (alongside real captures, in their own subfolder)
    // and recorded to history - so a preview shows up in Recent too, not
    // just as a tab that's gone the moment it's closed.
    const filename = captureFilename(
      sourceTab.url ?? '',
      new Date().toISOString(),
      'png',
    );
    const downloadId = await startDownload(
      objectUrl,
      `${DOWNLOAD_FOLDER}/previews/${filename}`,
    );
    await recordHistory({
      url: sourceTab.url ?? '',
      filename,
      byteLength,
      warningCount: 0,
      at: Date.now(),
      downloadId,
      kind: 'preview',
    });

    // The blob only exists as long as the offscreen document that minted it
    // stays open (below, in finally) - wait for both readers to be done with
    // it first: the tab that displays it and the download that writes it.
    if (tab.id !== undefined) await waitForTabLoad(tab.id);
    await waitForDownload(downloadId);
    await offscreen.revoke(objectUrl).catch(() => {
      /* the document may already be gone; the blob went with it */
    });
    return { ok: true };
  } catch (error) {
    const message = friendlyError(error);
    notify('Screenshot preview failed', message);
    return { ok: false, error: message };
  } finally {
    captureLock.release(claim);
    await offscreen.close();
  }
}

// Sent by the popup itself, not a content script, so the tab id travels in
// the message rather than sender.tab (which is only set for senders that are
// content scripts running in a tab). Returns `true` to keep the message
// channel open until previewScreenshot's promise resolves - otherwise the
// popup's sendMessage resolves as soon as the message is dispatched, before
// the capture actually finishes or fails.
chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    const request = message as { type?: string; tabId?: number } | null;
    if (request?.type !== PREVIEW_SCREENSHOT) return undefined;
    void previewScreenshot(request.tabId).then(sendResponse);
    return true;
  },
);

/**
 * The element picker (injected on demand from the popup) sends this once the
 * user confirms a selection. Headless, same as the keyboard shortcut, with
 * the picked selector overriding `selectionSelector` for this one capture.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const request = message as { type?: string; selector?: string } | null;
  if (request?.type !== PICKER_CAPTURE || !request.selector) return undefined;
  triggerCapture(sender.tab?.id, { selectionSelector: request.selector });
  return undefined;
});

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

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Capture page with Quick-Caps',
      contexts: ['page'],
    });
  });

  // An update from a version that registered the recorder from the manifest
  // arrives with nothing registered dynamically, and a fresh install with the
  // observation toggles off arrives wanting nothing registered. Both are the
  // same reconcile.
  void loadSettings().then(syncRecorderRegistration);

  // Explains what Quick-Caps will ask permission for, and why, before Chrome's
  // native prompt shows up unexplained on the first capture. Skipped on
  // update/browser-update reinstalls, which is not a first impression.
  if (details.reason === 'install') {
    void chrome.tabs.create({
      url: chrome.runtime.getURL('src/onboarding/index.html'),
    });
  }
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
  // The registration persists across sessions, so this is a correction, not
  // the primary path: it catches a profile whose stored settings changed while
  // the extension was disabled.
  void loadSettings().then(syncRecorderRegistration);
});

/**
 * The recorder is only registered while a setting consumes what it observes, so
 * the moment those settings change is the moment the registration has to
 * change. Storage is the seam rather than a message from the popup: the popup
 * is not the only writer (settings sync between profiles), and a storage change
 * wakes the worker on its own.
 *
 * A page already open when a toggle is switched on has no recorder in it -
 * nothing can retroactively observe requests that already happened - so the
 * change takes effect on that tab's next load. The popup and the README already
 * say to reload before capturing a log.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !(SETTINGS_KEY_STORAGE in changes)) return;
  void loadSettings().then(syncRecorderRegistration);
});
