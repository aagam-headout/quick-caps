type Props = {
  legend: string;
  summary: string;
  open: boolean;
  panelId: string;
  onClick: () => void;
  /** A narrow, inline trigger for the header instead of a full-width block control. */
  compact?: boolean;
  /** Accent-tinted styling for the one trigger that's the primary lever, not a secondary option. */
  emphasis?: boolean;
  /** The current selection's icon, shown ahead of the summary text — lets a
   * trigger like Theme read at a glance without opening the panel. */
  icon?: React.ReactNode;
};

/**
 * The button both dropdown variants open from: a legend, a one-line summary
 * of the current value, and a chevron that rotates open. Shared so the two
 * dropdowns read as one control family rather than two hand-tuned buttons.
 */
export function DropdownTrigger({
  legend,
  summary,
  open,
  panelId,
  onClick,
  compact,
  emphasis,
  icon,
}: Props) {
  return (
    <button
      type="button"
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={panelId}
      {...(compact ? { 'aria-label': `${legend}: ${summary}` } : {})}
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-[6px] rounded-[var(--radius-control)] border text-left text-[11px] font-medium transition-colors duration-[var(--duration-fast)] ${
        emphasis
          ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))]'
          : 'border-[var(--border)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      } ${compact ? 'px-[8px] py-[5px]' : 'w-full px-[8px] py-[6px]'}`}
    >
      {compact ? null : (
        <span className="uppercase tracking-[0.06em]">{legend}</span>
      )}
      {icon ? (
        <span
          aria-hidden="true"
          className="shrink-0 text-[var(--text-secondary)]"
        >
          {icon}
        </span>
      ) : null}
      <span
        className={`min-w-0 truncate normal-case tracking-normal ${compact ? '' : 'ml-auto'}`}
      >
        {summary}
      </span>
      <svg
        viewBox="0 0 12 12"
        aria-hidden="true"
        className={`h-[10px] w-[10px] shrink-0 transition-transform duration-[var(--duration-fast)] ${
          open ? 'rotate-90' : ''
        }`}
      >
        <path
          d="M4.5 2.5 8 6l-3.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
