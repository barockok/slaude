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
  }, [r]);
  return { messages, status };
}
