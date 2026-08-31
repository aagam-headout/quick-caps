import { useRef, useState } from 'react';
import type { HistoryEntry } from '../use-history.js';
import { formatSize } from '../lib/format-size.js';

function formatWhen(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const KIND_LABEL: Record<'html' | 'zip' | 'preview', string> = {
  html: 'HTML',
  zip: 'ZIP',
  preview: 'Preview',
};

// Marks the folder row as "opens in a new place" (the OS file manager),
// same shorthand as an external link.
const ExternalLinkIcon = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true" className="h-[10px] w-[10px]">
    <path
      d="M5 2.5H2.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7M7 2h3v3M9.7 2.3 5.5 6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function RecentList({
  entries,
  ready = true,
}: {
  entries: HistoryEntry[];
  /** False while history is still loading from chrome.storage.local. */
  ready?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // Opening the accordion in a short popup can leave the newly-revealed
  // entries and the folder button below the fold. Scroll it into view once
  // it opens, rather than leaving the user to notice and scroll themselves.
  const handleToggle = (): void => {
    if (detailsRef.current?.open) {
      detailsRef.current.scrollIntoView?.({ block: 'nearest' });
    }
  };

  /**
   * Opening a captured file can fail long after it was saved - the user moved
   * it, emptied their downloads, or Chrome forgot the record. Unhandled, the
   * click just did nothing at all.
   */
  const open = (downloadId: number, filename: string): void => {
    setError(null);
    void Promise.resolve()
      .then(() => chrome.downloads.open(downloadId))
      .catch(() => {
        setError(
          `${filename} could not be opened - it may have been moved or deleted.`,
        );
      });
  };

  // Reveals the Quick-Caps download folder in the OS file manager. There's
  // no "open this folder path" API - chrome.downloads.show anchors on a
  // specific download and reveals its containing folder, so the newest entry
  // with a live downloadId stands in for "the folder".
  const folderAnchor = entries.find(
    (entry) => entry.downloadId !== undefined,
  )?.downloadId;

  const openFolder = (): void => {
    if (folderAnchor === undefined) return;
    setError(null);
    void Promise.resolve()
      .then(() => chrome.downloads.show(folderAnchor))
      .catch(() => {
        setError('Could not open the Quick-Caps folder.');
      });
  };

  return (
    <details
      ref={detailsRef}
      onToggle={handleToggle}
      className="group px-[var(--space-2)]"
    >
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
        {ready && folderAnchor !== undefined ? (
          <button
            type="button"
            onClick={openFolder}
            className="mt-[6px] flex w-full cursor-pointer items-center justify-between gap-[5px] rounded-[var(--radius-control)] bg-[var(--surface-raised)] px-[6px] py-[4px] text-[10.5px] font-medium text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--border)] hover:text-[var(--text-primary)]"
          >
            Open Quick-Caps folder
            <ExternalLinkIcon />
          </button>
        ) : null}
        {!ready ? (
          <ul className="flex flex-col gap-[4px] pt-[6px]">
            {[0, 1].map((index) => (
              <li
                key={index}
                className="h-[32px] animate-pulse rounded-[var(--radius-control)] bg-[var(--surface-raised)]"
              />
            ))}
          </ul>
        ) : entries.length === 0 ? (
          <p className="pt-[6px] text-[11px] text-[var(--text-secondary)]">
            No captures yet.
          </p>
        ) : (
          <ul className="pt-[6px]">
            {entries.slice(0, 10).map((entry) => {
              const downloadId = entry.downloadId;
              return (
                <li key={`${entry.filename}-${entry.at}`}>
                  <button
                    type="button"
                    // Entries recorded before downloadId existed, or whose
                    // download chrome later forgot, fall back to a plain,
                    // unclickable row rather than a button that silently
                    // does nothing.
                    disabled={downloadId === undefined}
                    onClick={() => {
                      if (downloadId !== undefined)
                        open(downloadId, entry.filename);
                    }}
                    aria-label={`Open ${entry.filename}`}
                    title={
                      downloadId === undefined
                        ? "Chrome no longer has this download on record, so it can't be reopened"
                        : undefined
                    }
                    className="block w-full rounded-[var(--radius-control)] px-[6px] py-[5px] text-left transition-colors duration-[var(--duration-fast)] enabled:cursor-pointer enabled:hover:bg-[var(--surface-raised)] disabled:cursor-default"
                  >
                    <span className="flex items-center gap-[5px]">
                      <span
                        aria-hidden="true"
                        className="h-[4px] w-[4px] shrink-0 rounded-full bg-[var(--accent)]"
                      />
                      <span className="block truncate font-mono text-[11px] text-[var(--text-primary)]">
                        {entry.filename}
                      </span>
                      {entry.kind ? (
                        <span className="shrink-0 rounded-full bg-[var(--surface-raised)] px-[6px] py-[1px] text-[9.5px] font-medium uppercase tracking-[0.04em] text-[var(--text-secondary)]">
                          {KIND_LABEL[entry.kind]}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-[10.5px] text-[var(--text-secondary)]">
                      {formatSize(entry.byteLength)} · {formatWhen(entry.at)}
                      {entry.warningCount > 0
                        ? ` · ${entry.warningCount} warning${entry.warningCount === 1 ? '' : 's'}`
                        : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {error ? (
          <p
            role="alert"
            className="pt-[6px] text-[10.5px] leading-[1.4] text-[var(--error)]"
          >
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
