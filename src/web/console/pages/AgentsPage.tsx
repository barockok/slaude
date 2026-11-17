import { useMemo, useState } from "react";
import type { AgentSummary, AgentsResponse } from "../../../gateway/panel/api-types";
import { navigate } from "../../lib/router";
import { Avatar, Button, Card, EmptyState, PageHeader, SearchField, Table, type Column } from "../../ui";
import { LiveBadge } from "../components/LiveBadge";
import { ErrorState } from "../components/ErrorState";
import { useApi } from "../hooks/useApi";

const COLUMNS: Column<AgentSummary>[] = [
  {
    key: "name",
    header: "Name",
    skeleton: 0.5,
    render: (a) => (
      <span className="sl-identity">
        <Avatar name={a.name} size="sm" />
        <span className="sl-identity__name">{a.name}</span>
      </span>
    ),
  },
  {
    key: "slack",
    header: "Slack user",
    width: "15%",
    skeleton: 0.6,
    render: (a) => (a.slackUserId ? <span className="sl-mono">{a.slackUserId}</span> : <span className="sl-faint">Shared app user</span>),
  },
  {
    key: "model",
    header: "Model",
    width: "18%",
    skeleton: 0.7,
    render: (a) => (a.model ? <span className="sl-mono sl-truncate">{a.model}</span> : <span className="sl-faint">Deployment default</span>),
  },
  { key: "runsOn", header: "Runs on", width: "12%", skeleton: 0.5, render: (a) => <span className="sl-mono">{a.runsOn}</span> },
  { key: "status", header: "Status", width: "9%", skeleton: 0.5, render: (a) => <LiveBadge live={a.live} /> },
  { key: "mandates", header: "Mandates", width: "8%", align: "end", skeleton: 0.3, render: (a) => a.mandateCount },
  { key: "grants", header: "Grants", width: "7%", align: "end", skeleton: 0.3, render: (a) => a.grantCount },
];

export function AgentsPage() {
  const { data, loading, error, reload } = useApi<AgentsResponse>("/api/agents");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = data?.agents ?? [];
    return q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all;
  }, [data, query]);

  return (
    <>
      <PageHeader title="Agents" description="Every agent on this deployment, its mandates and who can reach it." />
      {error && !data ? (
        <Card>
          <ErrorState what="Agents" error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <div className="sl-filter-row">
            <SearchField
              label="Search agents by name"
              placeholder="Search by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Table
            label="Agents"
            columns={COLUMNS}
            rows={rows}
            rowKey={(a) => a.name}
            loading={loading && !data}
            skeletonRows={5}
            onRowClick={(a) => navigate(`/agents/${encodeURIComponent(a.name)}`)}
            empty={
              query ? (
                <EmptyState
                  title="No matching agents"
                  description={`No agent name contains "${query.trim()}".`}
                  action={<Button onClick={() => setQuery("")}>Clear search</Button>}
                />
              ) : (
                <EmptyState
                  title="No agents yet"
                  description="Agents come from your personas repository or the default SOUL.md. Add one there and it appears here after the next sync."
                />
              )
            }
          />
        </>
      )}
    </>
  );
}
