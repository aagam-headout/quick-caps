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

/**
 * Asks for the cross-origin host permission.
 *
 * This must happen here rather than in the service worker: chrome requires
 * permissions.request to be called during a user gesture, and a worker handling
 * a message has none. Declining is a supported outcome — the capture proceeds
 * with same-origin material and reports what it skipped.
 */
async function requestHostPermission(): Promise<boolean> {
  try {
    if (await chrome.permissions.contains(ALL_URLS)) return true;
    return await chrome.permissions.request(ALL_URLS);
  } catch {
    return false;
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

    const hasHostPermission = await requestHostPermission();
    port.current?.postMessage({
      type: 'capture:start',
      tabId: tab.id,
      hasHostPermission,
    });
  }, []);

  return { start, progress, result, error, running };
}
