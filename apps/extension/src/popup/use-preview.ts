import { useCallback, useState } from 'react';
import {
  PREVIEW_SCREENSHOT,
  type PreviewScreenshotResponse,
} from '../lib/messages.js';

/**
 * Captures, stitches, and opens the active tab's full-page screenshot in a
 * new tab - independent of the "Full-page screenshot (PNG)" setting, which
 * only controls whether it rides along with an actual capture.
 */
export function usePreview() {
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const preview = useCallback(async () => {
    setError(null);
    setRunning(true);
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) {
        setError('No active tab to preview.');
        return;
      }
      const response = (await chrome.runtime.sendMessage({
        type: PREVIEW_SCREENSHOT,
        tabId: tab.id,
      })) as PreviewScreenshotResponse | undefined;
      if (response && !response.ok) setError(response.error);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not preview the page.',
      );
    } finally {
      setRunning(false);
    }
  }, []);

  return { preview, running, error };
}
