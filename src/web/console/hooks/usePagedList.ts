/**
 * A cursor-paged list: the first page loads whenever `url` changes, "Load
 * more" appends the next. `url` is the endpoint with its filters and no
 * cursor; the answer is `{ items, nextCursor }`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthRedirectError } from "../../lib/api";
import { api } from "../client";

export interface PagedList<T> {
  items: T[];
  loading: boolean;
  more: boolean;
  error: Error | null;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const withCursor = (url: string, cursor: string) => `${url}${url.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;

export function usePagedList<T>(url: string): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const moreCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    moreCtl.current?.abort();
    setMore(false);
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api.get<Page<T>>(url, { signal: ctl.signal }).then(
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
    if (!cursor) return;
    const ctl = new AbortController();
    moreCtl.current?.abort();
    moreCtl.current = ctl;
    setMore(true);
    setError(null);
    api.get<Page<T>>(withCursor(url, cursor), { signal: ctl.signal }).then(
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
