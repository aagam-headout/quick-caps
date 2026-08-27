type Theme = 'system' | 'light' | 'dark';

export function ThemeToggle({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (theme: Theme) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="sr-only">Theme</legend>
      <div className="inline-flex overflow-hidden rounded-[var(--radius-control)] border border-[var(--border)]">
        {(['system', 'light', 'dark'] as const).map((theme) => (
          <label
            key={theme}
            className={`cursor-pointer px-[7px] py-[3px] text-[11px] capitalize ${
              value === theme
                ? 'bg-[var(--surface-raised)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)]'
            }`}
          >
            <input
              type="radio"
              name="theme"
              value={theme}
              checked={value === theme}
              onChange={() => onChange(theme)}
              className="sr-only"
            />
            {theme}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
