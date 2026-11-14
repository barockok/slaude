import { useEffect, useMemo, useState, type ReactNode } from "react";
import { navigate, useSearch } from "../../../lib/router";
import { Button, Card, EmptyState, FilterChip, SearchField, Table, type Column, type FilterOption } from "../../../ui";
import { ErrorState } from "../../components/ErrorState";
import { usePagedList } from "../../hooks/usePagedList";

const PAGE = 50;

const STATE_OPTIONS: FilterOption<string>[] = [
  { value: "all", label: "All" },
  { value: "declared", label: "Declared" },
  { value: "observed", label: "Observed" },
  { value: "verified", label: "Verified" },
];
const SERVICE_OPTIONS: FilterOption<string>[] = [
  { value: "all", label: "All" },
  { value: "slack", label: "Slack" },
  { value: "email", label: "Email" },
  { value: "oidc", label: "Sign-in" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "telegram", label: "Telegram" },
];

export interface DomainListProps<T> {
  /** Route of the page, e.g. `/users`; filters live in its query string. */
  route: string;
  /** API path without a query, e.g. `/api/users`. */
  endpoint: string;
  label: string;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  searchLabel: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  onRowClick?: (row: T) => void;
}

/** A filtered, paged read-only list of domain records. The filters are in the URL. */
export function DomainList<T>(p: DomainListProps<T>): ReactNode {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const state = params.get("state") ?? "";
  const service = params.get("service") ?? "";
  const q = params.get("q") ?? "";
  const [qDraft, setQDraft] = useState(q);
  useEffect(() => setQDraft(q), [q]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const s = next.toString();
    navigate(s ? `${p.route}?${s}` : p.route, { replace: true });
  };

  // The server matches a value prefix, so query once typing stops.
  useEffect(() => {
    const v = qDraft.trim();
    if (v === q) return;
    const t = setTimeout(() => update({ q: v || null }), 400);
    return () => clearTimeout(t);
  }, [qDraft]);

  const url = useMemo(() => {
    const s = new URLSearchParams();
    if (state) s.set("state", state);
    if (service) s.set("service", service);
    if (q) s.set("q", q);
    s.set("limit", String(PAGE));
    return `${p.endpoint}?${s}`;
  }, [p.endpoint, state, service, q]);

  const list = usePagedList<T>(url);
  const filtered = !!(state || service || q);
  const clearAll = () => {
    setQDraft("");
    navigate(p.route, { replace: true });
  };

  return (
    <>
      <div className="sl-filter-row sl-filter-row--wrap">
        <FilterChip label="State" value={state || "all"} options={STATE_OPTIONS} onChange={(v) => update({ state: v === "all" ? null : v })} />
        <FilterChip label="Service" value={service || "all"} options={SERVICE_OPTIONS} onChange={(v) => update({ service: v === "all" ? null : v })} />
        <SearchField
          label={p.searchLabel}
          placeholder={p.searchPlaceholder}
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") update({ q: qDraft.trim() || null });
          }}
        />
      </div>
      {list.error && list.items.length === 0 ? (
        <Card>
          <ErrorState what={p.label} error={list.error} onRetry={list.reload} />
        </Card>
      ) : (
        <div className="sl-section sl-section--flush">
          <Table
            label={p.label}
            columns={p.columns}
            rows={list.items}
            rowKey={p.rowKey}
            loading={list.loading}
            skeletonRows={8}
            onRowClick={p.onRowClick}
            empty={
              filtered ? (
                <EmptyState
                  title="No matching records"
                  description="Nothing matches these filters."
                  action={<Button onClick={clearAll}>Clear filters</Button>}
                />
              ) : (
                <EmptyState title={p.emptyTitle} description={p.emptyDescription} />
              )
            }
          />
          {list.error && list.items.length > 0 && (
            <p className="sl-form__error" role="alert">
              Could not load more: {list.error.message}
            </p>
          )}
          {list.hasMore && !list.loading && (
            <div className="sl-more">
              <Button onClick={list.loadMore} loading={list.more}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

export const STATE_TONE = { declared: "neutral", observed: "accent", verified: "success" } as const;
export const READ_ONLY_NOTE = "Read only in this release. Resolving conflicts and undoing a merge arrive in a later release.";
