import { useCallback, useState } from 'react';

/**
 * Injects the element picker into the active tab, then closes the popup.
 *
 * The click that triggers this happens inside the popup itself, not on the
 * page — a popup only auto-closes on a click that lands outside it, so
 * without an explicit window.close() here it would just sit there on top of
 * the page while the picker's overlay is trying to do its own thing
 * underneath. The picker's own confirm bar drives the capture from here.
 */
export function usePicker() {
  const [error, setError] = useState<string | null>(null);

  const pick = useCallback(async () => {
    setError(null);
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) {
      setError('No active tab to pick from.');
      return;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        files: ['picker.js'],
      });
      window.close();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the picker.',
      );
    }
  }, []);

  return { pick, error };
}
