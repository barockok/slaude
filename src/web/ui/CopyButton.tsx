import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { IconAlert, IconCheck, IconCopy } from "./icons";

/** How long "Copied" or "Copy failed" stays on the button before it goes back to its icon. */
export const COPY_FEEDBACK_MS = 2000;

type CopyState = "idle" | "copied" | "failed";

const TEXT: Record<Exclude<CopyState, "idle">, string> = { copied: "Copied", failed: "Copy failed" };

export interface CopyButtonProps {
  /** What goes on the clipboard. */
  text: string;
  /** Accessible name at rest, e.g. "Copy SKILL.md". */
  label: string;
  className?: string;
}

/**
 * An icon button that copies `text`. After a click its icon and label switch
 * to "Copied" (or "Copy failed" when the clipboard refuses) for about two
 * seconds, shown as text next to the icon, and the same words are announced
 * through a polite live region. One button element throughout, so focus stays
 * on it.
 */
export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  // A click while a message shows starts the timer over, so the newest result stays up its full time.
  const [round, setRound] = useState(0);
  // Set in the effect too: StrictMode runs mount, unmount, mount.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [state, round]);
  // What the live region says. Emptied for one tick before each result, so a
  // repeat click announces "Copied" again instead of leaving the text unchanged.
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    setAnnounce("");
    if (state === "idle") return;
    const t = setTimeout(() => setAnnounce(TEXT[state]), 50);
    return () => clearTimeout(t);
  }, [state, round]);

  const copy = async () => {
    let next: CopyState;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      next = "copied";
    } catch {
      // Blocked or unavailable: say so; the text stays selectable (Raw view).
      next = "failed";
    }
    if (!mounted.current) return;
    setState(next);
    setRound((r) => r + 1);
  };

  const message = state === "idle" ? null : TEXT[state];
  return (
    <>
      <button
        type="button"
        aria-label={message ?? label}
        title={message ?? label}
        className={cx("sl-icon-btn", "sl-btn--ghost", "sl-icon-btn--sm", "sl-copy-btn", message && "has-text", state === "failed" && "is-failed", className)}
        data-state={state}
        onClick={copy}
      >
        {state === "copied" ? <IconCheck size={16} /> : state === "failed" ? <IconAlert size={16} /> : <IconCopy size={16} />}
        {message && (
          <span className="sl-copy-btn__text" aria-hidden="true">
            {message}
          </span>
        )}
      </button>
      <span className="sl-visually-hidden" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  );
}
