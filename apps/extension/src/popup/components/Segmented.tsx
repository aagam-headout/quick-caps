export type SegmentedOption = {
  value: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
};

type Props = {
  name: string;
  legend: string;
  /** Hide the legend when the surrounding context already names the control. */
  hideLegend?: boolean;
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  /** Stack tiles vertically with room for a hint line. */
  stacked?: boolean;
};

/**
 * One control for presets, output mode, and theme. Radios underneath, so arrow
 * keys work and a screen reader hears a group rather than three buttons.
 */
export function Segmented({
  name,
  legend,
  hideLegend,
  value,
  options,
  onChange,
  stacked,
}: Props) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend
        className={
          hideLegend
            ? 'sr-only'
            : 'pb-[6px] text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--text-secondary)]'
        }
      >
        {legend}
      </legend>
      <div
        className="grid gap-[2px] rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-raised)] p-[2px]"
        // Tailwind cannot generate a class from a runtime value, so the column
        // count is set directly rather than through grid-cols-N.
        style={{
          gridTemplateColumns: stacked
            ? '1fr'
            : `repeat(${options.length}, 1fr)`,
        }}
      >
        {options.map((option) => {
          const selected = value === option.value;
          return (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center justify-center gap-[6px] rounded-[4px] px-2 py-[6px] text-center text-[12px] transition-all duration-[var(--duration-fast)] ${
                selected
                  ? 'bg-[var(--surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              {option.icon ? (
                <span aria-hidden="true" className="shrink-0">
                  {option.icon}
                </span>
              ) : null}
              <span className="min-w-0">
                <span className="block truncate">{option.label}</span>
                {option.hint ? (
                  <span className="block text-[10.5px] text-[var(--text-secondary)]">
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
