import type { AuditEventView } from "../../../gateway/panel/api-types";
import { Link } from "../../lib/router";
import { Badge, CodeBlock, KeyValue } from "../../ui";
import { ACTOR_KIND_LABEL, absoluteTime, actionLabel, decisionLabel, decisionTone, relativeTime, sessionPath } from "../lib/format";
import { Drawer } from "./Drawer";

const none = <span className="sl-faint">None</span>;

/** Every field of one audit event, with links to its session and agent. */
export function AuditDrawer({ event, onClose }: { event: AuditEventView | null; onClose: () => void }) {
  const e = event;
  return (
    <Drawer open={!!e} onClose={onClose} title={e ? actionLabel(e.action) : ""} description={e?.summary || undefined}>
      {e && (
        <div className="sl-stack-lg">
          <KeyValue
            className="sl-kv--compact"
            items={[
              {
                key: "at",
                label: "Time",
                value: (
                  <span className="sl-stack">
                    <span>{absoluteTime(e.at)}</span>
                    <span className="sl-caption">{relativeTime(e.at)}</span>
                  </span>
                ),
              },
              {
                key: "agent",
                label: "Agent",
                value: e.persona ? (
                  <Link className="sl-link" to={`/agents/${encodeURIComponent(e.persona)}`}>
                    {e.persona}
                  </Link>
                ) : (
                  none
                ),
              },
              {
                key: "actor",
                label: "Actor",
                value: (
                  <span className="sl-stack">
                    <span className="sl-mono sl-break">{e.actorId}</span>
                    <span className="sl-caption">{ACTOR_KIND_LABEL[e.actorKind] ?? e.actorKind}</span>
                  </span>
                ),
              },
              { key: "action", label: "Action", value: <span className="sl-mono sl-break">{e.action}</span> },
              {
                key: "target",
                label: "Target",
                value: e.targetId ? (
                  <span className="sl-stack">
                    <span className="sl-mono sl-break">{e.targetId}</span>
                    {e.targetKind && <span className="sl-caption">{e.targetKind.replace(/_/g, " ")}</span>}
                  </span>
                ) : (
                  none
                ),
              },
              {
                key: "decision",
                label: "Decision",
                value: e.decision ? <Badge tone={decisionTone(e.decision)}>{decisionLabel(e.decision)}</Badge> : none,
              },
              {
                key: "session",
                label: "Session",
                value: e.sessionId ? (
                  <Link className="sl-link sl-mono" to={sessionPath(e.sessionId)}>
                    {e.sessionId}
                  </Link>
                ) : (
                  none
                ),
              },
              { key: "channel", label: "Channel", value: e.channelId ? <span className="sl-mono">{e.channelId}</span> : none },
              ...(e.threadTs ? [{ key: "thread", label: "Thread", value: <span className="sl-mono">{e.threadTs}</span> }] : []),
              { key: "id", label: "Event id", value: <span className="sl-mono sl-break">{e.id}</span> },
            ]}
          />
          <div className="sl-stack">
            <h3 className="sl-subhead">Details</h3>
            <p className="sl-caption">Secret values are redacted before an event is stored.</p>
            <CodeBlock language="json" code={JSON.stringify(e.details ?? {}, null, 2)} className="sl-code--wrap" />
          </div>
        </div>
      )}
    </Drawer>
  );
}
