import type { ReactNode } from "react";
import type { GuardrailThreatModel, NamedChannel, OwnerGuardrailRule, OwnerGuardrailSource, OwnerGuardrailSummary } from "../../../../gateway/panel/api-types";
import { Link } from "../../../lib/router";
import { Badge, type BadgeTone } from "../../../ui";
import { CONSOLE_GUARDRAIL_PAGES } from "./guardrailPages";

/** A guardrail's console page; one named like a console page is reached under /guardrails/~/. */
export const guardrailPath = (slug: string) =>
  CONSOLE_GUARDRAIL_PAGES.has(slug) ? `/guardrails/~/${encodeURIComponent(slug)}` : `/guardrails/${encodeURIComponent(slug)}`;

const SOURCE: Record<OwnerGuardrailSource, { label: string; hint: string }> = {
  git: { label: "Deploy repo", hint: "From the deploy repo's guardrails/ folder, synced by /deploy" },
  file: { label: "Host file", hint: "Imported from host files with slaude guardrails import" },
  console: { label: "Console", hint: "Written in the console" },
};

export function GuardrailSourceBadges({ g }: { g: Pick<OwnerGuardrailSummary, "source" | "override" | "behindSource"> }) {
  const s = SOURCE[g.source] ?? { label: g.source, hint: "" };
  return (
    <span className="sl-gr-badges">
      <span title={s.hint}>
        <Badge>{s.label}</Badge>
      </span>
      {g.override && (
        <span title="A console override replaces the source text">
          <Badge tone="accent">Console override</Badge>
        </span>
      )}
      {g.behindSource && (
        <span title="The source changed after the override was written; the override is kept">
          <Badge tone="warning">Behind source</Badge>
        </span>
      )}
    </span>
  );
}

/** On, Off, or why it does not apply. */
export function GuardrailStatus({ g }: { g: OwnerGuardrailSummary }) {
  const badges: Array<{ label: string; tone: BadgeTone; hint: string }> = [];
  if (!g.enabled) badges.push({ label: "Off", tone: "neutral", hint: "Switched off in the console" });
  else if (!g.authorEnabled && g.scope !== null) badges.push({ label: "Off", tone: "neutral", hint: "Its frontmatter says enabled: false" });
  else if (g.scope === null) badges.push({ label: "Unreadable", tone: "danger", hint: "Its frontmatter could not be read, so it applies to nobody" });
  else badges.push({ label: "On", tone: "success", hint: "Applies where its scope says" });
  if (g.errorCount > 0) badges.push({ label: `${g.errorCount} ${g.errorCount === 1 ? "problem" : "problems"}`, tone: "warning", hint: "Validation errors: its valid rules and prose still apply" });
  if (g.appliesToNoAgent) badges.push({ label: "Applies to no agent", tone: "warning", hint: "No agent of this deployment matches its scope" });
  if (g.skippedFor.length) badges.push({ label: "Over the prose cap", tone: "warning", hint: `Left out of the prompt for ${g.skippedFor.join(", ")}` });
  return (
    <span className="sl-gr-badges">
      {badges.map((b) => (
        <span key={b.label} title={b.hint}>
          <Badge tone={b.tone}>{b.label}</Badge>
        </span>
      ))}
    </span>
  );
}

/** Enforced rule counts, and the Guidance label. */
export function RuleCounts({ g }: { g: OwnerGuardrailSummary }) {
  const enforced = g.ruleCounts.tool + g.ruleCounts.inbound + g.ruleCounts.reply;
  const parts: ReactNode[] = [];
  if (enforced) {
    parts.push(
      <span key="e" title={`${g.ruleCounts.tool} tool, ${g.ruleCounts.reply} reply, ${g.ruleCounts.inbound} inbound`}>
        <Badge tone="success">{`Enforced: ${enforced}`}</Badge>
      </span>,
    );
  }
  if (g.guidance) {
    parts.push(
      <span key="g" title={g.load === "on-match" ? "Advisory prose, given to the model once per session when a trigger matches" : "Advisory prose, in the system prompt"}>
        <Badge tone="accent">{g.load === "on-match" ? "Guidance (on match)" : "Guidance"}</Badge>
      </span>,
    );
  }
  return parts.length ? <span className="sl-gr-badges">{parts}</span> : <span className="sl-faint">Nothing</span>;
}

export function channelText(c: NamedChannel): string {
  return c.label ?? c.id;
}

/** Shared, or the agents it names; then the channels it is limited to. */
export function AppliesTo({ g }: { g: OwnerGuardrailSummary }) {
  return (
    <span className="sl-stack">
      {g.scope === "shared" ? (
        <span>Every agent</span>
      ) : g.scope === "agents" ? (
        <ul className="sl-chips">
          {g.agents.map((a) => (
            <li key={a} className="sl-tag" title={g.unknownAgents.includes(a) ? "No agent of this deployment has this name" : undefined}>
              {g.unknownAgents.includes(a) ? <span className="sl-faint">{a}</span> : <Link to={`/agents/${encodeURIComponent(a)}`}>{a}</Link>}
            </li>
          ))}
        </ul>
      ) : (
        <span className="sl-faint">Nobody (unreadable)</span>
      )}
      {g.channels.length > 0 && <span className="sl-caption">{`Only in ${g.channels.map(channelText).join(", ")}`}</span>}
    </span>
  );
}

export function RuleStatusBadge({ r }: { r: OwnerGuardrailRule }) {
  // An rc.9 gateway still reports reply rules as pending.
  if (r.status === "pending") {
    return (
      <span title="Stored and shown; this gateway does not enforce it yet">
        <Badge tone="warning">Not yet enforced</Badge>
      </span>
    );
  }
  const title =
    r.action === "approve"
      ? "Held on an approval card for the requester or an approver; a timeout, a wake or no approver is a deny"
      : "Checked by code on every event; never in the prompt";
  return (
    <span title={title}>
      <Badge tone="success">Enforced</Badge>
    </span>
  );
}

/** How strongly an agent is kept from changing its own guardrails here. */
export function ThreatModelNote({ t }: { t: GuardrailThreatModel }) {
  if (t.strong) {
    return (
      <p className="sl-caption">
        {t.db === "pg" ? "Stored in Postgres" : "Turns run on nodes"}: a session cannot reach the database, so an agent cannot change its own guardrails. Every stored guardrail is signed and checked when a session starts.
      </p>
    );
  }
  return (
    <p className="sl-notice is-warning" role="note">
      This deployment runs in one process on the sqlite database under $SLAUDE_HOME. A session's shell can reach that file: guardrails are protected against drift and accidental edits, and tampering is detected (sessions refuse to start), but an adversarial agent could still stop its own sessions from starting. Use Postgres or nodes for the stronger guarantee.
    </p>
  );
}
