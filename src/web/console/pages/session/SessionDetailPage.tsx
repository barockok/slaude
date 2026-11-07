import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEventView, AuditPageResponse, SessionDetailResponse, SessionRowView, SessionUsageSnapshot } from "../../../../gateway/panel/api-types";
import { Link, navigate } from "../../../lib/router";
import { useIdentity } from "../../../shared/AppFrame";
import { Avatar, Badge, Button, Card, EmptyState, IconArrowLeft, Skeleton, Tabs } from "../../../ui";
import { api } from "../../client";
import { AuditDrawer } from "../../components/AuditDrawer";
import { AuditTable } from "../../components/AuditTable";
import { ErrorState } from "../../components/ErrorState";
import { TimeAgo } from "../../../shared/TimeAgo";
import { useApi } from "../../hooks/useApi";
import { useAuditPages } from "../../hooks/useAuditPages";
import { useRole } from "../../hooks/useRole";
import { auditHref, sessionPath } from "../../lib/format";
import { StatusBadge } from "../SessionsPage";
import { ChatTab } from "./ChatTab";
import { ControlBar } from "./ControlBar";
import { StreamIndicator, TimelineTab } from "./TimelineTab";
import { buildItems, contextLabel, historyItems, latestUsage, sessionActivityNow, tailUsers, turnRunning, type OperatorMessage } from "./timeline-model";
import { SlackUsersProvider } from "../../components/SlackText";
import { ModelName } from "../SessionsPage";
import { useSessionEvents } from "./useSessionEvents";
import { useSessionHistory } from "./useSessionHistory";
import { useSessionLock } from "./useSessionLock";

export const SESSION_TABS = ["timeline", "chat", "audit"] as const;
export type SessionTab = (typeof SESSION_TABS)[number];
const TAB_LABEL: Record<SessionTab, string> = { timeline: "Timeline", chat: "Chat", audit: "Audit" };

export function isSessionTab(t: string | undefined): t is SessionTab {
  return !!t && (SESSION_TABS as readonly string[]).includes(t);
}

const REFRESH_MS = 20_000;
/** Operator messages kept on the page, like the event tail's cap. */
const SENT_KEEP = 200;

