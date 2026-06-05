import { useEffect, useState } from "react";
import type { ReplController } from "../repl";
import { forText } from "./ansi";

/** Subscribe a component to a ReplController's two output streams. The controller emits ANSI-
 *  decorated scrollback lines (committed) and a live status label; we strip ANSI for <text>
 *  (see ansi.ts / API-NOTES.md — <text> renders escape bytes literally). */
export function useRepl(r: ReplController) {
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    r.onOutput((line) => setMessages((m) => [...m, forText(line)]));
    r.onStatus((label) => setStatus(label));
    // onOutput/onStatus replace (not append) the single sink, so on unmount detach by resetting
    // to no-ops — avoids a stale closure writing into an unmounted tree.
    return () => { r.onOutput(() => {}); r.onStatus(() => {}); };
  }, [r]);
  // Append a local line to the same scrollback — used to echo the user's own submitted input
  // into the timeline (the controller only emits agent-side output).
  const echo = (line: string) => setMessages((m) => [...m, line]);
  return { messages, status, echo };
}
