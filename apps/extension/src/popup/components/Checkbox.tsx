type Props = {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** A secondary action related to this one setting (e.g. "Preview") shown
   * at the row's trailing edge. Its own click must not also toggle the
   * checkbox - see the stopPropagation note where callers build it. */
  trailing?: React.ReactNode;
};

const InfoIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[11px] w-[11px]">
    <circle
      cx="8"
      cy="8"
      r="6.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <path
      d="M8 7.3v4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
    <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
  </svg>
);

/**
 * The native input stays in the tree and keeps its own focus ring and keyboard
 * behaviour; only the box is drawn. Wrapping the whole row in the label gives a
 * comfortable hit target instead of a 14px square.
 */
export function Checkbox({
  id,
  label,
  hint,
  checked,
  onChange,
  trailing,
}: Props) {
  return (
    <label
      htmlFor={id}
      className="group flex cursor-pointer flex-col gap-[1px] rounded-[var(--radius-control)] px-[6px] py-[5px] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-raised)]"
    >
      <span className="flex items-start gap-2">
        <span className="relative mt-[1px] flex h-[15px] w-[15px] shrink-0 items-center justify-center">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            aria-describedby={hint ? `${id}-hint` : undefined}
            className="peer h-[15px] w-[15px] cursor-pointer appearance-none rounded-[4px] border border-[var(--border)] bg-[var(--surface)] transition-all duration-[var(--duration-fast)] checked:border-[var(--accent)] group-hover:border-[var(--gray-500)] checked:group-hover:border-[var(--accent)]"
          />
          <svg
            viewBox="0 0 12 12"
            aria-hidden="true"
            className="pointer-events-none absolute h-[10px] w-[10px] scale-50 text-[var(--accent)] opacity-0 transition-all duration-[var(--duration-fast)] peer-checked:scale-100 peer-checked:opacity-100"
          >
            <path
              d="M2 6.2 4.6 8.8 10 3.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-[12.5px] text-[var(--text-primary)]">
              {label}
            </span>
            {hint ? (
              <button
                type="button"
                tabIndex={0}
                aria-describedby={`${id}-hint`}
                onClick={(event) => {
                  // Inside the row's <label> - a plain click would bubble
                  // and toggle the checkbox instead of just revealing the
                  // hint.
                  event.preventDefault();
                  event.stopPropagation();
                }}
                className="pc-hint-trigger flex h-[14px] w-[14px] shrink-0 cursor-help items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--accent)]"
              >
                <InfoIcon />
              </button>
            ) : null}
          </span>
          {trailing ? <span className="shrink-0">{trailing}</span> : null}
        </span>
      </span>
      {hint ? (
        <span className="pc-hint-row pl-[23px]">
          <span
            id={`${id}-hint`}
            className="block pt-[1px] text-[11px] leading-[1.35] text-[var(--text-secondary)]"
          >
            {hint}
          </span>
        </span>
      ) : null}
    </label>
  );
}
