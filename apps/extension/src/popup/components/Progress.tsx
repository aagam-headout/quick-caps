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
    <div aria-live="polite" className="pc-enter">
      <div className="flex items-baseline justify-between text-[11.5px]">
        <span className="text-[var(--text-primary)]">
          {LABELS[progress.phase]}
        </span>
        {percent === null ? null : (
          <span className="font-mono text-[var(--text-secondary)]">
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
        className="relative mt-[6px] h-[3px] w-full overflow-hidden rounded-full bg-[var(--surface-raised)]"
      >
        {percent === null ? (
          // No total to count against yet, so sweep instead of faking a number.
          <div className="pc-sweep absolute inset-0" />
        ) : (
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-[var(--ease-out)]"
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
}
