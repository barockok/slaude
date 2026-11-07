import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
}

export interface TabsProps<V extends string> {
  label: string;
  tabs: TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** The active panel's content. */
  children?: ReactNode;
}

/** WAI-ARIA tabs with automatic activation: arrows, Home and End move and select. */
export function Tabs<V extends string>({ label, tabs, value, onChange, children }: TabsProps<V>) {
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.value === value);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next]!;
    onChange(t.value);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(t.value)}"]`)?.focus();
  };

  return (
    <div className="sl-tabs">
      <div className="sl-tabs__list" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
        {tabs.map((t) => {
          const selected = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              id={`${base}-tab-${t.value}`}
              data-value={t.value}
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              className={cx("sl-tabs__tab", selected && "is-selected")}
              onClick={() => onChange(t.value)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {children !== undefined && (
        <div
          className="sl-tabs__panel"
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${value}`}
          tabIndex={0}
        >
          {children}
        </div>
      )}
    </div>
  );
}
