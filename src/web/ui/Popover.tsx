import {
  Fragment, useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref,
} from "react";
import { cx } from "./cx";
import { IconCheck } from "./icons";

export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu" | "dialog";
  /** Set only while the panel is open, so it never points at a missing element. */
  "aria-controls"?: string;
}

export interface PopoverProps {
  trigger: (props: PopoverTriggerProps) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  /** "menu" when the content is a Menu; "dialog" for free content. */
  kind?: "menu" | "dialog";
  className?: string;
  /** Accessible name of the panel. */
  label?: string;
}

/**
 * A panel anchored under its trigger. Escape closes it and returns focus to the
 * trigger; a pointer press outside closes it. The panel is positioned inside the
 * anchor so it scrolls with the page and needs no measuring.
 */
export function Popover({ trigger, children, align = "start", kind = "dialog", className, label }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    // Free content gets focus on its first control; a Menu focuses its own item.
    if (kind === "dialog") {
      const first = panelRef.current?.querySelector<HTMLElement>(
        "button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      (first ?? panelRef.current)?.focus();
    }
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close, kind]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <span className="sl-popover-anchor" ref={anchorRef} onKeyDown={onKeyDown}>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((o) => !o),
        "aria-expanded": open,
        "aria-haspopup": kind,
        "aria-controls": open ? id : undefined,
      })}
      {open && (
        <div
          id={id}
          ref={panelRef}
          className={cx("sl-popover", `sl-popover--${align}`, className)}
          role={kind === "dialog" ? "dialog" : undefined}
          aria-label={kind === "dialog" ? label : undefined}
          tabIndex={-1}
        >
          {children(() => close())}
        </div>
      )}
    </span>
  );
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Shown as a radio-style item with a check when true or false. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a hairline above this item to start a group. */
  separatorBefore?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  label: string;
  items: MenuItem[];
  /** Called after an item is chosen, e.g. to close the popover. */
  onDone?: () => void;
  header?: ReactNode;
}

/** A WAI-ARIA menu: arrow keys move, Home and End jump, Enter or Space choose. */
export function Menu({ label, items, onDone, header }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const itemEls = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[role^='menuitem']:not(:disabled)") ?? []);

  useEffect(() => {
    const els = itemEls();
    const checked = els.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? els[0])?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = itemEls();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % els.length;
    else if (e.key === "ArrowUp") next = (i - 1 + els.length) % els.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = els.length - 1;
    else if (e.key === "Tab") onDone?.();
    if (next >= 0) {
      e.preventDefault();
      els[next]?.focus();
    }
  };

  const hasChecks = items.some((it) => it.checked !== undefined);
  return (
    <div className="sl-menu" role="menu" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {header && <div className="sl-menu__header">{header}</div>}
      {items.map((it) => (
        <Fragment key={it.key}>
        {it.separatorBefore && <div className="sl-menu__sep" role="separator" />}
        <button
          type="button"
          role={it.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.checked === undefined ? undefined : it.checked}
          tabIndex={-1}
          disabled={it.disabled}
          className={cx("sl-menu__item", it.danger && "is-danger")}
          onClick={() => {
            it.onSelect();
            onDone?.();
          }}
        >
          {it.icon && <span className="sl-menu__icon">{it.icon}</span>}
          <span className="sl-menu__label">{it.label}</span>
          {hasChecks && <span className="sl-menu__check">{it.checked ? <IconCheck size={16} /> : null}</span>}
        </button>
        </Fragment>
      ))}
    </div>
  );
}
