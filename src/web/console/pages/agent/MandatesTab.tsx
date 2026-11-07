import { useLayoutEffect, useRef, useState } from "react";
import type { AgentDetailResponse, MandateView } from "../../../../gateway/panel/api-types";
import { Avatar, Badge, Card, EmptyState } from "../../../ui";
import { TimeAgo } from "../../components/TimeAgo";

const GROUPS: Array<{ kind: MandateView["kind"]; label: string; hint: string }> = [
  { kind: "global", label: "Global", hint: "Applies to every admitted message." },
  { kind: "channel", label: "Channels", hint: "Each channel block in the soul, on top of the global mandate." },
  { kind: "heartbeat", label: "Heartbeat", hint: "What the agent watches on its own between messages." },
  { kind: "cron", label: "Crons", hint: "Scheduled prompts that run on their own." },
];

const SOURCE_LABEL: Record<MandateView["source"], string> = { soul: "Soul", cron: "Cron", proactive: "Proactive" };

/** Slack's `<#C123>` channel reference, shown as `#C123`. */
export const slackText = (s: string) => s.replace(/<#([A-Z0-9]+)(\|[^>]*)?>/g, "#$1");

function Instructions({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);

  return (
    <div className="sl-mandate__instructions">
      <p ref={ref} className={open ? undefined : "is-clamped"}>
        {slackText(text)}
      </p>
      {(overflows || open) && (
        <button type="button" className="sl-link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function Approvers({ m, persona }: { m: MandateView; persona: string }) {
  if (m.approvers.length === 0) {
    if (m.approverNote) return <span className="sl-faint">Falls back to configured approvers or anyone</span>;
    if (persona !== "default") return <Badge tone="warning">Nobody can approve: no manager configured</Badge>;
    return <span className="sl-faint">None</span>;
  }
  return (
    <span className="sl-approvers">
      {m.approvers.map((id) => (
        <span key={id} className="sl-person">
          <Avatar name={id.slice(1)} size="sm" />
          <span className="sl-mono">{id}</span>
        </span>
      ))}
      {m.approverNote && <span className="sl-caption">Scope-matched per request</span>}
    </span>
  );
}

function MandateCard({ m, persona }: { m: MandateView; persona: string }) {
  return (
    <article className="sl-mandate">
      <header className="sl-mandate__head">
        <h3 className="sl-mandate__title">{slackText(m.title)}</h3>
        <span className="sl-mandate__badges">
          {m.proactive && (
            <Badge tone={m.proactive.enabled ? "accent" : "neutral"}>
              {m.proactive.enabled ? `Proactive${m.proactive.highest ? `: up to ${m.proactive.highest}` : ""}` : "Proactive off"}
            </Badge>
          )}
          <Badge>{SOURCE_LABEL[m.source]}</Badge>
        </span>
      </header>

      {m.triggers.length > 0 && (
        <ul className="sl-chips" aria-label="Triggers">
          {m.triggers.map((t) => (
            <li key={t} className="sl-tag">
              {slackText(t)}
            </li>
          ))}
        </ul>
      )}

      {m.inheritsGlobal && <p className="sl-faint">Inherits the global mandate</p>}
      {m.instructions && <Instructions text={m.instructions} />}

      <dl className="sl-mandate__meta">
        {m.kind === "cron" && (
          <>
            <div>
              <dt>Schedule</dt>
              <dd className="sl-mono">{m.schedule ?? "Unknown"}</dd>
            </div>
            <div>
              <dt>Last run</dt>
              <dd>{m.lastRunAt ? <TimeAgo at={m.lastRunAt} /> : <span className="sl-faint">Not run yet</span>}</dd>
            </div>
            {m.channelId && (
              <div>
                <dt>Posts to</dt>
                <dd className="sl-mono">#{m.channelId}</dd>
              </div>
            )}
          </>
        )}
        <div className="sl-mandate__approvers">
          <dt>Approvers</dt>
          <dd>
            <Approvers m={m} persona={persona} />
          </dd>
        </div>
      </dl>
    </article>
  );
}

export function MandatesTab({ agent }: { agent: AgentDetailResponse }) {
  if (agent.mandates.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No mandates"
          description="This agent has no mandate in its SOUL.md, no channel blocks, no heartbeat and no active crons."
        />
      </Card>
    );
  }
  return (
    <div className="sl-groups">
      {GROUPS.map((g) => {
        const items = agent.mandates.filter((m) => m.kind === g.kind);
        if (items.length === 0) return null;
        return (
          <section key={g.kind} className="sl-group" aria-label={g.label}>
            <div className="sl-group__head">
              <h2 className="sl-section__title">
                {g.label} <span className="sl-count">{items.length}</span>
              </h2>
              <p className="sl-caption">{g.hint}</p>
            </div>
            <div className="sl-group__list">
              {items.map((m) => (
                <MandateCard key={m.id} m={m} persona={agent.name} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
