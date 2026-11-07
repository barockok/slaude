/**
 * An audit listing a page at a time: the first page loads whenever `url`
 * changes, "Load more" appends the next one. `url` is the endpoint with its
 * filters and no cursor, or null to load nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEventView, AuditPageResponse } from "../../../gateway/panel/api-types";
import { AuthRedirectError } from "../../lib/api";
import { api } from "../client";

export interface AuditPages {
  items: AuditEventView[];
  /** First page in flight (show skeletons). */
  loading: boolean;
  /** "Load more" in flight. */
  more: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

const withCursor = (url: string, cursor: string) => `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;

export function useAuditPages(url: string | null): AuditPages {
  const [items, setItems] = useState<AuditEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(url !== null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const moreCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    moreCtl.current?.abort();
    setMore(false);
    if (url === null) return;
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api.get<AuditPageResponse>(url, { signal: ctl.signal }).then(
      (p) => {
        if (ctl.signal.aborted) return;
        setItems(p.items);
        setCursor(p.nextCursor);
        setLoading(false);
      },
      (e: Error) => {
        if (ctl.signal.aborted || e instanceof AuthRedirectError) return;
        setItems([]);
        setCursor(null);
        setError(e);
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [url, tick]);

  useEffect(() => () => moreCtl.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (!cursor || url === null) return;
    const ctl = new AbortController();
    moreCtl.current?.abort();
    moreCtl.current = ctl;
    setMore(true);
    setError(null);
    api.get<AuditPageResponse>(withCursor(url, cursor), { signal: ctl.signal }).then(
      (p) => {
        if (ctl.signal.aborted) return;
        setItems((xs) => [...xs, ...p.items]);
        setCursor(p.nextCursor);
        setMore(false);
      },
      (e: Error) => {
        if (ctl.signal.aborted || e instanceof AuthRedirectError) return;
        setError(e);
        setMore(false);
      },
    );
  }, [cursor, url]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { items, loading, more, error, hasMore: cursor !== null, loadMore, reload };
}
