import { useMemo, useState } from "react";
import type { AgentsResponse, SessionActivity, SessionSummaryView, SessionsResponse } from "../../../gateway/panel/api-types";
import { navigate } from "../../lib/router";
import {
  Avatar, Badge, Button, Card, EmptyState, FilterChip, IconLock, PageHeader, SearchField, Table, type Column, type FilterOption,
} from "../../ui";
import { ErrorState } from "../components/ErrorState";
import { TimeAgo } from "../../shared/TimeAgo";
import { useApi } from "../hooks/useApi";
import { useIdentity } from "../../shared/AppFrame";
import { sessionActivity, sessionPath } from "../lib/format";

type StatusFilter = "all" | SessionActivity;

const STATUS_OPTIONS: FilterOption<StatusFilter>[] = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "warm", label: "Warm" },
  { value: "idle", label: "Idle" },
  { value: "error", label: "Error" },
];

/** "CTEAM" over "thread 1762506060.000101", or a DM, or no Slack thread at all. */
export function ChannelThread({ channel, thread, title }: { channel: string | null; thread: string | null; title?: string | null }) {
  if (!channel) {
    return (
      <span className="sl-stack">
        <span className="sl-faint">No Slack thread</span>
        {title && <span className="sl-caption sl-truncate">{title}</span>}
      </span>
    );
  }
  const dm = channel.startsWith("D");
  return (
    <span className="sl-stack">
      <span className="sl-inline sl-nowrap">
        <span className="sl-mono">{channel}</span>
        {dm && <Badge>DM</Badge>}
      </span>
      <span className="sl-caption sl-truncate">{title ?? (thread ? `Thread ${thread}` : "Channel")}</span>
    </span>
  );
}

/** What a session is doing now: Working, Warm, Idle or Error (never the stored status). */
export function StatusBadge({ activity }: { activity: string }) {
  const s = sessionActivity(activity);
  return (
    <span title={s.hint || undefined}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

function columns(me: string | null): Column<SessionSummaryView>[] {
  return [
    {
      key: "agent",
      header: "Agent",
      width: "14%",
      skeleton: 0.6,
      render: (s) => (
        <span className="sl-identity">
          <Avatar name={s.persona_id} size="sm" />
          <span className="sl-identity__name">{s.persona_id}</span>
        </span>
      ),
    },
    {
      key: "where",
      header: "Channel and thread",
      skeleton: 0.7,
      render: (s) => <ChannelThread channel={s.slack_channel_id} thread={s.slack_thread_ts} title={s.title} />,
    },
    { key: "status", header: "Status", width: "8.5rem", skeleton: 0.5, render: (s) => <StatusBadge activity={s.activity} /> },
    { key: "model", header: "Model", width: "15%", skeleton: 0.7, render: (s) => <span className="sl-mono sl-truncate">{s.model}</span> },
    { key: "activity", header: "Last activity", width: "9rem", skeleton: 0.6, render: (s) => <TimeAgo at={s.updated_at} /> },
    {
      key: "locked",
      header: "Locked by",
      width: "16%",
      skeleton: 0.5,
      render: (s) =>
        s.panel_locked_by ? (
          <span className="sl-inline sl-nowrap" title="Driven from the console; Slack is paused for this thread">
            <IconLock size={14} className="sl-faint" />
            <span className="sl-truncate">{s.panel_locked_by === me ? "You" : s.panel_locked_by}</span>
          </span>
        ) : (
          <span className="sl-faint">None</span>
        ),
    },
  ];
}

export function SessionsPage() {
  const [agent, setAgent] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const me = useIdentity()?.name ?? null;

  const q = new URLSearchParams();
  if (agent !== "all") q.set("persona", agent);
  q.set("limit", "200");
  const { data, loading, error, reload } = useApi<SessionsResponse>(`/api/sessions?${q}`);
  const agents = useApi<AgentsResponse>("/api/agents");

  const agentOptions: FilterOption<string>[] = [
    { value: "all", label: "All" },
    ...(agents.data?.agents ?? []).map((a) => ({ value: a.name, label: a.name })),
  ];

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Activity is filtered here: the stored status the server filters on is not it.
    const all = (data?.sessions ?? []).filter((s) => status === "all" || s.activity === status);
    if (!needle) return all;
    return all.filter((s) =>
      [s.slack_channel_id, s.slack_thread_ts, s.title, s.id].some((v) => v?.toLowerCase().includes(needle)),
    );
  }, [data, query, status]);

  const filtered = agent !== "all" || status !== "all" || query.trim() !== "";
  const clear = () => {
    setAgent("all");
    setStatus("all");
    setQuery("");
  };

  return (
    <>
      <PageHeader title="Sessions" description="Live and recent conversations, with a timeline you can step into." />
      {error && !data ? (
        <Card>
          <ErrorState what="Sessions" error={error} onRetry={reload} />
        </Card>
      ) : (
        <>
          <div className="sl-filter-row">
            <FilterChip label="Agent" value={agent} options={agentOptions} onChange={setAgent} />
            <FilterChip label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
            <SearchField
              label="Search sessions by channel or thread"
              placeholder="Search by channel or thread"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Table
            label="Sessions"
            className="sl-sessions-table"
            columns={columns(me)}
            rows={rows}
            rowKey={(s) => s.id}
            loading={loading && !data}
            skeletonRows={6}
            onRowClick={(s) => navigate(sessionPath(s.id))}
            empty={
              filtered ? (
                <EmptyState
                  title="No matching sessions"
                  description="No session matches these filters."
                  action={<Button onClick={clear}>Clear filters</Button>}
                />
              ) : (
                <EmptyState
                  title="No sessions yet"
                  description="A session starts when someone talks to an agent in Slack. It shows up here with its live timeline."
                />
              )
            }
          />
        </>
      )}
    </>
  );
}
