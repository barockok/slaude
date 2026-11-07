import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconButton } from "./Button";
import { cx } from "./cx";
import { IconClose } from "./icons";

export type ToastTone = "neutral" | "success" | "danger";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before it dismisses itself; 0 keeps it until closed. */
  duration?: number;
}

interface ToastEntry extends Required<Omit<ToastInput, "description">> {
  id: number;
  description?: string;
}

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

/** Show a toast from anywhere under ToastProvider. */
export function useToast(): (t: ToastInput) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast needs a ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback((t: ToastInput) => {
    const entry: ToastEntry = {
      id: next.current++,
      title: t.title,
      description: t.description,
      tone: t.tone ?? "neutral",
      duration: t.duration ?? 5000,
    };
    setToasts((ts) => [...ts.slice(-3), entry]);
  }, []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sl-toasts" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  // The parent passes a fresh callback each render; the timer must not restart.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!toast.duration || paused) return;
    const t = setTimeout(() => dismissRef.current(), toast.duration);
    return () => clearTimeout(t);
  }, [toast.duration, paused]);

  return (
    <div
      className={cx("sl-toast", `sl-toast--${toast.tone}`)}
      role={toast.tone === "danger" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="sl-toast__text">
        <p className="sl-toast__title">{toast.title}</p>
        {toast.description && <p className="sl-toast__desc">{toast.description}</p>}
      </div>
      <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
        <IconClose size={16} />
      </IconButton>
    </div>
  );
}
