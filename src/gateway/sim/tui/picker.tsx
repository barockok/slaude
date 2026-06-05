/** @jsxImportSource @opentui/react */
import { LAYERS, ROLE_NAMES } from "../roles";

export interface PickerProps {
  which: "layer" | "as";
  onPick: (value: string) => void;
  onCancel: () => void;
}

/** A <select> overlay for /layer · /as. The select owns arrow-nav + Enter; we map its
 *  onSelect(index, option) → onPick(option.value). Esc-to-cancel is wired by the parent's
 *  useKeyboard (the select doesn't surface Escape), so onCancel stays a parent concern. */
export function Picker({ which, onPick }: PickerProps) {
  const options =
    which === "layer"
      ? LAYERS.map((l) => ({ name: l.name, description: l.desc, value: l.name }))
      : ROLE_NAMES.map((r) => ({ name: r, description: "", value: r }));
  const title = which === "layer" ? "layer — ↑/↓ · Enter · Esc" : "as — ↑/↓ · Enter · Esc";
  return (
    <box border title={title} flexDirection="column" height={options.length + 2}>
      <select
        focused
        height={options.length}
        options={options}
        onSelect={(_i, opt) => {
          if (opt) onPick(String(opt.value));
        }}
      />
    </box>
  );
}
