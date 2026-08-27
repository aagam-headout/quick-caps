import type { CaptureWarningView } from '../../lib/messages.js';

export function WarningList({ warnings }: { warnings: CaptureWarningView[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-[12px] text-[var(--warning)]">
        {warnings.length} warning{warnings.length === 1 ? '' : 's'}
      </summary>
      <ul className="mt-1 space-y-1">
        {warnings.map((warning, index) => (
          <li key={`${warning.phase}-${index}`} className="text-[11px]">
            <span className="font-mono text-[var(--text-secondary)]">
              {warning.phase}
            </span>{' '}
            <span className="text-[var(--text-primary)]">{warning.reason}</span>
            {warning.url ? (
              <span className="block truncate font-mono text-[var(--text-secondary)]">
                {warning.url}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
