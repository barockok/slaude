import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentsResponse, ModelSource, SessionActivity, SessionSummaryView, SessionsResponse } from "../../../gateway/panel/api-types";
import { AuthRedirectError } from "../../lib/api";
import { api } from "../client";
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

/** "#team" (or the id when the name is unknown) over "thread 1762506060.000101", or a DM, or no Slack thread at all. */
export function ChannelThread({ channel, label, thread, title }: { channel: string | null; label?: string; thread: string | null; title?: string | null }) {
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
      <span className="sl-inline sl-nowrap" title={label ? channel : undefined}>
        {label ? <span className="sl-truncate">{label}</span> : <span className="sl-mono">{channel}</span>}
        {dm && !label?.startsWith("DM") && <Badge>DM</Badge>}
      </span>
      <span className="sl-caption sl-truncate">{title ?? (thread ? `Thread ${thread}` : "Channel")}</span>
    </span>
  );
}

/** The model a session runs on; where it comes from when it is not the session's own. */
export function ModelName({ effective_model, model_source }: { effective_model: string | null; model_source: ModelSource }) {
  if (model_source === "session" && effective_model) return <span className="sl-mono sl-truncate">{effective_model}</span>;
  if (model_source === "agent" && effective_model) {
    return (
      <span className="sl-mono sl-truncate" title="The agent's configured model">
        {effective_model}
      </span>
    );
  }
  return (
    <span className="sl-faint sl-truncate" title={effective_model ? `SLAUDE_MODEL: ${effective_model}` : "No model is configured; the provider's default applies"}>
      Deployment default
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
      render: (s) => <ChannelThread channel={s.slack_channel_id} label={s.channel_label} thread={s.slack_thread_ts} title={s.title} />,
    },
    { key: "status", header: "Status", width: "8.5rem", skeleton: 0.5, render: (s) => <StatusBadge activity={s.activity} /> },
    { key: "model", header: "Model", width: "15%", skeleton: 0.7, render: (s) => <ModelName effective_model={s.effective_model} model_source={s.model_source} /> },
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

/** Sessions per page; the server's default too. */
export const SESSIONS_PAGE = 50;

/** The sessions list a page at a time: the first page loads whenever `persona` changes, "Load more" appends. */
function useSessionPages(persona: string) {
  const [rows, setRows] = useState<SessionSummaryView[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const moreCtl = useRef<AbortController | null>(null);

  const url = useCallback(
    (offset: number) => {
      const q = new URLSearchParams({ limit: String(SESSIONS_PAGE) });
      if (persona !== "all") q.set("persona", persona);
      if (offset) q.set("offset", String(offset));
      return `/api/sessions?${q}`;
    },
    [persona],
  );

  useEffect(() => {
    moreCtl.current?.abort();
    setMore(false);
    const ctl = new AbortController();
    setLoading(true);
    api.get<SessionsResponse>(url(0), { signal: ctl.signal }).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setRows(r.sessions);
        setNext(r.nextOffset ?? null);
        setError(null);
        setLoaded(true);
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

  const loadMore = useCallback(() => {
    if (next === null) return;
    const ctl = new AbortController();
    moreCtl.current?.abort();
    moreCtl.current = ctl;
    setMore(true);
    api.get<SessionsResponse>(url(next), { signal: ctl.signal }).then(
      (r) => {
        if (ctl.signal.aborted) return;
        // A row that moved up between pages is not listed twice.
        setRows((xs) => {
          const seen = new Set(xs.map((x) => x.id));
          return [...xs, ...r.sessions.filter((x) => !seen.has(x.id))];
        });
        setNext(r.nextOffset ?? null);
        setMore(false);
      },
      (e: Error) => {
        if (ctl.signal.aborted || e instanceof AuthRedirectError) return;
        setError(e);
        setMore(false);
      },
    );
  }, [next, url]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { rows, loading, loaded, more, error, hasMore: next !== null, loadMore, reload };
}

export function SessionsPage() {
  const [agent, setAgent] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const me = useIdentity()?.name ?? null;

  const pages = useSessionPages(agent);
  const agents = useApi<AgentsResponse>("/api/agents");

  const agentOptions: FilterOption<string>[] = [
    { value: "all", label: "All" },
    ...(agents.data?.agents ?? []).map((a) => ({ value: a.name, label: a.name })),
  ];

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Activity is filtered here: the stored status the server filters on is not it.
    const all = pages.rows.filter((s) => status === "all" || s.activity === status);
    if (!needle) return all;
    return all.filter((s) =>
      [s.slack_channel_id, s.channel_label, s.slack_thread_ts, s.title, s.id].some((v) => v?.toLowerCase().includes(needle)),
    );
  }, [pages.rows, query, status]);

  const filtered = agent !== "all" || status !== "all" || query.trim() !== "";
  const clear = () => {
    setAgent("all");
    setStatus("all");
    setQuery("");
  };

  return (
    <>
      <PageHeader title="Sessions" description="Live and recent conversations, with a timeline you can step into." />
      {pages.error && !pages.loaded ? (
        <Card>
          <ErrorState what="Sessions" error={pages.error} onRetry={pages.reload} />
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
            loading={pages.loading && !pages.loaded}
            skeletonRows={6}
            onRowClick={(s) => navigate(sessionPath(s.id))}
            empty={
              filtered ? (
                <EmptyState
                  title="No matching sessions"
                  description={pages.hasMore ? "No loaded session matches these filters. Load more to search older sessions." : "No session matches these filters."}
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
          {pages.error && pages.loaded && (
            <p className="sl-notice is-danger" role="alert">
              Could not load more: {pages.error.message}
            </p>
          )}
          {pages.hasMore && (
            <div className="sl-more">
              <Button onClick={pages.loadMore} loading={pages.more}>
                Load more
              </Button>
              <span className="sl-caption">
                {pages.rows.length} loaded, newest first
              </span>
            </div>
          )}
        </>
      )}
    </>
  );
}
