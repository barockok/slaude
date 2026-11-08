import { useState } from "react";
import type { GuardrailWriteError, GuardrailWriteResponse, OwnerGuardrailDetail, OwnerGuardrailRule, OwnerGuardrailToggleResponse } from "../../../../gateway/panel/api-types";
import { ApiError } from "../../../lib/api";
import { Link, navigate } from "../../../lib/router";
import { Badge, Button, Card, Dialog, EmptyState, IconArrowLeft, KeyValue, Markdown, PageHeader, Skeleton, useToast } from "../../../ui";
import { TimeAgo } from "../../../shared/TimeAgo";
import { api } from "../../client";
import { ErrorState } from "../../components/ErrorState";
import { useApi } from "../../hooks/useApi";
import { channelText, guardrailPath, GuardrailSourceBadges, GuardrailStatus, RuleStatusBadge, ThreatModelNote } from "./guardrailParts";
import { GuardrailTestBox } from "./GuardrailTestBox";
import { lineDiff } from "../../lib/line-diff";

const ON: Record<OwnerGuardrailRule["on"], string> = { tool: "Tool call", reply: "Reply", inbound: "Inbound message" };
const ACTION: Record<OwnerGuardrailRule["action"], string> = { deny: "Deny", approve: "Needs approval", redact: "Redact", audit: "Record only" };

function matchText(r: OwnerGuardrailRule): string {
  if (r.on === "tool") {
    const input = r.input === undefined ? "" : typeof r.input === "string" ? ` with any input value matching ${r.input}` : ` with ${Object.entries(r.input).map(([k, v]) => `${k} matching ${v}`).join(", ")}`;
    return `${(r.tool ?? []).join(" or ")}${input}`;
  }
  return r.text ?? "";
}

const FIRING: Record<string, string> = {
  "guardrail.tool.denied": "Denied a tool call",
  "guardrail.tool.audited": "Recorded a tool call",
  "guardrail.inbound.denied": "Denied a message",
  "guardrail.inbound.audited": "Recorded a message",
  "guardrail.guidance.delivered": "Guidance given",
  "guardrail.tool.approved": "Approved a held tool call",
  "guardrail.tool.refused": "Refused a held tool call",
  "guardrail.reply.denied": "Denied a reply",
  "guardrail.reply.held": "Held a reply",
  "guardrail.reply.redacted": "Redacted a reply",
  "guardrail.reply.audited": "Recorded a reply",
};

