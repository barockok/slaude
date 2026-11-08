/**
 * The Test box (phase B): one tool call, reply or inbound message through an
 * agent's effective guardrails in a channel, optionally with an unsaved
 * draft, evaluated by the server with the runtime's own matcher. Nothing is
 * posted, held or recorded (but a guardrail.tested row without the text).
 */
import { useState, type FormEvent } from "react";
import type { AgentsResponse, GuardrailTestRequest, GuardrailTestResponse, OwnerRuleAction } from "../../../../gateway/panel/api-types";
import { Link } from "../../../lib/router";
import { Badge, Button, Card, Field, Input, Select, type BadgeTone } from "../../../ui";
import { api } from "../../client";
import { useApi } from "../../hooks/useApi";
import { guardrailPath } from "./guardrailParts";

type Kind = GuardrailTestRequest["kind"];

const KIND_LABEL: Record<Kind, string> = { tool: "Tool call", reply: "Reply", inbound: "Inbound message" };
export const ACTION_LABEL: Record<OwnerRuleAction, string> = { deny: "Deny", approve: "Needs approval", redact: "Redact", audit: "Record only" };
const ACTION_TONE: Record<OwnerRuleAction, BadgeTone> = { deny: "danger", approve: "warning", redact: "accent", audit: "neutral" };

