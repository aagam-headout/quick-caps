type Props = {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
};

/**
 * A labeled single-line input for the handful of settings that are text, not
 * a toggle — filename template, exclude selector. Styled to match the
 * dropdown triggers and checkboxes rather than the browser default, so it
 * doesn't read as a different control family.
 */
export function TextField({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
}: Props) {
  return (
    <label htmlFor={id} className="block px-[6px] py-[5px]">
      <span className="block text-[12.5px] text-[var(--text-primary)]">
        {label}
      </span>
      {hint ? (
        <span
          id={`${id}-hint`}
          className="mb-[4px] block text-[11px] text-[var(--text-secondary)]"
        >
          {hint}
        </span>
      ) : null}
      <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="mt-[4px] w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-[8px] py-[6px] font-mono text-[11.5px] text-[var(--text-primary)] transition-colors duration-[var(--duration-fast)] placeholder:text-[var(--text-secondary)] hover:border-[var(--gray-500)]"
      />
    </label>
  );
}
