import type { CaptureProgress } from '../../lib/messages.js';

const LABELS: Record<CaptureProgress['phase'], string> = {
  idle: 'Ready',
  permissions: 'Checking permissions',
  collecting: 'Reading the page',
  'fetching-assets': 'Fetching assets',
  screenshot: 'Capturing screenshot',
  bundling: 'Building the archive',
  downloading: 'Saving',
  done: 'Done',
  failed: 'Failed',
};

export function Progress({ progress }: { progress: CaptureProgress }) {
  const percent =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;
  return (
    <div aria-live="polite">
      <div className="flex justify-between text-[12px] text-[var(--text-secondary)]">
        <span>{LABELS[progress.phase]}</span>
        {percent === null ? null : (
          <span className="font-mono">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={LABELS[progress.phase]}
        className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-[var(--surface-raised)]"
      >
        <div
          className="h-full bg-[var(--accent)] transition-[width] duration-200"
          style={{ width: `${percent ?? 40}%` }}
        />
      </div>
    </div>
  );
}