function Result({ r }: { r: GuardrailTestResponse }) {
  const g = r.guidance;
  return (
    <div className="sl-stack" aria-live="polite" data-testid="guardrail-test-result">
      <div className="sl-title-row">
        {r.decision ? <Badge tone={ACTION_TONE[r.decision.action]}>{`Decision: ${ACTION_LABEL[r.decision.action]}`}</Badge> : <Badge tone="success">No rule matched</Badge>}
        {r.tooLarge && (
          <span title="Past a size bound the input is not fully checked; that counts as a match for deny and approve rules">
            <Badge tone="warning">Too large to check</Badge>
          </span>
        )}
        <span className="sl-caption">{`${r.rulesChecked} enforced ${r.rulesChecked === 1 ? "rule" : "rules"} of this kind apply to ${r.agent}${r.channel ? ` in ${r.channel}` : ""}`}</span>
      </div>
      <p className="sl-break">{r.outcome}</p>
      {r.draft && (r.draft.errors.length > 0 ? (
        <div className="sl-notice is-warning" role="note">
          <p>{`The draft of ${r.draft.slug} has problems${r.draft.blocking.length ? " that would refuse a save" : ""}:`}</p>
          <ul className="sl-gr-errors">
            {r.draft.errors.map((e) => (
              <li key={e} className="sl-break">
                {e}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="sl-caption">{`Tested with the unsaved draft of ${r.draft.slug} ${r.draft.replaced ? "in place of its stored text" : "added to the stored set"}.`}</p>
      ))}
      {r.hits.length > 0 && (
        <div className="sl-scroll-x" tabIndex={0}>
          <table className="sl-simple-table sl-gr-table" aria-label="Matching rules">
            <thead>
              <tr>
                <th>Guardrail</th>
                <th>Rule</th>
                <th>Action</th>
                <th>Message</th>
                <th>
                  <span className="sl-visually-hidden">Flags</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {r.hits.map((h) => (
                <tr key={`${h.slug}#${h.ruleId}`}>
                  <td>{h.draft ? <span>{h.slug}</span> : <Link to={guardrailPath(h.slug)}>{h.slug}</Link>}</td>
                  <td className="sl-mono">{h.ruleId}</td>
                  <td>{ACTION_LABEL[h.action]}</td>
                  <td className="sl-break">{h.message}</td>
                  <td>
                    <span className="sl-gr-badges">
                      {h.deciding && <Badge tone="accent">Decides</Badge>}
                      {h.oversize && <Badge tone="warning">Too large to check</Badge>}
                      {h.draft && <Badge>Draft</Badge>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {r.posted !== undefined && (
        <div className="sl-stack">
          <span className="sl-caption">Would be posted as</span>
          <pre className="sl-gr-posted sl-break">{r.posted}</pre>
        </div>
      )}
      <div className="sl-stack">
        <span className="sl-strong">Guidance</span>
        <ul className="sl-gr-errors" aria-label="Guidance">
          {g.always.length > 0 ? (
            <li>{`Always in the prompt: ${g.always.map((x) => x.name).join(", ")} (${g.proseChars.toLocaleString()} of ${g.proseMax.toLocaleString()} characters).`}</li>
          ) : (
            <li className="sl-faint">No always-loaded Guidance here.</li>
          )}
          {g.skipped.length > 0 && <li>{`Left out by the prose cap: ${g.skipped.map((x) => `${x.name} (${x.chars.toLocaleString()} characters)`).join(", ")}.`}</li>}
          {g.delivered.length > 0 && <li>{`Delivered on match by this ${r.kind === "tool" ? "tool call" : "message"}, once per session: ${g.delivered.map((x) => x.name).join(", ")}.`}</li>}
          {g.indexed.length > 0 && <li>{`On match, only listed in the prompt: ${g.indexed.map((x) => x.name).join(", ")}.`}</li>}
        </ul>
      </div>
    </div>
  );
}

export interface TestBoxProps {
  /** Preselected agent. */
  agent?: string;
  /** An unsaved draft to try in place of the stored text (the editor's). */
  draft?: { slug: string; md: string } | null;
  /** Show the draft fields so one can be pasted (the standalone page). */
  draftInput?: boolean;
  title?: string;
  description?: string;
}

export function GuardrailTestBox({ agent: initialAgent = "default", draft = null, draftInput = false, title = "Test", description }: TestBoxProps) {
  const agents = useApi<AgentsResponse>("/api/agents");
  const names = agents.data?.agents.map((a) => a.name) ?? [initialAgent];
  const [agent, setAgent] = useState(initialAgent);
  const [channel, setChannel] = useState("");
  const [kind, setKind] = useState<Kind>("tool");
  const [tool, setTool] = useState("");
  const [input, setInput] = useState("{}");
  const [text, setText] = useState("");
  const [useDraft, setUseDraft] = useState(true);
  const [draftSlug, setDraftSlug] = useState("");
  const [draftMd, setDraftMd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GuardrailTestResponse | null>(null);

  const draftToSend = draftInput ? (draftSlug.trim() && draftMd.trim() ? { slug: draftSlug.trim(), md: draftMd } : null) : draft && useDraft ? draft : null;

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: GuardrailTestRequest = {
        agent,
        channel: channel.trim() || null,
        kind,
        ...(kind === "tool" ? { tool: tool.trim(), input } : { text }),
        draft: draftToSend,
      };
      setResult(await api.post<GuardrailTestResponse>("/api/guardrails/test", body));
    } catch (err) {
      setResult(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={title}
      description={description ?? "Try a tool call, a reply or an incoming message against one agent's guardrails. Nothing is posted, held or run."}
      id="guardrail-test"
    >
      <form className="sl-stack" onSubmit={run} aria-label="Test a guardrail">
        <div className="sl-gr-test-grid">
          <Field label="What">
            {({ id }) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Agent">
            {({ id }) => (
              <Select id={id} value={agent} onChange={(e) => setAgent(e.target.value)}>
                {(names.includes(agent) ? names : [agent, ...names]).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Channel" hint="A channel id; empty for none (a background pass).">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={channel} placeholder="C0123" onChange={(e) => setChannel(e.target.value)} />}
          </Field>
        </div>
        {kind === "tool" ? (
          <>
            <Field label="Tool name">
              {({ id }) => <Input id={id} className="sl-mono" value={tool} placeholder="mcp__mail__send_message" onChange={(e) => setTool(e.target.value)} />}
            </Field>
            <Field label="Tool input (JSON)">
              {({ id }) => <textarea id={id} className="sl-input sl-mono" rows={4} spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label={kind === "reply" ? "Reply text" : "Message text"} hint={kind === "reply" ? "Formatted as a real reply is (mrkdwn, the soul's redaction) before the rules run." : undefined}>
            {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} className="sl-input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />}
          </Field>
        )}
        {draftInput && (
          <details className="sl-fold">
            <summary className="sl-fold__summary">Try an unsaved draft</summary>
            <div className="sl-fold__body sl-stack">
              <Field label="Draft guardrail name" hint="An existing name replaces its stored text; a new one is added.">
                {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} className="sl-mono" value={draftSlug} onChange={(e) => setDraftSlug(e.target.value)} />}
              </Field>
              <Field label="Draft GUARDRAIL.md">
                {({ id }) => <textarea id={id} className="sl-input sl-mono" rows={8} spellCheck={false} value={draftMd} onChange={(e) => setDraftMd(e.target.value)} />}
              </Field>
            </div>
          </details>
        )}
        {!draftInput && draft && (
          <label className="sl-inline sl-caption">
            <input type="checkbox" checked={useDraft} onChange={(e) => setUseDraft(e.target.checked)} />
            Use my unsaved changes
          </label>
        )}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={kind === "tool" && !tool.trim()}>
            Run test
          </Button>
        </div>
      </form>
      {error && (
        <p className="sl-notice is-danger" role="alert">
          {error}
        </p>
      )}
      {result && <Result r={result} />}
    </Card>
  );
}
