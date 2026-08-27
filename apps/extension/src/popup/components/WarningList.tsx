import type { CaptureWarningView } from '../../lib/messages.js';

export function WarningList({ warnings }: { warnings: CaptureWarningView[] }) {
  if (warnings.length === 0) return null;
  return (
    <details className="mt-[8px] border-t border-[var(--border)] pt-[6px]">
      <summary className="flex cursor-pointer list-none items-center gap-[5px] text-[11.5px] text-[var(--warning)] [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="h-[11px] w-[11px]"
        >
          <path
            d="M6 1.5 11 10.5H1L6 1.5Zm0 3v3m0 1.6v.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {warnings.length} warning{warnings.length === 1 ? '' : 's'}
      </summary>
      <div className="pc-collapse">
        <ul className="mt-[6px] space-y-[5px]">
          {warnings.map((warning, index) => (
            <li
              key={`${warning.phase}-${index}`}
              className="text-[11px] leading-[1.35]"
            >
              <span className="mr-[5px] rounded-[3px] bg-[var(--surface-raised)] px-[4px] py-[1px] font-mono text-[10px] text-[var(--text-secondary)]">
                {warning.phase}
              </span>
              <span className="text-[var(--text-primary)]">
                {warning.reason}
              </span>
              {warning.url ? (
                <span className="block truncate font-mono text-[10.5px] text-[var(--text-secondary)]">
                  {warning.url}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
