type Props = {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** A secondary action related to this one setting (e.g. "Preview") shown
   * at the row's trailing edge. Its own click must not also toggle the
   * checkbox — see the stopPropagation note where callers build it. */
  trailing?: React.ReactNode;
};

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
      className="group flex cursor-pointer items-start gap-2 rounded-[var(--radius-control)] px-[6px] py-[5px] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-raised)]"
    >
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
      <span className="flex min-w-0 flex-1 items-start justify-between gap-2">
        <span className="min-w-0 leading-[1.35]">
          <span className="block text-[12.5px] text-[var(--text-primary)]">
            {label}
          </span>
          {hint ? (
            <span
              id={`${id}-hint`}
              className="block text-[11px] text-[var(--text-secondary)]"
            >
              {hint}
            </span>
          ) : null}
        </span>
        {trailing ? <span className="shrink-0">{trailing}</span> : null}
      </span>
    </label>
  );
}
