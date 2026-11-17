import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryPageSummaryView, MemoryPagesResponse, MemoryStoresResponse } from "../../../../gateway/panel/api-types";
import { AuthRedirectError } from "../../../lib/api";
import { Link, navigate } from "../../../lib/router";
import { Badge, Button, Card, EmptyState, IconArrowLeft, PageHeader, Table, type Column } from "../../../ui";
import { api } from "../../client";
import { TimeAgo } from "../../../shared/TimeAgo";
import { useApi } from "../../hooks/useApi";
import { KindBadge, MemoryError, PrivateBadge, isPrivateStoreId, pagePath } from "./memoryParts";

const PAGE = 50;

const COLUMNS: Column<MemoryPageSummaryView>[] = [
  {
    key: "page",
    header: "Page",
    skeleton: 0.7,
    render: (p) => (
      <span className="sl-stack">
        <span className="sl-truncate">{p.title || p.slug}</span>
        <span className="sl-mono sl-caption sl-truncate">{p.slug}</span>
      </span>
    ),
  },
  { key: "type", header: "Type", width: "9rem", skeleton: 0.5, render: (p) => (p.type ? <Badge>{p.type}</Badge> : null) },
  {
    key: "updated",
    header: "Updated",
    width: "9rem",
    skeleton: 0.6,
    render: (p) => (p.updatedAt ? <TimeAgo at={p.updatedAt} /> : <span className="sl-faint">Unknown</span>),
  },
];

/** One store's pages, ordered by slug, a page of results at a time. */
export function MemoryStorePage({ storeId }: { storeId: string }) {
  const stores = useApi<MemoryStoresResponse>("/api/memory/stores");
  const store = stores.data?.stores.find((s) => s.id === storeId) ?? null;
  const [items, setItems] = useState<MemoryPageSummaryView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const moreCtl = useRef<AbortController | null>(null);

  const url = useCallback(
    (c: string | null) => `/api/memory/stores/${encodeURIComponent(storeId)}/pages?limit=${PAGE}${c ? `&cursor=${encodeURIComponent(c)}` : ""}`,
    [storeId],
  );

  useEffect(() => {
    const ctl = new AbortController();
    moreCtl.current?.abort();
    setLoading(true);
    setMore(false);
    setError(null);
    api.get<MemoryPagesResponse>(url(null), { signal: ctl.signal }).then(
      (p) => {
        if (ctl.signal.aborted) return;
        setItems(p.items);
        setCursor(p.nextCursor);
        setLoading(false);
      },
      (e: Error) => {
        if (ctl.signal.aborted || e instanceof AuthRedirectError) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => ctl.abort();
  }, [url, tick]);

  useEffect(() => () => moreCtl.current?.abort(), []);

  const loadMore = async () => {
    if (!cursor) return;
    const ctl = new AbortController();
    moreCtl.current = ctl;
    setMore(true);
    setError(null);
    try {
      const p = await api.get<MemoryPagesResponse>(url(cursor), { signal: ctl.signal });
      if (ctl.signal.aborted) return;
      setItems((xs) => [...xs, ...p.items]);
      setCursor(p.nextCursor);
    } catch (e) {
      if (!ctl.signal.aborted && !(e instanceof AuthRedirectError)) setError(e as Error);
    } finally {
      if (!ctl.signal.aborted) setMore(false);
    }
  };

  const priv = isPrivateStoreId(storeId);
  const back = (
    <Link to="/memory" className="sl-back">
      <IconArrowLeft size={14} />
      Memory
    </Link>
  );

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="sl-title-row">
            <span>{store?.label ?? storeId}</span>
            {store && <KindBadge kind={store.kind} />}
            {priv && <PrivateBadge />}
          </span>
        }
        description={
          <span className="sl-inline">
            <span className="sl-mono">{storeId}</span>
            {store && <span>{`${store.pageCount.toLocaleString()} ${store.pageCount === 1 ? "page" : "pages"}`}</span>}
          </span>
        }
      />
      {error && items.length === 0 ? (
        <MemoryError what="Memory store" error={error} onRetry={() => setTick((t) => t + 1)} />
      ) : (
        <div className="sl-section sl-section--flush">
          <Table
            label={`Pages in ${store?.label ?? storeId}`}
            columns={COLUMNS}
            rows={items}
            rowKey={(p) => p.slug}
            loading={loading}
            skeletonRows={8}
            onRowClick={(p) => navigate(pagePath(storeId, p.slug))}
            empty={<EmptyState title="No pages in this store" description="Pages appear here once an agent saves something to this store." />}
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
      )}
    </>
  );
}