function SessionAudit({ sessionId }: { sessionId: string }) {
  const pages = useAuditPages(`/api/sessions/${encodeURIComponent(sessionId)}/audit?limit=25`);
  const [open, setOpen] = useState<AuditEventView | null>(null);
  if (pages.error && pages.items.length === 0) return <ErrorState what="Session audit" error={pages.error} onRetry={pages.reload} />;
  return (
    <div className="sl-section sl-section--flush">
      <AuditTable
        label="Audit events for this session"
        rows={pages.items}
        loading={pages.loading}
        skeletonRows={5}
        onRowClick={setOpen}
        empty={
          <EmptyState
            title="Nothing recorded for this session"
            description="Tool permission decisions, approvals and console actions on this session show up here."
          />
        }
      />
      {pages.hasMore && !pages.loading && (
        <div className="sl-more">
          <Button onClick={pages.loadMore} loading={pages.more}>
            Load more
          </Button>
        </div>
      )}
      {!pages.loading && pages.items.length > 0 && (
        <p className="sl-more">
          <Link className="sl-link" to={auditHref({ session: sessionId })}>
            Open in Approvals and audit
          </Link>
        </p>
      )}
      <AuditDrawer event={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function ContextMeter({ usage }: { usage: SessionUsageSnapshot }) {
  return (
    <span className="sl-caption sl-tl-toolbar__end" title={`${usage.totalInput.toLocaleString("en-US")} of ${usage.contextWindow.toLocaleString("en-US")} tokens`}>
      {contextLabel(usage)}
    </span>
  );
}

function HeaderSkeleton() {
  return (
    <div className="sl-detail-skeleton" aria-busy="true" aria-label="Loading session">
      <Skeleton width="16rem" height="2rem" />
      <Skeleton width="24rem" height="1rem" />
      <Skeleton width="100%" height="20rem" radius="var(--sl-radius-panel)" />
    </div>
  );
}

export function SessionDetailPage({ id, tab }: { id: string; tab: SessionTab }) {
  const { data, error, reload } = useApi<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
  const me = useIdentity()?.name ?? null;
  const role = useRole();
  const isSuper = role === "superadmin";
  const [session, setSession] = useState<SessionRowView | null>(null);
  const [sent, setSent] = useState<OperatorMessage[]>([]);
  const [gates, setGates] = useState<AuditEventView[]>([]);
  const events = useSessionEvents(id);
  const history = useSessionHistory(id);
  const lock = useSessionLock(id, data ? data.panel_locked_by ?? null : undefined, me);

  useEffect(() => {
    if (data) setSession(data.session);
  }, [data]);

  // Keep the header and the lock owner fresh while nobody here holds the lock.
  useEffect(() => {
    if (lock.mine) return;
    const t = setInterval(reload, REFRESH_MS);
    return () => clearInterval(t);
  }, [reload, lock.mine]);

  // Gate decisions on this session come from the audit trail, not the live
  // tail: load them now and again after each turn ends.
  useEffect(() => {
    const ctl = new AbortController();
    api.get<AuditPageResponse>(`/api/sessions/${encodeURIComponent(id)}/audit?limit=100`, { signal: ctl.signal }).then(
      (p) => !ctl.signal.aborted && setGates(p.items.filter((e) => e.action.startsWith("gate."))),
      () => undefined,
    );
    return () => ctl.abort();
  }, [id, events.turnsEnded]);

  // A turn ended: the status in the header has likely changed.
  useEffect(() => {
    if (events.turnsEnded > 0) reload();
  }, [events.turnsEnded, reload]);

  const persona = session?.persona_id ?? "agent";
  const items = useMemo(() => buildItems(events.entries, gates, sent, persona), [events.entries, gates, sent, persona]);
  const chat = useMemo(() => items.filter((i): i is Extract<typeof i, { kind: "text" }> => i.kind === "text"), [items]);
  const earlier = useMemo(() => historyItems(history.items, persona), [history.items, persona]);
  const users = useMemo(() => ({ ...history.users, ...tailUsers(events.entries) }), [history.users, events.entries]);
  const usage = latestUsage(events.entries);
  const activity = sessionActivityNow(data, turnRunning(events.entries));

  const onSent = useCallback(
    (text: string) =>
      setSent((xs) => [...xs.slice(-(SENT_KEEP - 1)), { id: `op-${Date.now()}-${xs.length}`, at: Date.now(), text, by: me ?? "You" }]),
    [me],
  );

  const back = (
    <Link to="/sessions" className="sl-back">
      <IconArrowLeft size={14} />
      Sessions
    </Link>
  );

  if (error && !data) {
    return (
      <>
        <div className="sl-page-header">
          <div className="sl-page-header__text">
            <div className="sl-page-header__back">{back}</div>
          </div>
        </div>
        <Card>
          <ErrorState what="Session" error={error} onRetry={reload} />
        </Card>
      </>
    );
  }

  if (!session) {
    return (
      <>
        <div className="sl-page-header__back">{back}</div>
        <HeaderSkeleton />
      </>
    );
  }

  const channel = data?.channel_label ?? session.slack_channel_id;
  const where = session.slack_channel_id
    ? `${channel}${session.slack_thread_ts ? `, thread ${session.slack_thread_ts}` : ""}`
    : "No Slack thread";
  // A model set from the console lands in `session`; otherwise what the server resolved.
  const model = session.model
    ? { effective_model: session.model, model_source: "session" as const }
    : { effective_model: data?.effective_model ?? null, model_source: data?.model_source ?? ("deployment" as const) };

  return (
    <>
      <header className="sl-page-header sl-session-head">
        <div className="sl-page-header__text">
          <div className="sl-page-header__back">{back}</div>
          <h1 className="sl-page-header__title">
            <span className="sl-title-row">
              <Avatar name={session.persona_id} />
              <span className="sl-break">{session.title ?? (session.slack_channel_id ? `${session.persona_id} in ${channel}` : `${session.persona_id} session`)}</span>
              <StatusBadge activity={activity} />
            </span>
          </h1>
          <p className="sl-page-header__desc sl-session-meta">
            <span>
              Agent{" "}
              <Link className="sl-link" to={`/agents/${encodeURIComponent(session.persona_id)}`}>
                {session.persona_id}
              </Link>
            </span>
            <span className="sl-mono" title={data?.channel_label ? session.slack_channel_id ?? undefined : undefined}>{where}</span>
            <ModelName {...model} />
            <span>
              Active <TimeAgo at={session.updated_at} />
            </span>
          </p>
        </div>
        <div className="sl-page-header__actions">
          <ControlBar
            session={session}
            isSuperadmin={isSuper}
            onChanged={(s) => {
              if (s) setSession(s);
              else reload();
            }}
          />
        </div>
      </header>

      <Tabs
        label="Session sections"
        tabs={SESSION_TABS.map((t) => ({
          value: t,
          label:
            t === "chat" && lock.owner ? (
              <span className="sl-inline">
                Chat <Badge tone={lock.mine ? "accent" : "warning"}>{lock.mine ? "You" : "Locked"}</Badge>
              </span>
            ) : (
              TAB_LABEL[t]
            ),
        }))}
        value={tab}
        onChange={(t) => navigate(sessionPath(id, t), { inPage: true })}
      >
        {tab !== "audit" && (
          <div className="sl-tl-toolbar">
            <StreamIndicator status={events.status} />
            <span className="sl-caption">
              {events.entries.length} {events.entries.length === 1 ? "event" : "events"} since you opened this page
            </span>
            {usage && <ContextMeter usage={usage} />}
          </div>
        )}
        <SlackUsersProvider users={users}>
        {tab === "timeline" ? (
          <TimelineTab items={items} earlier={earlier} history={history} status={events.status} detail={events.detail} />
        ) : tab === "chat" ? (
          <ChatTab sessionId={id} messages={chat} earlier={earlier} history={history} lock={lock} isSuperadmin={isSuper} onSent={onSent} />
        ) : (
          <SessionAudit sessionId={id} />
        )}
        </SlackUsersProvider>
      </Tabs>
    </>
  );
}
