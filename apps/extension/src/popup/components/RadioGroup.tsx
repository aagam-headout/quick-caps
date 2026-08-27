type Option = { value: string; label: string; hint?: string };

type Props = {
  name: string;
  legend: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
};

export function RadioGroup({ name, legend, value, options, onChange }: Props) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">
        {legend}
      </legend>
      {options.map((option) => (
        <div key={option.value} className="flex items-start gap-2 py-[3px]">
          <input
            id={`${name}-${option.value}`}
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-[2px] h-[14px] w-[14px] shrink-0 accent-[var(--accent)]"
          />
          <label
            htmlFor={`${name}-${option.value}`}
            className="text-[13px] leading-tight text-[var(--text-primary)]"
          >
            {option.label}
            {option.hint ? (
              <span className="block text-[11px] text-[var(--text-secondary)]">
                {option.hint}
              </span>
            ) : null}
          </label>
        </div>
      ))}
    </fieldset>
  );
}
