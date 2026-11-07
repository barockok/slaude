import { useState, type KeyboardEvent } from "react";
import { cx } from "./cx";
import { IconMonitor, IconMoon, IconSun } from "./icons";
import { readThemePref, saveThemePref, type ThemePref } from "./theme";

const OPTIONS: Array<{ value: ThemePref; label: string; Icon: typeof IconSun }> = [
  { value: "system", label: "System", Icon: IconMonitor },
  { value: "light", label: "Light", Icon: IconSun },
  { value: "dark", label: "Dark", Icon: IconMoon },
];

/** Three-way segmented control: system, light, dark. A radio group for assistive tech. */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = useState<ThemePref>(readThemePref);
  const choose = (p: ThemePref) => {
    setPref(p);
    saveThemePref(p);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = OPTIONS.findIndex((o) => o.value === pref);
    let n = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % OPTIONS.length;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + OPTIONS.length) % OPTIONS.length;
    if (n < 0) return;
    e.preventDefault();
    const v = OPTIONS[n]!.value;
    choose(v);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${v}"]`)?.focus();
  };

  return (
    <div className={cx("sl-theme-toggle", className)} role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          data-value={value}
          aria-checked={pref === value}
          aria-label={label}
          title={label}
          tabIndex={pref === value ? 0 : -1}
          className={cx("sl-theme-toggle__opt", pref === value && "is-selected")}
          onClick={() => choose(value)}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}
