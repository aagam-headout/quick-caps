import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CAPTURE_PORT,
  type CaptureProgress,
  type CaptureWarningView,
  type WorkerToPopup,
} from '../lib/messages.js';

export type CaptureResultView = {
  filename: string;
  byteLength: number;
  warnings: CaptureWarningView[];
};

const ALL_URLS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/** An origin match pattern for the page being captured, e.g. https://x.test/*. */
function originPatternFor(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.protocol.startsWith('http')) return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

export type HostAccess = {
  /** Cross-origin assets are reachable. */
  all: boolean;
  /** The captured page itself is readable. */
  page: boolean;
};

/**
 * Asks for host access, broad first and narrow as a fallback.
 *
 * This must happen here rather than in the service worker: chrome requires
 * permissions.request to run during a user gesture, and a worker handling a
 * message has none.
 *
 * Two grants matter for different reasons. `<all_urls>` is what makes
 * cross-origin stylesheets and images fetchable, and declining it only degrades
 * the capture. Access to the page's own origin is what makes the page readable
 * at all - activeTab is supposed to cover that, but it does not survive every
 * path through the permission dialog, so ask for it explicitly rather than
 * failing with Chrome's opaque "Cannot access contents of the page".
 */
async function requestHostAccess(pageUrl: string): Promise<HostAccess> {
  try {
    if (await chrome.permissions.contains(ALL_URLS)) {
      return { all: true, page: true };
    }
    if (await chrome.permissions.request(ALL_URLS)) {
      return { all: true, page: true };
    }

    const pattern = originPatternFor(pageUrl);
    if (!pattern) return { all: false, page: false };
    const origins = { origins: [pattern] };
    if (await chrome.permissions.contains(origins)) {
      return { all: false, page: true };
    }
    return { all: false, page: await chrome.permissions.request(origins) };
  } catch {
    return { all: false, page: false };
  }
}

/**
 * How long the popup waits with no word at all from the worker before giving
 * up. Generous, because serializing a heavy page legitimately takes a while  -
 * every progress message resets it.
 */
const SILENCE_TIMEOUT_MS = 180_000;

export function useCapture() {
  const port = useRef<chrome.runtime.Port | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [progress, setProgress] = useState<CaptureProgress | null>(null);
  const [result, setResult] = useState<CaptureResultView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const stop = useCallback((reason?: string) => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
    setRunning(false);
    if (reason) setError(reason);
  }, []);

  const armWatchdog = useCallback(() => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      // Without this the button reads "Capturing…" forever if the worker dies
      // between messages.
      stop('The capture stopped responding. Reload the page and try again.');
    }, SILENCE_TIMEOUT_MS);
  }, [stop]);

  useEffect(() => {
    const connection = chrome.runtime.connect({ name: CAPTURE_PORT });
    port.current = connection;
    connection.onMessage.addListener((message: WorkerToPopup) => {
      if (message.type === 'capture:progress') {
        setProgress(message.progress);
        armWatchdog();
      }
      if (message.type === 'capture:done') {
        setResult(message);
        stop();
      }
      if (message.type === 'capture:failed') {
        stop(message.reason);
      }
    });
    connection.onDisconnect.addListener(() => {
      port.current = null;
      // A disconnect mid-capture means the worker was torn down.
      setRunning((wasRunning) => {
        if (wasRunning) {
          setError('The capture was interrupted. Try again.');
        }
        return false;
      });
      if (watchdog.current) clearTimeout(watchdog.current);
    });
    return () => {
      if (watchdog.current) clearTimeout(watchdog.current);
      connection.disconnect();
    };
  }, [armWatchdog, stop]);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    setProgress(null);
    setRunning(true);
    armWatchdog();

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      setError('No active tab to capture.');
      setRunning(false);
      return;
    }

    const access = await requestHostAccess(tab.url ?? '');
    const connection = port.current;
    if (!connection) {
      stop('Lost the connection to the extension. Reopen the popup.');
      return;
    }
    try {
      connection.postMessage({
        type: 'capture:start',
        tabId: tab.id,
        hasHostPermission: access.all,
        hasPageAccess: access.page,
      });
      armWatchdog();
    } catch {
      stop('Could not reach the extension worker. Try again.');
    }
  }, [armWatchdog, stop]);

  return { start, progress, result, error, running };
}
