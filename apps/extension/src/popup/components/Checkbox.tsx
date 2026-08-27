type Props = {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export function Checkbox({ id, label, hint, checked, onChange }: Props) {
  return (
    <div className="flex items-start gap-2 py-[3px]">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="mt-[2px] h-[14px] w-[14px] shrink-0 rounded-[3px] border border-[var(--border)] accent-[var(--accent)]"
      />
      <div className="leading-tight">
        <label htmlFor={id} className="text-[13px] text-[var(--text-primary)]">
          {label}
        </label>
        {hint ? (
          <p
            id={`${id}-hint`}
            className="text-[11px] text-[var(--text-secondary)]"
          >
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}
