import { useCallback, useEffect, useState } from 'react';
import {
  defaultSettings,
  parseSettings,
  type CaptureSettings,
} from 'quick-caps-core';

const KEY = 'settings';

export async function loadStoredSettings(): Promise<CaptureSettings> {
  const stored = await chrome.storage.sync.get(KEY);
  try {
    return parseSettings(stored[KEY] ?? {});
  } catch {
    // Corrupt stored settings must not brick the popup.
    return defaultSettings;
  }
}

export async function storeSettings(settings: CaptureSettings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: settings });
}

export function useSettings() {
  const [settings, setSettings] = useState<CaptureSettings>(defaultSettings);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadStoredSettings().then((loaded) => {
      setSettings(loaded);
      setReady(true);
    });
  }, []);

  const update = useCallback((patch: Partial<CaptureSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      void storeSettings(next);
      return next;
    });
  }, []);

  return { settings, update, ready };
}
