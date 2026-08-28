import { useId } from 'react';
import { DropdownTrigger } from './DropdownTrigger.js';
import { useDropdown } from './use-dropdown.js';

export type SingleSelectOption = {
  value: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
};

type Props = {
  legend: string;
  options: SingleSelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** A narrow, inline trigger for the header, with the panel right-aligned under it. */
  compact?: boolean;
  /** Accent-tinted trigger for the one dropdown that's the primary lever. */
  emphasis?: boolean;
};

/**
 * A compact trigger button showing the current choice, opening a floating
 * panel of radio rows with a tick mark on the selected one. Choosing a row
 * closes the panel immediately - this is one choice, not a checklist.
 */
export function SingleSelectDropdown({
  legend,
  options,
  value,
  onChange,
  compact,
  emphasis,
}: Props) {
  const { open, setOpen, rootRef } = useDropdown<HTMLDivElement>();
  const panelId = useId();
  const groupName = useId();
  const current = options.find((option) => option.value === value);

  return (
    <div ref={rootRef} className={compact ? 'relative' : 'relative w-full'}>
      <DropdownTrigger
        legend={legend}
        summary={current?.label ?? ''}
        open={open}
        panelId={panelId}
        onClick={() => setOpen((next) => !next)}
        {...(compact ? { compact: true } : {})}
        {...(emphasis ? { emphasis: true } : {})}
        {...(current?.icon ? { icon: current.icon } : {})}
      />

      {open ? (
        <fieldset
          id={panelId}
          className={`pc-enter absolute top-[calc(100%+4px)] z-10 m-0 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-[4px] shadow-[0_6px_20px_rgba(0,0,0,0.16)] ${
            compact ? 'right-0 min-w-[160px]' : 'left-0 right-0'
          }`}
        >
          <legend className="sr-only">{legend}</legend>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <label
                key={option.value}
                className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-control)] px-[6px] py-[5px] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-raised)]"
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.value}
                  checked={selected}
                  onChange={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="sr-only"
                />
                {option.icon ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[var(--text-secondary)]"
                  >
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 leading-[1.35]">
                  <span className="block text-[12.5px] text-[var(--text-primary)]">
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span className="block text-[11px] text-[var(--text-secondary)]">
                      {option.hint}
                    </span>
                  ) : null}
                </span>
                <svg
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                  className={`h-[10px] w-[10px] shrink-0 text-[var(--accent)] transition-opacity duration-[var(--duration-fast)] ${
                    selected ? 'opacity-100' : 'opacity-0'
                  }`}
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
              </label>
            );
          })}
        </fieldset>
      ) : null}
    </div>
  );
}
