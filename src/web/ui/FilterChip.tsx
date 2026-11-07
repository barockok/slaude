import { Popover, Menu } from "./Popover";
import { IconChevronDown } from "./icons";

export interface FilterOption<V extends string> {
  value: V;
  label: string;
}

export interface FilterChipProps<V extends string> {
  /** What is filtered, e.g. "Created". */
  label: string;
  value: V;
  options: FilterOption<V>[];
  onChange: (value: V) => void;
}

/** "Label  Value  v" chip that opens a single-choice menu. */
export function FilterChip<V extends string>({ label, value, options, onChange }: FilterChipProps<V>) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Popover
      kind="menu"
      trigger={(p) => (
        <button type="button" className="sl-chip" {...p} aria-label={`${label}: ${current}`}>
          <span className="sl-chip__label">{label}</span>
          <span className="sl-chip__value">{current}</span>
          <IconChevronDown size={16} className="sl-chip__chevron" />
        </button>
      )}
    >
      {(close) => (
        <Menu
          label={label}
          onDone={close}
          items={options.map((o) => ({
            key: o.value,
            label: o.label,
            checked: o.value === value,
            onSelect: () => onChange(o.value),
          }))}
        />
      )}
    </Popover>
  );
}
