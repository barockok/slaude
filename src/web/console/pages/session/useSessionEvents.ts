import { useEffect, useState } from "react";
import { openSessionStream, type StreamEntry, type StreamStatus } from "../../lib/sessionStream";

const KEEP = 600;

export interface SessionEvents {
  entries: StreamEntry[];
  status: StreamStatus;
  detail: string | null;
  /** Count of turns that ended since the page opened (done or error), to refresh around them. */
  turnsEnded: number;
}

/** The session's live tail, kept for the life of the detail page (all tabs share it). */
export function useSessionEvents(sessionId: string): SessionEvents {
  const [entries, setEntries] = useState<StreamEntry[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [detail, setDetail] = useState<string | null>(null);
  const [turnsEnded, setTurnsEnded] = useState(0);

  useEffect(() => {
    setEntries([]);
    // Ids of the entries kept, in arrival order: trimmed with them, so a long
    // session does not grow the set without bound.
    const seen = new Set<string>();
    const order: string[] = [];
    const close = openSessionStream(sessionId, {
      onEntry: (e) => {
        if (seen.has(e.id)) return;
        seen.add(e.id);
        order.push(e.id);
        while (order.length > KEEP) seen.delete(order.shift()!);
        setEntries((xs) => (xs.length >= KEEP ? [...xs.slice(xs.length - KEEP + 1), e] : [...xs, e]));
        if ((e.event.type === "done" && !e.event.autoEvolve) || e.event.type === "error") setTurnsEnded((n) => n + 1);
      },
      onStatus: (s, d) => {
        setStatus(s);
        setDetail(d ?? null);
      },
    });
    return close;
  }, [sessionId]);

  return { entries, status, detail, turnsEnded };
}