function Rules({ d }: { d: OwnerGuardrailDetail }) {
  return (
    <Card
      title="Rules"
      description="Checked by code on every event, never put in the prompt. The model sees only the outcome."
      flush={d.rules.length > 0}
    >
      {d.rules.length === 0 ? (
        <EmptyState title="No rules" description="This guardrail is Guidance only." />
      ) : (
        <div className="sl-scroll-x" tabIndex={0}>
          <table className="sl-simple-table sl-gr-table" aria-label="Rules">
            <thead>
              <tr>
                <th>Rule</th>
                <th>On</th>
                <th>Matches</th>
                <th>Action</th>
                <th>Message</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.rules.map((r) => (
                <tr key={r.id}>
                  <td className="sl-mono">{r.id}</td>
                  <td>{ON[r.on]}</td>
                  <td className="sl-mono sl-break">{matchText(r)}</td>
                  <td>{ACTION[r.action]}</td>
                  <td className="sl-break">{r.message || <span className="sl-faint">Default message</span>}</td>
                  <td>
                    <RuleStatusBadge r={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Guidance({ d }: { d: OwnerGuardrailDetail }) {
  return (
    <Card
      title={
        <span className="sl-title-row">
          <span>Guidance</span>
          <Badge tone="accent">Advisory</Badge>
        </span>
      }
      description={
        d.load === "on-match"
          ? "Given to the model once per session, the first time a trigger matches. Only its name and description are in the prompt until then."
          : "In the system prompt of every session it applies to, right after the soul. The model is asked to follow it; nothing in code enforces prose."
      }
    >
      {d.prose ? <Markdown source={d.prose} copyLabel="Copy Guidance" /> : <span className="sl-faint">No Guidance text.</span>}
      {d.triggers && (
        <KeyValue
          className="sl-kv--compact"
          items={[
            { key: "tool", label: "Tool trigger", value: d.triggers.tool.length ? <span className="sl-mono sl-break">{d.triggers.tool.join(", ")}</span> : <span className="sl-faint">None</span> },
            { key: "inbound", label: "Message trigger", value: d.triggers.inbound ? <span className="sl-mono sl-break">{d.triggers.inbound}</span> : <span className="sl-faint">None</span> },
            ...(d.triggers.channels.length ? [{ key: "ch", label: "Trigger channels", value: d.triggers.channels.map(channelText).join(", ") }] : []),
          ]}
        />
      )}
    </Card>
  );
}

function Firings({ d }: { d: OwnerGuardrailDetail }) {
  return (
    <Card title="Recent firings" description={d.firings.length ? "The latest 20, from the audit trail. Never the tool input or the message text." : "It has not fired yet."} flush={d.firings.length > 0}>
      {d.firings.length > 0 && (
        <div className="sl-scroll-x" tabIndex={0}>
          <table className="sl-simple-table" aria-label="Recent firings">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Rule</th>
                <th>Agent</th>
                <th>Channel</th>
              </tr>
            </thead>
            <tbody>
              {d.firings.map((f) => (
                <tr key={f.id}>
                  <td>
                    <TimeAgo at={f.at} />
                  </td>
                  <td>{FIRING[f.action] ?? f.action}</td>
                  <td className="sl-mono">{f.ruleId ?? <span className="sl-faint">None</span>}</td>
                  <td>{f.agent ?? <span className="sl-faint">None</span>}</td>
                  <td>{f.channel ? channelText(f.channel) : <span className="sl-faint">None</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Switch({ d, reload }: { d: OwnerGuardrailDetail; reload: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = !d.enabled;
  const act = async () => {
    setBusy(true);
    try {
      await api.put<OwnerGuardrailToggleResponse>(`/api/guardrails/${encodeURIComponent(d.slug)}/enabled`, { enabled: next });
      toast({ tone: "success", title: next ? "Guardrail on" : "Guardrail off", description: `${d.name} ${next ? "applies again" : "no longer applies"} from each agent's next turn.` });
      setConfirm(false);
      reload();
    } catch (e) {
      toast({ tone: "danger", title: "Could not change the guardrail", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Switch" description={d.canToggle ? "Turns this guardrail on or off for every agent it applies to. Recorded in the audit trail." : "Only a superadmin can switch a guardrail on or off."}>
      <Button variant={d.enabled ? "danger" : "primary"} disabled={!d.canToggle} onClick={() => setConfirm(true)}>
        {d.enabled ? "Turn off" : "Turn on"}
      </Button>
      <Dialog
        open={confirm}
        onClose={() => (busy ? undefined : setConfirm(false))}
        size="sm"
        title={next ? "Turn this guardrail on?" : "Turn this guardrail off?"}
        description={
          next
            ? "Its rules and Guidance apply again. Warm sessions pick it up after their current turn."
            : "Its rules stop being checked and its Guidance leaves the prompt. Warm sessions pick it up after their current turn."
        }
        footer={
          <>
            <Button onClick={() => setConfirm(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={next ? "primary" : "danger"} loading={busy} onClick={act}>
              {next ? "Turn on" : "Turn off"}
            </Button>
          </>
        }
      />
    </Card>
  );
}

/** The override against the source text it replaces (the current synced or imported one). */
function OverrideDiff({ d }: { d: OwnerGuardrailDetail }) {
  if (!d.overrideOf) return null;
  const lines = lineDiff(d.overrideOf.sourceMd, d.md);
  const changed = lines.filter((l) => l.kind !== "same").length;
  return (
    <Card
      title={
        <span className="sl-title-row">
          <span>Changes from the source</span>
          {d.behindSource && <Badge tone="warning">Behind source</Badge>}
        </span>
      }
      description={
        d.behindSource
          ? "The source changed after this override was written. Lines marked - are in the current source and not in the override; lines marked + are the override's."
          : "Lines marked - are in the source and not in the override; lines marked + are the override's."
      }
    >
      <p className="sl-caption">
        Override by {d.overrideOf.author}, <TimeAgo at={d.overrideOf.updatedAt} />. {changed ? `${changed} ${changed === 1 ? "line differs" : "lines differ"}.` : "Same text as the source."}
      </p>
      <pre className="sl-gr-diff" aria-label="Override diff against the source">
        {lines.map((l, i) => (
          <span key={i} className={`sl-gr-diff__line is-${l.kind}`}>
            {`${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}\n`}
          </span>
        ))}
      </pre>
    </Card>
  );
}

/** Edit, clear the override, delete: superadmin only; each write carries the revision loaded. */
function Actions({ d, reload }: { d: OwnerGuardrailDetail; reload: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const path = `/api/guardrails/${encodeURIComponent(d.slug)}${confirm === "clear" ? "/override" : ""}?revision=${d.revision}`;
      await api.del<GuardrailWriteResponse>(path);
      toast({
        tone: "success",
        title: confirm === "clear" ? "Override cleared" : "Guardrail deleted",
        description: confirm === "clear" ? "The source text applies again from each agent's next turn." : `${d.name} no longer applies.`,
      });
      setConfirm(null);
      if (confirm === "delete") navigate("/guardrails");
      else reload();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as GuardrailWriteError | null) : null;
      const stale = body?.code === "stale";
      toast({
        tone: "danger",
        title: stale ? "It changed since you loaded it" : "Could not change the guardrail",
        description: `${e instanceof Error ? e.message : String(e)}${body?.hint ? ` ${body.hint}` : ""}`,
      });
      setConfirm(null);
      if (stale) reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Change it"
      description={
        d.canEdit
          ? d.deletable
            ? "Written in the console: edit it or delete it. Every change is recorded in the audit trail."
            : "From the deploy repo or host files: an edit saves a console override, kept across syncs. To remove it, switch it off or delete it at its source."
          : "Only a superadmin can edit, override or delete a guardrail."
      }
    >
      <div className="sl-title-row">
        <Button variant="primary" disabled={!d.canEdit} onClick={() => navigate(`${guardrailPath(d.slug)}/edit`)}>
          {d.override ? "Edit override" : d.deletable ? "Edit" : "Edit as override"}
        </Button>
        {d.override && (
          <Button disabled={!d.canEdit} onClick={() => setConfirm("clear")}>
            Clear override
          </Button>
        )}
        {d.deletable && (
          <Button variant="danger" disabled={!d.canEdit} onClick={() => setConfirm("delete")}>
            Delete
          </Button>
        )}
      </div>
      <Dialog
        open={confirm !== null}
        onClose={() => (busy ? undefined : setConfirm(null))}
        size="sm"
        title={confirm === "clear" ? "Clear the override?" : "Delete this guardrail?"}
        description={
          confirm === "clear"
            ? "The console override is dropped and the source text applies again. Warm sessions pick it up after their current turn."
            : "Its rules stop being checked and its Guidance leaves the prompt. This cannot be undone."
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={act}>
              {confirm === "clear" ? "Clear override" : "Delete"}
            </Button>
          </>
        }
      />
    </Card>
  );
}

function Body({ d, reload }: { d: OwnerGuardrailDetail; reload: () => void }) {
  return (
    <div className="sl-memory-page">
      <div className="sl-memory-page__main">
        {d.errors.length > 0 && (
          <Card title="Problems" description="Rules that failed validation are not applied; the other rules and the Guidance still are.">
            <ul className="sl-gr-errors">
              {d.errors.map((e) => (
                <li key={e} className="sl-break">
                  {e}
                </li>
              ))}
            </ul>
          </Card>
        )}
        <Card title="GUARDRAIL.md">
          <Markdown source={d.md} copyLabel="Copy GUARDRAIL.md" />
        </Card>
        <OverrideDiff d={d} />
        <Rules d={d} />
        <Guidance d={d} />
        <GuardrailTestBox agent={d.appliesTo.agents[0] ?? "default"} description="Try a tool call, a reply or an incoming message against an agent's guardrails, this one included. Nothing is posted, held or run." />
        <Firings d={d} />
      </div>
      <aside className="sl-memory-page__aside">
        <Card title="Applies to">
          <KeyValue
            className="sl-kv--compact"
            items={[
              {
                key: "agents",
                label: d.scope === "shared" ? "Every agent" : "Agents",
                value: d.appliesTo.agents.length ? (
                  <ul className="sl-chips">
                    {d.appliesTo.agents.map((a) => (
                      <li key={a} className="sl-tag">
                        <Link to={`/agents/${encodeURIComponent(a)}/guardrails`}>{a}</Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="sl-faint">No agent</span>
                ),
              },
              ...(d.unknownAgents.length ? [{ key: "unknown", label: "Unknown names", value: <span className="sl-mono">{d.unknownAgents.join(", ")}</span> }] : []),
              { key: "channels", label: "Channels", value: d.appliesTo.everyChannel ? "Every channel" : d.appliesTo.channels.map(channelText).join(", ") },
            ]}
          />
        </Card>
        <Card title="Status">
          <div className="sl-stack">
            <GuardrailStatus g={d} />
            {d.skippedFor.length > 0 && (
              <p className="sl-caption">{`Its Guidance does not fit the always-loaded prose cap for ${d.skippedFor.join(", ")}, so it is left out of their prompt (its rules still apply).`}</p>
            )}
            <span className="sl-caption">{d.lastFiredAt ? <>Last fired <TimeAgo at={d.lastFiredAt} /></> : "Never fired"}</span>
          </div>
        </Card>
        <Card title="Source">
          <div className="sl-stack">
            <GuardrailSourceBadges g={d} />
            {d.behindSource && <p className="sl-caption">The source text changed after this override was written. The override is kept until someone updates or clears it.</p>}
          </div>
        </Card>
        <Actions d={d} reload={reload} />
        <Switch d={d} reload={reload} />
        <Card title="Who can change it">
          <ThreatModelNote t={d.threatModel} />
          <p className="sl-caption">Tool rules are a policy on named tools: a shell or fetch tool can reach the same service, so pair a deny with a Bash or WebFetch input rule.</p>
        </Card>
      </aside>
    </div>
  );
}

export function GuardrailDetailPage({ slug }: { slug: string }) {
  const { data, error, reload } = useApi<OwnerGuardrailDetail>(`/api/guardrails/${encodeURIComponent(slug)}`);
  const back = (
    <Link to="/guardrails" className="sl-back">
      <IconArrowLeft size={14} />
      Guardrails
    </Link>
  );
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <>
      <PageHeader back={back} title={<span className="sl-break">{data?.name ?? (missing ? "No such guardrail" : slug)}</span>} description={data?.description || undefined} />
      {error && !data ? (
        <Card>
          {missing ? (
            <EmptyState title="No such guardrail" description="It may have been removed by a sync or an import." action={<Link className="sl-link" to="/guardrails">Back to guardrails</Link>} />
          ) : (
            <ErrorState what="Guardrail" error={error} onRetry={reload} />
          )}
        </Card>
      ) : !data ? (
        <div className="sl-memory-page" aria-busy="true" aria-label="Loading guardrail">
          <div className="sl-memory-page__main">
            <Skeleton height="24rem" radius="var(--sl-radius-panel)" />
          </div>
          <div className="sl-memory-page__aside">
            <Skeleton height="14rem" radius="var(--sl-radius-panel)" />
          </div>
        </div>
      ) : (
        <Body d={data} reload={reload} />
      )}
    </>
  );
}
