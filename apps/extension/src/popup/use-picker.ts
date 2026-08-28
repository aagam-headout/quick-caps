import { useCallback, useState } from 'react';

/**
 * Injects the element picker into the active tab. The popup closes on its
 * own right after — any click into the page does that for any Chrome
 * extension popup — so there is nothing to wire up for what happens next;
 * the picker's own confirm bar drives the capture from there.
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
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not start the picker.',
      );
    }
  }, []);

  return { pick, error };
}
