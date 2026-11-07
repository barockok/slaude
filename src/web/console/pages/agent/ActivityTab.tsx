import { useEffect, useRef, useState } from "react";
import type { AuditEventView, AuditPageResponse } from "../../../../gateway/panel/api-types";
import { navigate } from "../../../lib/router";
import { Button, EmptyState } from "../../../ui";
import { api } from "../../client";
import { AuditTable } from "../../components/AuditTable";
import { ErrorState } from "../../components/ErrorState";
import { auditLinkFor } from "../../lib/format";

const PAGE = 25;

/** The agent's audit trail, newest first, a page at a time. */
export function ActivityTab({ name }: { name: string }) {
  const [items, setItems] = useState<AuditEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  // The in-flight "Load more", cancelled on unmount, agent change or reload.
  const moreCtl = useRef<AbortController | null>(null);

  const url = (c: string | null) =>
    `/api/audit?persona=${encodeURIComponent(name)}&limit=${PAGE}${c ? `&cursor=${encodeURIComponent(c)}` : ""}`;

  useEffect(() => {
    const ctl = new AbortController();
    moreCtl.current?.abort();
    setMore(false);
    setLoading(true);
    setError(null);
    api.get<AuditPageResponse>(url(null), { signal: ctl.signal }).then(
      (p) => {
        if (ctl.signal.aborted) return;
        setItems(p.items);
        setCursor(p.nextCursor);
        setLoading(false);
      },
      (e: Error) => {
        if (ctl.signal.aborted) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [name, tick]);

  useEffect(() => () => moreCtl.current?.abort(), []);

  const loadMore = async () => {
    if (!cursor) return;
    const ctl = new AbortController();
    moreCtl.current = ctl;
    setMore(true);
    setError(null);
    try {
      const p = await api.get<AuditPageResponse>(url(cursor), { signal: ctl.signal });
      if (ctl.signal.aborted) return;
      setItems((xs) => [...xs, ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      if (!ctl.signal.aborted) setError(e as Error);
    } finally {
      if (!ctl.signal.aborted) setMore(false);
    }
  };

  if (error && items.length === 0) return <ErrorState what="Activity" error={error} onRetry={() => setTick((t) => t + 1)} />;

  return (
    <div className="sl-section sl-section--flush">
      <AuditTable
        label={`Activity of ${name}`}
        rows={items}
        loading={loading}
        skeletonRows={6}
        onRowClick={(e) => navigate(auditLinkFor(e))}
        empty={<EmptyState title="No activity yet" description={`Decisions and console changes for ${name} show up here.`} />}
      />
      {error && items.length > 0 && (
        <p className="sl-form__error" role="alert">
          Could not load more: {error.message}
        </p>
      )}
      {cursor && !loading && (
        <div className="sl-more">
          <Button onClick={loadMore} loading={more}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
