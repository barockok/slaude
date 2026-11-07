import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton, IconClose } from "../../ui";

const FOCUSABLE =
  "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}

/**
 * A modal panel from the right edge (a full-height sheet on a phone): focus
 * moves in and is trapped, Escape or a backdrop press closes, and focus goes
 * back to whatever opened it.
 */
export function Drawer({ open, onClose, title, description, children }: DrawerProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const els = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (els.length === 0) return e.preventDefault();
    const first = els[0]!;
    const last = els[els.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="sl-drawer-layer" onKeyDown={onKeyDown}>
      <div className="sl-dialog-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="sl-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
      >
        <header className="sl-drawer__head">
          <div className="sl-stack">
            <h2 id={`${id}-title`} className="sl-dialog__title">
              {title}
            </h2>
            {description && (
              <p id={`${id}-desc`} className="sl-dialog__desc">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <IconClose size={16} />
          </IconButton>
        </header>
        <div className="sl-drawer__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
