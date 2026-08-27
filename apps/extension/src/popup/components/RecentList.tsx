import type { HistoryEntry } from '../use-history.js';

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatWhen(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function RecentList({ entries }: { entries: HistoryEntry[] }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center gap-[6px] rounded-[var(--radius-control)] py-[3px] text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--text-primary)] [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="pc-chevron h-[10px] w-[10px] shrink-0"
        >
          <path
            d="M4.5 2.5 8 6l-3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Recent
        {entries.length > 0 ? (
          <span className="ml-auto normal-case tracking-normal">
            {entries.length}
          </span>
        ) : null}
      </summary>
      <div className="pc-collapse">
        {entries.length === 0 ? (
          <p className="pt-[6px] text-[11px] text-[var(--text-secondary)]">
            No captures yet.
          </p>
        ) : (
          <ul className="pt-[6px]">
            {entries.slice(0, 8).map((entry) => (
              <li
                key={`${entry.filename}-${entry.at}`}
                className="rounded-[var(--radius-control)] px-[6px] py-[5px] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-raised)]"
              >
                <span className="block truncate font-mono text-[11px] text-[var(--text-primary)]">
                  {entry.filename}
                </span>
                <span className="text-[10.5px] text-[var(--text-secondary)]">
                  {formatSize(entry.byteLength)} · {formatWhen(entry.at)}
                  {entry.warningCount > 0
                    ? ` · ${entry.warningCount} warning${entry.warningCount === 1 ? '' : 's'}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
