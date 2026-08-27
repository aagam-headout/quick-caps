import { useEffect, useState } from 'react';

export type HistoryEntry = {
  url: string;
  filename: string;
  byteLength: number;
  warningCount: number;
  at: number;
};

/** Metadata for recent captures. Never the archives themselves. */
export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get('history').then((stored) => {
      setEntries((stored['history'] as HistoryEntry[] | undefined) ?? []);
      setReady(true);
    });
  }, []);

  return { entries, ready };
}
