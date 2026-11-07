import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cx } from "./cx";
import { SearchField } from "./Field";

export interface JumpTarget {
  label: string;
  to: string;
  /** Extra words that should match, e.g. "audit log". */
  keywords?: string;
}

export interface JumpSearchProps {
  placeholder: string;
  targets: JumpTarget[];
  onGo: (to: string) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * The top-bar search: a combobox over the app's pages. Ctrl K (Cmd K on a Mac)
 * focuses it; arrows move, Enter goes, Escape clears.
 */
export function JumpSearch({ placeholder, targets, onGo }: JumpSearchProps) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return targets;
    return targets.filter((t) => `${t.label} ${t.keywords ?? ""}`.toLowerCase().includes(s));
  }, [q, targets]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setActive(0), [q]);

  const go = (t: JumpTarget | undefined) => {
    if (!t) return;
    onGo(t.to);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(matches[active]);
    } else if (e.key === "Escape") {
      setQ("");
      setOpen(false);
    }
  };

  const showList = open && matches.length > 0;
  return (
    <div className="sl-jump">
      <SearchField
        ref={inputRef}
        label={placeholder}
        placeholder={placeholder}
        shortcut={[isMac ? "⌘" : "Ctrl", "K"]}
        value={q}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? `${listId}-${active}` : undefined}
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul className="sl-jump__list" role="listbox" id={listId} aria-label="Pages">
          {matches.map((t, i) => (
            <li
              key={t.to}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx("sl-jump__opt", i === active && "is-active")}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(t)}
            >
              {t.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
