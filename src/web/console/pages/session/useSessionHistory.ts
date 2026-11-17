import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHistoryItem, SessionHistoryResponse } from "../../../../gateway/panel/api-types";
import { api } from "../../client";

export interface SessionHistory {
  /** Earlier lines, oldest first. */
  items: SessionHistoryItem[];
  loading: boolean;
  /** Loading an older page. */
  more: boolean;
  hasMore: boolean;
  /** Why there is no history (memory off or remote), from the server. */
  note: string | null;
  error: string | null;
  /** Names of the people mentioned in the loaded lines, as the gateway resolved them. */
  users: Record<string, string>;
  loadMore: () => void;
}

const PAGE = 20;

/** The session's earlier turns from its conversation record (GET .../history), paged backwards. */
export function useSessionHistory(sessionId: string): SessionHistory {
  const [items, setItems] = useState<SessionHistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<Record<string, string>>({});
  const ctl = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    async (before: string | null) => {
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      const q = new URLSearchParams({ limit: String(PAGE) });
      if (before) q.set("cursor", before);
      try {
        const r = await api.get<SessionHistoryResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/history?${q}`, { signal: c.signal });
        if (c.signal.aborted) return;
        setItems((xs) => (before ? [...r.items, ...xs] : r.items));
        setCursor(r.nextCursor);
        setNote(r.note ?? null);
        if (r.users) setUsers((u) => ({ ...u, ...r.users }));
        setError(null);
      } catch (e) {
        if (c.signal.aborted) return;
        setError((e as Error).message || "Earlier turns could not be loaded.");
      } finally {
        if (!c.signal.aborted) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setItems([]);
    setCursor(null);
    setNote(null);
    setError(null);
    setUsers({});
    setLoading(true);
    void fetchPage(null);
    return () => ctl.current?.abort();
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!cursor || more) return;
    setMore(true);
    void fetchPage(cursor);
  }, [cursor, more, fetchPage]);

  return { items, loading, more, hasMore: cursor !== null, note, error, users, loadMore };
}
