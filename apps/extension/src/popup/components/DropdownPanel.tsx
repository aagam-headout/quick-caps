import { useId } from 'react';
import { DropdownTrigger } from './DropdownTrigger.js';
import { useDropdown } from './use-dropdown.js';

type Props = {
  legend: string;
  summary: string;
  children: React.ReactNode;
};

/**
 * Shared shell for a floating-panel dropdown: the trigger button plus the
 * panel it opens below, closing on an outside click or Escape. Every
 * settings group in the popup that isn't the single always-visible "Page
 * contents" checklist opens this same way — MultiSelectDropdown builds its
 * checklist on top of this, and any other mixed-content group (checkboxes,
 * text fields, whatever) can too, so the popup reads as one control family
 * instead of a mix of dropdowns and collapsible sections for equivalent
 * settings groups.
 */
export function DropdownPanel({ legend, summary, children }: Props) {
  const { open, setOpen, rootRef } = useDropdown<HTMLDivElement>();
  const panelId = useId();

  return (
    <div ref={rootRef} className="relative">
      <DropdownTrigger
        legend={legend}
        summary={summary}
        open={open}
        panelId={panelId}
        onClick={() => setOpen((value) => !value)}
      />

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label={legend}
          className="pc-enter absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-[280px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] p-[4px] shadow-[0_6px_20px_rgba(0,0,0,0.16)]"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
