import { useEffect, useState } from 'react';

export type HistoryEntry = {
  url: string;
  filename: string;
  byteLength: number;
  warningCount: number;
  at: number;
  // Optional: entries recorded before this field existed won't have one, and
  // an entry can lose it if chrome.downloads later evicts the record.
  downloadId?: number;
  /** Unset only for entries recorded before this field existed. */
  kind?: 'html' | 'zip' | 'preview';
};

const KINDS = new Set(['html', 'zip', 'preview']);

/**
 * Keeps only entries the list can actually render.
 *
 * Storage is shared with older versions of the extension and with anything
 * else that can write to it; one malformed record used to be enough to throw
 * inside render and blank the whole popup.
 */
function sanitize(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: HistoryEntry[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    if (typeof record['filename'] !== 'string' || !record['filename']) continue;
    entries.push({
      url: typeof record['url'] === 'string' ? record['url'] : '',
      filename: record['filename'],
      byteLength:
        typeof record['byteLength'] === 'number' &&
        Number.isFinite(record['byteLength'])
          ? record['byteLength']
          : 0,
      warningCount:
        typeof record['warningCount'] === 'number' &&
        Number.isFinite(record['warningCount'])
          ? record['warningCount']
          : 0,
      at:
        typeof record['at'] === 'number' && Number.isFinite(record['at'])
          ? record['at']
          : Date.now(),
      ...(typeof record['downloadId'] === 'number'
        ? { downloadId: record['downloadId'] }
        : {}),
      ...(typeof record['kind'] === 'string' && KINDS.has(record['kind'])
        ? { kind: record['kind'] as 'html' | 'zip' | 'preview' }
        : {}),
    });
  }
  return entries;
}

/** Metadata for recent captures. Never the archives themselves. */
export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void chrome.storage.local
      .get('history')
      .then((stored) => {
        if (!live) return;
        setEntries(sanitize(stored['history']));
      })
      .catch(() => {
        /* an unreadable history is an empty one, not a broken popup */
      })
      .finally(() => {
        if (live) setReady(true);
      });

    // The worker writes history when a capture finishes, which is usually
    // while this popup is open - without this the Recent list still showed
    // the state from when the popup was opened.
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local' || !changes['history']) return;
      setEntries(sanitize(changes['history'].newValue));
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return { entries, ready };
}
