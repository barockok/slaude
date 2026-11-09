import { useMemo, useState } from "react";
import type { SkillSourceKind, SkillStatus, SkillSummaryView, SkillsResponse } from "../../../../gateway/panel/api-types";
import { navigate } from "../../../lib/router";
import { Button, Card, EmptyState, FilterChip, PageHeader, SearchField, Table, type Column, type FilterOption } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { SOURCE_LABEL, SourceBadge, StatusBadge, agentsText, originLine, skillPath } from "./skillParts";

type SourceFilter = "all" | SkillSourceKind;
type StatusFilter = "all" | SkillStatus;

const SOURCE_OPTIONS: FilterOption<SourceFilter>[] = [
  { value: "all", label: "All" },
  ...(Object.keys(SOURCE_LABEL) as SkillSourceKind[]).map((k) => ({ value: k, label: SOURCE_LABEL[k] })),
];
const STATUS_OPTIONS: FilterOption<StatusFilter>[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "retired", label: "Retired" },
];

function columns(allAgents: readonly string[]): Column<SkillSummaryView>[] {
  return [
    {
      key: "skill",
      header: "Skill",
      width: "30%",
      skeleton: 0.7,
      render: (s) => (
        <span className="sl-stack">
          <span className="sl-truncate sl-strong">{s.name}</span>
          <span className="sl-caption sl-truncate" title={s.description}>
            {s.description || <span className="sl-faint">No description</span>}
          </span>
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      width: "16%",
      skeleton: 0.5,
      render: (s) => (
        <span className="sl-stack">
          <SourceBadge source={s.source} />
          <span className="sl-caption sl-truncate sl-mono" title={originLine(s)}>
            {originLine(s)}
          </span>
        </span>
      ),
    },
    { key: "agents", header: "Agents", width: "18%", skeleton: 0.5, render: (s) => <span className="sl-truncate">{agentsText(s, allAgents)}</span> },
    {
      key: "usage",
      header: "Uses",
      width: "14%",
      skeleton: 0.4,
      render: (s) => (
        <span className="sl-stack">
          <span>{s.usage.uses.toLocaleString()}</span>
          <span className="sl-caption">{s.usage.lastUsedAt ? <TimeAgo at={s.usage.lastUsedAt} /> : "Never used"}</span>
        </span>
      ),
    },
    { key: "version", header: "Version", width: "6rem", skeleton: 0.3, render: (s) => (s.currentVersion !== null ? <span className="sl-mono" title={s.status === "retired" ? "Version when retired" : undefined}>v{s.currentVersion}</span> : <span className="sl-faint">None</span>) },
    { key: "status", header: "Status", width: "8rem", skeleton: 0.4, render: (s) => <StatusBadge status={s.status} /> },
  ];
}

export function SkillsPage() {
  const { data, loading, error, reload } = useApi<SkillsResponse>("/api/skills");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [agent, setAgent] = useState("all");
  const [query, setQuery] = useState("");

  const allAgents = useMemo(() => [...new Set((data?.skills ?? []).flatMap((s) => s.agents))].sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b))), [data]);
  const agentOptions: FilterOption<string>[] = [{ value: "all", label: "All" }, ...allAgents.map((a) => ({ value: a, label: a }))];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.skills ?? []).filter(
      (s) =>
        (source === "all" || s.source === source) &&
        (status === "all" || s.status === status) &&
        (agent === "all" || s.agents.includes(agent) || (s.status === "retired" && s.origin.authoredBy === agent)) &&
        (!q || [s.name, s.slug, s.description, s.invocation].some((t) => t.toLowerCase().includes(q))),
    );
  }, [data, source, status, agent, query]);

  const filtered = source !== "all" || status !== "all" || agent !== "all" || !!query;
  const clear = () => {
    setSource("all");
    setStatus("all");
    setAgent("all");
    setQuery("");
  };

  return (
    <>
      <PageHeader title="Skills" description="Every skill your agents can use: where it came from, which agents have it, and how often they use it." />
      {error && !data ? (
        <Card>
          <ErrorState what="Skills" error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          {data && data.notes.length > 0 && (
            <div className="sl-notice" role="status">
              {data.notes.map((n) => (
                <p key={n}>{n}</p>
              ))}
            </div>
          )}
          <div className="sl-filter-row">
            <FilterChip label="Source" value={source} options={SOURCE_OPTIONS} onChange={setSource} />
            <FilterChip label="Agent" value={agent} options={agentOptions} onChange={setAgent} />
            <FilterChip label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
            <SearchField label="Search skills" placeholder="Search by name or description" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Table
            label="Skills"
            columns={columns(allAgents)}
            rows={rows}
            rowKey={(s) => s.id}
            loading={loading && !data}
            skeletonRows={6}
            onRowClick={(s) => navigate(skillPath(s.id))}
            empty={
              filtered ? (
                <EmptyState title="No matching skills" action={<Button onClick={clear}>Clear filters</Button>} />
              ) : (
                <EmptyState title="No skills yet" description="Skills come from the dependency manifest, plugins, slaude itself, and what agents write for themselves." />
              )
            }
          />
        </>
      )}
    </>
  );
}
