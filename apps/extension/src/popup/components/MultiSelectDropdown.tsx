import { useId } from 'react';
import { Checkbox } from './Checkbox.js';
import { DropdownTrigger } from './DropdownTrigger.js';
import { useDropdown } from './use-dropdown.js';

type Option<K extends string> = { key: K; label: string; hint?: string };

type Props<K extends string> = {
  legend: string;
  options: Option<K>[];
  values: Record<K, boolean>;
  onChange: (key: K, value: boolean) => void;
};

/**
 * A compact trigger button ("Extras · 3/5") that opens a floating checklist
 * panel with a tick mark per selection, closing on an outside click or
 * Escape. Unlike Section's collapsible <details>, the panel overlays rather
 * than pushing the rest of the form down — the point for a group of options
 * most captures leave untouched.
 */
export function MultiSelectDropdown<K extends string>({
  legend,
  options,
  values,
  onChange,
}: Props<K>) {
  const { open, setOpen, rootRef } = useDropdown<HTMLDivElement>();
  const panelId = useId();
  const selected = options.filter((option) => values[option.key]).length;

  return (
    <div ref={rootRef} className="relative">
      <DropdownTrigger
        legend={legend}
        summary={`${selected}/${options.length}`}
        open={open}
        panelId={panelId}
        onClick={() => setOpen((value) => !value)}
      />

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label={legend}
          className="pc-enter absolute left-0 right-0 top-[calc(100%+4px)] z-10 rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-[4px] shadow-[0_6px_20px_rgba(0,0,0,0.16)]"
        >
          {options.map(({ key, label, hint }) => (
            <Checkbox
              key={key}
              id={`include-${key}`}
              label={label}
              {...(hint ? { hint } : {})}
              checked={values[key]}
              onChange={(checked) => onChange(key, checked)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
