import { useMemo, useState } from "react";
import type { MemoryStoreKind, MemoryStoreView, MemoryStoresResponse } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { navigate } from "../../../lib/router";
import { Button, Card, EmptyState, FilterChip, PageHeader, SearchField, Table, type Column, type FilterOption } from "../../../ui";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { useRole } from "../../hooks/useRole";
import { KIND_LABEL, KindBadge, PrivateBadge, isPrivateKind, storePath } from "./memoryParts";

const COLUMNS: Column<MemoryStoreView>[] = [
  {
    key: "store",
    header: "Store",
    width: "26%",
    skeleton: 0.6,
    render: (s) => <span className="sl-mono sl-truncate">{s.id}</span>,
  },
  { key: "kind", header: "Kind", width: "9.5rem", skeleton: 0.5, render: (s) => <KindBadge kind={s.kind} /> },
  {
    key: "label",
    header: "Agent or label",
    skeleton: 0.7,
    render: (s) => (
      <span className="sl-inline">
        <span>{s.label}</span>
        {isPrivateKind(s.kind) && <PrivateBadge />}
      </span>
    ),
  },
  { key: "pages", header: "Pages", width: "6rem", align: "end", skeleton: 0.3, render: (s) => s.pageCount.toLocaleString() },
];

export function MemoryStoresPage() {
  const { data, loading, error, reload } = useApi<MemoryStoresResponse>("/api/memory/stores");
  const role = useRole();
  const [kind, setKind] = useState<"all" | MemoryStoreKind>("all");
  const [query, setQuery] = useState("");

  const kinds = useMemo(() => [...new Set((data?.stores ?? []).map((s) => s.kind))], [data]);
  const options: FilterOption<"all" | MemoryStoreKind>[] = [
    { value: "all", label: "All" },
    ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] ?? k })),
  ];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.stores ?? []).filter(
      (s) => (kind === "all" || s.kind === kind) && (!q || s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)),
    );
  }, [data, kind, query]);

  const unavailable = error instanceof ApiError && error.status === 503;
  const description =
    role === "operator"
      ? "Browse the memory stores your agents read and write. Personal and profile stores are visible to superadmins only."
      : "Browse the memory stores your agents read and write.";

  return (
    <>
      <PageHeader title="Memory" description={description} />
      {error && !data ? (
        <Card>
          {unavailable ? (
            <EmptyState
              title="Memory is not available here"
              description={`${error.message}. Memory stores live in the agent brain; when it is turned off or runs elsewhere, there is nothing to browse from the console.`}
              action={<Button onClick={reload}>Try again</Button>}
            />
          ) : (
            <ErrorState what="Memory stores" error={error} onRetry={reload} />
          )}
        </Card>
      ) : (
        <>
          <div className="sl-filter-row">
            <FilterChip label="Kind" value={kind} options={options} onChange={setKind} />
            <SearchField label="Search stores" placeholder="Search by store or label" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Table
            label="Memory stores"
            columns={COLUMNS}
            rows={rows}
            rowKey={(s) => s.id}
            loading={loading && !data}
            skeletonRows={6}
            onRowClick={(s) => navigate(storePath(s.id))}
            empty={
              kind !== "all" || query ? (
                <EmptyState
                  title="No matching stores"
                  action={
                    <Button
                      onClick={() => {
                        setKind("all");
                        setQuery("");
                      }}
                    >
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="No memory stores yet"
                  description="A store appears once an agent saves its first page, or when a library is installed."
                />
              )
            }
          />
        </>
      )}
    </>
  );
}
