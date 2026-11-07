/**
 * Load one API resource: data, loading, error, and a reload. A reload keeps the
 * previous data on screen until the new answer arrives (no flash to skeleton).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthRedirectError } from "../../lib/api";
import { api } from "../client";

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const lastPath = useRef(path);

  useEffect(() => {
    if (path === null) return;
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(null);
    }
    const ctl = new AbortController();
    setLoading(true);
    setError(null);
    api.get<T>(path, { signal: ctl.signal }).then(
      (d) => {
        if (ctl.signal.aborted) return;
        setData(d);
        setLoading(false);
      },
      (e: Error) => {
        if (ctl.signal.aborted || e instanceof AuthRedirectError) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}
