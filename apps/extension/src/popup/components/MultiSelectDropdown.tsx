import { Checkbox } from './Checkbox.js';
import { DropdownPanel } from './DropdownPanel.js';

type Option<K extends string> = {
  key: K;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
};

type Props<K extends string> = {
  legend: string;
  options: Option<K>[];
  values: Record<K, boolean>;
  onChange: (key: K, value: boolean) => void;
};

/**
 * A checklist of toggles inside a DropdownPanel, with a tick mark per
 * selection and an "N/total" summary on the trigger.
 */
export function MultiSelectDropdown<K extends string>({
  legend,
  options,
  values,
  onChange,
}: Props<K>) {
  const selected = options.filter((option) => values[option.key]).length;

  return (
    <DropdownPanel legend={legend} summary={`${selected}/${options.length}`}>
      {options.map(({ key, label, hint, trailing }) => (
        <Checkbox
          key={key}
          id={`include-${key}`}
          label={label}
          {...(hint ? { hint } : {})}
          {...(trailing ? { trailing } : {})}
          checked={values[key]}
          onChange={(checked) => onChange(key, checked)}
        />
      ))}
    </DropdownPanel>
  );
}
