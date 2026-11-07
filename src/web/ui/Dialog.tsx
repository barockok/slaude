import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { IconClose } from "./icons";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons, right-aligned in the footer. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const FOCUSABLE =
  "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * Modal dialog: focus moves in and is trapped, Escape or a backdrop press
 * closes, and focus returns to whatever opened it.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md" }: DialogProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(`.sl-dialog__body ${FOCUSABLE}, .sl-dialog__foot ${FOCUSABLE}`);
    (first ?? panel)?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
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
    if (els.length === 0) {
      e.preventDefault();
      return;
    }
    const first = els[0]!;
    const last = els[els.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="sl-dialog-layer" onKeyDown={onKeyDown}>
      <div className="sl-dialog-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`sl-dialog sl-dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        tabIndex={-1}
      >
        <header className="sl-dialog__head">
          <div>
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
        {children && <div className="sl-dialog__body">{children}</div>}
        {footer && <footer className="sl-dialog__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
