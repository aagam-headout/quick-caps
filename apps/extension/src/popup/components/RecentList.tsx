import type { HistoryEntry } from '../use-history.js';

export function RecentList({ entries }: { entries: HistoryEntry[] }) {
  return (
    <details>
      <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">
        Recent
      </summary>
      {entries.length === 0 ? (
        <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
          No captures yet.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {entries.map((entry) => (
            <li key={`${entry.filename}-${entry.at}`} className="text-[11px]">
              <span className="block truncate font-mono text-[var(--text-primary)]">
                {entry.filename}
              </span>
              <span className="text-[var(--text-secondary)]">
                {(entry.byteLength / 1024).toFixed(1)} KB
                {entry.warningCount > 0
                  ? ` · ${entry.warningCount} warning${entry.warningCount === 1 ? '' : 's'}`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
