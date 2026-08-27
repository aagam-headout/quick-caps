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
 * at all — activeTab is supposed to cover that, but it does not survive every
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
    setProgress(null);
    setRunning(true);

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
    port.current?.postMessage({
      type: 'capture:start',
      tabId: tab.id,
      hasHostPermission: access.all,
      hasPageAccess: access.page,
    });
  }, []);

  return { start, progress, result, error, running };
}
