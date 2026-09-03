import { useState, useCallback, type ReactNode } from "react";
import { statusMeta, exactTime, relTime } from "./lib";

export function StatusDot({ status, withLabel = true }: { status: string; withLabel?: boolean }) {
  const m = statusMeta(status);
  return (
    <span className={`status ${m.running ? "running" : ""}`} data-status={status}>
      <span className="dot" style={{ background: m.color, "--halo": m.bg } as any} />
      {withLabel && <span>{m.label}</span>}
    </span>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  }, [text]);
  return (
    <span className="copyline">
      <span>{label ?? text}</span>
      <button className={`copybtn ${done ? "copied" : ""}`} onClick={onCopy} title="Copy" aria-label="Copy value">
        {done ? "✓" : "⧉"}
      </button>
    </span>
  );
}

export function RelTime({ ts, base }: { ts: number; base?: number }) {
  return <span className="rel" title={exactTime(ts)}>{relTime(ts, base)}</span>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
